# Installs/uninstalls `syncd` (github.com/antoniopicone/serverless-sync) as a
# systemd --user service, so it starts automatically on login and restarts on
# failure instead of having to be launched by hand in a terminal.
#
# Linux only — see service/macos and service/windows for the equivalent
# manual setup on those platforms.
#
# Usage:
#   make install-service SYNCD_BIN=/path/to/syncd SYNCD_AUTH_TOKEN=secret
#   make uninstall-service
#   make status-service
#   make logs-service

SERVICE_NAME    := syncd
SYSTEMD_USER_DIR := $(HOME)/.config/systemd/user
UNIT_FILE       := $(SYSTEMD_USER_DIR)/$(SERVICE_NAME).service
UNIT_TEMPLATE   := service/linux/syncd.service.template

# Overridable: `make install-service SYNCD_BIN=... SYNCD_DEVICE=...`
SYNCD_BIN        ?= $(HOME)/Developer/serverless-sync/target/release/syncd
SYNCD_DEVICE      ?= $(shell hostname)
SYNCD_DATA_DIR    ?= $(HOME)/.syncd
SYNCD_PORT        ?= 47100
SYNCD_AUTH_TOKEN  ?=
SYNCD_BOOTSTRAP   ?=

EXEC_START := $(SYNCD_BIN) --device $(SYNCD_DEVICE) --data-dir $(SYNCD_DATA_DIR) --port $(SYNCD_PORT)
ifneq ($(strip $(SYNCD_AUTH_TOKEN)),)
EXEC_START += --auth-token $(SYNCD_AUTH_TOKEN)
endif
ifneq ($(strip $(SYNCD_BOOTSTRAP)),)
EXEC_START += --bootstrap $(SYNCD_BOOTSTRAP)
endif

.PHONY: install-service uninstall-service status-service logs-service

install-service:
	@if [ ! -x "$(SYNCD_BIN)" ]; then \
		echo "error: syncd binary not found or not executable at $(SYNCD_BIN)"; \
		echo "  build it first (cd serverless-sync && cargo build --release), or pass SYNCD_BIN=/path/to/syncd"; \
		exit 1; \
	fi
	mkdir -p $(SYSTEMD_USER_DIR)
	sed 's#__EXEC_START__#$(EXEC_START)#' $(UNIT_TEMPLATE) > $(UNIT_FILE)
	systemctl --user daemon-reload
	systemctl --user enable --now $(SERVICE_NAME).service
	@echo "syncd installed and started as a systemd --user service (port $(SYNCD_PORT), data dir $(SYNCD_DATA_DIR))."
	@echo "It will now also start automatically on login. Enable lingering with"
	@echo "  loginctl enable-linger $$(whoami)"
	@echo "if you want it running even when you're not logged in."

uninstall-service:
	-systemctl --user disable --now $(SERVICE_NAME).service
	rm -f $(UNIT_FILE)
	systemctl --user daemon-reload
	@echo "syncd service removed. Data on disk under $(SYNCD_DATA_DIR) is left untouched."

status-service:
	systemctl --user status $(SERVICE_NAME).service

logs-service:
	journalctl --user -u $(SERVICE_NAME).service -f
