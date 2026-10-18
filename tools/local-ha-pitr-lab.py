# Opt-in parent orchestration for the separately reviewed closed profile probe.
# Defining this prefix does not start PostgreSQL, acquire a lease, or read a
# private profile. The original no-argument generic lab remains below verbatim.
# Implementation is not execution authorization; a future authorized parent
# must explicitly acknowledge the new mode and use the configured canonical root.
import hashlib as _pn_hashlib
import importlib.util as _pn_importlib
import json as _pn_json_module
import os as _pn_os
from pathlib import Path as _PnPath
import re as _pn_re
import shlex as _pn_shlex
import shutil as _pn_shutil
import signal as _pn_signal
import socket as _pn_socket
import stat as _pn_stat
import subprocess as _pn_subprocess
import sys as _pn_sys
import time as _pn_time
import uuid as _pn_uuid


class ProfileNativeRefusal(Exception):
    """Constant local-fixture failure codes, never private exception contents."""


_PN_PORTS = (55440, 55441, 55442)
_PN_MIGRATIONS = (
    "001-foundation.sql", "002-lock-privileges.sql",
    "004-monotonic-fences.sql", "005-identity-authority.sql",
    "006-product-computers.sql", "007-context-artifacts.sql",
    "008-recovery-controls.sql", "009-runtime-trigger-permissions.sql",
    "010-resource-controls.sql", "011-console-domain.sql",
    "012-tenant-identity-fks.sql", "016-placement-generation.sql",
    "021-vera-profiles.sql",
)
_PN_EMPTY_DIGEST = _pn_hashlib.sha256(b"[]").hexdigest()
_PN_VERA_HASH = "296b720552850723745420cde99c633a8cc88340843ea6915ecce60a4d183dec"
_PN_PROFILE_HASH = "28ead8dbb329a2430ad430111f51a7d100d72c94df50e0dc9db4315a9a72e26a"
_PN_PHASES = {
    "seed-s0": ("S0", "primary", 55440),
    "source-s1": ("S1", "primary", 55440),
    "source-s2": ("S2", "primary", 55440),
    "read-s0": ("S0", "restored", 55442),
    "close-s0": ("S0", "restored", 55442),
    "read-s1": ("S1", "restored", 55442),
    "close-s1": ("S1", "restored", 55442),
    "read-s2": ("S2", "standby", 55441),
    "close-s2": ("S2", "standby", 55441),
}
_PN_OVERRIDE_KEYS = (
    "WORKOS_API_KEY", "WORKOS_CLIENT_ID", "WORKOS_COOKIE_PASSWORD",
    "DATABASE_URL", "CT_DATABASE_URL", "CT_PRODUCTION_CONFIG",
    "CT_STAGING_CONFIG", "PGPASSWORD", "PGPASSFILE", "PGSERVICE",
    "PGSERVICEFILE", "PGHOSTADDR", "PGOPTIONS", "PGSSLCERT", "PGSSLKEY",
    "PGSSLROOTCERT", "PGDATABASE", "CT_DATABASE",
)


def _pn_require(condition, code):
    if not condition:
        raise ProfileNativeRefusal(code)


def _pn_arguments(arguments):
    if not arguments:
        return None
    _pn_require(arguments == ["profile-native-closed"], "UNSUPPORTED_LAB_ARGUMENTS")
    return "profile-native-closed"


def _pn_environment(environment):
    _pn_require(environment.get("CT_LOCAL_DR_LAB") == "yes", "LOCAL_LAB_ACK_REQUIRED")
    _pn_require(environment.get("CT_PROFILE_NATIVE_EXECUTION_AUTHORIZED") == "yes",
                "SEPARATE_NATIVE_EXECUTION_AUTHORIZATION_REQUIRED")
    _pn_require(environment.get("CT_RUNTIME_ENV") == "local-test"
                and environment.get("CT_ALLOW_LOCAL_FIXTURES") == "yes",
                "ISOLATED_FIXTURE_REQUIRED")
    _pn_require(environment.get("NODE_ENV") != "production", "PRODUCTION_REFUSED")
    for key in _PN_OVERRIDE_KEYS:
        _pn_require(not environment.get(key), "NATIVE_CONNECTION_OVERRIDE_REFUSED")
    for key, value in (("PGHOST", "127.0.0.1"), ("PGPORT", "55432"),
                       ("PGUSER", "localtest"), ("PGSSLMODE", "disable"),
                       ("CT_DEPLOYMENT_ENV", "local-test"),
                       ("CT_CONSOLE_MODE", "LOCAL_FIXTURE")):
        _pn_require(environment.get(key, value) == value, "CONFLICTING_FIXTURE_SETTING")


def _pn_hash_bytes(value):
    return _pn_hashlib.sha256(value).hexdigest()


def _pn_canonical(value):
    return _pn_json_module.dumps(value, sort_keys=True, separators=(",", ":"),
                                ensure_ascii=False, allow_nan=False).encode("utf-8")


def _pn_hash_file(filename):
    digest = _pn_hashlib.sha256()
    fd = _pn_os.open(filename, _pn_os.O_RDONLY | _pn_os.O_NOFOLLOW)
    with _pn_os.fdopen(fd, "rb") as incoming:
        before = _pn_os.fstat(incoming.fileno())
        _pn_require(_pn_stat.S_ISREG(before.st_mode) and not before.st_mode & 0o022,
                    "UNSAFE_SEALED_FILE")
        for block in iter(lambda: incoming.read(1024 * 1024), b""):
            digest.update(block)
        after = _pn_os.fstat(incoming.fileno())
        _pn_require((before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns)
                    == (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns),
                    "FILE_CHANGED_DURING_SEAL")
    return digest.hexdigest()


def _pn_owned(root, filename, directory=None):
    """Check every existing descendant; never follow an owned-looking symlink."""
    filename = _PnPath(filename)
    _pn_require(filename.is_absolute(), "ABSOLUTE_OWNED_PATH_REQUIRED")
    try:
        relative = filename.relative_to(root)
    except ValueError:
        raise ProfileNativeRefusal("PATH_OUTSIDE_CANONICAL_ROOT") from None
    current = root
    for part in (None, *relative.parts):
        if part is not None:
            current = current / part
        metadata = current.lstat()
        _pn_require(not _pn_stat.S_ISLNK(metadata.st_mode), "SYMLINK_REFUSED")
        _pn_require(metadata.st_uid == _pn_os.getuid()
                    and not metadata.st_mode & 0o022, "UNSAFE_PATH_OWNERSHIP")
        if current != filename or directory is True:
            _pn_require(_pn_stat.S_ISDIR(metadata.st_mode), "OWNED_DIRECTORY_REQUIRED")
        elif directory is False:
            _pn_require(_pn_stat.S_ISREG(metadata.st_mode), "ORDINARY_FILE_REQUIRED")
    return filename


def _pn_directory(root, filename):
    if filename.exists() or filename.is_symlink():
        return _pn_owned(root, filename, True)
    _pn_directory(root, filename.parent)
    filename.mkdir(mode=0o700)
    return _pn_owned(root, filename, True)


def _pn_new_file(root, filename, content):
    _pn_owned(root, filename.parent, True)
    fd = _pn_os.open(filename, _pn_os.O_WRONLY | _pn_os.O_CREAT
                     | _pn_os.O_EXCL | _pn_os.O_NOFOLLOW, 0o600)
    with _pn_os.fdopen(fd, "wb") as output:
        output.write(content)
        output.flush()
        _pn_os.fsync(output.fileno())
    _pn_owned(root, filename, False)


def _pn_new_json(root, filename, value):
    _pn_new_file(root, filename, _pn_canonical(value) + b"\n")


def _pn_tree(root, directory):
    _pn_owned(root, directory, True)
    entries = []
    for filename in sorted(directory.rglob("*")):
        metadata = filename.lstat()
        _pn_require(not _pn_stat.S_ISLNK(metadata.st_mode), "TREE_SYMLINK_REFUSED")
        if _pn_stat.S_ISDIR(metadata.st_mode):
            _pn_owned(root, filename, True)
        else:
            _pn_owned(root, filename, False)
            entries.append({"path": str(filename.relative_to(directory)),
                            "bytes": metadata.st_size, "sha256": _pn_hash_file(filename)})
    return {"entries": entries, "sha256": _pn_hash_bytes(_pn_canonical(entries))}


def _pn_fence(value, close=False):
    _pn_require(isinstance(value, dict)
                and set(value) == {"revision", "fence", "blocked", "authorityDigest"},
                "FENCE_SHAPE")
    revision = value["revision"]
    _pn_require(type(revision) is int and 0 < revision < 9007199254740991,
                "FENCE_REVISION")
    _pn_require(isinstance(value["fence"], str)
                and _pn_re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}", value["fence"]),
                "FENCE_IDENTIFIER")
    _pn_require(type(value["blocked"]) is bool
                and value["authorityDigest"] == _PN_EMPTY_DIGEST, "FENCE_BINDING")
    if close:
        _pn_require(value["blocked"] and revision + 1 < 9007199254740991,
                    "RECOVERY_FENCE_HEADROOM_REQUIRED")
    return {**value, "revision": str(revision)}


def _pn_lsn(value):
    _pn_require(isinstance(value, str)
                and _pn_re.fullmatch(r"[0-9A-F]{1,8}/[0-9A-F]{1,8}", value), "WAL_LSN")
    high, low = value.split("/")
    return (int(high, 16) << 32) + int(low, 16)


