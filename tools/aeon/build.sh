#!/usr/bin/env bash
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
# Explicit toolchain may be supplied by trusted local setup; no downloads here.
rustc=${RUSTC:-rustc}
mkdir -p "$root/.artifacts/aeon"
python3 "$root/tools/aeon/verify-vendor.py"
"$rustc" --edition=2021 -D warnings "$root/tools/aeon/ranker.rs" -o "$root/.artifacts/aeon/ranker"
"$rustc" --edition=2021 -D warnings --test "$root/tools/aeon/ranker.rs" -o "$root/.artifacts/aeon/ranker-tests"
"$root/.artifacts/aeon/ranker-tests"
