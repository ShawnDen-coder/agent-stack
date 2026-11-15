# Herdr macOS native smoke

Run after packing the CLI and installing its runtime dependencies into an independent unpacked package:

```sh
node scripts/smoke-herdr-macos.mjs --cli /absolute/path/to/package/dist/cli.js --target darwin-x64
# On native Apple Silicon, use --target darwin-arm64.
```

The script requires a real native target, Node, npm and Git. It copies `stack` to a short, isolated temporary root, builds a `herdr-only` workspace profile and generates its lock from the checked-in [v0.9.5 manifest snapshot](../test/fixtures/herdr-release/v0.9.5.json). The snapshot records the official stable manifest URL and values observed on 2026-11-15; it is not a live metadata lookup. The preload accepts only that manifest URL and is used only for lock generation. The first `setup` uses the real locked HTTPS release URL without a fetch mock and checks the resulting managed receipt, digest and executable version. A separate preload fails and records any fetch during the second `setup`; the script requires identical managed receipts and no fetch attempt.

The script starts only its own server in a private session with isolated HOME, config and state. It verifies version and private protocol 22, creates a workspace/root pane, runs and reads a harmless command, and reconnects using separate CLI invocations. After stopping and restarting its own server, it verifies that the pane survives, the terminal is rebuilt, the old output is absent and a new command works. Cleanup stops only the child server and removes the temporary root. All command and readiness waits are bounded. This is IPC/CLI evidence, not TUI, keyboard, GUI, ConPTY, Pi integration or Windows evidence.

On 2026-11-15, the `93dd76208c002e7a75f45fff47cf344c9fb853be` unpacked CLI passed this script on native macOS x64 with a **live** HTTPS asset download, managed installation and no-fetch repeat; SHA-256 was `5fb0a908ec7f6745e3e245738b06bfad56c46391c391ab3c0955fbead01f1369`. Earlier isolated runtime evidence used the same verified official bytes via a controlled response, not live download. macOS arm64 is implemented for native CI but has not been run locally. The script does not claim either architecture's GUI or interactive terminal behavior.