def _pn_wal_names(first, last, segment_bytes, timeline):
    _pn_require(type(segment_bytes) is int and segment_bytes >= 1024 * 1024
                and segment_bytes <= 1024 * 1024 * 1024
                and segment_bytes & (segment_bytes - 1) == 0, "WAL_SEGMENT_SIZE")
    _pn_require(isinstance(timeline, str) and _pn_re.fullmatch(r"[1-9][0-9]*", timeline)
                and int(timeline) <= 0xffffffff, "SOURCE_TIMELINE")
    start, finish = _pn_lsn(first), _pn_lsn(last)
    _pn_require(start <= finish, "ORDERED_WAL_RANGE")
    begin, end = start // segment_bytes, max(start, finish - 1) // segment_bytes
    _pn_require(end - begin < 4096, "LOCAL_WAL_RANGE_EXCESS")
    per_log = (1 << 32) // segment_bytes
    return [f"{int(timeline):08X}{number // per_log:08X}{number % per_log:08X}"
            for number in range(begin, end + 1)]


def _pn_proc_identity(pid):
    process = _PnPath("/proc") / str(pid)
    metadata = process.stat()
    fields = (process / "stat").read_text().rsplit(")", 1)[1].split()
    return {"pid": pid, "parentPid": int(fields[1]), "uid": metadata.st_uid, "startTicks": fields[19],
            "executable": str((process / "exe").resolve()),
            "command": (process / "cmdline").read_bytes().split(b"\0")[:-1]}


def _pn_group_members(group_id):
    """Live members of one freshly created session/group; never a port scan."""
    members = []
    for process in _PnPath("/proc").iterdir():
        if not process.name.isdecimal():
            continue
        try:
            fields = (process / "stat").read_text().rsplit(")", 1)[1].split()
            if int(fields[2]) != group_id or fields[0] == "Z":
                continue
            members.append({
                "pid": int(process.name), "parentPid": int(fields[1]),
                "groupId": int(fields[2]), "sessionId": int(fields[3]),
                "uid": process.stat().st_uid, "startTicks": fields[19],
                "state": fields[0],
            })
        except (FileNotFoundError, ProcessLookupError):
            continue  # A disappearing process is not adopted or signalled.
    return members


class _ProfileNativeCancellationSignals:
    """Defer cooperative cancellation; never inherit a new ignore/block in exec.

    Caught handlers reset to default on exec, as the prior caught handlers did.
    An already ignored disposition stays ignored. This flag-based handler spans
    the actual Lease's resource lifetime, so cancellation cannot jump over an
    acquisition, mask-entry, or ownership-retention finalizer. Checks occur only
    where a successful spawn is already represented in the ownership registry.
    This does not contain hostile code, SIGKILL, host loss, or arbitrary faults.
    """
    def __init__(self):
        self.pending, self.previous, self.installed = False, {}, []

    def defer(self, *_):
        self.pending = True

    def check(self):
        if self.pending:
            raise KeyboardInterrupt

    def __enter__(self):
        self.previous = {signal: _pn_signal.getsignal(signal)
                         for signal in (_pn_signal.SIGINT, _pn_signal.SIGTERM)}
        try:
            for signal, previous in self.previous.items():
                if previous != _pn_signal.SIG_IGN:
                    _pn_signal.signal(signal, self.defer)
                    self.installed.append(signal)
        except BaseException:
            for signal in self.installed:
                try:
                    _pn_signal.signal(signal, self.previous[signal])
                except BaseException:
                    pass
            raise  # No spawn is allowed until acquisition-mask entry succeeds.
        return self

    def __exit__(self, kind, error, _):
        restoration = None
        for signal in self.installed:
            try:
                _pn_signal.signal(signal, self.previous[signal])
            except BaseException as failure:
                restoration = failure
        if restoration is not None:
            if error is not None:
                error.add_note("CANCELLATION_HANDLER_RESTORATION_FAILED")
            else:
                raise restoration


class _ProfileNativeCleanupSignals:
    """Mask repeated cooperative interrupts while draining owned resources."""
    def __enter__(self):
        self.previous = {signal: _pn_signal.getsignal(signal)
                         for signal in (_pn_signal.SIGINT, _pn_signal.SIGTERM)}
        for signal in self.previous:
            _pn_signal.signal(signal, _pn_signal.SIG_IGN)
        return self

    def __exit__(self, *_):
        for signal, previous in self.previous.items():
            _pn_signal.signal(signal, previous)


class _ProfileNativeCommandGroup:
    """A direct Popen/start_new_session group tracked until observed quiescent.

    A live session/group retains its kernel ID after the direct leader exits.
    Do not drop that provenance merely because Popen.poll() reaps the leader.
    Completed groups are never inspected or adopted again (including PID reuse).
    This is trusted cooperative command cleanup, not hostile-process containment.
    """
    def __init__(self, process, arguments, label):
        self.process, self.arguments, self.label = process, arguments, label
        self.start_ticks, self.drained = None, process is None

    def capture(self):
        _pn_require(self.process.pid > 1 and self.process.args == self.arguments,
                    "DIRECT_COMMAND_GROUP_REQUIRED")
        if self.process.poll() is not None:
            return
        try:
            identity = _pn_proc_identity(self.process.pid)
        except (FileNotFoundError, ProcessLookupError):
            _pn_require(self.process.poll() is not None, "OWNED_COMMAND_IDENTITY_UNAVAILABLE")
            return
        _pn_require(identity["pid"] == self.process.pid
                    and identity["parentPid"] == _pn_os.getpid()
                    and identity["uid"] == _pn_os.getuid(), "DIRECT_COMMAND_PROCESS_IDENTITY")
        self.start_ticks = identity["startTicks"]

    def members(self):
        if self.drained:
            return []
        _pn_require(self.process.pid > 1 and self.process.args == self.arguments,
                    "DIRECT_COMMAND_GROUP_REQUIRED")
        members = _pn_group_members(self.process.pid)
        _pn_require(all(member["groupId"] == self.process.pid
                        and member["sessionId"] == self.process.pid
                        and member["uid"] == _pn_os.getuid()
                        and (self.start_ticks is None
                             or int(member["startTicks"]) >= int(self.start_ticks))
                        for member in members),
                    "OWNED_COMMAND_GROUP_IDENTITY")
        leader = next((member for member in members
                       if member["pid"] == self.process.pid), None)
        if leader:
            _pn_require(self.process.poll() is None
                        and leader["parentPid"] == _pn_os.getpid()
                        and (self.start_ticks is None
                             or leader["startTicks"] == self.start_ticks),
                        "OWNED_COMMAND_LEADER_REPLACED")
            self.start_ticks = leader["startTicks"]
        elif members:
            _pn_require(self.process.poll() is not None,
                        "OWNED_COMMAND_LEADER_NOT_CONFIRMED")
        if not members and self.process.poll() is not None:
            self.drained = True
        return members

    def quiet(self):
        self.members()
        return self.drained

    def signal(self, signal):
        if self.members():
            try:
                _pn_os.killpg(self.process.pid, signal)
            except ProcessLookupError:
                pass  # It exited between positive inspection and the signal.


class _ProfileNativeServer:
    """A foreground postmaster launched by this parent, never a port/PID adoption."""
    def __init__(self, process, directory, port, executable, arguments, log):
        self.process = process
        self.directory, self.port, self.executable = directory, port, executable
        self.arguments, self.log = arguments, log
        self.identity = None
        self.cluster = None
        self.stopped = process is None

    def capture_identity(self):
        _pn_require(self.process.poll() is None
                    and self.process.args == [str(x) for x in self.arguments],
                    "DIRECT_POSTMASTER_CHILD_REQUIRED")
        identity = _pn_proc_identity(self.process.pid)
        _pn_require(identity["parentPid"] == _pn_os.getpid()
                    and identity["uid"] == _pn_os.getuid()
                    and identity["executable"] == str(self.executable.resolve()),
                    "STARTED_POSTMASTER_IDENTITY")
        self.identity = identity

    def assert_process(self, root, require_pidfile=True):
        _pn_owned(root, self.directory, True)
        _pn_require(not self.stopped and self.process.poll() is None, "OWNED_SERVER_LOST")
        if self.identity is None:
            self.capture_identity()
        actual = _pn_proc_identity(self.process.pid)
        # PostgreSQL may rewrite process-title bytes. Stable PID/start/PPID/UID/
        # executable plus the native data-directory/start/system-ID bindings
        # matter; a mutable command title is not the ownership oracle.
        stable = ("pid", "parentPid", "uid", "startTicks", "executable")
        _pn_require(all(actual[key] == self.identity[key] for key in stable),
                    "POSTMASTER_PROCESS_IDENTITY")
        pidfile = self.directory / "postmaster.pid"
        if require_pidfile or pidfile.exists() or pidfile.is_symlink():
            _pn_owned(root, pidfile, False)
            _pn_require(pidfile.read_text().splitlines()[0] == str(self.process.pid),
                        "POSTMASTER_PID_BINDING")


