#!/usr/bin/env python3
"""Hold the fixed local HA/PITR ports so clients cannot take them as ephemeral ports.

This process only listens. It does not accept connections or stop any other process.
"""
import signal
import socket
import sys

PORTS = (55440, 55441, 55442)


def main():
    held = []
    for port in PORTS:
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            sock.bind(("127.0.0.1", port))
        except OSError as error:
            print(
                f"Refusing to reserve {port} ({error}). The occupant was not killed.",
                file=sys.stderr,
            )
            return 2
        sock.listen(1)
        held.append(sock)

    def stop(_signum, _frame):
        for item in held:
            item.close()
        raise SystemExit(0)

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    signal.pause()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
