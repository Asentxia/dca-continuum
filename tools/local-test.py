#!/usr/bin/env python3
"""Local-only preflight and cooperative test lease. Never installs or resets services."""
import argparse
import fcntl
import json
import os
from pathlib import Path
import re
import signal
import stat
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parent.parent
KEYS = {"node24Bin", "node22Bin", "pgBin", "chromium"}
LIVE = ("WORKOS_API_KEY", "WORKOS_COOKIE_PASSWORD", "WORKOS_CLIENT_ID",
        "DATABASE_URL", "CT_DATABASE_URL", "CT_PRODUCTION_CONFIG", "CT_STAGING_CONFIG",
        "PGSERVICE", "PGSERVICEFILE", "PGHOSTADDR", "PGOPTIONS", "PGPASSWORD")


def validate_environment(env):
    if any(env.get(key) for key in LIVE):
        raise ValueError("Live credentials or database overrides are present (values withheld).")
    for key, default in (("CT_RUNTIME_ENV", "local-test"),
                         ("CT_DEPLOYMENT_ENV", "local-test"),
                         ("CT_CONSOLE_MODE", "LOCAL_FIXTURE"),
                         ("PGHOST", "127.0.0.1"), ("PGPORT", "55432"),
                         ("PGUSER", "localtest")):
        if env.get(key, default) != default:
            raise ValueError("Conflicting local fixture setting: " + key)
    if env.get("NODE_ENV") == "production":
        raise ValueError("Production profile refused.")


def load_profile(path):
    profile = json.loads(Path(path).read_text())
    if not isinstance(profile, dict) or set(profile) != KEYS:
        raise ValueError("Profile must contain exactly the four documented runtime paths.")
    for value in profile.values():
        if not isinstance(value, str) or not Path(value).is_absolute():
            raise ValueError("Profile paths must be absolute Linux paths.")
    return profile


def output(command, env):
    result = subprocess.run(command, cwd=ROOT, env=env, text=True,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=15)
    if result.returncode:
        raise ValueError("Preflight command failed: " + Path(command[0]).name)
    return result.stdout.strip()


def database_query(sql, env):
    return output([str(Path(env["CT_PG_BIN"]) / "psql"), "-X", "-w", "-At",
                   "-h", "127.0.0.1", "-p", "55432", "-U", "localtest",
                   "-d", "postgres", "-c", sql], env)


def require_owned_database(actual, root=ROOT):
    expected = root / ".local" / "pgdata"
    if (root / ".local").is_symlink() or expected.is_symlink():
        raise ValueError("Linked database directories refused.")
    if Path(actual).resolve() != expected.resolve():
        raise ValueError("Port 55432 belongs to another checkout; no takeover or reset performed.")


def preflight(profile):
    validate_environment(os.environ)
    env = dict(os.environ)
    env.update(CT_NODE22_BIN=profile["node22Bin"], CT_PG_BIN=profile["pgBin"],
               CT_CHROMIUM_PATH=profile["chromium"], PGCONNECT_TIMEOUT="5",
               CT_RUNTIME_ENV="local-test", CT_ALLOW_LOCAL_FIXTURES="yes",
               PGHOST="127.0.0.1", PGPORT="55432", PGUSER="localtest")
    env["PATH"] = profile["node24Bin"] + ":" + profile["pgBin"] + ":/usr/bin:/bin"
    versions = {}
    for name, binary, expected in (
        ("backend", Path(profile["node24Bin"]) / "node", "v24.14.1"),
        ("frontend", Path(profile["node22Bin"]) / "node", "v22.23.3"),
        ("postgres", Path(profile["pgBin"]) / "postgres", None),
    ):
        if not binary.is_file() or not os.access(binary, os.X_OK):
            raise ValueError("Missing executable: " + name)
        versions[name] = output([str(binary), "--version"], env)
        matches = versions[name] == expected if expected else bool(re.fullmatch(r"postgres \(PostgreSQL\) 17\.\d+(?:\s.*)?", versions[name]))
        if not matches:
            raise ValueError("Runtime differs from current CI pin: " + name)
    if not Path(profile["chromium"]).is_file() or not os.access(profile["chromium"], os.X_OK):
        raise ValueError("Chromium executable missing.")
    config = Path("/etc/continuum-fixture-priv.conf")
    helper = Path("/usr/local/sbin/continuum-fixture-priv")
    for path in (config, helper):
        metadata = path.lstat()
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != 0 or metadata.st_mode & 0o022:
            raise ValueError("Fixture helper/config ownership or permissions unsafe.")
    if helper.read_bytes() != (ROOT / "tools" / "continuum-fixture-priv.py").read_bytes():
        raise ValueError("Installed fixture helper differs from current source; no reinstall performed.")
    settings = dict(line.split("=", 1) for line in config.read_text().splitlines()
                    if line and not line.startswith("#"))
    fixtures = ROOT / ".local" / "computer-fixtures"
    if fixtures.is_symlink() or settings.get("fixtures") != str(fixtures):
        raise ValueError("Fixture helper is pinned to another checkout. No configuration changed.")
    if settings.get("node") != str(Path(profile["node24Bin"]) / "node"):
        raise ValueError("Fixture helper Node differs from the profile.")
    require_owned_database(database_query("SHOW data_directory", env))
    versions["server"] = database_query("SHOW server_version", env)
    if not re.fullmatch(r"17\.\d+", versions["server"].split()[0]):
        raise ValueError("Fixture server differs from the PostgreSQL 17 policy.")
    # Authentication must work noninteractively; the launcher never starts a server.
    return env, versions


