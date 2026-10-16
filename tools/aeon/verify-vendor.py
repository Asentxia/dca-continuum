"""Exact selected donor bytes. Never fetches or accepts a replacement pin."""
from pathlib import Path
from hashlib import sha256
ROOT = Path(__file__).resolve().parents[2]
FILES = {
    'vendor/aeon/augmenter.rs': '86f974d75502d9f57c0790dbf3b61253b1dd60114d01d67910de008da5faca8c',
    'vendor/aeon/LICENSE': '046d505b195d400a42747cc576219b551d2989a302ebd2b2aea5c5d5609db3f9',
}
for name, expected in FILES.items():
    if sha256((ROOT / name).read_bytes()).hexdigest() != expected:
        raise SystemExit(f'AEON pin mismatch: {name}')
print('AEON selected donor bytes verified')
