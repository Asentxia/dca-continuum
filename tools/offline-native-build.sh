#!/usr/bin/env bash
# Explicit offline development build/tests; never called by product execution.
set -euo pipefail
cd "$(dirname "$0")/.."
: "${NEXUS_TOOLCHAIN_BIN:?Preinstall the pinned Rust 1.94.0 toolchain}"
: "${CARGO_HOME:?Prefetch the reviewed Cargo.lock dependency closure explicitly}"
mkdir -p .artifacts/implementation/native
bash tools/nexus-build.sh > .artifacts/implementation/native/NEXUS-BUILD.log 2>&1
NEXUS_NATIVE_TEST_ONLY=yes bash tools/nexus-test.sh > .artifacts/implementation/native/NEXUS-NATIVE.log 2>&1
RUSTC="$NEXUS_TOOLCHAIN_BIN/rustc" bash tools/aeon/build.sh > .artifacts/implementation/native/AEON-NATIVE.log 2>&1
printf 'Pinned native build/tests passed; no registry/provider request made by these offline commands.\n'
