/**
 * Isolated-world content script.
 * Bridges MAIN world page-hook <-> extension popup.
 */
(function () {
  "use strict";

  const PAGE_SOURCE = "gemini-thinking-auto";
  const BRIDGE_SOURCE = "gemini-thinking-auto-bridge";
  const CONSENT_KEY = "consent";
  const MAX_LOGS = 2000;

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

  /** @type {any[]} */
  let logs = [];
  /** @type {any} */
  let lastState = null;
  let ready = false;

  function pushLog(entry) {
    if (!entry) return;
    logs.push(entry);
    if (logs.length > MAX_LOGS) logs = logs.slice(-MAX_LOGS);
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== PAGE_SOURCE) return;

    if (data.type === "log") {
      pushLog(data.payload);
    } else if (data.type === "logs") {
      if (data.payload && Array.isArray(data.payload.logs)) {
        logs = data.payload.logs.slice(-MAX_LOGS);
      }
      if (data.payload && data.payload.state) lastState = data.payload.state;
      ready = true;
    } else if (data.type === "state" || data.type === "ready") {
      lastState = data.payload;
      ready = true;
    }
  });

  function askPage(type) {
    window.postMessage({ source: BRIDGE_SOURCE, type }, "*");
  }

  function requestFromPage(type, timeoutMs) {
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
        if (type === "getLogs" && data.type === "logs") {
          if (data.payload && Array.isArray(data.payload.logs)) {
            logs = data.payload.logs.slice(-MAX_LOGS);
          }
          if (data.payload && data.payload.state) lastState = data.payload.state;
          ready = true;
          finish(data.payload);
        } else if (type === "getState" && data.type === "state") {
          lastState = data.payload;
          ready = true;
          finish(data.payload);
        }
      };

      window.addEventListener("message", onMessage);
      askPage(type);
      setTimeout(() => finish(null), timeoutMs || 200);
    });
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || !message.type) return;

    if (message.type === "ping") {
      sendResponse({ ok: true, ready, logCount: logs.length });
      return false;
    }

    if (message.type === "getLogs") {
      requestFromPage("getLogs", 250).then(() => {
        sendResponse({
          ok: true,
          logs,
          state: lastState,
          ready,
          href: location.href,
          fetchedAt: Date.now(),
        });
      });
      return true;
    }

    if (message.type === "getState") {
      requestFromPage("getState", 250).then(() => {
        sendResponse({ ok: true, state: lastState, ready });
      });
      return true;
    }

    if (message.type === "enableNow") {
      askPage("enableNow");
      sendResponse({ ok: true });
      return false;
    }

    if (message.type === "clearLogs") {
      logs = [];
      askPage("clearLogs");
      sendResponse({ ok: true });
      return false;
    }
  });

  setTimeout(() => askPage("getLogs"), 800);
  setTimeout(() => askPage("getState"), 1000);
})();