class Lease:
    """Shared by cooperating launches for this Linux user, regardless of worktree."""
    def __init__(self, path=None):
        self.path = path or Path("/tmp") / ("continuum-local-tests-" + str(os.getuid()) + ".lock")

    def __enter__(self):
        fd = os.open(self.path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        self.file = os.fdopen(fd, "r+")
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
            self.file.close()
            raise ValueError("Unsafe local lease file.")
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            self.file.close()
            raise ValueError("Another cooperating local test run holds the lease.") from None
        return self

    def __exit__(self, *_):
        self.file.close()


def source_identity(env):
    return json.loads(output([sys.executable, "tools/canonical-source-digest.py"], env))


def run_child(command, env, log):
    child = subprocess.Popen(command, cwd=ROOT, env=env, stdout=log,
                             stderr=subprocess.STDOUT, start_new_session=True)
    try:
        return child.wait()
    finally:
        if child.poll() is None:
            # Only the process group this launcher created; never a shared database.
            os.killpg(child.pid, signal.SIGTERM)
            try:
                child.wait(timeout=10)
            except subprocess.TimeoutExpired:
                os.killpg(child.pid, signal.SIGKILL)
                child.wait()


def execute(mode, tests, profile):
    with Lease():
        env, versions = preflight(profile)
        clients = database_query("SELECT count(*) FROM pg_stat_activity WHERE backend_type = 'client backend' AND pid <> pg_backend_pid()", env)
        if clients != "0":
            raise ValueError("Fixture server has other client sessions; test run refused.")
        if mode == "canonical":
            if any(os.environ.get(key) != "yes" for key in ("CT_RESET_LOCAL_FIXTURE", "CT_RESET_CONSOLE_FIXTURE")):
                raise ValueError("Canonical requires both explicit CT_RESET_* fixture acknowledgements.")
            commands = [["bash", "tools/run-canonical-tests.sh"]]
        else:
            if not tests or any(not re.fullmatch(r"[a-zA-Z0-9_-]+\.test\.js", test) for test in tests):
                raise ValueError("Focused mode requires dist/tests basenames such as event-envelope.test.js.")
            commands = [["npm", "run", "build"], ["node", "--test", "--test-concurrency=1"] +
                        ["dist/tests/" + test for test in tests]]
        directory = ROOT / ".artifacts" / "local-launcher" / str(time.time_ns())
        for parent in (ROOT / ".artifacts", directory.parent):
            if parent.is_symlink():
                raise ValueError("Linked evidence directory refused.")
        directory.mkdir(parents=True, mode=0o700)
        record = {"mode": mode, "versions": versions,
                  "status": "INCOMPLETE", "databaseLifecycle": "existing owned server retained"}
        status = 130
        try:
            before = record["before"] = source_identity(env)
            record["gitHead"] = output(["git", "rev-parse", "HEAD"], env)
            with (directory / "run.log").open("w") as log:
                for command in commands:
                    status = run_child(command, env, log)
                    if status:
                        break
            record["after"] = source_identity(env)
            if record["after"] != before:
                status = 2
                record["status"] = "SOURCE_CHANGED"
            else:
                record["status"] = "PASS" if status == 0 else "FAIL"
        except KeyboardInterrupt:
            status = 130
            raise
        except Exception:
            status = 2
            raise
        finally:
            record["exitCode"] = status
            (directory / "result.json").write_text(json.dumps(record, indent=2) + "\n")
            print("Private local evidence: " + str(directory))
        return status


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("check", "focused", "canonical"))
    parser.add_argument("--profile", required=True, help="Private JSON file outside the repository")
    parser.add_argument("tests", nargs="*")
    args = parser.parse_intermixed_args()
    try:
        profile = load_profile(args.profile)
        if args.mode == "check":
            _, versions = preflight(profile)
            print(json.dumps({"status": "READY", "versions": versions}, indent=2))
            return 0
        def interrupted(*_):
            raise KeyboardInterrupt
        signal.signal(signal.SIGTERM, interrupted)
        return execute(args.mode, args.tests, profile)
    except (ValueError, OSError, subprocess.TimeoutExpired, json.JSONDecodeError) as error:
        print("Refused: " + str(error), file=sys.stderr)
        return 2
    except KeyboardInterrupt:
        print("Interrupted; shared services were not stopped.", file=sys.stderr)
        return 130


if __name__ == "__main__":
    sys.exit(main())
