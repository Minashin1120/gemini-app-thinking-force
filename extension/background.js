/**
 * Service worker (MV3).
 * Opens the consent page ONCE after install. Never on updates once the user
 * has consented (or has already been prompted).
 */
(function () {
  "use strict";

  const CONSENT_KEY = "consent";
  const PROMPTED_KEY = "consentPromptedAt";

  function openWelcome() {
    chrome.tabs.create({ url: chrome.runtime.getURL("welcome.html") });
  }

  function promptOnce() {
    chrome.storage.local.get(PROMPTED_KEY).then((data) => {
      if (data[PROMPTED_KEY]) return; // already shown once
      chrome.storage.local.set({ [PROMPTED_KEY]: Date.now() });
      openWelcome();
    });
  }

  chrome.runtime.onInstalled.addListener((details) => {
    if (details.reason === "install") {
      // First install: always show the consent page.
      promptOnce();
      return;
    }
    if (details.reason === "update") {
      // Update: only prompt if the user never consented (e.g. upgrading from a
      // version without the consent flow). Never re-prompt after consent.
      chrome.storage.local.get(CONSENT_KEY).then((data) => {
        if (data[CONSENT_KEY]) return;
        promptOnce();
      });
    }
  });
})();
