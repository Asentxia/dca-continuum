#!/usr/bin/env python3
"""Fingerprint all NEXUS native/adapter/tests/notices, excluding generated targets."""
import hashlib
import json
from pathlib import Path

root = Path(__file__).resolve().parents[1]
paths = set()
for pattern in ['src/nexus*', 'tests/nexus/**/*', 'tools/nexus*', 'vendor/nexus/**/*',
                'docs/integrations/NEXUS*']:
    for path in root.glob(pattern):
        if path.is_dir():
            paths.update(p for p in path.rglob('*') if p.is_file() and
                         not {'target', '__pycache__'} & set(p.relative_to(root).parts))
        elif path.is_file():
            paths.add(path)
for p in ['src/bounded-computation-contract.ts', 'tests/bounded-computation-contract.test.ts',
          'src/db.ts', 'src/provider-adapter.ts', 'docs/M1-SAFETY-CONTRACTS.md',
          'docs/M1-CONTRACT-EXTENSION-v2.md', 'docs/M1-CONTRACT-EXTENSION-v3.md',
          'docs/M1-CONTRACT-EXTENSION-v4.md', 'docs/RECOVERY-CONTRACT-v0.2.md',
          'qualification/PRODUCTION-GATES.json', 'docs/RELEASE-GATES.json']:
    paths.add(root / p)
files = {str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(paths)}
encoded = json.dumps(files, sort_keys=True, separators=(',', ':')).encode()
print(json.dumps({'profile': 'nexus-local-i32-v1', 'files': files,
                  'sourceSha256': hashlib.sha256(encoded).hexdigest()}, indent=2))
