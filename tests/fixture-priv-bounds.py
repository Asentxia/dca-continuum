#!/usr/bin/env python3
"""The fixture helper must reject privilege widening even when sudo can start it."""
import json
import os
import subprocess
import sys

HELPER = "/usr/local/sbin/continuum-fixture-priv"
NODE = os.environ.get("CT_FIXTURE_NODE", "/home/bennadmin/continuum-runtime/node24/bin/node")


def run(args: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["sudo", "-n", HELPER, *args],
        text=True,
        capture_output=True,
        timeout=10,
    )


def expect_deny(label: str, args: list[str]) -> None:
    result = run(args)
    if result.returncode == 0:
        print(label, "was accepted", result.stdout, result.stderr, file=sys.stderr)
        raise SystemExit(1)


def main() -> None:
    expect_deny("root chown", ["chown", "0:0", "/etc/passwd"])
    expect_deny("arbitrary chown", ["chown", "110001:1000", "/etc"])
    expect_deny("kill init", ["kill", "1"])
    expect_deny(
        "root unshare",
        ["unshare", "--reuid=0", "--regid=0", "--clear-groups", "--", NODE, "-e", "0"],
    )
    expect_deny(
        "shell unshare",
        [
            "unshare",
            "--reuid=65534",
            "--regid=65534",
            "--clear-groups",
            "--no-new-privs",
            "--bounding-set=-all",
            "--inh-caps=-all",
            "--ambient-caps=-all",
            "--",
            "/bin/bash",
        ],
    )
    report = {"helperDeniesWidening": True}
    if os.environ.get("CT_EXPECT_NARROW_SUDO") == "yes":
        raw = subprocess.run(
            ["sudo", "-n", "/usr/bin/unshare", "--net", "true"],
            text=True,
            capture_output=True,
        )
        report["rawUnshareDenied"] = raw.returncode != 0
        if raw.returncode == 0:
            print("raw unshare is still passwordless", file=sys.stderr)
            raise SystemExit(1)
    print(json.dumps(report))


if __name__ == "__main__":
    main()
