'use strict';

const { exec } = require('child_process');

function run(cmd) {
  return new Promise((resolve) => {
    exec(cmd, { timeout: 4000, windowsHide: true }, (err, stdout) => {
      resolve(err ? '' : (stdout || ''));
    });
  });
}

const IPV4 = /\b(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\b/;

// Returns the default-route gateway IP, or null if it can't be determined.
async function detectGateway() {
  try {
    if (process.platform === 'win32') {
      const out = await run('chcp 65001 >NUL & ipconfig');
      for (const line of out.split(/\r?\n/)) {
        if (/default gateway/i.test(line)) {
          const m = line.match(IPV4);
          if (m && m[1] !== '0.0.0.0') return m[1];
        }
      }
      const rp = await run('route print -4');
      const m = rp.match(/^\s*0\.0\.0\.0\s+0\.0\.0\.0\s+(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/m);
      if (m) return m[1];
      return null;
    }
    if (process.platform === 'darwin') {
      const out = await run('route -n get default');
      const m = out.match(/gateway:\s*(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/i);
      return m ? m[1] : null;
    }
    // linux
    let out = await run('ip route show default');
    let m = out.match(/default via (\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/);
    if (m) return m[1];
    out = await run('route -n');
    m = out.match(/^0\.0\.0\.0\s+(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/m);
    return m ? m[1] : null;
  } catch (_) {
    return null;
  }
}

module.exports = { detectGateway };
