import errno
import fcntl
import json
import os
import pty
import select
import signal
import sys
import struct
import termios
import time

node, parent = sys.argv[1:3]
mode = sys.argv[3] if len(sys.argv) > 3 else "input"
pid, fd = pty.fork()
if pid == 0:
    os.execv(node, [node, parent])
output = bytearray()
sent = False
status = None
deadline = time.monotonic() + 10
try:
    while time.monotonic() < deadline:
        if select.select([fd], [], [], 0.1)[0]:
            try:
                data = os.read(fd, 65536)
            except OSError as error:
                if error.errno != errno.EIO:
                    raise
                data = b""
            output.extend(data)
            if not sent and b"TTY:true:true" in output:
                if mode == "parent-sigint":
                    os.kill(pid, signal.SIGINT)
                elif mode == "resize":
                    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 31, 101, 0, 0))
                else:
                    os.write(fd, b"\x03" if mode == "interrupt" else b"hello\n")
                sent = True
        done, raw = os.waitpid(pid, os.WNOHANG)
        if done:
            status = os.waitstatus_to_exitcode(raw)
            while select.select([fd], [], [], 0)[0]:
                try:
                    chunk = os.read(fd, 65536)
                except OSError as error:
                    if error.errno != errno.EIO:
                        raise
                    break
                if not chunk:
                    break
                output.extend(chunk)
            break
    if status is None:
        os.kill(pid, signal.SIGKILL)
        _, raw = os.waitpid(pid, 0)
        status = os.waitstatus_to_exitcode(raw)
    print(json.dumps({"status": status if status >= 0 else 128-status, "signal": -status if status < 0 else None, "sent": sent, "output": output.decode("utf8", "replace")}))
finally:
    os.close(fd)