class _ProfileNativeRun:
    """Trusted, cooperative, local-only orchestration; not a containment boundary."""
    def __init__(self, root, launcher, profile, environment, versions, lease):
        self.root, self.launcher, self.profile = root, launcher, profile
        self.environment, self.versions, self.lease = environment, versions, lease
        self.base = root / ".local" / "dr-lab"
        self.run_id, self.lease_id, self.orchestration_id = (
            str(_pn_uuid.uuid4()), str(_pn_uuid.uuid4()), str(_pn_uuid.uuid4()))
        self.out = root / ".artifacts/implementation/dr-lab/profile-native" / self.run_id
        self.servers, self.command_number, self.manifest_hash = [], 0, None
        self.command_groups, self.evidence_seals = [], {}
        self.ownership_handoff_written = False
        self.cancellation, self.cleaning_up = None, False
        self.source_identity, self.runtime_seal, self.input_seals = None, None, {}
        self.sender_identity = None
        self.code, self.mirror_hash, self.source_fence = None, None, str(_pn_uuid.uuid4())
        self.result = {
            "kind": "profile-native-orchestration-result/v0.1",
            "scope": "LOCAL_PROFILE_NATIVE_FIXTURE_ONLY", "runId": self.run_id,
            "status": "INCOMPLETE", "cases": [], "phases": [],
            "nativeQualification": "NOT CLAIMED", "activated": False,
            "gates": {"production": "BLOCKED", "scheduler": "HELD", "canary": "NO-GO"},
        }
        self.node = _PnPath(profile["node24Bin"]) / "node"
        self.pg = _PnPath(profile["pgBin"])

    def write(self, name, value):
        _pn_require(_pn_re.fullmatch(r"[A-Za-z0-9._-]+\.json", name), "OUTPUT_NAME")
        _pn_new_json(self.root, self.out / name, value)

    def check_cancel(self):
        cancellation = getattr(self, "cancellation", None)
        if cancellation is not None and not getattr(self, "cleaning_up", False):
            cancellation.check()

    def check_acquisition_cancel(self, acquisition):
        if not getattr(self, "cleaning_up", False):
            acquisition.check()

    def drain_command(self, group, output=b""):
        # Registry insertion precedes inspection/communication. Only the direct
        # group's positively bound members may be signalled, even after its
        # leader exited. An incomplete drain remains owned under the same Lease.
        with _ProfileNativeCleanupSignals():
            for signal in (_pn_signal.SIGTERM, _pn_signal.SIGKILL):
                try:
                    group.signal(signal)
                except BaseException:
                    pass  # Unconfirmed ownership never becomes permission to kill.
                for _ in range(3):
                    try:
                        output, _ = group.process.communicate(timeout=10)
                        break
                    except _pn_subprocess.TimeoutExpired as error:
                        if isinstance(error.output, bytes):
                            output = error.output
                        break
                    except KeyboardInterrupt:
                        continue  # Also preserves the primary in mock error paths.
                    except BaseException:
                        break
                try:
                    if group.quiet():
                        return output, True
                except BaseException:
                    pass
        return output, False

    def command(self, arguments, environment=None, timeout=120):
        self.command_number += 1
        label = f"{self.command_number:04d}"
        arguments = [str(x) for x in arguments]
        self.write(label + "-command.json", {"arguments": arguments,
                   "scope": "SYNTHETIC_LOCAL_FIXTURE", "environmentValuesLogged": False})
        # Pre-register the acquisition slot before any child can exist. A failed
        # spawn stays drained; successful Popen linkage cannot be cancelled away.
        group = _ProfileNativeCommandGroup(None, arguments, label)
        self.command_groups.append(group)
        child, interrupted, timed_out, output, drained = None, None, False, b"", True
        try:
            self.check_cancel()
            with _ProfileNativeCancellationSignals() as acquisition:
                child = _pn_subprocess.Popen(
                    arguments, cwd=self.root, env=environment or self.environment,
                    stdout=_pn_subprocess.PIPE, stderr=_pn_subprocess.STDOUT,
                    start_new_session=True, restore_signals=True)
                group.process, group.drained = child, False
                self.check_acquisition_cancel(acquisition)
            # Restoration may receive a late signal on the temporary handler.
            self.check_acquisition_cancel(acquisition)
            self.check_cancel()
            group.capture()
            output, _ = child.communicate(timeout=timeout)
            self.check_cancel()
            drained = group.quiet()
            _pn_require(drained, "OWNED_COMMAND_DESCENDANTS_REMAIN")
        except BaseException as error:
            interrupted = error
            timed_out = isinstance(error, _pn_subprocess.TimeoutExpired)
            try:
                if group.process is not None:
                    output, drained = self.drain_command(group, output)
            except BaseException:
                # A second interrupt even at signal-handler restoration cannot
                # replace the primary or discard this registered group's hold.
                interrupted.add_note("OWNED_COMMAND_DRAIN_INTERRUPTED")
                try:
                    drained = group.quiet()
                except BaseException:
                    drained = False
        try:
            _pn_new_file(self.root, self.out / (label + ".log"), output)
            self.write(label + "-exit.json", {
                "exit": child.returncode if child is not None else None, "timeout": timed_out,
                "interrupted": interrupted is not None, "drained": drained,
                "drainFailure": None if drained else "OWNED_COMMAND_DRAIN_INCOMPLETE",
            })
        except Exception:
            if interrupted is None:
                raise ProfileNativeRefusal("OWNED_COMMAND_EVIDENCE_WRITE_FAILED") from None
            interrupted.add_note("OWNED_COMMAND_EVIDENCE_WRITE_FAILED")
        if interrupted:
            if timed_out:
                raise ProfileNativeRefusal("OWNED_COMMAND_TIMEOUT") from None
            raise interrupted
        _pn_require(child.returncode == 0, "OWNED_COMMAND_FAILED")
        return output.decode("utf-8", errors="strict").strip()

    def pg_command(self, name, arguments, timeout=120):
        _pn_require(name in {"initdb", "createdb", "psql", "pg_basebackup",
                            "pg_verifybackup"}, "NATIVE_TOOL_ALLOWLIST")
        return self.command([self.pg / name, *arguments], timeout=timeout)

    def sql(self, server, statement, database="ct_dr"):
        _pn_require(server in self.servers and database in {"ct_dr", "postgres"},
                    "OWNED_SQL_TARGET")
        server.assert_process(self.root)
        return self.pg_command("psql", ["-X", "-w", "-qAt", "-v", "ON_ERROR_STOP=1",
                    "-h", "127.0.0.1", "-p", server.port, "-U", "localtest",
                    "-d", database, "-c", statement])

    def wait(self, condition, timeout=45):
        end = _pn_time.monotonic() + timeout
        while _pn_time.monotonic() < end:
            self.check_cancel()
            if condition():
                return
            _pn_time.sleep(.15)
        raise ProfileNativeRefusal("NATIVE_CONDITION_TIMEOUT")

    def lease_guard(self):
        _pn_require(not self.lease.file.closed, "PARENT_LEASE_LOST")
        opened = _pn_os.fstat(self.lease.file.fileno())
        actual = self.lease.path.lstat()
        _pn_require((opened.st_dev, opened.st_ino) == (actual.st_dev, actual.st_ino)
                    and opened.st_uid == _pn_os.getuid()
                    and _pn_stat.S_ISREG(opened.st_mode)
                    and not opened.st_mode & 0o077, "SHARED_LEASE_FILE_CHANGED")
        # The parent retains the actual original flock descriptor throughout.
        # Mirror/PPID/hash agreement is only a cooperative attestation.

    def source_guard(self):
        self.lease_guard()
        _pn_require(self.command(["git", "status", "--porcelain"]) == "",
                    "TRACKED_OR_UNTRACKED_SOURCE_CHANGED")
        current = _pn_json_module.loads(self.command(
            [_pn_sys.executable, "tools/canonical-source-digest.py"]))
        _pn_require(current == self.source_identity, "IMPLEMENTED_SOURCE_CHANGED")
        _pn_require(self.runtime_inventory() == self.runtime_seal, "SEALED_RUNTIME_CHANGED")

    def runtime_inventory(self):
        emitted = _pn_tree(self.root, self.root / "dist")
        # Seal all installed runtime code/data, not just package-version labels.
        # Bin symlinks are build entry points, not imported fallback implementations.
        directory = self.root / "node_modules"
        _pn_owned(self.root, directory, True)
        entries = []
        for filename in sorted(directory.rglob("*")):
            if ".bin" in filename.relative_to(directory).parts:
                continue
            metadata = filename.lstat()
            _pn_require(not _pn_stat.S_ISLNK(metadata.st_mode), "DEPENDENCY_SYMLINK_REFUSED")
            if _pn_stat.S_ISREG(metadata.st_mode):
                _pn_owned(self.root, filename, False)
                entries.append({"path": str(filename.relative_to(directory)),
                                "bytes": metadata.st_size, "sha256": _pn_hash_file(filename)})
            elif not _pn_stat.S_ISDIR(metadata.st_mode):
                raise ProfileNativeRefusal("UNEXPECTED_DEPENDENCY_SURFACE")
        return {"emitted": emitted, "dependencies": entries,
                "dependencyDigest": _pn_hash_bytes(_pn_canonical(entries)),
                "nodeExecutableSha256": _pn_hash_file(self.node.resolve()),
                "pythonExecutableSha256": _pn_hash_file(_PnPath(_pn_sys.executable).resolve()),
                "postgresTools": {name: _pn_hash_file((self.pg / name).resolve()) for name in
                                  ("postgres", "initdb", "createdb", "psql",
                                   "pg_basebackup", "pg_verifybackup")}}

    def prepare(self):
        _pn_require(not self.base.exists() and not self.base.is_symlink(),
                    "EXISTING_LAB_REFUSED_NO_RESET_OR_ADOPTION")
        for port in _PN_PORTS:
            with _pn_socket.socket(_pn_socket.AF_INET, _pn_socket.SOCK_STREAM) as socket:
                try:
                    socket.bind(("127.0.0.1", port))
                except OSError:
                    raise ProfileNativeRefusal("OCCUPIED_NATIVE_PORT") from None
        _pn_directory(self.root, self.out.parent)
        self.out.mkdir(mode=0o700)
        _pn_owned(self.root, self.out, True)
        _pn_directory(self.root, self.base.parent)
        self.base.mkdir(mode=0o700)
        for name in ("wal", "sealed-wal", "independent", "empty-home", "temporary"):
            _pn_directory(self.root, self.base / name)
        _pn_new_file(self.root, self.base / "empty-pgpass", b"")
        # Do not pass ambient credentials or consult the user's home password files.
        self.environment = {
            "PATH": self.environment["PATH"], "LANG": "C.UTF-8", "TZ": "UTC",
            "HOME": str(self.base / "empty-home"), "TMPDIR": str(self.base / "temporary"),
            "PGHOST": "127.0.0.1", "PGUSER": "localtest", "PGSSLMODE": "disable",
            "PGPASSFILE": str(self.base / "empty-pgpass"), "PGCONNECT_TIMEOUT": "5",
            "PGCLIENTENCODING": "UTF8", "PGAPPNAME": "ct_profile_native_parent",
            "CT_RUNTIME_ENV": "local-test", "CT_DEPLOYMENT_ENV": "local-test",
            "CT_CONSOLE_MODE": "LOCAL_FIXTURE", "CT_ALLOW_LOCAL_FIXTURES": "yes",
            "CT_LOCAL_DR_LAB": "yes",
        }
        _pn_require(self.command(["git", "status", "--porcelain"]) == "",
                    "CLEAN_REVIEWED_ROOT_REQUIRED")
        self.source_identity = _pn_json_module.loads(self.command(
            [_pn_sys.executable, "tools/canonical-source-digest.py"]))
        commit = self.command(["git", "rev-parse", "HEAD"])
        tree = self.command(["git", "rev-parse", "HEAD^{tree}"])
        _pn_require(_pn_re.fullmatch(r"[0-9a-f]{40}", commit)
                    and _pn_re.fullmatch(r"[0-9a-f]{40}", tree), "CODE_PIN")
        compiler = self.root / "node_modules/typescript/bin/tsc"
        _pn_owned(self.root, compiler, False)
        tool_versions = {}
        for name in ("postgres", "initdb", "createdb", "psql", "pg_basebackup", "pg_verifybackup"):
            tool_versions[name] = self.command([self.pg / name, "--version"])
            _pn_require(_pn_re.fullmatch(
                _pn_re.escape(name) + r" \(PostgreSQL\) 17\.[0-9]+(?:\s.*)?",
                tool_versions[name]), "NATIVE_PG17_TOOL_REQUIRED")
        self.versions = {**self.versions, "nativeTools": tool_versions}
        self.command([self.node, compiler, "--project", "tsconfig.json",
                      "--incremental", "false", "--pretty", "false"])
        self.runtime_seal = self.runtime_inventory()
        _pn_require(_pn_hash_file(self.root / "src/regency/vera-service.ts") == _PN_VERA_HASH
                    and _pn_hash_file(self.root / "migrations/021-vera-profiles.sql")
                    == _PN_PROFILE_HASH, "FROZEN_PROFILE_CONTRACT")
        self.code = {
            "commit": commit, "tree": tree,
            "probeSourceSha256": _pn_hash_file(self.root / "tests/dr-vera-profile-probe.ts"),
            "probeRuntimeSha256": _pn_hash_file(self.root / "dist/tests/dr-vera-profile-probe.js"),
            "nodeVersion": "24.14.1", "runtimeEnvironment": "local-test",
            "probeMode": "profile-native-closed/v0.1",
        }
        self.orchestration = {
            "kind": "local-ha-pitr-lab/profile-native-closed/v0.1",
            "id": self.orchestration_id, "runId": self.run_id,
            "launcherPid": str(_pn_os.getpid()), "active": True,
        }
        mirror = {
            "kind": "profile-native-shared-lease/v0.1", "runId": self.run_id,
            "leaseId": self.lease_id, "root": str(self.root),
            "ownerUid": str(_pn_os.getuid()), "active": True, "database": "ct_dr",
            "ports": list(_PN_PORTS), "commit": commit, "tree": tree,
            "orchestration": self.orchestration,
        }
        _pn_new_json(self.root, self.base / "profile-native-lease.json", mirror)
        self.mirror_hash = _pn_hash_file(self.base / "profile-native-lease.json")
        _pn_new_json(self.root, self.base / "independent/authority-journal.json", [])
        self.write("source-and-runtime-seals.json", {
            "code": self.code, "source": self.source_identity,
            "runtime": self.runtime_seal, "versions": self.versions,
            "migrationHashes": {name: _pn_hash_file(self.root / "migrations" / name)
                                for name in _PN_MIGRATIONS},
            "leaseMirrorSha256": self.mirror_hash,
            "attestationIsNotLeaseOrOperatorAuthority": True,
        })

    def append_configuration(self, directory, configuration):
        _pn_owned(self.root, directory, True)
        filename = directory / "postgresql.conf"
        _pn_owned(self.root, filename, False)
        with filename.open("a", encoding="utf-8") as output:
            output.write("\n" + configuration + "\n")
            output.flush()
            _pn_os.fsync(output.fileno())

    def start(self, directory, port):
        _pn_require(port in _PN_PORTS
                    and directory == self.base / {55440: "primary", 55441: "standby",
                                                  55442: "restored"}[port], "FIXED_SERVER_SLOT")
        _pn_owned(self.root, directory, True)
        socket_directory = self.base / ("socket-" + str(port))
        _pn_directory(self.root, socket_directory)
        log_filename = directory / "profile-native-server.log"
        _pn_new_file(self.root, log_filename, b"")
        log = log_filename.open("ab")
        arguments = [self.pg / "postgres", "-D", directory, "-p", port,
                     "-h", "127.0.0.1", "-k", socket_directory]
        server = _ProfileNativeServer(None, directory, port,
                                      self.pg / "postgres", arguments, log)
        self.servers.append(server)
        try:
            self.check_cancel()
            with _ProfileNativeCancellationSignals() as acquisition:
                process = _pn_subprocess.Popen(
                    [str(x) for x in arguments], cwd=self.root, env=self.environment,
                    stdout=log, stderr=_pn_subprocess.STDOUT,
                    start_new_session=True, restore_signals=True)
                server.process, server.stopped = process, False
                self.check_acquisition_cancel(acquisition)
            self.check_acquisition_cancel(acquisition)
            self.check_cancel()
            # The linked direct Popen is the ownership anchor even if readiness
            # never arrives; no pg_ctl/PID-file/port adoption or foreign killing.
            server.capture_identity()
            self.wait(lambda: self.server_ready(server))
            server.cluster = self.server_cluster(server)
        except BaseException:
            if server.stopped:  # Popen failed; there is no owned live postmaster.
                log.close()
            raise
        self.write(f"server-{port}-{len(self.servers)}.json", {
            "pid": str(process.pid), "startTicks": server.identity["startTicks"],
            "uid": str(server.identity["uid"]), "directory": str(directory),
            "port": port, "executable": server.identity["executable"],
            "cluster": server.cluster, "startedByThisRun": True,
        })
        return server

    def server_ready(self, server):
        _pn_require(server.process.poll() is None, "OWNED_SERVER_START_FAILED")
        if not (server.directory / "postmaster.pid").exists():
            return False
        server.assert_process(self.root)
        try:
            return self.sql(server, "SELECT 1", "postgres") == "1"
        except ProfileNativeRefusal as error:
            if str(error) != "OWNED_COMMAND_FAILED":
                raise
            return False

    def server_cluster(self, server):
        raw = self.sql(server, "SELECT json_build_object("
            "'systemIdentifier',(pg_control_system()).system_identifier::text,"
            "'postmasterStart',pg_postmaster_start_time()::text,"
            "'directory',current_setting('data_directory'),"
            "'port',inet_server_port()::text,'address',host(inet_server_addr()),"
            "'database',current_database(),'actor',session_user,"
            "'version',current_setting('server_version_num'))::text", "postgres")
        cluster = _pn_json_module.loads(raw)
        _pn_require(cluster["directory"] == str(server.directory)
                    and cluster["port"] == str(server.port)
                    and cluster["address"] == "127.0.0.1"
                    and cluster["database"] == "postgres" and cluster["actor"] == "localtest"
                    and _pn_re.fullmatch(r"17[0-9]{4}", cluster["version"])
                    and _pn_re.fullmatch(r"[1-9][0-9]*", cluster["systemIdentifier"])
                    and int(cluster["systemIdentifier"]) <= 18446744073709551615
                    and _pn_re.fullmatch(
                        r"\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,6})?\+00",
                        cluster["postmasterStart"]), "NATIVE_PG17_SERVER_BINDING")
        if server.cluster:
            _pn_require(cluster == server.cluster, "OWNED_CLUSTER_REPLACED")
        return cluster

    def clients(self, server, allow_sender=False):
        raw = self.sql(server, "SELECT coalesce(json_agg(x),'[]'::json)::text FROM ("
            "SELECT pid::text,backend_start::text AS \"backendStart\",backend_type,"
            "datname,usename,application_name,host(client_addr) AS address "
            "FROM pg_stat_activity WHERE backend_type IN('client backend','walsender') "
            "AND pid<>pg_backend_pid() ORDER BY pid) x", "postgres")
        rows = _pn_json_module.loads(raw)
        if not rows:
            return None
        _pn_require(allow_sender and len(rows) == 1 and rows[0]["backend_type"] == "walsender"
                    and rows[0]["datname"] is None and rows[0]["usename"] == "localtest"
                    and rows[0]["application_name"] == "ct_local_standby"
                    and rows[0]["address"] == "127.0.0.1", "UNKNOWN_NATIVE_CLIENT")
        _pn_require(_pn_re.fullmatch(r"[1-9][0-9]*", rows[0]["pid"]), "OWNED_SENDER_PID")
        sender = {"pid": rows[0]["pid"], "backendStart": rows[0]["backendStart"]}
        if self.sender_identity is not None:
            _pn_require(sender == self.sender_identity, "OWNED_SENDER_RECONNECTED")
        return sender

    def bind_sender(self, primary, standby):
        """Bind the sender to an actual receiver child/socket of OUR postmaster."""
        primary.assert_process(self.root)
        standby.assert_process(self.root)
        raw = self.sql(standby, "SELECT coalesce(json_agg(x),'[]'::json)::text FROM ("
            "SELECT pid::text,status,sender_host,sender_port::text "
            "FROM pg_stat_wal_receiver) x", "postgres")
        receivers = _pn_json_module.loads(raw)
        if not receivers or receivers[0]["status"] != "streaming":
            return False
        _pn_require(len(receivers) == 1 and receivers[0]["sender_host"] == "127.0.0.1"
                    and receivers[0]["sender_port"] == "55440", "OWNED_RECEIVER_ENDPOINT")
        receiver = _pn_proc_identity(int(receivers[0]["pid"]))
        _pn_require(receiver["parentPid"] == standby.process.pid
                    and receiver["uid"] == _pn_os.getuid()
                    and receiver["executable"] == str((self.pg / "postgres").resolve()),
                    "OWNED_RECEIVER_PROCESS")
        replication = _pn_json_module.loads(self.sql(primary,
            "SELECT coalesce(json_agg(x),'[]'::json)::text FROM ("
            "SELECT pid::text,backend_start::text AS \"backendStart\","
            "host(client_addr) AS address,client_port::text,usename,application_name "
            "FROM pg_stat_replication) x", "postgres"))
        _pn_require(len(replication) == 1 and replication[0]["address"] == "127.0.0.1"
                    and replication[0]["usename"] == "localtest"
                    and replication[0]["application_name"] == "ct_local_standby",
                    "SINGLE_OWNED_REPLICATION_LINK")
        # No conninfo/password/authentication catalog is read. Correlate the
        # safe client_port to a socket descriptor owned by that receiver PID.
        directory = _PnPath("/proc") / str(receiver["pid"])
        inodes = set()
        for descriptor in (directory / "fd").iterdir():
            try:
                target = _pn_os.readlink(descriptor)
            except FileNotFoundError:
                continue
            match = _pn_re.fullmatch(r"socket:\[([0-9]+)\]", target)
            if match:
                inodes.add(match.group(1))
        local = f"0100007F:{int(replication[0]['client_port']):04X}"
        remote = f"0100007F:{primary.port:04X}"
        linked = any(
            fields[1] == local and fields[2] == remote and fields[3] == "01"
            and fields[9] in inodes
            for fields in (line.split() for line in (directory / "net/tcp").read_text().splitlines()[1:])
            if len(fields) >= 10)
        _pn_require(linked, "RECEIVER_SOCKET_TO_SENDER_BINDING")
        sender = {"pid": replication[0]["pid"], "backendStart": replication[0]["backendStart"]}
        _pn_require(self.clients(primary, allow_sender=True) == sender, "EXACT_OWNED_SENDER")
        self.sender_identity = sender
        return True

    def stop(self, server):
        _pn_require(server in self.servers, "ONLY_THIS_RUNS_POSTMASTER_MAY_BE_STOPPED")
        if server.stopped:
            return
        if server.process.poll() is None:
            pidfile = server.directory / "postmaster.pid"
            require_pidfile = (server.cluster is not None
                               or pidfile.exists() or pidfile.is_symlink())
            server.assert_process(self.root, require_pidfile=require_pidfile)
            if require_pidfile:
                # Even incomplete cluster capture retains ready-server refusals.
                self.clients(server, allow_sender=server.port == 55440)
            # Pre-ready ownership comes from the direct Popen/process witness,
            # not SQL/readiness or a pidfile which may never have been produced.
            _pn_os.kill(server.process.pid, _pn_signal.SIGINT)
            try:
                server.process.wait(timeout=45)
            except _pn_subprocess.TimeoutExpired:
                raise ProfileNativeRefusal("OWNED_SERVER_STOP_TIMEOUT_NO_FOREIGN_KILL") from None
        # Do not release ownership on a dead leader with live session members.
        _pn_require(not _pn_group_members(server.process.pid), "OWNED_SERVER_GROUP_NOT_DRAINED")
        server.stopped = True
        server.log.close()
        _pn_require(server.process.returncode == 0, "OWNED_SERVER_STOP_FAILED")

    def fence(self, close=False):
        filename = self.base / "independent/fence/fence.json"
        _pn_owned(self.root, filename, False)
        return _pn_fence(_pn_json_module.loads(filename.read_bytes()), close)

    def transition_fence(self, initialize=False):
        self.source_guard()
        # Fixed existing adapter, no direct file-format fabrication/activation.
        program = (
            "import {LocalIndependentFenceStore} from './dist/src/fence-store.js';"
            "import {canonical,sha} from './dist/src/db.js';"
            "const s=new LocalIndependentFenceStore('.local/dr-lab/independent/fence');"
        )
        if initialize:
            program += "await s.initialize({revision:1,fence:" + _pn_json_module.dumps(
                self.source_fence) + ",blocked:false,authorityDigest:sha(canonical([]))});"
        else:
            old = self.fence()
            _pn_require(not old["blocked"] and old["fence"] == self.source_fence,
                        "SOURCE_DRAIN_BLOCK_ONLY")
            program += ("const old=await s.read();if(old.blocked||old.revision!==1)"
                        "throw Error('source fence changed');"
                        "await s.advance(old.revision,sha(canonical([])));")
        self.command([self.node, "--input-type=module", "-e", program])
        state = self.fence()
        _pn_require(state["blocked"] != initialize and
                    (state["fence"] == self.source_fence if initialize
                     else state["fence"] != self.source_fence), "FENCE_TRANSITION")
        return state

    def manifest(self, value):
        filename = self.base / "profile-native-manifest.json"
        if self.manifest_hash is None:
            _pn_new_json(self.root, filename, value)
        else:
            _pn_owned(self.root, filename, False)
            _pn_require(_pn_hash_file(filename) == self.manifest_hash,
                        "PRIOR_PHASE_MANIFEST_CHANGED")
            temporary = self.base / ("manifest-" + str(_pn_uuid.uuid4()) + ".tmp")
            _pn_new_json(self.root, temporary, value)
            _pn_os.replace(temporary, filename)
            fd = _pn_os.open(self.base, _pn_os.O_RDONLY | _pn_os.O_DIRECTORY)
            try:
                _pn_os.fsync(fd)
            finally:
                _pn_os.close(fd)
        self.manifest_hash = _pn_hash_file(filename)

    def seal_evidence(self, filename):
        _pn_owned(self.root, filename, False)
        _pn_require(filename.parent == self.out, "PHASE_EVIDENCE_SCOPE")
        actual = _pn_hash_file(filename)
        if filename in self.evidence_seals:
            _pn_require(actual == self.evidence_seals[filename], "SEALED_PHASE_EVIDENCE_CHANGED")
        else:
            self.evidence_seals[filename] = actual
        return self.evidence_seals[filename]

    def sealed_evidence(self, filename):
        _pn_owned(self.root, filename, False)
        _pn_require(filename in self.evidence_seals, "UNSEALED_PHASE_EVIDENCE")
        _pn_require(_pn_hash_file(filename) == self.evidence_seals[filename],
                    "SEALED_PHASE_EVIDENCE_CHANGED")
        return self.evidence_seals[filename]

    def evidence_guard(self):
        for filename in self.evidence_seals:
            self.sealed_evidence(filename)
        for phase in self.result["phases"]:
            _pn_require(phase["sha256"] == self.sealed_evidence(
                self.out / (phase["phase"] + ".json")), "PHASE_RESULT_SEAL_CHANGED")

    def phase(self, phase, server, sender=None):
        _pn_require(phase in _PN_PHASES, "PHASE_ALLOWLIST")
        state, slot, port = _PN_PHASES[phase]
        _pn_require(server.port == port and server.directory == self.base / slot,
                    "PHASE_SERVER_BINDING")
        self.source_guard()
        self.server_cluster(server)
        actual_sender = self.clients(server, allow_sender=phase.startswith("source-"))
        _pn_require(actual_sender == sender, "OWNED_REPLICATION_SENDER_CHANGED")
        _pn_require(_pn_hash_file(self.base / "profile-native-lease.json") == self.mirror_hash,
                    "LEASE_MIRROR_CHANGED")
        source = phase in {"seed-s0", "source-s1", "source-s2"}
        independent = self.fence(close=phase.startswith("close-"))
        _pn_require(independent["blocked"] != source, "PHASE_INDEPENDENT_FENCE_STATE")
        snapshot = None if phase == "seed-s0" else self.out / (
            "snapshot-" + ({"source-s1": "s0", "source-s2": "s1"}.get(phase,
                                                        state.lower())) + ".json")
        receipt = self.out / ("read-" + state.lower() + ".json") if phase.startswith("close-") else None
        self.evidence_guard()
        for dependency in (snapshot, receipt):
            if dependency is not None:
                self.sealed_evidence(dependency)
        self.manifest({
            "kind": "profile-native-manifest/v0.1", "runId": self.run_id,
            "phase": phase, "orchestration": self.orchestration,
            "leaseSha256": self.mirror_hash, "code": self.code,
            "cluster": {key: server.cluster[key] for key in
                        ("systemIdentifier", "postmasterStart")},
            "sourceFence": self.source_fence, "independentFence": independent,
            "expectedSnapshotSha256": self.sealed_evidence(snapshot) if snapshot else None,
            "readReceiptSha256": self.sealed_evidence(receipt) if receipt else None,
            "replicationClient": sender,
        })
        environment = {key: value for key, value in self.environment.items()
                       if key not in {"PGPASSFILE", "PGAPPNAME"}}
        environment.update({
            "CT_PROFILE_NATIVE_PARENT_LAUNCH": "yes", "CT_PROFILE_NATIVE_RUN_ID": self.run_id,
            "CT_PROFILE_NATIVE_LEASE_ID": self.lease_id,
            "CT_PROFILE_NATIVE_ORCHESTRATION_ID": self.orchestration_id,
        })
        # Direct launch from the actual held parent: child's PPID == launcherPid.
        result = _pn_json_module.loads(self.command(
            [self.node, "dist/tests/dr-vera-profile-probe.js", self.run_id, phase],
            environment=environment))
        self.source_guard()
        _pn_require(_pn_hash_file(self.base / "profile-native-manifest.json") == self.manifest_hash,
                    "PHASE_MANIFEST_CHANGED")
        _pn_require(result.get("phase") == phase
                    and result.get("nativeQualification") == "NOT CLAIMED", "PHASE_RESULT")
        output = self.out / (phase + ".json")
        _pn_owned(self.root, output, False)
        _pn_require(_pn_json_module.loads(output.read_bytes()).get("phase") == phase,
                    "PHASE_OUTPUT")
        if source:
            self.seal_evidence(self.out / ("snapshot-" + state.lower() + ".json"))
        self.result["phases"].append({"phase": phase, "sha256": self.seal_evidence(output)})
        return result

    def seal_inputs(self, name, directory):
        seal = _pn_tree(self.root, directory)
        self.input_seals[name] = (directory, seal)
        self.write(name + "-seal.json", seal)
        return seal

    def input_guard(self):
        for directory, seal in self.input_seals.values():
            _pn_require(_pn_tree(self.root, directory) == seal, "IMMUTABLE_IMAGE_OR_ARCHIVE_CHANGED")

    def clone(self, backup, directory):
        self.input_guard()
        _pn_require(not directory.exists() and not directory.is_symlink(), "FRESH_CLONE_REQUIRED")
        _pn_shutil.copytree(backup, directory, symlinks=False)
        _pn_owned(self.root, directory, True)
        # Per-image process logs must not be inherited/adopted from the source.
        inherited = directory / "profile-native-server.log"
        if inherited.exists():
            _pn_owned(self.root, inherited, False)
            inherited.rename(directory / "source-server-log-retained.log")

    def promote(self, server):
        self.clients(server)
        _pn_require(self.sql(server, "SELECT pg_promote(true,30)") == "t", "NATIVE_PROMOTION")
        self.wait(lambda: self.sql(server, "SELECT pg_is_in_recovery()") == "f")
        self.server_cluster(server)

    def execute_images(self):
        self.prepare()
        self.transition_fence(initialize=True)
        primary_directory = self.base / "primary"
        self.pg_command("initdb", ["-D", primary_directory, "-U", "localtest",
                                 "-A", "trust", "--encoding=UTF8", "--locale=C"])
        archive_command = (_pn_shlex.quote(_pn_sys.executable) + " "
                           + _pn_shlex.quote(str(self.root / "tools/wal-archive.py"))
                           + " %p " + _pn_shlex.quote(str(self.base / "wal")) + "/%f")
        self.append_configuration(primary_directory,
            "wal_level=replica\nmax_wal_senders=6\narchive_mode=on\narchive_timeout=1\n"
            "fsync=on\nsynchronous_commit=on\ntimezone='UTC'\ndatestyle='ISO, YMD'\n"
            "archive_command='" + archive_command.replace("'", "''") + "'")
        hba = primary_directory / "pg_hba.conf"
        _pn_owned(self.root, hba, False)
        with hba.open("a") as output:
            output.write("\nhost replication localtest 127.0.0.1/32 trust\n")
        primary = self.start(primary_directory, 55440)
        self.pg_command("createdb", ["-w", "-h", "127.0.0.1", "-p", "55440",
                                    "-U", "localtest", "ct_dr"])
        for name in _PN_MIGRATIONS:
            self.clients(primary)
            self.pg_command("psql", ["-X", "-w", "-v", "ON_ERROR_STOP=1",
                "-h", "127.0.0.1", "-p", "55440", "-U", "localtest", "-d", "ct_dr",
                "-f", self.root / "migrations" / name])
        self.source_guard()
        # Only this fresh owned SOURCE may replace its initial blocked control.
        _pn_require(self.sql(primary, "WITH boot AS (UPDATE ct.control "
            "SET blocked=false,fence='" + self.source_fence + "' "
            "WHERE singleton AND blocked AND fence='UNENROLLED' AND lock_tag=0 "
            "RETURNING singleton) SELECT count(*) FROM boot") == "1", "SOURCE_F0_BOOTSTRAP")
        self.phase("seed-s0", primary)
        self.write("source-s0-barrier.json", {
            "lsn": self.sql(primary, "SELECT pg_current_wal_flush_lsn()::text"),
            "meaning": "sampled after S0 commit; NOT an exact transaction commit LSN"})
        backup = self.base / "backup"
        self.clients(primary)
        self.pg_command("pg_basebackup", ["-w", "-h", "127.0.0.1", "-p", "55440",
            "-U", "localtest", "-D", backup, "-X", "stream", "--checkpoint=fast",
            "--manifest-checksums=SHA256"], timeout=240)
        self.pg_command("pg_verifybackup", [backup], timeout=240)
        backup_manifest = _pn_json_module.loads((backup / "backup_manifest").read_bytes())
        ranges = backup_manifest.get("WAL-Ranges")
        _pn_require(isinstance(ranges, list) and len(ranges) == 1, "SINGLE_SOURCE_BACKUP_TIMELINE")
        timeline = self.sql(primary, "SELECT (pg_control_checkpoint()).timeline_id::text")
        _pn_require(str(ranges[0]["Timeline"]) == timeline, "BACKUP_SOURCE_TIMELINE")
        self.seal_inputs("original-backup", backup)
        self.write("backup-provenance.json", {
            "verification": "pg_verifybackup exit0", "sourceCluster": primary.cluster,
            "timeline": timeline, "walRanges": ranges, "backupCompletedBeforeS1": True,
            "manifestSha256": _pn_hash_file(backup / "backup_manifest")})

        standby_directory = self.base / "standby"
        self.clone(backup, standby_directory)
        _pn_new_file(self.root, standby_directory / "standby.signal", b"")
        self.append_configuration(standby_directory,
            "archive_mode=off\nprimary_conninfo='host=127.0.0.1 port=55440 user=localtest "
            "application_name=ct_local_standby'\n")
        standby = self.start(standby_directory, 55441)
        self.wait(lambda: self.bind_sender(primary, standby))
        sender = self.sender_identity
        self.phase("source-s1", primary, sender)
        restore_name = "ct_profile_native_s1_" + self.run_id.replace("-", "")
        restore_lsn = self.sql(primary, "SELECT pg_create_restore_point('" + restore_name + "')::text")
        self.phase("source-s2", primary, sender)
        s2_lsn = self.sql(primary, "SELECT pg_current_wal_flush_lsn()::text")
        _pn_require(_pn_lsn(ranges[0]["Start-LSN"]) <= _pn_lsn(ranges[0]["End-LSN"])
                    <= _pn_lsn(restore_lsn) < _pn_lsn(s2_lsn), "ORDERED_SOURCE_WAL_BARRIERS")
        self.sql(primary, "CHECKPOINT")
        last_segment = self.sql(primary, "SELECT pg_walfile_name(pg_switch_wal()-1)")
        segment_bytes = int(self.sql(primary,
            "SELECT pg_size_bytes(current_setting('wal_segment_size'))::text"))
        required = _pn_wal_names(ranges[0]["Start-LSN"], s2_lsn, segment_bytes, timeline)
        required.append(last_segment)
        self.wait(lambda: all((self.base / "wal" / name).is_file()
                  and (self.base / "wal" / name).stat().st_size == segment_bytes
                  for name in set(required)), timeout=90)
        self.wait(lambda: self.sql(standby, "SELECT pg_last_wal_replay_lsn()>='"
                                  + s2_lsn + "'::pg_lsn") == "t")
        self.write("ordered-wal-provenance.json", {
            "sourceTimeline": timeline, "restorePoint": {"name": restore_name, "lsn": restore_lsn},
            "s2PostCommitFlushBarrier": s2_lsn, "exactCommitLsnClaimed": False,
            "segmentBytes": segment_bytes, "requiredArchivedSegments": sorted(set(required)),
            "standbyReachedS2Barrier": True, "ownedSender": sender})
        self.clients(primary, allow_sender=True)
        self.stop(primary)
        self.transition_fence()  # Block independently before ANY recovered phase.
        archive = self.base / "sealed-wal"
        for filename in sorted((self.base / "wal").iterdir()):
            _pn_owned(self.root, filename, False)
            _pn_require(_pn_re.fullmatch(
                r"(?:[0-9A-F]{24}(?:\.[0-9A-F]{8}\.backup)?|[0-9A-F]{8}\.history)",
                filename.name), "UNEXPECTED_ARCHIVE_FILENAME")
            if _pn_re.fullmatch(r"[0-9A-F]{24}", filename.name):
                _pn_require(filename.stat().st_size == segment_bytes, "PARTIAL_WAL_REFUSED")
            _pn_new_file(self.root, archive / filename.name, filename.read_bytes())
        self.seal_inputs("sealed-source-wal", archive)

        self.phase("read-s2", standby)
        self.promote(standby)
        self.phase("close-s2", standby)
        self.result["cases"].append({"case": "local profile streaming/promotion S2", "status": "PASS"})
        self.stop(standby)

        restored_directory = self.base / "restored"
        self.clone(backup, restored_directory)
        self.append_configuration(restored_directory,
            "archive_mode=off\nprimary_conninfo=''\nrestore_command=''\n")
        physical = self.start(restored_directory, 55442)
        self.phase("read-s0", physical)
        self.phase("close-s0", physical)
        self.stop(physical)
        retained = self.base / "completed-physical-s0"
        _pn_require(physical.stopped and not retained.exists() and not retained.is_symlink(),
                    "ONLY_COMPLETED_OWNED_SLOT_MAY_BE_RETAINED")
        _pn_owned(self.root, restored_directory, True)
        restored_directory.rename(retained)  # Retain this run's completed image; never delete.
        self.result["cases"].append({"case": "local profile physical image S0", "status": "PASS"})
        self.clone(backup, restored_directory)
        _pn_new_file(self.root, restored_directory / "recovery.signal", b"")
        restore_command = "cp -- " + _pn_shlex.quote(str(archive)) + "/%f %p"
        self.append_configuration(restored_directory,
            "archive_mode=off\nprimary_conninfo=''\nrestore_command='"
            + restore_command.replace("'", "''") + "'\nrecovery_target_timeline='"
            + timeline + "'\nrecovery_target_name='" + restore_name
            + "'\nrecovery_target_action='pause'\n")
        pitr = self.start(restored_directory, 55442)
        self.wait(lambda: self.sql(pitr, "SELECT CASE WHEN pg_is_in_recovery() "
            "THEN pg_get_wal_replay_pause_state()='paused' ELSE false END") == "t", timeout=90)
        self.phase("read-s1", pitr)
        self.promote(pitr)
        self.phase("close-s1", pitr)
        self.stop(pitr)
        self.result["cases"].append({"case": "local profile named WAL/PITR S1", "status": "PASS"})
        self.input_guard()
        self.source_guard()
        self.evidence_guard()
        _pn_require(len(self.result["phases"]) == 9 and len(self.result["cases"]) == 3,
                    "COMPLETE_NATIVE_GROUPS_REQUIRED")
        self.result["status"] = "PASS"

    def resources_quiescent(self):
        try:
            return (all(group.quiet() for group in self.command_groups)
                    and all(server.stopped or (server.process.poll() is not None
                            and not _pn_group_members(server.process.pid))
                            for server in self.servers))
        except BaseException:
            return False  # Inspection uncertainty retains, never releases, ownership.

    def retain_lease_until_quiescent(self):
        # Called in the actual SAME Lease's finally, including result-write errors.
        # No stale-lock break, new lease, automatic adoption, or foreign-client kill.
        # Cooperative masking cannot protect against SIGKILL/host loss.
        announced = False
        while not self.resources_quiescent():
            self.result["status"] = "FAIL"
            try:
                _pn_signal.signal(_pn_signal.SIGINT, _pn_signal.SIG_IGN)
                _pn_signal.signal(_pn_signal.SIGTERM, _pn_signal.SIG_IGN)
                if not announced:
                    print("OWNERSHIP_RETAINED: cleanup incomplete; shared lease remains held",
                          file=_pn_sys.stderr, flush=True)
                    announced = True
                if not self.ownership_handoff_written:
                    self.write("ownership-retaining-handoff.json", {
                        "status": "OWNERSHIP_RETAINED_CLEANUP_INCOMPLETE",
                        "runId": self.run_id, "leaseId": self.lease_id,
                        "launcherPid": str(_pn_os.getpid()),
                        "ownedCommandGroups": [str(group.process.pid)
                                               for group in self.command_groups if not group.drained],
                        "ownedPostmasters": [str(server.process.pid)
                                             for server in self.servers if not server.stopped],
                        "adoptionOrForeignKillAuthorized": False,
                    })
                    self.ownership_handoff_written = True
            except BaseException:
                pass  # Losing the evidence directory does not release the Lease.
            for group in self.command_groups:
                if not group.drained:
                    try:
                        self.drain_command(group)
                    except BaseException:
                        pass
            for server in reversed(self.servers):
                if not server.stopped:
                    try:
                        self.stop(server)
                    except BaseException:
                        pass
            try:
                _pn_time.sleep(1)
            except BaseException:
                pass  # Repeated cooperative interrupts cannot release live children.

    def finish(self, failure=None):
        cleanup = []
        try:
            fence_file = self.base / "independent/fence/fence.json"
            if fence_file.exists() and not self.fence()["blocked"]:
                self.transition_fence()  # No automatic activation on failure.
        except Exception:
            cleanup.append("INDEPENDENT_BLOCK_OR_SEAL_CHECK_FAILED")
        for group in self.command_groups:
            if not group.drained:
                try:
                    _, drained = self.drain_command(group)
                    if not drained:
                        cleanup.append("OWNED_COMMAND_CLEANUP_INCOMPLETE")
                except BaseException:
                    cleanup.append("OWNED_COMMAND_CLEANUP_FAILED")
        for server in reversed(self.servers):
            if not server.stopped:
                try:
                    self.stop(server)
                except BaseException:
                    cleanup.append("OWNED_SERVER_CLEANUP_FAILED")
        try:
            self.evidence_guard()
        except Exception:
            cleanup.append("PHASE_EVIDENCE_CHECK_FAILED")
        self.result["stoppedAllOwnedClusters"] = all(s.stopped for s in self.servers)
        self.result["drainedAllOwnedCommandGroups"] = all(g.drained for g in self.command_groups)
        self.result["cleanupErrors"] = cleanup
        if (failure or cleanup or not self.result["stoppedAllOwnedClusters"]
                or not self.result["drainedAllOwnedCommandGroups"]):
            self.result["status"] = "FAIL"
        if failure:
            self.result["failureCode"] = (
                str(failure) if isinstance(failure, ProfileNativeRefusal)
                else "PARENT_NATIVE_ORCHESTRATION_FAILED")
        if self.out.exists():
            try:
                self.write("orchestration-result.json", self.result)
            except Exception:
                self.result["status"] = "FAIL"
                cleanup.append("FINAL_RESULT_WRITE_FAILED")
        else:
            self.result["status"] = "FAIL"
            cleanup.append("EVIDENCE_DIRECTORY_UNAVAILABLE")
        return self.result


