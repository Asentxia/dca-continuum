#!/usr/bin/env python3
"""Explicit no-fetch unfiltered audit with before/after advisory database binding.
Not called by runtime/build. Requires already installed audit tooling and DB.
"""
import datetime
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

root = Path(__file__).resolve().parents[1]
binary, database, output = map(lambda p: Path(p).resolve(), sys.argv[1:])
expected_db = 'edb58f5974b83eb8302332821cb6d389777aa351'
output.mkdir(parents=True, exist_ok=True)
lockfile = root / 'tools/nexus-native/Cargo.lock'
sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()

def snapshot():
    git = lambda *a: subprocess.check_output(['git', '-C', str(database), *a]).decode().strip()
    files = subprocess.check_output(['git', '-C', str(database), 'ls-files', '-z']).split(b'\0')
    digests = {name.decode(): sha(database / name.decode()) for name in files if name}
    result = {'commit': git('rev-parse', 'HEAD'), 'gitTree': git('rev-parse', 'HEAD^{tree}'),
              'trackedFileContentSha256': hashlib.sha256(json.dumps(digests, sort_keys=True,
                    separators=(',', ':')).encode()).hexdigest(), 'trackedFiles': len(digests),
              'dirtyStatus': git('status', '--porcelain', '--untracked-files=all')}
    if result['commit'] != expected_db or result['dirtyStatus']:
        raise SystemExit('Advisory DB changed/unreviewed; no scan clearance')
    return result

version = subprocess.check_output([str(binary), '--version'], text=True).strip()
if version != 'cargo-audit 0.22.2':
    raise SystemExit('Expected reviewed cargo-audit 0.22.2')
command = [str(binary), 'audit', '--no-fetch', '--db', str(database),
           '--file', str(lockfile), '--json', '-D', 'warnings']
env = {key: os.environ[key] for key in ['HOME', 'CARGO_HOME'] if key in os.environ}
env.update({'PATH': '/usr/bin:/bin', 'CARGO_NET_OFFLINE': 'true'})
started = datetime.datetime.now(datetime.timezone.utc).isoformat()
lock_before = sha(lockfile)
before = snapshot()
result = subprocess.run(command, cwd=root, env=env, capture_output=True)
after = snapshot()
(output / 'cargo-audit.json').write_bytes(result.stdout)
(output / 'cargo-audit.stderr').write_bytes(result.stderr)
evidence = {'startedAt': started, 'completedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
            'toolVersion': version, 'toolSha256': sha(binary), 'command': command,
            'environment': {'CARGO_NET_OFFLINE': 'true'}, 'exitCode': result.returncode,
            'lockSha256': sha(lockfile), 'before': before, 'after': after,
            'rawReportSha256': hashlib.sha256(result.stdout).hexdigest()}
(output / 'audit-provenance.json').write_text(json.dumps(evidence, indent=2) + '\n')
if before != after or sha(lockfile) != lock_before or result.returncode != 0:
    raise SystemExit('Audit failed or DB changed; inspect retained full evidence')
report = json.loads(result.stdout)
assert report['vulnerabilities']['count'] == 0 and report['warnings'] == {}
assert report['settings']['ignore'] == [] and report['settings']['target_arch'] == []
assert report['settings']['target_os'] == [] and report['settings']['severity'] is None
print(json.dumps({'vulnerabilities': 0, 'warnings': 0, 'database': after,
                  'dependencyCountIncludingBridge': report['lockfile']['dependency-count']}, indent=2))
