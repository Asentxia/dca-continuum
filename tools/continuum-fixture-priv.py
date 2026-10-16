#!/usr/bin/env python3
"""Root-owned local fixture privilege gate.

sudoers may allow this program only. It refuses every operation that is not
one of the reviewed fixture shapes: chown of a direct computer-fixture
directory, kill of that fixture's Node process, or a network-namespace drop
to an unprivileged uid that then executes only the configured Node.
"""
import json
import os
import re
import sys

CONF = "/etc/continuum-fixture-priv.conf"
DROP = (
    "--clear-groups",
    "--no-new-privs",
    "--bounding-set=-all",
    "--inh-caps=-all",
    "--ambient-caps=-all",
)


def deny(message: str) -> None:
    print(message, file=sys.stderr)
    raise SystemExit(2)


def own_root(path: str) -> os.stat_result:
    st = os.stat(path)
    if st.st_uid != 0 or st.st_mode & 0o022:
        deny("fixture privilege file must be root-owned and not group/world writable")
    return st


def load() -> tuple[str, str]:
    if os.geteuid() != 0:
        deny("fixture privilege helper must run as root")
    own_root(os.path.realpath(sys.argv[0]))
    own_root(CONF)
    data: dict[str, str] = {}
    for line in open(CONF, encoding="utf-8"):
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        key, value = line.split("=", 1)
        data[key] = value
    node, root = data["node"], data["fixtures"]
    if not os.path.isabs(node) or not os.path.isabs(root):
        deny("configured paths must be absolute")
    if os.path.islink(node) or not os.path.isfile(node):
        deny("configured node is not a regular file")
    node = os.path.realpath(node)
    real_root = os.path.realpath(root)
    if (
        os.path.basename(real_root) != "computer-fixtures"
        or os.path.basename(os.path.dirname(real_root)) != ".local"
    ):
        deny("fixture root must be the computer-fixtures directory")
    return node, root


def fixture_uid(uid: int) -> bool:
    return uid == 65534 or 110000 <= uid <= 199999


def split_command(args: list[str]) -> tuple[list[str], list[str]]:
    if "--" not in args:
        deny("missing command separator")
    cut = args.index("--")
    return args[:cut], args[cut + 1 :]


def privilege_flags(flags: list[str]) -> int:
    reuid = regid = None
    seen: list[str] = []
    for flag in flags:
        if flag.startswith("--reuid="):
            reuid = int(flag.split("=", 1)[1])
        elif flag.startswith("--regid="):
            regid = int(flag.split("=", 1)[1])
        elif flag in DROP:
            seen.append(flag)
        else:
            deny("unexpected privilege flag")
    if reuid is None or reuid != regid or not fixture_uid(reuid):
        deny("refusing privilege target")
    if seen != list(DROP):
        deny("refusing incomplete privilege drop")
    return reuid


def probe_path_ok(path: str) -> bool:
    if path == "tests/isolation-probe.mjs":
        return True
    if not os.path.isabs(path) or ".." in path.split("/"):
        return False
    real = os.path.realpath(path)
    return os.path.isfile(real) and real.endswith("/tests/isolation-probe.mjs")


def command_ok(argv: list[str], node: str) -> None:
    if (
        len(argv) == 3
        and os.path.realpath(argv[0]) == node
        and argv[1] == "-e"
        and argv[2]
        and len(argv[2]) <= 65536
        and "\x00" not in argv[2]
    ):
        return
    if (
        len(argv) == 4
        and argv[0] == "/usr/bin/env"
        and argv[1].startswith("PROBE_CONFIG=")
        and "\n" not in argv[1]
        and "\x00" not in argv[1]
        and len(argv[1]) <= 8192
        and os.path.realpath(argv[2]) == node
        and probe_path_ok(argv[3])
    ):
        json.loads(argv[1].split("=", 1)[1])
        return
    deny("refusing command")


def chown(spec: str, path: str, root: str) -> None:
    match = re.fullmatch(r"(1[0-9]{5}):([1-9][0-9]{0,4})", spec)
    if not match:
        deny("refusing owner")
    uid, gid = int(match.group(1)), int(match.group(2))
    if not 110000 <= uid <= 199999 or gid == 0 or gid > 65534:
        deny("refusing owner")
    if not os.path.isabs(path) or "\x00" in path or os.path.islink(path):
        deny("refusing path")
    real = os.path.realpath(path)
    parent = os.path.realpath(root)
    if os.path.dirname(real) != parent or not os.path.isdir(real):
        deny("refusing path")
    os.chown(real, uid, gid)


def process_uid(pid: str) -> int:
    if not re.fullmatch(r"[0-9]+", pid):
        deny("refusing process")
    uid = None
    for line in open(f"/proc/{pid}/status", encoding="utf-8"):
        if line.startswith("Uid:"):
            uid = int(line.split()[1])
    if uid is None or not fixture_uid(uid):
        deny("refusing process")
    return uid


def exe_is_node(pid: str, node: str) -> None:
    if os.path.realpath(f"/proc/{pid}/exe") != os.path.realpath(node):
        deny("refusing process")


def main() -> None:
    node, root = load()
    args = sys.argv[1:]
    if not args:
        deny("missing operation")
    op = args[0]
    if op == "chown" and len(args) == 3:
        chown(args[1], args[2], root)
        return
    if op == "kill" and len(args) == 2:
        process_uid(args[1])
        exe_is_node(args[1], node)
        os.kill(int(args[1]), 9)
        return
    if op == "unshare":
        flags, command = split_command(args[1:])
        privilege_flags(flags)
        command_ok(command, node)
        os.execv(
            "/usr/bin/unshare",
            ["unshare", "--net", "--", "/usr/bin/setpriv", *flags, *command],
        )
    if op == "nsenter" and args[1].startswith("--target="):
        pid = args[1].split("=", 1)[1]
        process_uid(pid)
        exe_is_node(pid, node)
        flags, command = split_command(args[2:])
        privilege_flags(flags)
        command_ok(command, node)
        os.execv(
            "/usr/bin/nsenter",
            ["nsenter", "-t", pid, "--net", "--", "/usr/bin/setpriv", *flags, *command],
        )
    deny("refusing operation")


if __name__ == "__main__":
    main()