def _profile_native_main():
    _pn_arguments(_pn_sys.argv[1:])
    _pn_environment(_pn_os.environ)
    root = _PnPath(__file__).absolute().parent.parent
    _pn_require(root.resolve() == root and _pn_re.fullmatch(r"[A-Za-z0-9_./-]+", str(root)),
                "CANONICAL_ROOT_REQUIRED")
    _pn_owned(root, root, True)
    # Refuse a predecessor BEFORE profile/preflight/database/process actions.
    base = root / ".local/dr-lab"
    _pn_require(not base.exists() and not base.is_symlink(),
                "EXISTING_LAB_REFUSED_NO_RESET_OR_ADOPTION")
    launcher_file = root / "tools/local-test.py"
    _pn_owned(root, launcher_file, False)
    spec = _pn_importlib.spec_from_file_location("continuum_native_shared_launcher", launcher_file)
    launcher = _pn_importlib.module_from_spec(spec)
    spec.loader.exec_module(launcher)
    # Fixed existing private profile, not a URL/path/credential option.
    profile = launcher.load_profile(root.parent / "local-test-profile.json")
    with launcher.Lease() as lease:
        with _ProfileNativeCancellationSignals() as cancellation:
            environment, versions = launcher.preflight(profile)
            cancellation.check()
            _pn_require(launcher.database_query(
                "SELECT count(*) FROM pg_stat_activity WHERE backend_type='client backend' "
                "AND pid<>pg_backend_pid()", environment) == "0", "MAIN_FIXTURE_CLIENTS_PRESENT")
            cancellation.check()
            run = _ProfileNativeRun(root, launcher, profile, environment, versions, lease)
            run.cancellation = cancellation
            failure = None
            try:
                run.execute_images()
                cancellation.check()
            except BaseException as error:
                failure = error
            finally:
                # This finalizer is unconditional BEFORE cleanup-mask entry.
                # Until both masks are installed, the lifetime handler defers
                # cooperative cancellation rather than jumping past ownership.
                try:
                    run.cleaning_up = True
                    try:
                        _pn_signal.signal(_pn_signal.SIGTERM, _pn_signal.SIG_IGN)
                        _pn_signal.signal(_pn_signal.SIGINT, _pn_signal.SIG_IGN)
                    except BaseException as error:
                        run.result["cleanupSignalMaskEntryFailed"] = True
                        if failure is None:
                            failure = error
                        else:
                            failure.add_note("CLEANUP_SIGNAL_MASK_ENTRY_FAILED")
                    result = run.finish(failure)
                finally:
                    run.retain_lease_until_quiescent()
            print(_pn_json_module.dumps({key: result.get(key) for key in (
                "status", "scope", "runId", "cases", "stoppedAllOwnedClusters",
                "drainedAllOwnedCommandGroups", "nativeQualification")}, sort_keys=True))
            return 0 if result["status"] == "PASS" else 1


