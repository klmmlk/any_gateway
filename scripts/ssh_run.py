"""SSH via plink (PuTTY) with password auth — works on Windows.

Usage:
    python scripts/ssh_run.py <host> <user> <password> <cmd...>
"""
from __future__ import annotations

import os
import shlex
import subprocess
import sys

PLINK = r"D:\Users\Administrator\Desktop\putty\plink.exe"


def main() -> int:
    if len(sys.argv) < 5:
        print("usage: ssh_run.py <host> <user> <password> <cmd...>", file=sys.stderr)
        return 2
    host = sys.argv[1]
    user = sys.argv[2]
    password = sys.argv[3]
    cmd = " ".join(sys.argv[4:])
    if not os.path.exists(PLINK):
        print(f"plink not found at {PLINK}", file=sys.stderr)
        return 3
    args = [
        PLINK,
        "-ssh",
        "-l", user,
        "-pw", password,
        "-no-antispoof",
        "-batch",
        "-C",
        host,
        cmd,
    ]
    proc = subprocess.run(args, capture_output=True)
    for buf in (proc.stdout, proc.stderr):
        if buf is None:
            continue
        try:
            sys.stdout.buffer.write(buf)
        except Exception:
            # Last-resort decode fallback
            sys.stdout.buffer.write(buf.decode("utf-8", errors="replace").encode("utf-8"))
    sys.stdout.flush()
    return proc.returncode


if __name__ == "__main__":
    sys.exit(main())
