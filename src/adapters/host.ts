import { machine } from "node:os";

// Node exposes the execution architecture and a machine name, but does not
// provide a portable guarantee that x64 is not running under emulation.
export function observeHost() {
  const value = machine();
  const native =
    process.platform === "darwin" &&
    process.arch === "arm64" &&
    ["arm64", "aarch64"].includes(value);
  return {
    platform: process.platform,
    processArch: process.arch,
    machine: value,
    target: `${process.platform}-${process.arch}`,
    native,
  };
}
