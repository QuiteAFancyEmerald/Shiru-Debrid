# Shiru-Debrid

A personal, hardened local build of [Shiru](https://github.com/RockinChaos/Shiru), based on
the debrid architecture from [gabrieljcodes' PR #185](https://github.com/RockinChaos/Shiru/pull/185)
(`feat/debrid-and-hayase-v2`).

<p align="center">
  <a href="#installation"><img alt="Install Linux x64" src="https://img.shields.io/badge/Install-Linux_x64_AppImage-2ea44f?logo=gnu-bash&logoColor=white"></a>
  <a href="#build"><img alt="Build from source" src="https://img.shields.io/badge/Build-from_source-blue?logo=github&logoColor=white"></a>
  <img alt="Platform" src="https://img.shields.io/badge/Platform-Linux_x64_only-crimson?logo=linux&logoColor=white">
</p>

This fork tracks the upstream PR branch and adds local configuration on top: provider
plug-ins (kept independent and configured by each user inside the app), a permission
gate that requires an approved network path before playback, update checks that are
disabled unless the user opts in, and strict content-handling rules (no swarm
protocols, no local media storage, responses marked no-store).

This repository hosts no content and provides no media. It is a modified client for
an upstream GPLv3 project; you configure it with your own accounts and you are
responsible for what you watch with it.

---

## Installation

Prebuilt AppImages are published to this repository's
[**Releases** page](https://github.com/QuiteAFancyEmerald/Shiru-Debrid/releases) —
nothing is committed to the repository tree.

### Option A — prebuilt binary from GitHub Releases

1. Download the latest AppImage from the
   [Releases page](https://github.com/QuiteAFancyEmerald/Shiru-Debrid/releases/latest).
2. Install and run:
   ```bash
   install -m 0755 ~/Downloads/linux-shiru-debrid-*.AppImage ~/.local/bin/
   ~/.local/bin/shiru-debrid-*.AppImage
   ```

### Option B — build from source

Requirements: Node 24+, pnpm 12.17.0.

```bash
git clone https://github.com/QuiteAFancyEmerald/Shiru-Debrid.git
cd Shiru-Debrid/electron
pnpm install --frozen-lockfile
pnpm exec electron-builder --linux AppImage
install -m 0755 dist/linux-shiru-debrid-*.AppImage ~/.local/bin/
```

On CachyOS, `scripts/build-cachyos.sh` in the repository root builds an
additionally optimized variant instead (pinned to the build CPU; local use only).

### First run

All configuration happens inside the application under **Settings**:

- **Debrid** — provider selection, key, playback mode, streaming behavior
- **Fork** — network gate (on by default), update checks (off by default)
- **Client** — connection settings (DHT/PEX disabled by default here)
- **Player / Interface / Profiles** — standard upstream options

## Updates

The build never checks for anything by default, and its update feed points only at
this repository's fork. Checks can be enabled (notify + link only) in
**Settings → Fork**.

## CI

`.github/workflows/build.yml` (manual dispatch) builds the AppImage and **publishes it to
GitHub Releases**. `.github/workflows/quality.yml` runs lint/typecheck on push.

## Build notes

- Linux x64 AppImage is the only supported target.
- glibc floor ≈ 2.25 (runs on any modern distro; verified symbol levels).
- `scripts/build-cachyos.sh` produces a locally tuned variant on CachyOS/Arch hosts
  (`-march=native` + LTO; do not distribute that variant).

## Attribution

- Upstream project: [RockinChaos/Shiru](https://github.com/RockinChaos/Shiru) — GPLv3.
- Feature base: [gabrieljcodes/Shiru](https://github.com/gabrieljcodes/Shiru) / [PR #185](https://github.com/RockinChaos/Shiru/pull/185).

Like upstream, this fork is a media *client*: it hosts, distributes, and provides no
media, and playback is limited to files and accounts the user supplies.