if len(_pn_sys.argv) > 1:
    try:
        raise SystemExit(_profile_native_main())
    except ProfileNativeRefusal as _pn_error:
        print("Refused: " + str(_pn_error), file=_pn_sys.stderr)
        raise SystemExit(2) from None
    except Exception:
        print("Refused: PROFILE_NATIVE_PREPARATION_FAILED", file=_pn_sys.stderr)
        raise SystemExit(2) from None

# ORIGINAL NO-ARGUMENT GENERIC LAB -- byte-preserved below.
import os as _fixture_os
if _fixture_os.environ.get('NODE_ENV') == 'production' or _fixture_os.environ.get('CT_RUNTIME_ENV') != 'local-test' or _fixture_os.environ.get('CT_ALLOW_LOCAL_FIXTURES') != 'yes' or any(_fixture_os.environ.get(k) for k in ['WORKOS_API_KEY','WORKOS_CLIENT_ID','WORKOS_COOKIE_PASSWORD','DATABASE_URL','CT_DATABASE_URL','CT_PRODUCTION_CONFIG','CT_STAGING_CONFIG']):
    raise SystemExit('Explicit isolated local DR fixture profile required; staging/production denied')
#!/usr/bin/env python3
"""Actual native PostgreSQL streaming/failover/WAL-PITR lab; NEVER accepts a remote endpoint."""
from pathlib import Path
import os,sys,json,subprocess,time,shutil,socket
root=Path(__file__).resolve().parent.parent;os.chdir(root)
base=root/'.local/dr-lab';out=root/'.artifacts/implementation/dr-lab';out.mkdir(parents=True,exist_ok=True)
if os.environ.get('CT_LOCAL_DR_LAB')!='yes':raise SystemExit('Explicit local DR lab flag required')
if base.exists():raise SystemExit('Lab directory already exists. Inspect/stop it before explicitly removing the disposable lab.')
base.mkdir(parents=True,mode=0o700);archive=base/'wal';archive.mkdir(mode=0o700)
log=open(out/'RAW-COMMANDS.log','w');started=[];held={};results={"scope":"actual local native PostgreSQL; not cloud HA, regional DR or live identity/provider", "cases":[],"status":"FAIL"}
def cmd(args,env=None):
 log.write('$ '+' '.join(map(str,args))+'\n');log.flush();p=subprocess.run(list(map(str,args)),stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,env=env);log.write(p.stdout);log.flush()
 if p.returncode:raise RuntimeError(f'command failed ({p.returncode}): {args[0]}')
 return p.stdout.strip()
