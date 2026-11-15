import { app, protocol, dialog } from 'electron'
import process from 'node:process'
import App from './app.js'
import { startNetGuard } from './netguard.js'
import { registerForkSettingsIpc } from './forkSettings.js'

let main // Keep a global reference of the window object, if you don't, the window will, be closed automatically when the JavaScript object is garbage collected.

function createWindow () {
  main = new App()
}

// FORK PATCH (debrid-only): this is a Linux-only build. Refuse obviously and
// loudly everywhere else instead of failing confusingly inside the guard.
if (process.platform !== 'linux') {
  app.whenReady().then(() => {
    dialog.showErrorBox('Shiru-Debrid (Hardened Fork)', `This build targets Linux x64 (AppImage) only. This build does not run on ${process.platform}.`)
    app.exit(1)
  })
} else if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  // register extension:// for loading and testing local extensions
  protocol.registerSchemesAsPrivileged([
    { scheme: 'extension', privileges: { secure: true, standard: true, corsEnabled: true } }
  ])

  registerForkSettingsIpc() // FORK PATCH: exposes Settings → Fork to the renderer.
  startNetGuard() // FORK PATCH: app may only run while traffic exits through Mullvad.

  app.on('ready', createWindow)

  app.on('activate', () => {
    if (main == null) createWindow()
    else main.showAndFocus()
  })
}
