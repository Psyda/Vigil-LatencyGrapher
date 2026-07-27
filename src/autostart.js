'use strict';

const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

// Linux has no login-item API in Electron, so we manage an autostart entry.
const LINUX_DESKTOP = path.join(os.homedir(), '.config', 'autostart', 'vigil.desktop');

// Launch arguments so an auto-started instance opens straight to the tray
// instead of popping the window on every boot. main.js reads '--hidden'.
function launchArgs() {
  // Packaged: execPath is the app binary, just pass the flag.
  // Dev (electron .): execPath is the electron binary, so it also needs the app path.
  return app.isPackaged ? ['--hidden'] : [app.getAppPath(), '--hidden'];
}

function setAutostart(enabled) {
  try {
    if (process.platform === 'linux') {
      if (enabled) {
        fs.mkdirSync(path.dirname(LINUX_DESKTOP), { recursive: true });
        const exec = `"${process.execPath}" ${launchArgs().map((a) => (a.includes(' ') ? `"${a}"` : a)).join(' ')}`;
        const content = [
          '[Desktop Entry]',
          'Type=Application',
          'Name=Vigil',
          'Comment=Network latency and packet-loss monitor',
          `Exec=${exec}`,
          'Terminal=false',
          'X-GNOME-Autostart-enabled=true',
          '',
        ].join('\n');
        fs.writeFileSync(LINUX_DESKTOP, content);
      } else if (fs.existsSync(LINUX_DESKTOP)) {
        fs.unlinkSync(LINUX_DESKTOP);
      }
      return enabled;
    }

    // win32 + darwin
    const opts = { openAtLogin: enabled, openAsHidden: enabled };
    if (!app.isPackaged) {
      // point the login item at the electron binary plus the app path in dev
      opts.path = process.execPath;
      opts.args = launchArgs();
    } else if (process.platform === 'win32') {
      opts.args = ['--hidden'];
    }
    app.setLoginItemSettings(opts);
    return enabled;
  } catch (_) {
    return false;
  }
}

function getAutostart() {
  try {
    if (process.platform === 'linux') return fs.existsSync(LINUX_DESKTOP);
    return app.getLoginItemSettings().openAtLogin;
  } catch (_) {
    return false;
  }
}

module.exports = { setAutostart, getAutostart };