def sql(port,query,db='ct_dr'):
 return cmd(['psql','-h','127.0.0.1','-p',port,'-U','localtest','-d',db,'-v','ON_ERROR_STOP=1','-Atc',query])
def describe_port(port):
 try:
  with open('/proc/net/tcp') as handle: rows=handle.read().splitlines()[1:]
 except OSError: return 'tcp owner unavailable'
 inodes=[]
 for row in rows:
  parts=row.split()
  if len(parts)<10: continue
  local=parts[1]
  if int(local.split(':')[1],16)!=port: continue
  inodes.append((parts[3],parts[9]))
 if not inodes: return 'no matching tcp inode; occupant not killed'
 details=[]
 for state,inode in inodes:
  for pid in os.listdir('/proc'):
   if not pid.isdigit(): continue
   fd_dir='/proc/'+pid+'/fd'
   try: fds=os.listdir(fd_dir)
   except OSError: continue
   for fd in fds:
    try: target=os.readlink(fd_dir+'/'+fd)
    except OSError: continue
    if target!='socket:['+inode+']': continue
    try:
     with open('/proc/'+pid+'/cmdline','rb') as handle: text=handle.read().replace(b'\x00',b' ').decode(errors='replace')[:240]
    except OSError: text='unreadable cmdline'
    details.append('pid '+pid+' state '+state+' '+text)
 return '\n'.join(details) or 'inode not mapped; occupant not killed'
