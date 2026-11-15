/**
 * FORK PATCH: user-facing settings for fork-specific behavior (network guard,
 * update policy). Persisted as JSON in the app data directory, independent of
 * the renderer's IndexedDB settings store so they are readable before any
 * window exists. Exposed to the Settings → Fork tab over IPC.
 */
import { app, ipcMain } from 'electron'
import Store from './store.js'

const SETTINGS_FILE = 'fork-settings.json'
const DEFAULTS = { netGuard: true, updatePolicy: 'off' }

/** @type {Store} */
const store = new Store(app.getPath('userData'), SETTINGS_FILE, DEFAULTS)

export function getForkSettings() {
  return {
    netGuard: store.get('netGuard') === undefined ? DEFAULTS.netGuard : Boolean(store.get('netGuard')),
    updatePolicy: store.get('updatePolicy') === 'fork' ? 'fork' : 'off'
  }
}

export function setForkSettings(patch) {
  if (patch && typeof patch === 'object') {
    if (typeof patch.netGuard === 'boolean') store.set('netGuard', patch.netGuard)
    if (patch.updatePolicy === 'fork' || patch.updatePolicy === 'off') store.set('updatePolicy', patch.updatePolicy)
  }
  return getForkSettings()
}

export function registerForkSettingsIpc() {
  ipcMain.handle('common:forkSettingsGet', () => getForkSettings())
  ipcMain.handle('common:forkSettingsSet', (_event, patch) => setForkSettings(patch))
}
