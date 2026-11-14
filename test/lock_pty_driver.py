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

node, cli, repo, path, mode, columns = sys.argv[1:7]
preload = sys.argv[8]
color_mode = sys.argv[7] if len(sys.argv) > 7 else "no-color"
out_read, out_write = os.pipe() if mode == "redirect-out" else pty.openpty()
err_read, err_write = os.pipe() if mode == "redirect-err" else (None, None)
pid, tty = pty.fork()
if pid == 0:
    os.close(out_read)
    os.dup2(out_write, 1)
    os.close(out_write)
    if err_write is not None:
        os.close(err_read)
        os.dup2(err_write, 2)
        os.close(err_write)
    env = os.environ.copy()
    env.update({"PATH": path, "TERM": "xterm-256color", "TMPDIR": os.path.join(repo, "tmp"), "FORCE_COLOR": "3"})
    env.pop("CI", None)
    if color_mode == "no-color":
        env["NO_COLOR"] = "1"
    else:
        env.pop("NO_COLOR", None)
    if mode == "ci":
        env["CI"] = "true"
    if mode == "dumb":
        env["TERM"] = "dumb"
    args = [node, "--import", preload, cli, "lock", "--dry-run", "--repo", repo]
    if mode in ("interrupt", "report"):
        args += ["--profile", "fixture"]
    if len(sys.argv) > 9:
        args += ["--target", sys.argv[9]]
    os.execve(node, args, env)
os.close(out_write)
if err_write is not None:
    os.close(err_write)
for fd in (tty, out_read):
    if os.isatty(fd):
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 24, int(columns), 0, 0))
error_fd = err_read if err_read is not None else tty
streams = {out_read: bytearray(), error_fd: bytearray()}
sent = False
deadline = time.monotonic() + 12
status = None
try:
    while time.monotonic() < deadline and streams:
        ready, _, _ = select.select(list(streams), [], [], 0.1)
        for fd in ready:
            try:
                chunk = os.read(fd, 65536)
            except OSError as error:
                if error.errno != errno.EIO:
                    raise
                chunk = b""
            if chunk:
                streams[fd].extend(chunk)
            else:
                # Retain the buffer but stop selecting its closed descriptor.
                pass
        if not sent and b"Choose a profile" in streams[error_fd]:
            os.write(tty, b"\x03" if mode == "cancel" else b"\r")
            sent = True
        if mode == "interrupt" and not sent and os.path.exists(os.path.join(repo, "probe.pid")):
            os.write(tty, b"\x03")
            sent = True
        exited, raw = os.waitpid(pid, os.WNOHANG)
        if exited:
            status = os.waitstatus_to_exitcode(raw)
            # Drain any data written before exit.
            for fd in list(streams):
                while select.select([fd], [], [], 0)[0]:
                    try:
                        chunk = os.read(fd, 65536)
                    except OSError as error:
                        if error.errno != errno.EIO:
                            raise
                        break
                    if not chunk:
                        break
                    streams[fd].extend(chunk)
            break
    if status is None:
        os.kill(pid, signal.SIGKILL)
        _, raw = os.waitpid(pid, 0)
        status = os.waitstatus_to_exitcode(raw)
    print(json.dumps({"status": status, "sent": sent, "stdout": streams[out_read].decode("utf8", "replace"), "stderr": streams[error_fd].decode("utf8", "replace")}))
finally:
    for fd in set((tty, out_read, error_fd)):
        os.close(fd)