def claim(port):
 last=None
 for _ in range(40):
  sock=socket.socket(socket.AF_INET,socket.SOCK_STREAM)
  sock.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1)
  try:
   sock.bind(('127.0.0.1',port));sock.listen(1);return sock
  except OSError as error:
   last=error;sock.close();time.sleep(.05)
 raise RuntimeError(f'Lab port {port} is already in use ({last}). The occupant was not killed.\n{describe_port(port)}')
def start(directory,port):
 reservation=held.pop(port,None)
 if reservation is not None: reservation.close()
 sock=base/('socket-'+str(port));sock.mkdir(mode=0o700)
 try:cmd(['pg_ctl','-D',directory,'-l',directory/'server.log','-o',f'-p {port} -h 127.0.0.1 -k {sock}','-w','start'])
 except Exception as error:
  server_log=directory/'server.log'
  detail=server_log.read_text(errors='replace') if server_log.exists() else 'server log was not created'
  (out/f'server-{port}.log').write_text(detail)
  raise RuntimeError(f'{error}\nPostgreSQL server log:\n{detail[-4000:]}') from error
 started.append(directory)
def stop(directory):
 cmd(['pg_ctl','-D',directory,'-m','immediate','-w','stop']);started.remove(directory)
def probe(phase,port):
 v=json.loads(cmd(['node','dist/tests/dr-effect-probe.js',phase,port],env={**os.environ,'CT_LOCAL_DR_LAB':'yes'}));(out/(phase+'.json')).write_text(json.dumps(v,indent=2)+'\n');return v
