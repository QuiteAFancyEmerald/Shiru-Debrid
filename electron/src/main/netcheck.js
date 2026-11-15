/**
 * Network compliance detection for the local Shiru fork build.
 *
 * FORK PATCH: the app is only allowed to run while the machine's default
 * route genuinely exits through Mullvad — either a Tailscale exit node
 * (policy table on Linux, tunnel device elsewhere) or the Mullvad app /
 * another Mullvad-style tunnel. A running tailnet without an exit node is
 * NOT compliant, because internet traffic would leave through the physical
 * connection.
 *
 * Cross-platform notes: the Tailscale and Mullvad CLIs work on Linux,
 * Windows and macOS; the route-table checks are best-effort per platform
 * (iproute2 policy table on Linux, netstat/route elsewhere). When neither
 * CLI is available on a non-Linux platform the check degrades to the route
 * probe only; guard behavior remains fail-closed.
 * This module is intentionally Electron-free so its logic can be tested
 * with plain node.
 */
import { execFile } from 'node:child_process'
import process from 'node:process'

const TUNNEL_INTERFACE_PREFIX = /^(mullvad|wg|tun|tailscale|utun)/i

function sh(command, args) {
  return new Promise(resolve => {
    execFile(command, args, { timeout: 5000, windowsHide: true }, (error, stdout) => resolve({ error, stdout }))
  })
}

async function commandExists(command) {
  const lister = process.platform === 'win32' ? 'where' : 'which'
  const { error, stdout } = await sh(lister, [command])
  return !error && String(stdout).trim().length > 0
}

/**
 * The interface carrying the default route, per platform.
 * Returns null when undetectable (the caller relies on CLI checks instead).
 */
async function defaultRouteDevice() {
  if (process.platform === 'linux') {
    const { error, stdout } = await sh('ip', ['route', 'show', 'default'])
    if (error) return null
    for (const match of String(stdout).matchAll(/\bdev\s+(\S+)/g)) {
      if (match[1]) return match[1]
    }
    return null
  }
  if (process.platform === 'darwin') {
    const { error, stdout } = await sh('route', ['-n', 'get', 'default'])
    if (error) return null
    const match = /interface:\s+(\S+)/.exec(String(stdout))
    return match ? match[1] : null
  }
  if (process.platform === 'win32') {
    const { error, stdout } = await sh('route', ['print', '0.0.0.0'])
    if (error) return null
    // Active default route rows: `0.0.0.0  0.0.0.0  <gateway>  <gateway>  <metric>` (metric column absent pre-Win10)
    for (const line of String(stdout).split('\n')) {
      const columns = line.trim().split(/\s{2,}/)
      if (columns.length >= 4 && columns[0] === '0.0.0.0' && columns[1] === '0.0.0.0') {
        return columns[3] || null
      }
    }
    return null
  }
  return null
}

/**
 * Mullvad compliance: the Mullvad daemon reports a connected tunnel, or the
 * default route exits through a tunnel interface (mullvad-tun0/wg0/tunX or
 * tailscale0 with an active exit node).
 */
export async function mullvadExitActive() {
  if (await commandExists('mullvad')) {
    const { error, stdout } = await sh('mullvad', ['status'])
    if (!error && /^Connected/i.test(String(stdout).split('\n')[0].trim())) return true
    // FORK PATCH FIX: Disconnected/Connecting/Blocked must NOT short-circuit to
    // false — the Mullvad daemon can sit idle while a Tailscale exit node is
    // genuinely carrying the default route.
  }
  // FORK PATCH FIX: modern Tailscale installs exit-node routing as a policy
  // table (rule "lookup 52" + "default dev tailscale0" in table 52) while the
  // main table keeps the physical default. The main table alone therefore
  // lies — check the policy table first, then the classic main-table route.
  const policyTable = await sh('ip', ['route', 'show', 'table', '52'])
  if (!policyTable.error && /^\s*default\b/m.test(String(policyTable.stdout))) return true
  const device = await defaultRouteDevice()
  return Boolean(device && TUNNEL_INTERFACE_PREFIX.test(device))
}

export async function isCompliant() {
  let exitDevice = null

  // 1) Mullvad daemon explicitly connected (Mullvad app tunnel / CLI).
  if (await commandExists('mullvad')) {
    const { error, stdout } = await sh('mullvad', ['status'])
    if (!error && /^Connected/i.test(String(stdout).split('\n')[0].trim())) exitDevice = 'mullvad'
  }

  // 2) Tailscale exit node: modern Linux tailscaled routes exit traffic via a
  // policy table (rule "lookup 52" + "default dev tailscale0" in table 52)
  // while the main table keeps the physical default, so check that table on
  // Linux; other platforms rely on the CLI and main-table checks below.
  if (!exitDevice && process.platform === 'linux') {
    const policyTable = await sh('ip', ['route', 'show', 'table', '52'])
    if (!policyTable.error) {
      const match = /^\s*default\s+dev\s+(\S+)/m.exec(String(policyTable.stdout))
      if (match) exitDevice = match[1]
    }
  }

  // 3) Classic fallbacks: older Tailscale builds (main-table default via
  // tailscale0), wg-quick tunnels (wg0), the Mullvad app tunnel (mullvad-tun0).
  if (!exitDevice) {
    const device = await defaultRouteDevice()
    if (device && TUNNEL_INTERFACE_PREFIX.test(device)) exitDevice = device
  }

  return { compliant: Boolean(exitDevice), exitDevice }
}
