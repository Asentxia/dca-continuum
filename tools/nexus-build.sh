#!/usr/bin/env bash
# Explicit setup/build command. Never called by executable ingress.
set -euo pipefail
cd "$(dirname "$0")/.."
: "${NEXUS_TOOLCHAIN_BIN:?Set directory of preinstalled Rust 1.94.0 binaries (not rustup proxies)}"
: "${CARGO_HOME:?Set reviewed Cargo registry cache directory}"
"$NEXUS_TOOLCHAIN_BIN/rustc" --version | grep -q '^rustc 1\.94\.0 '
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$PWD/.artifacts/nexus-target}"
mkdir -p "$CARGO_TARGET_DIR"
env -i HOME="$HOME" PATH="$NEXUS_TOOLCHAIN_BIN:/usr/bin:/bin" CARGO_HOME="$CARGO_HOME" \
  CARGO_TARGET_DIR="$CARGO_TARGET_DIR" RUSTC="$NEXUS_TOOLCHAIN_BIN/rustc" \
  "$NEXUS_TOOLCHAIN_BIN/cargo" build --offline --locked --manifest-path tools/nexus-native/Cargo.toml -j 2
"${NEXUS_PYTHON:-python3}" tools/nexus-native-fingerprint.py record "$CARGO_TARGET_DIR/debug/continuum-nexus-bridge" "$CARGO_TARGET_DIR/nexus-build.json"
printf 'Prebuilt runtime: %s/debug/continuum-nexus-bridge\n' "$CARGO_TARGET_DIR"
