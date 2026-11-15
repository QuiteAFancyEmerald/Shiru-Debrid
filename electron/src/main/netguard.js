/**
 * FORK PATCH: refuse to run (and keep refusing while running) unless the
 * machine is connected through Tailscale or Mullvad. Wired from main.js.
 */
import { app, dialog } from 'electron'
import process from 'node:process'
import { development } from './util.js'
import { isCompliant } from './netcheck.js'
import { getForkSettings } from './forkSettings.js'

const STARTUP_RETRY_MS = 5_000
const STARTUP_MAX_WAIT_MS = 30_000
const RUNTIME_CHECK_INTERVAL_MS = 15_000
const RUNTIME_MAX_FAILED_CHECKS = 3

function enforce(message) {
  console.log(`[netguard] ${message}`)
  dialog.showMessageBoxSync({
    type: 'error',
    title: 'Shiru (Debrid Fork)',
    message,
    buttons: ['Quit'],
    noLink: true
  })
  app.exit(1)
}
export function startNetGuard() {
  if (process.env.SHIRU_FORK_NO_GUARD) return
  if (development) return
  if (!getForkSettings().netGuard) {
    console.log('[netguard] disabled in Settings → Fork.')
    return
  }

  let runtimeFailures = 0
  let quitScheduled = false

  app.whenReady().then(() => {
    const startedAt = Date.now()
    const startupLoop = setInterval(async () => {
      let result
      try {
        result = await isCompliant()
      } catch {
        return // transient detection error, extend the startup grace
      }
      if (result.compliant) {
        clearInterval(startupLoop)
        setInterval(async () => {
          if (quitScheduled) return
          try {
            const check = await isCompliant()
            if (check.compliant) {
              runtimeFailures = 0
              return
            }
          } catch {
            return
          }
          if (++runtimeFailures >= RUNTIME_MAX_FAILED_CHECKS) {
            quitScheduled = true
            enforce('Mullvad exit/tunnel connectivity was lost. Shiru (Debrid Fork) is closing to keep its traffic off your normal connection.')
          }
        }, RUNTIME_CHECK_INTERVAL_MS).unref?.()
        return
      }
      if (Date.now() - startedAt >= STARTUP_MAX_WAIT_MS) {
        clearInterval(startupLoop)
        enforce('Shiru (Debrid Fork) requires an active Mullvad exit node (via Tailscale) or a Mullvad tunnel. Enable one, then start the app again.')
      }
    }, STARTUP_RETRY_MS)
    startupLoop.unref?.()
  }).catch(() => {})
}
