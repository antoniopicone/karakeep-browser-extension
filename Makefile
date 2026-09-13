# Builds and installs reading-list-syncd (native/reading-list-syncd/) — the
# background sync daemon embedded in this extension — plus the Chrome
# Native Messaging host manifest the extension uses to reach it. No
# external service, no separate daemon to install by hand: this project
# owns the whole thing, source included, under native/.
#
# Two pieces get installed, both needed:
#   1. a systemd --user service (Linux; see service/macos and
#      service/windows for the launchd/Task Scheduler equivalents) running
#      `reading-list-syncd serve` in the background, so it starts on login,
#      restarts on failure, and does the actual peer-to-peer sync;
#   2. a Native Messaging host manifest, telling Chrome it's allowed to
#      spawn `reading-list-syncd` (with no arguments — bridge mode, see the
#      binary's own module doc comment) on this extension's behalf.
#
# Usage:
#   make install-service        # build the daemon, install it as a service
#   make install-native-host    # register the Native Messaging host
#   make install                # both of the above
#   make build-daemon           # just compile, nothing installed
#   make uninstall
#   make status-service
#   make logs-service
#
# There's no port or secret to pass here: Chrome's Native Messaging origin
# check (allowed_origins, pinned to this extension's fixed ID via
# manifest.json's "key") plus the daemon's loopback-only local API replace
# the old per-application secret this project used before it embedded its
# own daemon — see the top-level README's "Security model" section.

DAEMON_DIR      := $(CURDIR)/native/reading-list-syncd
DAEMON_BIN      := $(DAEMON_DIR)/target/release/reading-list-syncd
EXT_ID          := abnldgaciobpabmoffpkalojiihoollj

SERVICE_NAME    := reading-list-syncd
SYSTEMD_USER_DIR := $(HOME)/.config/systemd/user
UNIT_FILE       := $(SYSTEMD_USER_DIR)/$(SERVICE_NAME).service
UNIT_TEMPLATE   := service/linux/reading-list-syncd.service.template
NMH_TEMPLATE    := service/native-messaging-host.json.template
NMH_NAME        := com.antoniopicone.reading_list_syncd.json

# Overridable: `make install-service SYNCD_DEVICE=... SYNCD_PORT=...`
SYNCD_DEVICE      ?= $(shell hostname)
SYNCD_DATA_DIR    ?= $(HOME)/.reading-list
SYNCD_PORT        ?= 47100
SYNCD_BOOTSTRAP   ?=

EXEC_START := $(DAEMON_BIN) serve --device $(SYNCD_DEVICE) --data $(SYNCD_DATA_DIR)/reading-list.csv --port $(SYNCD_PORT)
ifneq ($(strip $(SYNCD_BOOTSTRAP)),)
EXEC_START += --bootstrap $(SYNCD_BOOTSTRAP)
endif

# Native Messaging host manifest locations the major Chromium-based
# browsers look in on Linux and macOS (installing to all of them is
# harmless — a manifest for a browser that isn't installed just sits there
# unused). Each browser vendor uses its own profile root, not a shared one,
# so Chrome's manifest is invisible to Brave/Edge/Vivaldi and vice versa —
# add another line here (same pattern) for any other Chromium browser you
# use that isn't listed.
NMH_DIRS_linux := \
	$(HOME)/.config/google-chrome/NativeMessagingHosts \
	$(HOME)/.config/chromium/NativeMessagingHosts \
	$(HOME)/.config/BraveSoftware/Brave-Browser/NativeMessagingHosts \
	$(HOME)/.config/microsoft-edge/NativeMessagingHosts \
	$(HOME)/.config/vivaldi/NativeMessagingHosts
NMH_DIRS_darwin := \
	"$(HOME)/Library/Application Support/Google/Chrome/NativeMessagingHosts" \
	"$(HOME)/Library/Application Support/Chromium/NativeMessagingHosts" \
	"$(HOME)/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts" \
	"$(HOME)/Library/Application Support/Microsoft Edge/NativeMessagingHosts" \
	"$(HOME)/Library/Application Support/Vivaldi/NativeMessagingHosts"
UNAME := $(shell uname -s)
ifeq ($(UNAME),Darwin)
NMH_DIRS := $(NMH_DIRS_darwin)
else
NMH_DIRS := $(NMH_DIRS_linux)
endif

.PHONY: install install-service uninstall uninstall-service install-native-host uninstall-native-host status-service logs-service build-daemon

# Compiles reading-list-syncd in release mode. Safe to re-run: it's a no-op
# if the binary already exists.
build-daemon:
	@if [ -x "$(DAEMON_BIN)" ]; then \
		echo "reading-list-syncd already built at $(DAEMON_BIN)"; \
	else \
		command -v cargo >/dev/null 2>&1 || { echo "error: cargo not found — install Rust first (https://rustup.rs/)"; exit 1; }; \
		(cd $(DAEMON_DIR) && cargo build --release) && echo "reading-list-syncd built at $(DAEMON_BIN)"; \
	fi

install: install-service install-native-host

install-service: build-daemon
	@if [ ! -x "$(DAEMON_BIN)" ]; then \
		echo "error: reading-list-syncd binary not found or not executable at $(DAEMON_BIN)"; \
		echo "  build it first (make build-daemon)"; \
		exit 1; \
	fi
	mkdir -p $(SYSTEMD_USER_DIR)
	sed 's#__EXEC_START__#$(EXEC_START)#' $(UNIT_TEMPLATE) > $(UNIT_FILE)
	systemctl --user daemon-reload
	systemctl --user enable --now $(SERVICE_NAME).service
	@echo "reading-list-syncd installed and started as a systemd --user service (port $(SYNCD_PORT), ledger $(SYNCD_DATA_DIR)/reading-list.csv)."
	@echo "It will now also start automatically on login. Enable lingering with"
	@echo "  loginctl enable-linger $$(whoami)"
	@echo "if you want it running even when you're not logged in."
	@echo "Run 'make install-native-host' too (or 'make install' for both) so the extension can reach it."

# Registers reading-list-syncd as a Chrome Native Messaging host, scoped to
# this extension's fixed ID (see manifest.json's "key" and this Makefile's
# EXT_ID) — this is what lets background.js/sidepanel.js/options.js call
# chrome.runtime.sendNativeMessage instead of talking to a port directly.
install-native-host: build-daemon
	@for dir in $(NMH_DIRS); do \
		mkdir -p "$$dir"; \
		sed -e 's#__PATH__#$(DAEMON_BIN)#' -e 's#__EXT_ID__#$(EXT_ID)#' $(NMH_TEMPLATE) > "$$dir/$(NMH_NAME)"; \
		echo "installed native messaging host manifest: $$dir/$(NMH_NAME)"; \
	done
	@echo "If you loaded the extension unpacked with a different ID than $(EXT_ID), edit manifest.json's \"key\" back to the committed value, or Chrome will refuse to reach this host."

uninstall: uninstall-service uninstall-native-host

uninstall-service:
	-systemctl --user disable --now $(SERVICE_NAME).service
	rm -f $(UNIT_FILE)
	systemctl --user daemon-reload
	@echo "reading-list-syncd service removed. Your ledger under $(SYNCD_DATA_DIR) is left untouched."

uninstall-native-host:
	@for dir in $(NMH_DIRS); do \
		rm -f "$$dir/$(NMH_NAME)"; \
	done
	@echo "native messaging host manifest removed."

status-service:
	systemctl --user status $(SERVICE_NAME).service

logs-service:
	journalctl --user -u $(SERVICE_NAME).service -f
