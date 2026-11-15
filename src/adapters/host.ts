import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { machine, tmpdir } from "node:os";
import { join } from "node:path";

// IsWow64Process2 examines the actual Node process, not PowerShell itself.
const windowsProbe = `$ErrorActionPreference='Stop'
$asm=[AppDomain]::CurrentDomain.DefineDynamicAssembly([Reflection.AssemblyName]::new('AgentStackHostProbe'),[Reflection.Emit.AssemblyBuilderAccess]::Run)
$mod=$asm.DefineDynamicModule('AgentStackHostProbe')
$type=$mod.DefineType('AgentStackNative',[Reflection.TypeAttributes]'Public, Abstract, Sealed')
$attr=[Reflection.MethodAttributes]'Public, Static, PinvokeImpl'
$cc=[Reflection.CallingConventions]::Standard
$native=[Runtime.InteropServices.CallingConvention]::Winapi
$charset=[Runtime.InteropServices.CharSet]::Ansi
$import=[Runtime.InteropServices.DllImportAttribute]
$ctor=$import.GetConstructor([type[]]@([string]))
$field=$import.GetField('SetLastError')
$lastError=[Reflection.Emit.CustomAttributeBuilder]::new($ctor,[object[]]@('kernel32.dll'),[Reflection.FieldInfo[]]@($field),[object[]]@($true))
function NativeMethod($name,$returnType,$parameters,$saveError) {
 $method=$type.DefinePInvokeMethod($name,'kernel32.dll',$attr,$cc,$returnType,[type[]]$parameters,$native,$charset)
 if ($saveError) { $method.SetCustomAttribute($lastError) }
 $method.SetImplementationFlags($method.GetMethodImplementationFlags() -bor [Reflection.MethodImplAttributes]::PreserveSig)
}
NativeMethod 'OpenProcess' ([IntPtr]) @([uint32],[bool],[int]) $true
NativeMethod 'IsWow64Process2' ([bool]) @([IntPtr],[uint16].MakeByRefType(),[uint16].MakeByRefType()) $true
NativeMethod 'CloseHandle' ([bool]) @([IntPtr]) $false
$probe=$type.CreateType()
$h=$probe.GetMethod('OpenProcess').Invoke($null,[object[]]@([uint32]0x1000,$false,[int]$env:AGENT_STACK_PROBE_PID))
if ($h -eq [IntPtr]::Zero) { throw 'OpenProcess failed' }
try {
 $values=[object[]]@($h,[uint16]0,[uint16]0)
 if (-not $probe.GetMethod('IsWow64Process2').Invoke($null,$values)) { throw 'IsWow64Process2 failed' }
 [Console]::Out.WriteLine("$($values[1]),$($values[2])")
} finally { [void]$probe.GetMethod('CloseHandle').Invoke($null,[object[]]@($h)) }`;

export async function observeHost(signal?: AbortSignal) {
  const value = machine();
  const base = {
    platform: process.platform,
    processArch: process.arch,
    machine: value,
    target: `${process.platform}-${process.arch}`,
  };
  if (
    process.platform === "darwin" &&
    process.arch === "arm64" &&
    ["arm64", "aarch64"].includes(value)
  )
    return { ...base, native: true, evidence: "native-arm64-process" };
  if (signal?.aborted)
    return { ...base, native: false, evidence: "probe-unknown" };
  const home = await mkdtemp(join(tmpdir(), "agent-stack-host-"));
  try {
    let command: string;
    let args: string[];
    let env: NodeJS.ProcessEnv;
    if (process.platform === "darwin" && process.arch === "x64") {
      // Force the child to use the same x86_64 architecture as Node; the
      // process-scoped sysctl then detects Rosetta for that architecture.
      command = "/usr/bin/arch";
      args = ["-x86_64", "/usr/sbin/sysctl", "-n", "sysctl.proc_translated"];
      env = { PATH: "", HOME: home, LANG: "C", LC_ALL: "C" };
    } else if (
      process.platform === "win32" &&
      process.arch === "x64" &&
      process.env.SystemRoot
    ) {
      command = join(
        process.env.SystemRoot,
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      );
      args = [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(windowsProbe, "utf16le").toString("base64"),
      ];
      env = {
        SystemRoot: process.env.SystemRoot,
        TEMP: home,
        TMP: home,
        USERPROFILE: home,
        AGENT_STACK_PROBE_PID: String(process.pid),
      };
    } else
      return { ...base, native: false, evidence: "unsupported-or-unknown" };
    if (signal?.aborted)
      return { ...base, native: false, evidence: "probe-unknown" };
    const result = await new Promise<{
      stdout: string;
      stderr: string;
      code: number | null;
    }>((resolve) => {
      let closed = false;
      let output:
        | { stdout: string; stderr: string; code: number | null }
        | undefined;
      const finish = () => {
        if (closed && output) resolve(output);
      };
      const child = execFile(
        command,
        args,
        {
          cwd: home,
          env,
          // Windows PowerShell may need a cold .NET/C# compiler startup.
          timeout: process.platform === "win32" ? 30000 : 3000,
          maxBuffer: 16384,
          killSignal: "SIGKILL",
          windowsHide: true,
          encoding: "utf8",
        },
        (error, stdout, stderr) => {
          output = {
            stdout,
            stderr,
            code: error
              ? typeof (error as NodeJS.ErrnoException & { code?: number })
                  .code === "number"
                ? (error as unknown as { code: number }).code
                : null
              : 0,
          };
          finish();
        },
      );
      const abort = () => {
        child.kill("SIGKILL");
      };
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      child.once("close", () => {
        signal?.removeEventListener("abort", abort);
        closed = true;
        finish();
      });
      // The probe has no input; shells must receive EOF before we await exit.
      child.stdin?.end();
    });
    if (process.platform === "darwin") {
      const native =
        (result.code === 0 && result.stdout.trim() === "0") ||
        (result.code === 1 &&
          /^sysctl: unknown oid 'sysctl\.proc_translated'\s*$/.test(
            result.stderr,
          ));
      return {
        ...base,
        native,
        evidence: native
          ? "same-architecture-sysctl"
          : result.code === 0 && result.stdout.trim() === "1"
            ? "rosetta"
            : "probe-unknown",
      };
    }
    const native = result.code === 0 && result.stdout.trim() === "0,34404";
    return {
      ...base,
      native,
      evidence: native
        ? "IsWow64Process2"
        : result.code === 0 && /^\d+,\d+$/.test(result.stdout.trim())
          ? "emulated-or-unsupported"
          : "probe-unknown",
    };
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}
