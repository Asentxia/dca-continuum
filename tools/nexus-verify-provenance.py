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
reviewed_by_key = {(p['name'], p['version']): p for p in m['dependencies']}
for package in lock['package']:
    if 'source' in package:
        reviewed_package = reviewed_by_key[(package['name'], package['version'])]
        assert package['checksum'] == reviewed_package['registryChecksum']
        assert package['source'] == reviewed_package['source']
runtime = tomllib.loads((root / 'tools/nexus-native/Cargo.toml').read_text())['dependencies']['wasmtime']
assert runtime['version'] == '=' + m['runtimeDependency']['version']
assert runtime['default-features'] is False
assert set(runtime['features']) == set(m['runtimeDependency']['features'])
# All complete root license/notice bodies must remain, not just SPDX/package links.
notices = (root / 'docs/integrations/NEXUS-THIRD-PARTY-NOTICES.txt').read_text()
retained = {}
for block in notices.split('\n---\nPackages: ')[1:]:
    labels, rest = block.split('\nSHA256: ', 1)
    original_hash, text = rest.split('\n\n', 1)
    normalized = '\n'.join(line.rstrip() for line in text.splitlines()).strip('\n') + '\n'
    retained[original_hash] = (set(labels.split(', ')), hashlib.sha256(normalized.encode()).hexdigest())
license_count = 0
for dep in m['dependencies']:
    for item in dep['licenseFiles']:
        labels, text_hash = retained[item['sha256']]
        assert f"{dep['name']}@{dep['version']}/{item['path']}" in labels
        assert text_hash == item['retainedTextSha256'], 'Incomplete/changed license text'
        license_count += 1
assert license_count == m['noticeRetention']['licenseFileCount']
print(f'Verified {license_count} complete retained license/notice texts')
if len(sys.argv) > 1:
    donor = Path(sys.argv[1])
    git = lambda *args: subprocess.check_output(['git', '-C', str(donor), *args], text=True).strip()
    assert git('rev-parse', 'HEAD') == m['commit']
    assert git('rev-parse', 'HEAD^{tree}') == m['tree']
    for f in m['donorFiles']:
        assert sha(donor / f['path']) == f['sha256'], f['path']
        assert git('rev-parse', f"HEAD:{f['path']}") == f['gitBlob'], f['path']
print(f"Verified {len(m['copiedArtifacts'])} donor-derived artifacts and {len(actual)} pinned dependencies")
