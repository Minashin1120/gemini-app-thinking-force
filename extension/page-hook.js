/**
 * Page-world (MAIN) script.
 * Enables 強化版思考モード (THINKING_LEVEL_EXTENDED) on gemini.google.com.
 *
 * Fix notes:
 * - data-test-id="thinking-level-toggle" is often on a HEADER wrapper, not the
 *   interactive mat-slide-toggle. We must click mat-slide-toggle's switch button.
 * - checked is bound to (selectedThinkingLevel === THINKING_LEVEL_EXTENDED).
 */
(function () {
  "use strict";

  const SOURCE = "gemini-thinking-auto";
  const LOG_PREFIX = "[gemini-thinking-auto]";
  const PREF_KEY = "last_selected_thinking_level_on_web";
  const PREF_FIELD_ID = 265;
  const PREF_INDEX = PREF_FIELD_ID - 1;
  const THINKING_LEVEL_EXTENDED = 2;
  const MAX_LOGS = 2000;

  const LABEL_PATTERNS = [
    /強化版思考モード/,
    /強化版思考/,
    /Enhanced thinking/i,
    /Extended thinking/i,
  ];

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
    lastReason: null,
    lastError: null,
    lastDomDetail: null,
    menuOpenCount: 0,
    toggleClickCount: 0,
    bootAt: Date.now(),
  };

  /** @type {{ts:number, level:string, msg:string, data?:any}[]} */
  const logs = [];

  function serialize(value) {
    try {
      return JSON.parse(
        JSON.stringify(value, (_, v) => {
          if (v instanceof Error) {
            return { name: v.name, message: v.message, stack: v.stack };
          }
          if (v instanceof Element) {
            return {
              tag: v.tagName,
              id: v.id,
              class: v.className,
              testId: v.getAttribute("data-test-id"),
              text: (v.textContent || "").trim().slice(0, 80),
            };
          }
          if (typeof v === "bigint") return String(v);
          return v;
        })
      );
    } catch (_) {
      return String(value);
    }
  }

  function emitToExtension(type, payload) {
    try {
      window.postMessage({ source: SOURCE, type, payload }, "*");
    } catch (_) {
      /* ignore */
    }
  }

  function log(level, msg, data) {
    const entry = {
      ts: Date.now(),
      level,
      msg,
      data: data === undefined ? undefined : serialize(data),
    };
    logs.push(entry);
    if (logs.length > MAX_LOGS) logs.splice(0, logs.length - MAX_LOGS);
    try {
      const args = data === undefined ? [LOG_PREFIX, msg] : [LOG_PREFIX, msg, data];
      if (level === "error") console.error(...args);
      else if (level === "warn") console.warn(...args);
      else console.debug(...args);
    } catch (_) {
      /* ignore */
    }
    emitToExtension("log", entry);
  }

  function logInfo(msg, data) {
    log("info", msg, data);
  }
  function logWarn(msg, data) {
    log("warn", msg, data);
  }
  function logError(msg, data) {
    log("error", msg, data);
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function getPublicState() {
    return {
      ...state,
      logCount: logs.length,
      url: location.href,
      hasAtToken: !!state.atToken,
    };
  }

  // ---------------------------------------------------------------------------
  // Network
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
    return [arr, [[PREF_KEY]]];
  }

  async function writeThinkingPreference(level = THINKING_LEVEL_EXTENDED) {
    if (!state.atToken) {
      logWarn("skip pref write: no at token yet");
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
      const ok = resp.ok && /L5adhe/.test(text);
      logInfo("pref write result", {
        status: resp.status,
        ok,
        level,
        bodySnippet: text.slice(0, 180),
      });
      state.prefWriteSucceeded = ok;
      return ok;
    } catch (err) {
      logError("pref write failed", err);
      state.lastError = String(err);
      return false;
    }
  }

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
  // DOM helpers
  // ---------------------------------------------------------------------------

  function isVisible(el) {
    if (!el || !(el instanceof Element)) return false;
    const style = window.getComputedStyle(el);
    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      style.opacity === "0"
    ) {
      return false;
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function queryAllDeep(selector, root = document) {
    const out = [];
    try {
      out.push(...root.querySelectorAll(selector));
    } catch (_) {
      /* ignore */
    }
    const walk = root.querySelectorAll("*");
    for (const el of walk) {
      if (el.shadowRoot) {
        out.push(...queryAllDeep(selector, el.shadowRoot));
      }
    }
    return out;
  }

  function queryDeep(selector, root = document) {
    const all = queryAllDeep(selector, root);
    return all.find(isVisible) || all[0] || null;
  }

  function textOf(el) {
    return ((el && el.textContent) || "").replace(/\s+/g, " ").trim();
  }

  function matchesLabel(text) {
    return LABEL_PATTERNS.some((re) => re.test(text || ""));
  }

  function findMenuButton() {
    const selectors = [
      '[data-test-id="bard-mode-menu-button"]',
      '[data-test-id="bard-mode-switcher"] button',
      "bard-mode-switcher button",
    ];
    for (const sel of selectors) {
      const el = queryDeep(sel);
      if (el && isVisible(el)) return el;
    }
    const candidates = Array.from(
      document.querySelectorAll("button, [role='button']")
    ).filter(isVisible);
    return (
      candidates.find((el) => {
        const t = textOf(el);
        return (
          /Flash|Pro|Gemini|思考|Thinking|Deep Think/i.test(t) && t.length < 100
        );
      }) || null
    );
  }

  /**
   * Resolve the actual interactive switch control for 強化版思考.
   * Prefer mat-slide-toggle near the label, not the header test-id wrapper.
   */
  function findSlideToggleControls() {
    const results = [];

    // 1) mat-slide-toggle inside thinking containers / pickers
    const hosts = [
      ...queryAllDeep("mat-slide-toggle"),
      ...queryAllDeep(".mat-mdc-slide-toggle"),
    ];

    for (const host of hosts) {
      if (!isVisible(host)) continue;
      // Prefer toggles near extended-thinking label text
      const near = host.closest(
        '[data-test-id="thinking-level-container"], [data-test-id="thinking-level-picker-desktop"], thinking-level-picker, [data-test-id="thinking-level-toggle"], .thinking-level-header'
      );
      const contextText = textOf(
        near || host.parentElement || host
      );
      const labelNear = matchesLabel(contextText) || matchesLabel(textOf(host));
      const btn =
        host.querySelector(
          'button[role="switch"], button.mdc-switch, .mdc-switch, input[type="checkbox"]'
        ) || host;
      results.push({
        host,
        button: btn,
        score: (labelNear ? 50 : 0) + (near ? 20 : 0) + (isVisible(btn) ? 10 : 0),
        contextText: contextText.slice(0, 120),
      });
    }

    // 2) role=switch near 強化版 label
    for (const labelEl of queryAllDeep("span, div, label, p")) {
      const t = textOf(labelEl);
      if (!matchesLabel(t) || t.length > 40) continue;
      const root =
        labelEl.closest(
          '[data-test-id="thinking-level-container"], [data-test-id="thinking-level-toggle"], .thinking-level-header, thinking-level-picker, mat-list-item, li, div'
        ) || labelEl.parentElement;
      if (!root) continue;
      const btn = root.querySelector(
        'button[role="switch"], mat-slide-toggle button, .mdc-switch, input[type="checkbox"]'
      );
      if (!btn) continue;
      const host = btn.closest("mat-slide-toggle, .mat-mdc-slide-toggle") || btn;
      results.push({
        host,
        button: btn,
        score: 80,
        contextText: t,
      });
    }

    results.sort((a, b) => b.score - a.score);
    return results;
  }

  function findBestToggle(opts) {
    const silent = !!(opts && opts.silent);
    const list = findSlideToggleControls().filter((x) => x.score >= 20);
    if (!silent) {
      logInfo("toggle candidates", {
        count: list.length,
        top: list.slice(0, 5).map((x) => ({
          score: x.score,
          contextText: x.contextText,
          host: x.host,
          button: x.button,
          on: isControlOn(x.button, x.host),
        })),
      });
    }
    return list[0] || null;
  }

  function findExtendedOption() {
    // Menu option rows for thinking levels
    const options = [
      ...queryAllDeep('[data-test-id="thinking-level-option"]'),
      ...queryAllDeep('[data-test-id="bard-mode-option-"]'),
      ...queryAllDeep("button, [role='menuitem'], [role='option']"),
    ];
    const seen = new Set();
    for (const el of options) {
      if (seen.has(el) || !isVisible(el)) continue;
      seen.add(el);
      const t = textOf(el);
      if (!matchesLabel(t)) continue;
      // Avoid huge containers
      if (t.length > 120) continue;
      const disabled =
        el.getAttribute("aria-disabled") === "true" ||
        el.classList.contains("disabled") ||
        el.hasAttribute("disabled");
      if (disabled) continue;
      const selected =
        el.classList.contains("selected") ||
        el.getAttribute("aria-selected") === "true" ||
        el.getAttribute("aria-checked") === "true";
      return { el, text: t, selected };
    }
    return null;
  }

  function isControlOn(button, host) {
    const nodes = [button, host].filter(Boolean);
    for (const n of nodes) {
      if (!n) continue;
      const aria = n.getAttribute && n.getAttribute("aria-checked");
      if (aria === "true") return true;
      if (aria === "false") return false;
      if (typeof n.checked === "boolean") return n.checked;
      if (n.classList) {
        if (
          n.classList.contains("mdc-switch--selected") ||
          n.classList.contains("mat-mdc-slide-toggle-checked") ||
          n.classList.contains("mat-checked")
        ) {
          return true;
        }
      }
    }
    if (host) {
      const sw = host.querySelector(
        '[aria-checked], .mdc-switch, button[role="switch"]'
      );
      if (sw && sw !== button) return isControlOn(sw, null);
    }
    return false;
  }

  function isExtendedModeUiActive() {
    // Model chip / header may show "拡張" or "強化"
    const btn = findMenuButton();
    if (btn) {
      const t = textOf(btn);
      if (/拡張|強化版|Extended|Thinking/i.test(t) && !/標準/.test(t)) {
        // weak signal
      }
    }
    const best = findBestToggle({ silent: true });
    if (best && isControlOn(best.button, best.host)) return true;
    const opt = findExtendedOption();
    if (opt && opt.selected) return true;
    return false;
  }

  function dispatchPointerSequence(el) {
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const common = {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: x,
      clientY: y,
      pointerId: 1,
      pointerType: "mouse",
      isPrimary: true,
      buttons: 1,
    };

    try {
      el.focus({ preventScroll: true });
    } catch (_) {
      try {
        el.focus();
      } catch (__) {
        /* ignore */
      }
    }

    const types = [
      ["pointerover", PointerEvent],
      ["pointerenter", PointerEvent],
      ["mouseover", MouseEvent],
      ["mouseenter", MouseEvent],
      ["pointerdown", PointerEvent],
      ["mousedown", MouseEvent],
      ["pointerup", PointerEvent],
      ["mouseup", MouseEvent],
      ["click", MouseEvent],
    ];

    for (const [type, Ctor] of types) {
      try {
        el.dispatchEvent(new Ctor(type, common));
      } catch (_) {
        try {
          el.dispatchEvent(new MouseEvent(type, common));
        } catch (__) {
          /* ignore */
        }
      }
    }

    // Native click as final fallback (often required for Angular Material)
    try {
      if (typeof el.click === "function") el.click();
    } catch (_) {
      /* ignore */
    }
  }

  /**
   * mat-slide-toggle listens to (change) with {checked:boolean}.
   * If native click fails, synthesize a change-like payload via input.
   */
  function forceToggleOn(host, button) {
    if (!host && !button) return false;

    // Prefer clicking the switch button
    const target =
      (button && isVisible(button) && button) ||
      (host &&
        host.querySelector(
          'button[role="switch"], button.mdc-switch, .mdc-switch__handle-track, .mdc-switch'
        )) ||
      host;

    logInfo("forceToggleOn click target", { target, host, button });
    dispatchPointerSequence(target);

    // Also try label / track
    if (host) {
      const track = host.querySelector(
        ".mdc-switch__track, .mdc-switch__handle, label"
      );
      if (track && track !== target) dispatchPointerSequence(track);
    }

    return true;
  }

  async function ensureMenuOpen() {
    // Already open if we can see toggle or options
    if (findBestToggle({ silent: true }) || findExtendedOption()) {
      logInfo("menu already shows thinking UI");
      return true;
    }

    const btn = findMenuButton();
    if (!btn) {
      logWarn("menu button not found");
      state.lastDomDetail = "menu-button-missing";
      return false;
    }

    logInfo("opening model menu", { button: btn, text: textOf(btn) });
    state.menuOpenCount += 1;
    dispatchPointerSequence(btn);

    for (let i = 0; i < 30; i++) {
      await sleep(100);
      if (findBestToggle({ silent: true }) || findExtendedOption()) {
        logInfo("thinking UI visible after open", { waitMs: (i + 1) * 100 });
        return true;
      }
      // nested nav into thinking levels
      const nav = queryDeep('[data-test-id="thinking-level-nav-button"]');
      if (nav && isVisible(nav) && i === 5) {
        logInfo("clicking thinking-level-nav-button");
        dispatchPointerSequence(nav);
      }
    }

    logWarn("thinking UI not found after opening menu");
    state.lastDomDetail = "thinking-ui-missing-after-open";
    return false;
  }

  function closeMenu() {
    try {
      document.activeElement &&
        document.activeElement instanceof HTMLElement &&
        document.activeElement.blur();
    } catch (_) {
      /* ignore */
    }
    document.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        code: "Escape",
        keyCode: 27,
        which: 27,
        bubbles: true,
      })
    );
    document.dispatchEvent(
      new KeyboardEvent("keyup", {
        key: "Escape",
        code: "Escape",
        keyCode: 27,
        which: 27,
        bubbles: true,
      })
    );
  }

  async function enableViaDom() {
    if (state.userDisabledThisSession) {
      logInfo("skip DOM: user disabled this session");
      return false;
    }

    state.domEnableAttempted = true;
    const opened = await ensureMenuOpen();
    if (!opened) {
      logWarn("could not open / locate model menu thinking UI");
      return false;
    }

    await sleep(200);

    // Strategy A: mat-slide-toggle
    let best = findBestToggle();
    if (best) {
      if (isControlOn(best.button, best.host)) {
        logInfo("slide toggle already ON");
        state.domEnableSucceeded = true;
        state.lastDomDetail = "toggle-already-on";
        closeMenu();
        return true;
      }

      logInfo("turning ON slide toggle");
      state.toggleClickCount += 1;
      forceToggleOn(best.host, best.button);

      for (let i = 0; i < 15; i++) {
        await sleep(100);
        best = findBestToggle({ silent: true }) || best;
        if (best && isControlOn(best.button, best.host)) {
          logInfo("slide toggle is ON after click", { waitMs: (i + 1) * 100 });
          state.domEnableSucceeded = true;
          state.lastDomDetail = "toggle-clicked-on";
          await sleep(150);
          closeMenu();
          return true;
        }
      }
      logWarn("slide toggle still OFF after click");
    } else {
      logWarn("no mat-slide-toggle candidate found");
    }

    // Strategy B: click 強化版思考モード option row
    const opt = findExtendedOption();
    if (opt) {
      if (opt.selected) {
        logInfo("extended option already selected", { text: opt.text });
        state.domEnableSucceeded = true;
        state.lastDomDetail = "option-already-selected";
        closeMenu();
        return true;
      }
      logInfo("clicking extended thinking option", { text: opt.text });
      state.toggleClickCount += 1;
      dispatchPointerSequence(opt.el);
      await sleep(300);
      const opt2 = findExtendedOption();
      if (opt2 && opt2.selected) {
        logInfo("extended option selected after click");
        state.domEnableSucceeded = true;
        state.lastDomDetail = "option-clicked";
        closeMenu();
        return true;
      }
      // Even without selected class, selection may have applied
      best = findBestToggle({ silent: true });
      if (best && isControlOn(best.button, best.host)) {
        state.domEnableSucceeded = true;
        state.lastDomDetail = "option-click-toggle-on";
        closeMenu();
        return true;
      }
      logWarn("option click did not show selected state", {
        text: opt.text,
        after: opt2,
      });
    } else {
      logWarn("no extended thinking option row found");
    }

    // Strategy C: click any visible control matching label + switch
    const labelHits = queryAllDeep("span, div, label").filter((el) => {
      const t = textOf(el);
      return matchesLabel(t) && t.length <= 30 && isVisible(el);
    });
    logInfo("label hits", {
      count: labelHits.length,
      samples: labelHits.slice(0, 5).map((el) => textOf(el)),
    });
    for (const label of labelHits.slice(0, 5)) {
      const root = label.parentElement;
      if (!root) continue;
      const sw = root.querySelector(
        'button[role="switch"], mat-slide-toggle, input[type="checkbox"]'
      );
      if (sw) {
        logInfo("clicking switch near label", { label: textOf(label) });
        dispatchPointerSequence(sw);
        await sleep(250);
        if (isControlOn(sw, sw.closest("mat-slide-toggle"))) {
          state.domEnableSucceeded = true;
          state.lastDomDetail = "label-near-switch";
          closeMenu();
          return true;
        }
      }
      // Click label itself
      dispatchPointerSequence(label);
    }

    state.lastDomDetail = "all-strategies-failed";
    state.domEnableSucceeded = false;
    // Leave menu open briefly for debugging if still failing? User may find it annoying.
    // Close to avoid stuck open menu.
    closeMenu();
    return false;
  }

  // ---------------------------------------------------------------------------
  // Orchestration
  // ---------------------------------------------------------------------------

  let enableTimer = null;
  let enableInFlight = false;
  let attemptCount = 0;

  function scheduleEnable(reason) {
    if (state.userDisabledThisSession) return;
    if (state.domEnableSucceeded) return;
    if (enableTimer) clearTimeout(enableTimer);
    enableTimer = setTimeout(() => {
      runEnable(reason);
    }, 350);
  }

  async function runEnable(reason) {
    if (enableInFlight) return;
    if (state.userDisabledThisSession) return;
    if (state.domEnableSucceeded) return;

    const now = Date.now();
    // throttle repeated failures a bit, but allow retries
    if (now - state.lastEnableAt < 1500 && attemptCount > 0) return;
    state.lastEnableAt = now;
    state.lastReason = reason;
    enableInFlight = true;
    attemptCount += 1;

    try {
      logInfo("runEnable", {
        reason,
        attemptCount,
        hasAt: !!state.atToken,
        hasBl: !!state.bl,
        hasSid: !!state.fSid,
      });

      if (state.atToken) {
        if (!state.prefWriteAttempted || !state.prefWriteSucceeded) {
          state.prefWriteAttempted = true;
          await writeThinkingPreference(THINKING_LEVEL_EXTENDED);
        }
      } else {
        logWarn("no at token yet; DOM path only");
      }

      if (!state.domEnableSucceeded) {
        await enableViaDom();
      }

      emitToExtension("state", getPublicState());
    } catch (err) {
      logError("runEnable error", err);
      state.lastError = String(err);
    } finally {
      enableInFlight = false;
    }
  }

  function watchDom() {
    let scheduled = false;
    const observer = new MutationObserver(() => {
      if (state.domEnableSucceeded || state.userDisabledThisSession) return;
      if (scheduled) return;
      scheduled = true;
      setTimeout(() => {
        scheduled = false;
        // Only act if thinking UI is present (menu open)
        if (findBestToggle({ silent: true }) || findExtendedOption()) {
          scheduleEnable("mutation-thinking-ui");
        }
      }, 300);
    });

    const start = () => {
      if (document.documentElement) {
        observer.observe(document.documentElement, {
          childList: true,
          subtree: true,
        });
      }
    };
    if (document.documentElement) start();
    else document.addEventListener("DOMContentLoaded", start, { once: true });
  }

  function watchToggleManualOff() {
    document.addEventListener(
      "click",
      (ev) => {
        const t = ev.target;
        if (!(t instanceof Element)) return;
        const toggleRoot = t.closest(
          'mat-slide-toggle, .mat-mdc-slide-toggle, [data-test-id="thinking-level-toggle"], [data-test-id="thinking-level-option"]'
        );
        if (!toggleRoot) return;
        setTimeout(() => {
          if (!state.domEnableSucceeded) return;
          const best = findBestToggle({ silent: true });
          const on = best && isControlOn(best.button, best.host);
          const opt = findExtendedOption();
          const selected = opt && opt.selected;
          if (!on && !selected) {
            state.userDisabledThisSession = true;
            state.domEnableSucceeded = false;
            logInfo("user disabled thinking mode; no re-enable this session");
            emitToExtension("state", getPublicState());
          }
        }, 350);
      },
      true
    );
  }

  function watchSpaNavigation() {
    const resetForNavigation = () => {
      if (state.userDisabledThisSession) return;
      state.domEnableSucceeded = false;
      state.prefWriteAttempted = false;
      attemptCount = 0;
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

  function listenExtensionMessages() {
    window.addEventListener("message", (event) => {
      if (event.source !== window) return;
      const data = event.data;
      if (!data || data.source !== SOURCE + "-bridge") return;
      if (data.type === "getLogs") {
        emitToExtension("logs", {
          logs,
          state: getPublicState(),
        });
      } else if (data.type === "getState") {
        emitToExtension("state", getPublicState());
      } else if (data.type === "enableNow") {
        state.domEnableSucceeded = false;
        state.userDisabledThisSession = false;
        runEnable("popup");
      } else if (data.type === "clearLogs") {
        logs.length = 0;
        logInfo("logs cleared");
        emitToExtension("logs", { logs, state: getPublicState() });
      }
    });
  }

  function boot() {
    logInfo("boot", { href: location.href, ua: navigator.userAgent });
    patchFetch();
    patchXHR();
    watchDom();
    watchToggleManualOff();
    watchSpaNavigation();
    listenExtensionMessages();

    const delays = [800, 1800, 3500, 6000, 10000, 15000];
    for (const d of delays) {
      setTimeout(() => scheduleEnable("timer-" + d), d);
    }

    window.__geminiThinkingAuto = {
      state,
      logs,
      enable: () => {
        state.domEnableSucceeded = false;
        state.userDisabledThisSession = false;
        return runEnable("manual");
      },
      writePref: () => writeThinkingPreference(THINKING_LEVEL_EXTENDED),
      getState: getPublicState,
      dump: () => ({ state: getPublicState(), logs: logs.slice() }),
    };

    emitToExtension("ready", getPublicState());
  }

  boot();
})();
