/**
 * Isolated-world content script.
 * Bridges MAIN world page-hook <-> extension popup (consent + status only).
 */
(function () {
  "use strict";

  const PAGE_SOURCE = "gemini-thinking-auto";
  const BRIDGE_SOURCE = "gemini-thinking-auto-bridge";
  const CONSENT_KEY = "consent";

  /**
   * Tell the MAIN-world page-hook whether the user accepted the ToS / privacy
   * policy. Auto-enable stays disabled until consent is granted.
   */
  function postConsent() {
    chrome.storage.local.get(CONSENT_KEY).then(({ consent }) => {
      window.postMessage(
        {
          source: BRIDGE_SOURCE,
          type: "consentResult",
          payload: { accepted: !!consent },
        },
        "*"
      );
    });
  }

  postConsent();
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && Object.prototype.hasOwnProperty.call(changes, CONSENT_KEY)) {
      postConsent();
    }
  });

  /** @type {any} */
  let lastState = null;
  let ready = false;

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== PAGE_SOURCE) return;

    if (data.type === "state" || data.type === "ready") {
      lastState = data.payload;
      ready = true;
    }
  });

  function askPage(type) {
    window.postMessage({ source: BRIDGE_SOURCE, type }, "*");
  }

  function requestState(timeoutMs) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (payload) => {
        if (done) return;
        done = true;
        window.removeEventListener("message", onMessage);
        resolve(payload);
      };

      const onMessage = (event) => {
        if (event.source !== window) return;
        const data = event.data;
        if (!data || data.source !== PAGE_SOURCE) return;
        if (data.type === "state") {
          lastState = data.payload;
          ready = true;
          finish(data.payload);
        }
      };

      window.addEventListener("message", onMessage);
      askPage("getState");
      setTimeout(() => finish(null), timeoutMs || 200);
    });
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || !message.type) return;

    if (message.type === "ping") {
      sendResponse({ ok: true, ready });
      return false;
    }

    if (message.type === "getState") {
      requestState(250).then(() => {
        sendResponse({ ok: true, state: lastState, ready });
      });
      return true;
    }

    if (message.type === "enableNow") {
      askPage("enableNow");
      sendResponse({ ok: true });
      return false;
    }
  });

  setTimeout(() => askPage("getState"), 1000);
})();