def until(fn,timeout=30):
 end=time.monotonic()+timeout
 while time.monotonic()<end:
  if fn():return
  time.sleep(.15)
 raise RuntimeError('lab condition timeout')
try:
 for port in (55440,55441,55442): held[port]=claim(port)
 primary=base/'primary';cmd(['initdb','-D',primary,'-U','localtest','-A','trust','--encoding=UTF8','--locale=C'])
 archive_command=f"{sys.executable} {root/'tools'/'wal-archive.py'} %p {archive}/%f"
 with (primary/'postgresql.conf').open('a') as f:f.write(f"\nwal_level=replica\nmax_wal_senders=6\narchive_mode=on\narchive_timeout=1\narchive_command='{archive_command}'\nfsync=on\nsynchronous_commit=on\nshared_buffers=16MB\ndynamic_shared_memory_type=mmap\nmax_connections=20\n")
 with (primary/'pg_hba.conf').open('a') as f:f.write('\nhost replication localtest 127.0.0.1/32 trust\n')
 start(primary,55440);cmd(['createdb','-h','127.0.0.1','-p',55440,'-U','localtest','ct_dr'])
 for filename in ['001-foundation.sql','002-lock-privileges.sql','004-monotonic-fences.sql','005-identity-authority.sql','006-product-computers.sql','008-recovery-controls.sql','016-placement-generation.sql']:
  cmd(['psql','-h','127.0.0.1','-p',55440,'-U','localtest','-d','ct_dr','-v','ON_ERROR_STOP=1','-f',root/'migrations'/filename])
 probe('seed',55440);backup=base/'backup';cmd(['pg_basebackup','-h','127.0.0.1','-p',55440,'-U','localtest','-D',backup,'-X','stream','--checkpoint=fast']);results['cases'].append({'case':'native physical base backup','status':'PASS'})
 lsn=sql(55440,"SELECT pg_create_restore_point('before_effect')");(out/'RESTORE-POINT.json').write_text(json.dumps({'name':'before_effect','lsn':lsn},indent=2))
 standby=base/'standby';shutil.copytree(backup,standby);(standby/'standby.signal').touch()
 with (standby/'postgresql.conf').open('a') as f:f.write("\nprimary_conninfo='host=127.0.0.1 port=55440 user=localtest application_name=ct_local_standby'\narchive_mode=off\n")
 start(standby,55441);until(lambda:sql(55441,'SELECT pg_is_in_recovery()')=='t');probe('send-revoke',55440)
 sql(55440,'CHECKPOINT')
 completed=sql(55440,"SELECT pg_walfile_name(pg_switch_wal() - 1)")
 segment_bytes=int(sql(55440,"SELECT pg_size_bytes(current_setting('wal_segment_size'))"))
 restore_file=sql(55440,f"SELECT pg_walfile_name('{lsn}'::pg_lsn)")
 until(lambda: (archive/completed).is_file() and (archive/completed).stat().st_size==segment_bytes and (archive/restore_file).is_file() and (archive/restore_file).stat().st_size==segment_bytes)
 until(lambda:sql(55441,"SELECT revoked FROM ct.grants WHERE tenant='dr' AND id='dr-grant'")=='t')
 results['cases'].append({'case':'streaming standby observes committed effect and revocation','status':'PASS'})
 stop(primary);cmd(['pg_ctl','-D',standby,'-w','promote']);until(lambda:sql(55441,'SELECT pg_is_in_recovery()')=='f');probe('failover-check',55441);results['cases'].append({'case':'primary immediate crash and standby promotion preserve revocation/no duplicate','status':'PASS'})
 probe('block-before-restore',55441);stop(standby)
 restored=base/'restored';shutil.copytree(backup,restored);(restored/'recovery.signal').touch()
 with (restored/'postgresql.conf').open('a') as f:f.write(f"\narchive_mode=off\nrestore_command='cp {archive}/%f %p'\nrecovery_target_name='before_effect'\nrecovery_target_action='pause'\n")
 start(restored,55442);until(lambda:sql(55442,'SELECT pg_is_wal_replay_paused()')=='t');cmd(['pg_ctl','-D',restored,'-w','promote']);until(lambda:sql(55442,'SELECT pg_is_in_recovery()')=='f')
 restored_result=probe('restore-check',55442);results['cases'].append({'case':'WAL PITR restores deliberately old authority, but independent fence rejects stale deployment','status':'PASS'});results['cases'].append({'case':'read-only gap reconciliation and independent revocation journal prevent resend/resurrection','status':'PASS'});results['restoreChecks']=restored_result;results['status']='PASS'
except Exception as e:
 results['error']=str(e);raise
finally:
 for sock in list(held.values()):
  try: sock.close()
  except Exception as error: results.setdefault('cleanupErrors',[]).append(str(error))
 held.clear()
 for directory in list(reversed(started)):
  try:stop(directory)
  except Exception as e:results.setdefault('cleanupErrors',[]).append(str(e))
 results['stoppedAllLabClusters']=not started;(out/'RESULT.json').write_text(json.dumps(results,indent=2)+'\n');log.close()
 print(json.dumps({k:results[k] for k in ['status','scope','cases','stoppedAllLabClusters']}))
