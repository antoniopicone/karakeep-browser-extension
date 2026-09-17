// Client for the embedded reading-list-syncd daemon (see native/) via
// Chrome's Native Messaging — replaces the old HTTP+encryption client that
// talked to a generic, separately-installed syncd. There's no port or
// secret to configure anymore: Chrome itself gates which extension can
// reach this host (see the native-messaging-host.json manifest, whose
// allowed_origins is pinned to this extension's fixed ID via manifest.json's
// "key"), and the daemon is loopback-only besides.
//
// The host process is short-lived by design (see native/reading-list-syncd's
// module doc comment): Chrome spawns it fresh per sendNativeMessage call and
// it just bridges this one message to the long-running `serve` daemon's
// local HTTP API, so plain one-shot sendNativeMessage (rather than a
// long-lived connectNative port) is the right fit — we don't need push
// notifications from it, chrome.alarms polling (see background.js) already
// covers picking up changes from other synced devices.
const NATIVE_HOST = 'com.antoniopicone.reading_list_syncd';

function nativeSendMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendNativeMessage(NATIVE_HOST, message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!response) {
        reject(new Error('no response from the native sync host'));
        return;
      }
      if (response.error) {
        reject(new Error(response.error));
        return;
      }
      resolve(response);
    });
  });
}

// { entity: "key", value: "..." } (or value: null to delete) -> { seq, vv }
async function syncdWrite(entity, value) {
  return nativeSendMessage({ type: 'write', entity, value });
}

// -> { device, entries: [{entity, value}, ...], vv, fingerprint }
async function syncdState() {
  return nativeSendMessage({ type: 'state' });
}
