#!/usr/bin/env python3
"""Check copied/adapted file hashes and dependency closure; optionally verify donor."""
import hashlib
import json
import subprocess
import sys
import tomllib
from pathlib import Path

root = Path(__file__).resolve().parents[1]
m = json.loads((root / 'docs/integrations/NEXUS-PROVENANCE.json').read_text())
sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
originals = {x['path']: x for x in m['donorFiles']}
for item in m['copiedArtifacts']:
    expected = originals[item['source']]['sha256'] if item['kind'] == 'verbatim' else item['sha256']
    assert sha(root / item['path']) == expected, item['path']
lockfile = root / 'tools/nexus-native/Cargo.lock'
assert sha(lockfile) == m['dependencyLockSha256'], 'Unreviewed dependency lock'
lock = tomllib.loads(lockfile.read_text())
actual = {(p['name'], p['version']) for p in lock['package'] if 'source' in p}
reviewed = {(p['name'], p['version']) for p in m['dependencies']}
assert actual == reviewed, 'Unreviewed dependency closure'
assert all(p['source'].startswith('registry+') and p.get('checksum') for p in lock['package'] if 'source' in p)
if len(sys.argv) > 1:
    donor = Path(sys.argv[1])
    git = lambda *args: subprocess.check_output(['git', '-C', str(donor), *args], text=True).strip()
    assert git('rev-parse', 'HEAD') == m['commit']
    assert git('rev-parse', 'HEAD^{tree}') == m['tree']
    for f in m['donorFiles']:
        assert sha(donor / f['path']) == f['sha256'], f['path']
        assert git('rev-parse', f"HEAD:{f['path']}") == f['gitBlob'], f['path']
print(f"Verified {len(m['copiedArtifacts'])} donor-derived artifacts and {len(actual)} pinned dependencies")
