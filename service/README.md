# Running `reading-list-syncd` as a background service

`reading-list-syncd` (source under [`native/`](../native/)) needs to be
running before the extension has anything to talk to (see the main
[README](../README.md)). Two things need installing, on every platform:

1. **The background daemon** (`serve` mode) — these configs let it start
   automatically at login/boot instead of having to launch it by hand in a
   terminal every time. It does the actual peer-to-peer sync and owns the
   CSV ledger.
2. **The Native Messaging host manifest** — a small JSON file that tells
   Chrome it's allowed to spawn `reading-list-syncd` (bridge mode, no
   arguments) on this extension's behalf. Without it, `chrome.runtime.
   sendNativeMessage` fails with "Specified native messaging host not
   found." regardless of whether the daemon is running.

   **Every Chromium-based browser keeps its own, separate copy of this
   file** — Chrome, Brave, Edge, Vivaldi, etc. each read only their own
   profile directory, not a shared one. `make install-native-host` (and the
   Windows script) write to all the common ones listed in the `Makefile`'s
   `NMH_DIRS_linux`/`NMH_DIRS_darwin`; if "host not found" persists after
   installing, check you're testing in one of those browsers, or add yours
   to that list (same one-line pattern, then re-run `make
   install-native-host`).

Both are pinned to this extension's fixed ID (`abnldgaciobpabmoffpkalojiihoollj`,
baked into `manifest.json`'s `"key"` so it doesn't change across machines) —
if you re-key the extension, update `EXT_ID` in the `Makefile` (or
`-ExtensionId` on Windows) to match.

## Linux (systemd --user)

Handled by the `Makefile` at the repo root:

```bash
make install     # builds the daemon, installs the service AND the native host
make status-service
make logs-service
make uninstall
```

Or do the two pieces separately: `make install-service` / `make
install-native-host`. `install-service` depends on a `build-daemon` target
that runs `cargo build --release` in `native/reading-list-syncd/`
automatically — no manual build step needed, as long as `cargo` is on your
`PATH`.

All variables (`SYNCD_DEVICE`, `SYNCD_DATA_DIR`, `SYNCD_PORT`,
`SYNCD_BOOTSTRAP`) have sane defaults — see the top of the `Makefile`.
There's no secret to pass here: Chrome's own Native Messaging origin check
(`allowed_origins`, see above) plus the daemon's loopback-only local API are
what gate access now. The service is installed per-user (`systemctl
--user`), starts on login, and restarts automatically on failure. If you
want it running even when you're logged out (e.g. a headless box), enable
lingering once:

```bash
loginctl enable-linger $(whoami)
```

## macOS (launchd + Makefile)

The **daemon** uses a launchd plist (Make's native-messaging-host target
already handles macOS paths, see below):

1. Copy the template and fill in the placeholders (your username and the
   actual path to the `reading-list-syncd` binary):
   ```bash
   cp service/macos/com.antoniopicone.reading-list-syncd.plist ~/Library/LaunchAgents/
   $EDITOR ~/Library/LaunchAgents/com.antoniopicone.reading-list-syncd.plist
   ```
2. Load it:
   ```bash
   launchctl load -w ~/Library/LaunchAgents/com.antoniopicone.reading-list-syncd.plist
   ```
3. To uninstall:
   ```bash
   launchctl unload -w ~/Library/LaunchAgents/com.antoniopicone.reading-list-syncd.plist
   rm ~/Library/LaunchAgents/com.antoniopicone.reading-list-syncd.plist
   ```

`RunAtLoad` + `KeepAlive` make launchd start it at login and restart it if it
exits unexpectedly. Logs go to `~/.reading-list/reading-list-syncd.log` /
`.err.log` (paths set in the plist).

The **Native Messaging host manifest** is OS-aware in the same `Makefile`
used on Linux (it detects macOS via `uname` and writes to Chrome's and
Chromium's `Application Support` directories instead):

```bash
make build-daemon        # if you haven't already, via the plist step above
make install-native-host
```

## Windows (Scheduled Task + registry)

No extra dependencies (no NSSM needed). One script installs both the
Scheduled Task (the daemon) and the Native Messaging host (a registry key
under `HKCU\Software\Google\Chrome\NativeMessagingHosts` and the Chromium
equivalent, pointing at a manifest this script also writes):

```powershell
cd service\windows
.\install-reading-list-syncd.ps1 -SyncdBin "C:\path\to\reading-list-syncd.exe"
```

Uninstall (removes both):

```powershell
.\uninstall-reading-list-syncd.ps1
```

Run `Get-ScheduledTask -TaskName reading-list-syncd | Get-ScheduledTaskInfo`
to check the daemon's status, or open Task Scheduler → search for
"reading-list-syncd".
