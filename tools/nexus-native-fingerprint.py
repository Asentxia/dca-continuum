#!/usr/bin/env python3
"""Bind the explicitly prebuilt executable to exact native source, without building."""
import hashlib
import json
import sys
from pathlib import Path

root = Path(__file__).resolve().parents[1]
mode, binary_name, record_name = sys.argv[1:]
binary, record = Path(binary_name), Path(record_name)
paths = [p for base in ['tools/nexus-native', 'vendor/nexus']
         for p in (root / base).rglob('*') if p.is_file() and 'target' not in p.parts]
paths += [root / 'tools/nexus-build.sh', Path(__file__).resolve()]
sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
data = {'nativeSources': {str(p.relative_to(root)): sha(p) for p in sorted(paths)},
        'binarySha256': sha(binary)}
if mode == 'record':
    record.write_text(json.dumps(data, indent=2) + '\n')
elif mode == 'verify':
    if json.loads(record.read_text()) != data:
        raise SystemExit('Prebuilt native runtime/source mismatch; run explicit nexus-build.sh')
    print('Prebuilt native source/binary hashes verified')
else:
    raise SystemExit('Expected record or verify')
