(function () {
  "use strict";

  var CONSENT_KEY = "consent";

  var btnAccept = document.getElementById("btnAccept");
  var btnDecline = document.getElementById("btnDecline");
  var btnReload = document.getElementById("btnReload");
  var status = document.getElementById("status");

  function showStatus(message, kind) {
    status.textContent = message;
    status.className = kind || "";
    status.style.display = "block";
  }

  /** Chrome 拡張のコンテキストが有効か（再読み込み後に古いタブが残るため）。 */
  function apiAvailable() {
    return (
      typeof chrome !== "undefined" &&
      !!chrome.runtime &&
      !!chrome.runtime.id &&
      !!chrome.storage &&
      !!chrome.storage.local
    );
  }

  /** コンテキスト無効時は原因を表示し、開き直しを案内する。 */
  function showApiError() {
    showStatus(
      "拡張機能が再読み込みされたため、この画面が古くなっています。F5 で再読み込みするか、[この画面を開き直す] を押してください。",
      "bad"
    );
    btnReload.style.display = "inline-block";
  }

  function disableButtons() {
    btnAccept.disabled = true;
    btnDecline.disabled = true;
  }

  function setConsent(value) {
    if (!apiAvailable()) {
      return Promise.reject(new Error("extension context invalidated"));
    }
    if (value) {
      return chrome.storage.local.set({
        [CONSENT_KEY]: {
          acceptedAt: new Date().toISOString(),
          version: 1,
        },
      });
    }
    return chrome.storage.local.remove(CONSENT_KEY);
  }

  function closeSoon() {
    setTimeout(function () {
      try {
        window.close();
      } catch (_) {
        /* ignore */
      }
    }, 2500);
  }

  // 何が起きても無言にならないように、想定外のエラーも画面に表示する。
  // ただしコンテキストが正常な間は「同意済み」表示などを上書きしない。
  window.addEventListener("error", function () {
    if (!apiAvailable()) showApiError();
  });
  window.addEventListener("unhandledrejection", function () {
    if (!apiAvailable()) showApiError();
  });

  btnReload.addEventListener("click", function () {
    location.reload();
  });

  if (!apiAvailable()) {
    showApiError();
  } else {
    chrome.storage.local.get(CONSENT_KEY).then(function (data) {
      if (data && data[CONSENT_KEY]) {
        disableButtons();
        showStatus(
          "この拡張機能はすでに同意済みです。このタブは閉じて問題ありません。",
          "ok"
        );
      }
    });
  }

  btnAccept.addEventListener("click", function () {
    setConsent(true)
      .then(function () {
        disableButtons();
        showStatus(
          "同意を受け付けました。このタブは閉じても問題ありません。",
          "ok"
        );
        closeSoon();
      })
      .catch(function () {
        showApiError();
      });
  });

  btnDecline.addEventListener("click", function () {
    setConsent(false)
      .then(function () {
        disableButtons();
        showStatus(
          "同意されなかったため、この拡張機能は動作しません。変更したい場合は拡張機能のアイコンから再度ご確認ください。",
          "bad"
        );
      })
      .catch(function () {
        showApiError();
      });
  });
})();
