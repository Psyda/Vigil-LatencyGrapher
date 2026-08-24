# Packaging

Everything needed to build the distributable releases lives here. End users never need Node or npm, only the build machine does.

## Build a release

Double-click `make-release.cmd`, or from the repo root run:

```bash
npm install
npx electron-builder --win
```

Three artifacts land in `release/` (gitignored), all named with the version from `package.json`:

| Artifact | What it is |
|---|---|
| `Vigil-<version>-Setup.exe` | Assisted per-user installer. No admin rights needed. Includes a "Start Vigil when I sign in" page with the box checked by default, wired to the same registry entry the in-app settings toggle manages. |
| `Vigil-<version>-Portable.exe` | Single self-contained exe. Run it from anywhere, nothing is installed. |
| `Vigil-<version>-win.zip` | Plain zip of the unpacked app folder, for people who prefer to extract and run `Vigil.exe` themselves. |

To ship an update: bump `version` in `package.json`, run the build again, and publish the three new files.

## Files here

| File | Purpose |
|---|---|
| `icon.ico` | Multi-size app icon (16 to 256px), used for the exe, installer, and shortcuts |
| `icon.png` | 256px icon for macOS and Linux targets |
| `installer.nsh` | NSIS additions: the start-at-login page and its registry wiring, cleaned up on uninstall |
| `make-release.cmd` | One-click build script |

## Notes

The builds are unsigned, so Windows SmartScreen will warn on first run of downloaded copies. Users click "More info" then "Run anyway". Code signing would remove that but needs a paid certificate.

All three artifacts share the same per-user data folder (`%APPDATA%\Vigil`), so history and settings survive switching between the installer and portable builds, and uninstalling keeps the recorded history.
