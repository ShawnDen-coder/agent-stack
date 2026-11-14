import errno
import fcntl
import json
import os
import pty
import select
import signal
import struct
import sys
import termios
import time

node, cli, repo, path, mode, columns = sys.argv[1:]
pid, fd = pty.fork()
if pid == 0:
    env = os.environ.copy()
    env.update({"PATH": path, "TERM": "xterm-256color", "NO_COLOR": "1", "TMPDIR": os.path.join(repo, "tmp")})
    env.pop("CI", None)
    env["FORCE_COLOR"] = "3"
    if mode == "ci":
        env["CI"] = "true"
    if mode == "dumb":
        env["TERM"] = "dumb"
    args = [node, cli, "doctor", "--repo", repo]
    if mode == "interrupt":
        args += ["--profile", "coding"]
    os.execve(node, args, env)
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 24, int(columns), 0, 0))
output = bytearray()
sent = False
deadline = time.monotonic() + 12
status = None
try:
    while time.monotonic() < deadline:
        ready, _, _ = select.select([fd], [], [], 0.1)
        if ready:
            try:
                chunk = os.read(fd, 65536)
            except OSError as error:
                if error.errno != errno.EIO:
                    raise
                break
            if not chunk:
                break
            output.extend(chunk)
            prompt = b"Inspecting toolchain" if mode == "interrupt" else b"Choose a profile"
            if not sent and prompt in output and (mode != "interrupt" or os.path.exists(os.path.join(repo, "probe.pid"))):
                os.write(fd, b"\x03" if mode in ("cancel", "interrupt") else b"\x1b[B\r")
                sent = True
        if mode == "interrupt" and not sent and os.path.exists(os.path.join(repo, "probe.pid")):
            os.write(fd, b"\x03")
            sent = True
        exited, raw = os.waitpid(pid, os.WNOHANG)
        if exited:
            status = os.waitstatus_to_exitcode(raw)
            break
    if status is None:
        exited, raw = os.waitpid(pid, os.WNOHANG)
        if exited:
            status = os.waitstatus_to_exitcode(raw)
        else:
            os.kill(pid, signal.SIGKILL)
            _, raw = os.waitpid(pid, 0)
            status = os.waitstatus_to_exitcode(raw)
    print(json.dumps({"status": status, "sent": sent, "output": output.decode("utf8", "replace")}))
finally:
    os.close(fd)
