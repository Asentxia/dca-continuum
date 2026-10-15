#!/usr/bin/env bash
# Explicit local qualification only: no DB, provider, registry or runtime auto-build.
set -euo pipefail
cd "$(dirname "$0")/.."
: "${NEXUS_TOOLCHAIN_BIN:?Set directory of preinstalled Rust 1.94.0 binaries}"
: "${CARGO_HOME:?Set reviewed Cargo registry cache directory}"
"$NEXUS_TOOLCHAIN_BIN/rustc" --version | grep -q '^rustc 1\.94\.0 '
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$PWD/.artifacts/nexus-target}"
export NEXUS_NATIVE_BINARY="${NEXUS_NATIVE_BINARY:-$CARGO_TARGET_DIR/debug/continuum-nexus-bridge}"
test -x "$NEXUS_NATIVE_BINARY" || { echo 'Run explicit tools/nexus-build.sh first' >&2; exit 1; }
python3 tools/nexus-native-fingerprint.py verify "$NEXUS_NATIVE_BINARY" "$CARGO_TARGET_DIR/nexus-build.json"
python3 tools/nexus-verify-provenance.py
mkdir -p .artifacts/nexus
cargo_local() {
  env -i HOME="$HOME" PATH="$NEXUS_TOOLCHAIN_BIN:/usr/bin:/bin" CARGO_HOME="$CARGO_HOME" \
    CARGO_TARGET_DIR="$CARGO_TARGET_DIR" RUSTC="$NEXUS_TOOLCHAIN_BIN/rustc" \
    "$NEXUS_TOOLCHAIN_BIN/cargo" "$@" --offline --locked --manifest-path tools/nexus-native/Cargo.toml
}
cargo_local test -j 2
# Recompile WAT fixtures offline in a temporary directory and compare exact bytes.
fixtures="$(mktemp -d "$PWD/.artifacts/nexus/fixtures.XXXXXX")"
trap 'rm -rf "$fixtures"' EXIT
cp tests/nexus/fixtures/*.wat "$fixtures/"
env -i HOME="$HOME" PATH="$NEXUS_TOOLCHAIN_BIN:/usr/bin:/bin" CARGO_HOME="$CARGO_HOME" \
  CARGO_TARGET_DIR="$CARGO_TARGET_DIR" RUSTC="$NEXUS_TOOLCHAIN_BIN/rustc" \
  "$NEXUS_TOOLCHAIN_BIN/cargo" run --offline --locked --manifest-path tools/nexus-native/Cargo.toml --example fixtures -- "$fixtures"
for f in tests/nexus/fixtures/*.wasm; do cmp "$f" "$fixtures/$(basename "$f")"; done
node node_modules/typescript/bin/tsc --pretty false
node --test dist/tests/nexus/local.test.js dist/tests/bounded-computation-contract.test.js
python3 tools/nexus-fingerprint.py > .artifacts/nexus/source-fingerprint.json
