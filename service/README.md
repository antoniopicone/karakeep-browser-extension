# Running `syncd` as a background service

`syncd` needs to be running before the extension has anything to talk to (see
the main [README](../README.md)). These configs let it start automatically —
at login/boot — instead of having to launch it by hand in a terminal every
time.

## Linux (systemd --user)

Handled by the `Makefile` at the repo root:

```bash
# build syncd first if you haven't:
#   cd ~/Developer/serverless-sync && cargo build --release

make install-service SYNCD_BIN=~/Developer/serverless-sync/target/release/syncd \
                      SYNCD_AUTH_TOKEN=your-token-here
make status-service
make logs-service
make uninstall-service
```

All variables (`SYNCD_BIN`, `SYNCD_DEVICE`, `SYNCD_DATA_DIR`, `SYNCD_PORT`,
`SYNCD_AUTH_TOKEN`, `SYNCD_BOOTSTRAP`) have sane defaults — see the top of the
`Makefile`. The service is installed per-user (`systemctl --user`), starts on
login, and restarts automatically on failure. If you want it running even
when you're logged out (e.g. a headless box), enable lingering once:

```bash
loginctl enable-linger $(whoami)
```

## macOS (launchd)

1. Copy the template and fill in the placeholders (your username, the actual
   path to the `syncd` binary, and optionally `--auth-token`):
   ```bash
   cp service/macos/com.antoniopicone.syncd.plist ~/Library/LaunchAgents/
   $EDITOR ~/Library/LaunchAgents/com.antoniopicone.syncd.plist
   ```
2. Load it:
   ```bash
   launchctl load -w ~/Library/LaunchAgents/com.antoniopicone.syncd.plist
   ```
3. To uninstall:
   ```bash
   launchctl unload -w ~/Library/LaunchAgents/com.antoniopicone.syncd.plist
   rm ~/Library/LaunchAgents/com.antoniopicone.syncd.plist
   ```

`RunAtLoad` + `KeepAlive` make launchd start it at login and restart it if it
exits unexpectedly. Logs go to `~/.syncd/syncd.log` / `syncd.err.log` (paths
set in the plist).

## Windows (Scheduled Task)

No extra dependencies (no NSSM needed) — uses a Scheduled Task that starts at
logon and restarts on failure.

```powershell
cd service\windows
.\install-syncd.ps1 -SyncdBin "C:\path\to\syncd.exe" -AuthToken "your-token-here"
```

Uninstall:

```powershell
.\uninstall-syncd.ps1
```

Run `Get-ScheduledTask -TaskName syncd | Get-ScheduledTaskInfo` to check its
status, or open Task Scheduler → search for "syncd".
