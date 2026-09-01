(function () {
  "use strict";

  const el = {
    conn: document.getElementById("conn"),
    domOk: document.getElementById("domOk"),
    chip: document.getElementById("chip"),
    prefOk: document.getElementById("prefOk"),
    detail: document.getElementById("detail"),
    btnRefresh: document.getElementById("btnRefresh"),
    btnEnable: document.getElementById("btnEnable"),
    consentView: document.getElementById("consentView"),
    appView: document.getElementById("appView"),
    consentNote: document.getElementById("consentNote"),
    linkTerms: document.getElementById("linkTerms"),
    linkPrivacy: document.getElementById("linkPrivacy"),
    btnAgree: document.getElementById("btnAgree"),
    btnReject: document.getElementById("btnReject"),
    footerNote: document.getElementById("footerNote"),
  };

  const CONSENT_KEY = "consent";

  function getConsent() {
    return chrome.storage.local.get(CONSENT_KEY).then((data) => !!data[CONSENT_KEY]);
  }

  function setConsent(value) {
    if (value) {
      return chrome.storage.local.set({
        [CONSENT_KEY]: { acceptedAt: new Date().toISOString(), version: 1 },
      });
    }
    return chrome.storage.local.remove(CONSENT_KEY);
  }

  function openExtensionPage(file) {
    chrome.tabs.create({ url: chrome.runtime.getURL(file) });
  }

  function renderConsent(accepted) {
    el.consentView.hidden = accepted;
    el.appView.hidden = !accepted;
  }

  /** @type {any} */
  let cache = { state: null, ready: false };

  function setBadge(node, text, cls) {
    node.textContent = text;
    node.className = "value " + (cls || "");
  }

  function render() {
    const st = cache.state || {};
    if (!cache.ready) {
      setBadge(el.conn, "Gemini タブ未検出 / 未接続", "bad");
    } else {
      setBadge(el.conn, "接続OK", "ok");
    }

    if (st.domEnableSucceeded || st.uiLooksExtended)
      setBadge(el.domOk, "成功", "ok");
    else if (st.domEnableAttempted) setBadge(el.domOk, "未成功 / 再試行中", "warn");
    else setBadge(el.domOk, "未実行", "");

    el.chip.textContent = st.menuButtonText || (st.uiLooksExtended ? "拡張" : "—");

    if (st.prefWriteSucceeded) setBadge(el.prefOk, "成功", "ok");
    else if (st.prefWriteAttempted) setBadge(el.prefOk, "失敗 / トークン待ち", "warn");
    else setBadge(el.prefOk, "未実行", "");

    el.detail.textContent =
      st.lastDomDetail || st.lastError || st.lastReason || "—";
  }

  async function getGeminiTab() {
    const tabs = await chrome.tabs.query({
      url: ["https://gemini.google.com/*"],
    });
    if (!tabs.length) return null;
    const active = tabs.find((t) => t.active);
    return active || tabs[0];
  }

  async function sendToGemini(message) {
    const tab = await getGeminiTab();
    if (!tab || tab.id == null) {
      throw new Error("gemini.google.com のタブが見つかりません");
    }
    return chrome.tabs.sendMessage(tab.id, message);
  }

  async function refresh() {
    el.conn.textContent = "取得中…";
    try {
      const res = await sendToGemini({ type: "getState" });
      cache = {
        state: (res && res.state) || null,
        ready: !!(res && res.ready),
      };
      // second pull shortly after for page async response
      setTimeout(async () => {
        try {
          const res2 = await sendToGemini({ type: "getState" });
          if (res2) {
            cache.state = res2.state || cache.state;
            cache.ready = res2.ready || cache.ready;
            render();
          }
        } catch (_) {
          /* ignore */
        }
      }, 200);
    } catch (err) {
      cache.ready = false;
      setBadge(el.conn, String(err.message || err), "bad");
      return;
    }
    render();
  }

  el.btnRefresh.addEventListener("click", () => refresh());
  el.btnEnable.addEventListener("click", async () => {
    try {
      await sendToGemini({ type: "enableNow" });
      setTimeout(refresh, 600);
      setTimeout(refresh, 2000);
    } catch (err) {
      setBadge(el.conn, String(err.message || err), "bad");
    }
  });

  el.linkTerms.addEventListener("click", () => openExtensionPage("terms.html"));
  el.linkPrivacy.addEventListener("click", () =>
    openExtensionPage("privacy.html")
  );
  el.btnAgree.addEventListener("click", async () => {
    try {
      await setConsent(true);
      renderConsent(true);
      el.consentNote.textContent = "";
      refresh();
      // Re-arm any open Gemini tab: content script picks up storage change and
      // the page-hook will start auto-enabling immediately.
      setTimeout(() => {
        sendToGemini({ type: "enableNow" }).catch(() => {});
      }, 300);
    } catch (err) {
      el.consentNote.textContent = "保存に失敗しました: " + String(err);
    }
  });
  el.btnReject.addEventListener("click", async () => {
    try {
      await setConsent(false);
    } catch (_) {
      /* ignore */
    }
    el.consentView.hidden = true;
    el.footerNote.textContent =
      "同意されなかったため、この拡張機能は動作しません。同意する場合は拡張機能のアイコンを再度クリックしてください。";
  });

  async function init() {
    const accepted = await getConsent();
    renderConsent(accepted);
    if (accepted) refresh();
  }

  init();
})();
