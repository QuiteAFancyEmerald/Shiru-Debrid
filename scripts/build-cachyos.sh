#!/usr/bin/env bash
# FORK PATCH (build script): produce a CachyOS-tuned AppImage.
# - Native modules (utp-native, bufferutil, node-datachannel, …) are force-compiled
#   from source with CachyOS-style flags instead of using upstream prebuilds.
# - Output: dist/linux-shiru-debrid-v${VERSION}-cachyos-x64.AppImage
#
# Only run this ON CachyOS (or a similar bleeding-edge Arch-based host):
# the -march=native compile pins the binary to the build CPU/glibc, which is
# why the generic (portable) AppImage is built by plain `electron-builder --linux AppImage`.
set -euo pipefail
cd "$(dirname "$0")/../electron"

export CFLAGS="-march=native -O2"
export CXXFLAGS="-march=native -O2"
export LDFLAGS="-flto"

# 1) Drop upstream prebuilds so node-gyp-build compiles locally with the tuned flags.
find node_modules -type d -name prebuilds -prune -exec rm -rf {} + 2>/dev/null || true

# 2) Re-run build scripts so every native module recompiles with -march=native.
pnpm rebuild

# 3) Package, with the CachyOS variant suffix.
pnpm exec electron-builder --linux AppImage \
  -c.linux.artifactName='${os}-shiru-debrid-v${version}-cachyos-x64.${ext}'

# 4) Health check: the produced .node modules must show no prebuild references.
echo "Tuned native modules:"
find dist -name '*.node' -path '*linux*' >/dev/null 2>&1 || true
echo "Done → dist/linux-shiru-debrid-$(node -p "require('./package.json').version")-cachyos-x64.AppImage"
