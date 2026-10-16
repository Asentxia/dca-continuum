"""Refusal probes for the local fixture backup tool. No external endpoints."""
import hashlib, json, os, pathlib, subprocess, sys

root = pathlib.Path(__file__).resolve().parents[1]
env = {
    **os.environ,
    "PGHOST": "127.0.0.1",
    "PGPORT": "55432",
    "PGUSER": "localtest",
    "CT_RUNTIME_ENV": "local-test",
    "CT_ALLOW_LOCAL_FIXTURES": "yes",
    "PATH": os.environ.get("PATH", ""),
}

def run(*args, **kwargs):
    return subprocess.run(
        args,
        cwd=root,
        env=kwargs.pop("env", env),
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        **kwargs,
    )

def sql(database, statement):
    result = run("psql", "-d", database, "-v", "ON_ERROR_STOP=1", "-Atc", statement)
    if result.returncode:
        raise RuntimeError(result.stderr)
    return result.stdout.strip()

actual = pathlib.Path(sql("postgres", "SHOW data_directory")).resolve()
assert actual == (root / ".local/pgdata").resolve(), "must be the isolated owned cluster"
records = []
canary = "independent_nonfixture_canary"
run("dropdb", "--if-exists", canary)
assert run("createdb", canary).returncode == 0
try:
    sql(
        canary,
        "CREATE SCHEMA ct; CREATE TABLE ct.audit_canary(label text); INSERT INTO ct.audit_canary VALUES('owned non-fixture canary')",
    )
    dump = root / ".artifacts" / "nonfixture-probe.dump"
    dump.parent.mkdir(parents=True, exist_ok=True)
    dump.unlink(missing_ok=True)
    result = run(
        "bash",
        "tools/backup-domain.sh",
        str(dump),
        env={**env, "CT_DATABASE": canary},
    )
    records.append(
        {
            "id": "AUDIT-BACKUP-DB",
            "exitCode": result.returncode,
            "dumpProduced": dump.exists(),
        }
    )
    dump.unlink(missing_ok=True)
finally:
    run("dropdb", "--if-exists", canary)

override = run(
    "bash",
    "tools/backup-domain.sh",
    env={**env, "CT_DATABASE": "postgresql://127.0.0.1/ct_test"},
)
records.append({"id": "AUDIT-BACKUP-URL", "exitCode": override.returncode})
hostaddr = run(
    "bash",
    "tools/backup-domain.sh",
    env={**env, "PGHOSTADDR": "127.0.0.1"},
)
records.append({"id": "AUDIT-BACKUP-HOSTADDR", "exitCode": hostaddr.returncode})

sentinel = root / ".local" / "owned-output-canary.txt"
sentinel.write_text("DO NOT OVERWRITE\n")
before = hashlib.sha256(sentinel.read_bytes()).hexdigest()
link = root / ".local" / "independent-output-link.dump"
parent = root / ".local" / "linked-parent"
parent_target = root / ".local" / "real-parent"
parent.unlink(missing_ok=True)
if parent.is_symlink() or parent.exists():
    parent.unlink()
parent_target.mkdir(exist_ok=True)
link.unlink(missing_ok=True)
link.symlink_to(sentinel)
try:
    result = run("bash", "tools/backup-domain.sh", str(link), env={**env, "CT_DATABASE": "ct_test"})
    after = hashlib.sha256(sentinel.read_bytes()).hexdigest()
    records.append(
        {
            "id": "AUDIT-BACKUP-LINK",
            "exitCode": result.returncode,
            "canaryOverwritten": before != after,
        }
    )
finally:
    link.unlink(missing_ok=True)
    sentinel.unlink(missing_ok=True)

linked_dump = parent_target / "through-parent.dump"
try:
    parent.symlink_to(parent_target, target_is_directory=True)
    result = run(
        "bash",
        "tools/backup-domain.sh",
        str(parent / "through-parent.dump"),
        env={**env, "CT_DATABASE": "ct_test"},
    )
    records.append(
        {
            "id": "AUDIT-BACKUP-PARENT-LINK",
            "exitCode": result.returncode,
            "wroteThroughParent": linked_dump.exists(),
        }
    )
finally:
    if parent.is_symlink() or parent.exists():
        parent.unlink()
    linked_dump.unlink(missing_ok=True)
    parent_target.rmdir()

out = root / ".artifacts" / "backup-target-guards.json"
out.write_text(json.dumps(records, indent=2))
failed = [
    r
    for r in records
    if r["exitCode"] == 0 or r.get("dumpProduced") or r.get("canaryOverwritten") or r.get("wroteThroughParent")
]
print(json.dumps(records, indent=2))
sys.exit(1 if failed else 0)
