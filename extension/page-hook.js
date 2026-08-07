/**
 * Page-world (MAIN) script.
 * - Captures batchexecute CSRF (`at`) / bl / f.sid from live traffic
 * - Persists THINKING_LEVEL_EXTENDED via L5adhe preference RPC
 * - DOM-activates the model-picker "強化版思考モード" toggle
 *
 * HAR findings (gemini.google.com.har):
 * - 強化版思考モード === THINKING_LEVEL_EXTENDED === numeric 2
 * - Preference key: last_selected_thinking_level_on_web (field id 265)
 * - Write RPC: L5adhe with sparse array length 265, value at index 264
 * - Toggle test id: data-test-id="thinking-level-toggle"
 * - Model menu button: data-test-id="bard-mode-menu-button"
 */
(function () {
  "use strict";

  const LOG_PREFIX = "[gemini-thinking-auto]";
  const PREF_KEY = "last_selected_thinking_level_on_web";
  const PREF_FIELD_ID = 265; // 1-based field id → array length
  const PREF_INDEX = PREF_FIELD_ID - 1; // 264
  const THINKING_LEVEL_EXTENDED = 2;

  const SELECTORS = {
    menuButton: '[data-test-id="bard-mode-menu-button"]',
    // Fallbacks seen in related UI
    menuButtonAlt: [
      'button[aria-haspopup="menu"]',
      "[data-test-id='bard-mode-switcher'] button",
      "bard-mode-switcher button",
    ],
    thinkingToggle: '[data-test-id="thinking-level-toggle"]',
    thinkingContainer: '[data-test-id="thinking-level-container"]',
    thinkingPicker: '[data-test-id="thinking-level-picker-desktop"]',
  };

  const state = {
    atToken: null,
    bl: null,
    fSid: null,
    hl: document.documentElement.lang || "ja",
    prefWriteAttempted: false,
    prefWriteSucceeded: false,
    domEnableAttempted: false,
    domEnableSucceeded: false,
    userDisabledThisSession: false,
    lastEnableAt: 0,
  };

  function log(...args) {
    try {
      console.debug(LOG_PREFIX, ...args);
    } catch (_) {
      /* ignore */
    }
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  // ---------------------------------------------------------------------------
  // Network: capture tokens + write preference
  // ---------------------------------------------------------------------------

  function captureFromUrl(url) {
    try {
      const u = new URL(url, location.origin);
      if (!u.pathname.includes("batchexecute")) return;
      const bl = u.searchParams.get("bl");
      const sid = u.searchParams.get("f.sid");
      const hl = u.searchParams.get("hl");
      if (bl) state.bl = bl;
      if (sid) state.fSid = sid;
      if (hl) state.hl = hl;
    } catch (_) {
      /* ignore */
    }
  }

  function captureFromBody(body) {
    if (!body || typeof body !== "string") return;
    const m = body.match(/(?:^|&)at=([^&]+)/);
    if (m) {
      try {
        state.atToken = decodeURIComponent(m[1]);
      } catch (_) {
        state.atToken = m[1];
      }
    }
  }

  function buildPrefPayload(level) {
    const arr = new Array(PREF_FIELD_ID).fill(null);
    arr[PREF_INDEX] = level;
    // L5adhe inner: [[sparseFields], [[prefKey]]]
    return [arr, [[PREF_KEY]]];
  }

  async function writeThinkingPreference(level = THINKING_LEVEL_EXTENDED) {
    if (!state.atToken) {
      log("skip pref write: no at token yet");
      return false;
    }
    const inner = buildPrefPayload(level);
    const fReq = JSON.stringify([
      [["L5adhe", JSON.stringify(inner), null, "generic"]],
    ]);
    const body =
      "f.req=" +
      encodeURIComponent(fReq) +
      "&at=" +
      encodeURIComponent(state.atToken) +
      "&";

    const params = new URLSearchParams();
    params.set("rpcids", "L5adhe");
    params.set("source-path", location.pathname || "/app");
    if (state.bl) params.set("bl", state.bl);
    if (state.fSid) params.set("f.sid", state.fSid);
    params.set("hl", state.hl || "ja");
    params.set("_reqid", String(1000000 + Math.floor(Math.random() * 9000000)));
    params.set("rt", "c");

    const url =
      "https://gemini.google.com/_/BardChatUi/data/batchexecute?" +
      params.toString();

    try {
      const resp = await nativeFetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
        },
        body,
        credentials: "include",
      });
      const text = await resp.text();
      const ok = resp.ok && text.includes("L5adhe");
      log("pref write", { status: resp.status, ok, level });
      state.prefWriteSucceeded = ok;
      return ok;
    } catch (err) {
      log("pref write failed", err);
      return false;
    }
  }

  // Keep a reference to the real fetch before patching.
  const nativeFetch = window.fetch.bind(window);

  function patchFetch() {
    window.fetch = async function (input, init) {
      try {
        const url =
          typeof input === "string"
            ? input
            : input && typeof input.url === "string"
              ? input.url
              : "";
        if (url && url.includes("batchexecute")) {
          captureFromUrl(url);
          if (init && init.body) captureFromBody(init.body);
        }
      } catch (_) {
        /* ignore */
      }

      const response = await nativeFetch(input, init);

      try {
        const url =
          typeof input === "string"
            ? input
            : input && typeof input.url === "string"
              ? input.url
              : "";
        if (url && url.includes("batchexecute") && state.atToken) {
          scheduleEnable("fetch");
        }
      } catch (_) {
        /* ignore */
      }

      return response;
    };
  }

  function patchXHR() {
    const open = XMLHttpRequest.prototype.open;
    const send = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function (method, url) {
      this.__gtaUrl = url;
      return open.apply(this, arguments);
    };

    XMLHttpRequest.prototype.send = function (body) {
      try {
        const url = this.__gtaUrl || "";
        if (String(url).includes("batchexecute")) {
          captureFromUrl(String(url));
          if (typeof body === "string") captureFromBody(body);
          this.addEventListener("load", function () {
            if (state.atToken) scheduleEnable("xhr");
          });
        }
      } catch (_) {
        /* ignore */
      }
      return send.apply(this, arguments);
    };
  }

  // ---------------------------------------------------------------------------
  // DOM: open model picker and turn on the slide toggle
  // ---------------------------------------------------------------------------

  function isVisible(el) {
    if (!el) return false;
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function queryDeep(selector, root = document) {
    const direct = root.querySelector(selector);
    if (direct) return direct;
    const all = root.querySelectorAll("*");
    for (const el of all) {
      if (el.shadowRoot) {
        const found = queryDeep(selector, el.shadowRoot);
        if (found) return found;
      }
    }
    return null;
  }

  function findMenuButton() {
    let btn = queryDeep(SELECTORS.menuButton);
    if (btn && isVisible(btn)) return btn;
    for (const sel of SELECTORS.menuButtonAlt) {
      btn = queryDeep(sel);
      if (btn && isVisible(btn)) return btn;
    }
    // Heuristic: button that looks like the model chip in the composer area
    const candidates = Array.from(
      document.querySelectorAll("button, [role='button']")
    ).filter(isVisible);
    return (
      candidates.find((el) => {
        const t = (el.textContent || "").trim();
        return (
          /Flash|Pro|Gemini|思考|Thinking|Deep Think/i.test(t) &&
          t.length < 80
        );
      }) || null
    );
  }

  function findThinkingToggle() {
    // Prefer exact test id
    let toggle = queryDeep(SELECTORS.thinkingToggle);
    if (toggle) return normalizeToggle(toggle);

    // Material slide toggle near "強化版思考" / "Thinking" label
    const labels = Array.from(
      document.querySelectorAll("span, div, label, button")
    ).filter((el) => {
      const t = (el.textContent || "").trim();
      return (
        t === "強化版思考モード" ||
        t === "強化版思考" ||
        /^Thinking$/i.test(t) ||
        /Enhanced thinking/i.test(t)
      );
    });

    for (const label of labels) {
      const root =
        label.closest("[data-test-id='thinking-level-container']") ||
        label.closest("thinking-level-picker") ||
        label.parentElement;
      if (!root) continue;
      const input =
        root.querySelector(
          'button[role="switch"], input[type="checkbox"], .mdc-switch, mat-slide-toggle button'
        ) || root.querySelector('[data-test-id="thinking-level-toggle"]');
      if (input) return normalizeToggle(input);
    }
    return null;
  }

  function normalizeToggle(el) {
    // Prefer the interactive switch control inside a wrapper
    if (el.matches && el.matches('[data-test-id="thinking-level-toggle"]')) {
      const inner =
        el.querySelector('button[role="switch"], input[type="checkbox"], button') ||
        el;
      return inner;
    }
    return el;
  }

  function isToggleOn(toggle) {
    if (!toggle) return false;
    if (toggle.getAttribute("aria-checked") != null) {
      return toggle.getAttribute("aria-checked") === "true";
    }
    if (typeof toggle.checked === "boolean") return toggle.checked;
    if (toggle.classList.contains("mdc-switch--selected")) return true;
    if (toggle.classList.contains("mat-mdc-slide-toggle-checked")) return true;
    // Walk up for mat-slide-toggle host
    const host = toggle.closest("mat-slide-toggle, .mat-mdc-slide-toggle");
    if (host) {
      if (host.classList.contains("mat-mdc-slide-toggle-checked")) return true;
      if (host.classList.contains("mdc-switch--selected")) return true;
      const sw = host.querySelector('[aria-checked]');
      if (sw) return sw.getAttribute("aria-checked") === "true";
    }
    return false;
  }

  function click(el) {
    if (!el) return;
    el.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    el.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
    el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    el.click();
  }

  async function ensureMenuOpen() {
    let toggle = findThinkingToggle();
    if (toggle && isVisible(toggle)) return true;

    const btn = findMenuButton();
    if (!btn) {
      log("menu button not found");
      return false;
    }
    click(btn);
    for (let i = 0; i < 20; i++) {
      await sleep(100);
      toggle = findThinkingToggle();
      if (toggle && isVisible(toggle)) return true;
      // Menu may render option list first without toggle for some models
      if (queryDeep(SELECTORS.thinkingContainer)) return true;
    }
    return false;
  }

  function closeMenu() {
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", keyCode: 27, bubbles: true })
    );
    document.dispatchEvent(
      new KeyboardEvent("keyup", { key: "Escape", keyCode: 27, bubbles: true })
    );
  }

  async function enableViaDom() {
    if (state.userDisabledThisSession) {
      log("skip DOM: user disabled this session");
      return false;
    }

    const opened = await ensureMenuOpen();
    if (!opened) {
      log("could not open model menu");
      return false;
    }

    await sleep(150);
    const toggle = findThinkingToggle();
    if (!toggle) {
      log("thinking toggle not found (model may not support it)");
      closeMenu();
      return false;
    }

    if (isToggleOn(toggle)) {
      log("toggle already on");
      state.domEnableSucceeded = true;
      closeMenu();
      return true;
    }

    log("clicking thinking toggle to enable");
    click(toggle);
    await sleep(200);

    const on = isToggleOn(toggle);
    state.domEnableSucceeded = on;
    log("toggle after click:", on);
    closeMenu();
    return on;
  }

  // ---------------------------------------------------------------------------
  // Orchestration
  // ---------------------------------------------------------------------------

  let enableTimer = null;
  let enableInFlight = false;

  function scheduleEnable(reason) {
    if (state.userDisabledThisSession) return;
    if (enableTimer) clearTimeout(enableTimer);
    enableTimer = setTimeout(() => {
      runEnable(reason);
    }, 400);
  }

  async function runEnable(reason) {
    if (enableInFlight) return;
    if (state.userDisabledThisSession) return;

    // Throttle: at most once every 3s for network-triggered runs
    const now = Date.now();
    if (now - state.lastEnableAt < 3000 && state.domEnableSucceeded) return;
    state.lastEnableAt = now;
    enableInFlight = true;

    try {
      log("runEnable", reason, {
        hasAt: !!state.atToken,
        hasBl: !!state.bl,
      });

      // 1) Persist preference (survives reloads)
      if (state.atToken && !state.prefWriteAttempted) {
        state.prefWriteAttempted = true;
        await writeThinkingPreference(THINKING_LEVEL_EXTENDED);
      } else if (state.atToken && !state.prefWriteSucceeded) {
        await writeThinkingPreference(THINKING_LEVEL_EXTENDED);
      }

      // 2) Sync live UI (current session without full reload)
      if (!state.domEnableSucceeded) {
        await enableViaDom();
      }
    } catch (err) {
      log("runEnable error", err);
    } finally {
      enableInFlight = false;
    }
  }

  function watchDom() {
    const observer = new MutationObserver(() => {
      // If toggle appears and is off, enable it (e.g. user opened menu)
      const toggle = findThinkingToggle();
      if (!toggle || !isVisible(toggle)) return;
      if (state.userDisabledThisSession) return;
      if (!isToggleOn(toggle)) {
        // Debounce DOM path
        scheduleEnable("mutation");
      } else {
        state.domEnableSucceeded = true;
      }
    });

    const start = () => {
      if (document.documentElement) {
        observer.observe(document.documentElement, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ["aria-checked", "class"],
        });
      }
    };

    if (document.documentElement) start();
    else document.addEventListener("DOMContentLoaded", start, { once: true });
  }

  function watchToggleManualOff() {
    // If user turns the toggle off after we enabled it, respect that for this session
    document.addEventListener(
      "click",
      (ev) => {
        const t = ev.target;
        if (!(t instanceof Element)) return;
        const toggleRoot = t.closest(
          '[data-test-id="thinking-level-toggle"], mat-slide-toggle, .mat-mdc-slide-toggle'
        );
        if (!toggleRoot) return;
        // After click, check state
        setTimeout(() => {
          const toggle = findThinkingToggle();
          if (toggle && !isToggleOn(toggle) && state.domEnableSucceeded) {
            state.userDisabledThisSession = true;
            state.domEnableSucceeded = false;
            log("user disabled thinking mode; will not re-enable this session");
          }
        }, 300);
      },
      true
    );
  }

  function watchSpaNavigation() {
    const resetForNavigation = () => {
      // New chat / route: try again (unless user opted out this session)
      state.domEnableSucceeded = false;
      state.prefWriteAttempted = false;
      scheduleEnable("navigation");
    };

    const wrapHistory = (fnName) => {
      const orig = history[fnName];
      history[fnName] = function () {
        const ret = orig.apply(this, arguments);
        resetForNavigation();
        return ret;
      };
    };
    wrapHistory("pushState");
    wrapHistory("replaceState");
    window.addEventListener("popstate", resetForNavigation);
  }

  function boot() {
    log("boot");
    patchFetch();
    patchXHR();
    watchDom();
    watchToggleManualOff();
    watchSpaNavigation();

    // Initial attempts after UI is likely ready
    const delays = [1500, 3500, 7000, 12000];
    for (const d of delays) {
      setTimeout(() => scheduleEnable("timer-" + d), d);
    }

    // Expose minimal debug API
    window.__geminiThinkingAuto = {
      state,
      enable: () => runEnable("manual"),
      writePref: () => writeThinkingPreference(THINKING_LEVEL_EXTENDED),
    };
  }

  boot();
})();
