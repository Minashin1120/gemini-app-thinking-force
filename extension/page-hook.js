/**
 * Page-world (MAIN) script.
 * Enables 強化版思考モード (THINKING_LEVEL_EXTENDED) on gemini.google.com.
 *
 * Lessons from user logs (v1.1):
 * - L5adhe pref write succeeds, but UI state is separate
 * - No mat-slide-toggle in current UI — option rows only
 * - Synthetic multi-event clicks often fail; after:null usually means menu closed
 * - Success signal: model chip text contains "拡張" (e.g. "Flash-Lite拡張")
 * - Re-clicking menu button while open CLOSES the menu (false "thinking UI not found")
 * - Prefer Angular component method invoke (yR / zR / onSelect) over DOM clicks
 */
(function () {
  "use strict";

  const SOURCE = "gemini-thinking-auto";
  const LOG_PREFIX = "[gemini-thinking-auto]";
  const PREF_KEY = "last_selected_thinking_level_on_web";
  const PREF_FIELD_ID = 265;
  const PREF_INDEX = PREF_FIELD_ID - 1;
  const THINKING_LEVEL_EXTENDED = 2;
  const THINKING_LEVEL_EXTENDED_STR = "THINKING_LEVEL_EXTENDED";
  const MAX_LOGS = 2000;

  /** Startup / retry timing (v1.4: prioritize first-paint enable speed). */
  const EARLY_WINDOW_MS = 6000;
  const SCHEDULE_DEBOUNCE_EARLY_MS = 40;
  const SCHEDULE_DEBOUNCE_LATE_MS = 120;
  const ENABLE_THROTTLE_EARLY_MS = 200;
  const ENABLE_THROTTLE_LATE_MS = 700;
  const POLL_STEP_MS = 50;

  /**
   * While the user is composing (IME) / actively typing in the prompt, delay
   * the UI enable so we never steal IME keystrokes or break composition.
   */
  const INPUT_IDLE_MS = 400;
  const MAX_INPUT_WAIT_MS = 10000;

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
    ngInvokeAttempted: false,
    ngInvokeSucceeded: false,
    userDisabledThisSession: false,
    lastEnableAt: 0,
    lastReason: null,
    lastError: null,
    lastDomDetail: null,
    menuOpenCount: 0,
    toggleClickCount: 0,
    /** True only when THIS extension opened the model menu (not the user). */
    menuOpenedByUs: false,
    /** IME composition currently active (compositionstart/end). */
    composing: false,
    /** Whether focus is inside the prompt composer. */
    promptActive: false,
    /** When focus last entered the prompt composer (ms epoch). */
    promptFocusAt: 0,
    /** When the user last typed in the prompt (ms epoch). */
    promptIdleAt: 0,
    /** Whether the last enable ran while the user was in the prompt (restore focus). */
    promptWasActive: false,
    /** Whether the isolated-world content script has reported consent state. */
    consentChecked: false,
    /** Whether the user accepted the ToS / privacy policy. Gates ALL enabling. */
    consentAccepted: false,
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
              class: String(v.className || "").slice(0, 120),
              testId: v.getAttribute("data-test-id"),
              role: v.getAttribute("role"),
              text: (v.textContent || "").replace(/\s+/g, " ").trim().slice(0, 80),
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
      const args =
        data === undefined ? [LOG_PREFIX, msg] : [LOG_PREFIX, msg, data];
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

  function isEarlyBoot() {
    return Date.now() - state.bootAt < EARLY_WINDOW_MS;
  }

  function getPublicState() {
    return {
      ...state,
      logCount: logs.length,
      url: location.href,
      hasAtToken: !!state.atToken,
      menuButtonText: textOf(findMenuButton()),
      uiLooksExtended: isExtendedActiveInUi(),
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
      Number(style.opacity) === 0
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
      if (el.shadowRoot) out.push(...queryAllDeep(selector, el.shadowRoot));
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
      "button.input-area-switch",
    ];
    for (const sel of selectors) {
      const el = queryDeep(sel);
      if (el && isVisible(el)) return el;
    }
    return null;
  }

  /**
   * Primary success signal from real UI (user log: "Flash-Lite拡張").
   */
  function isExtendedActiveInUi() {
    const btn = findMenuButton();
    if (!btn) return false;
    const t = textOf(btn);
    // Japanese UI appends "拡張" when THINKING_LEVEL_EXTENDED is selected
    if (/拡張/.test(t)) return true;
    if (/強化/.test(t)) return true;
    if (/Extended/i.test(t)) return true;
    // Avoid bare "Thinking" which may appear for other reasons
    return false;
  }

  function isModelMenuOpen() {
    const btn = findMenuButton();
    if (btn) {
      const expanded = btn.getAttribute("aria-expanded");
      if (expanded === "true") return true;
      if (expanded === "false") {
        // still check overlay — some builds omit aria-expanded
      }
    }

    const overlaySelectors = [
      '[data-test-id="bard-mode-popover-menu"]',
      '[data-test-id="bard-mode-desktop-gem-menu"]',
      '[data-test-id="gem-mode-menu"]',
      '[data-test-id="thinking-level-picker-desktop"]',
      '[data-test-id="thinking-level-list"]',
      '[data-test-id="thinking-level-option"]',
      ".cdk-overlay-pane",
    ];

    for (const sel of overlaySelectors) {
      for (const el of queryAllDeep(sel)) {
        if (!isVisible(el)) continue;
        const t = textOf(el);
        if (
          sel !== ".cdk-overlay-pane" ||
          /Flash|Pro|Gemini|思考|標準|強化|Thinking|Deep Think/i.test(t)
        ) {
          if (sel === ".cdk-overlay-pane" && t.length < 8) continue;
          return true;
        }
      }
    }
    return false;
  }

  function hasThinkingUi() {
    if (queryDeep('[data-test-id="thinking-level-option"]')) return true;
    if (queryDeep('[data-test-id="thinking-level-list"]')) return true;
    if (queryDeep('[data-test-id="thinking-level-picker-desktop"]')) return true;
    if (queryDeep('[data-test-id="thinking-level-toggle"]')) return true;
    if (queryDeep("mat-slide-toggle") && matchesLabel(document.body.innerText)) {
      // weak
    }
    // Any visible option-like node with 強化版
    for (const el of queryAllDeep(
      'button, [role="menuitem"], [data-test-id*="option"], [data-test-id*="mode"]'
    )) {
      if (!isVisible(el)) continue;
      const t = textOf(el);
      if (matchesLabel(t) && t.length < 80) return true;
    }
    return false;
  }

  function describeEl(el) {
    if (!el) return null;
    return {
      tag: el.tagName,
      testId: el.getAttribute("data-test-id"),
      role: el.getAttribute("role"),
      ariaChecked: el.getAttribute("aria-checked"),
      ariaSelected: el.getAttribute("aria-selected"),
      ariaDisabled: el.getAttribute("aria-disabled"),
      class: String(el.className || "").slice(0, 100),
      text: textOf(el).slice(0, 100),
      disabled: !!el.disabled,
    };
  }

  /**
   * Find the clickable node for 強化版思考 option.
   */
  function findExtendedOptionTarget() {
    const candidates = [];

    const push = (el, score, why) => {
      if (!el || !isVisible(el)) return;
      const t = textOf(el);
      if (!matchesLabel(t)) return;
      if (t.length > 100) return;
      candidates.push({ el, score, why, text: t });
    };

    for (const el of queryAllDeep('[data-test-id="thinking-level-option"]')) {
      push(el, 100, "thinking-level-option");
    }
    for (const el of queryAllDeep(
      '[data-test-id^="bard-mode-option"], [data-test-id^="bard-mode-sub-option"]'
    )) {
      push(el, 80, "bard-mode-option");
    }
    for (const el of queryAllDeep(
      'button[role="menuitem"], [role="menuitem"], button.mat-mdc-menu-item, .mat-mdc-menu-item'
    )) {
      push(el, 60, "menuitem");
    }
    for (const el of queryAllDeep("button, [role='button'], [role='option']")) {
      push(el, 30, "button-ish");
    }

    candidates.sort((a, b) => b.score - a.score);
    if (!candidates.length) return null;

    const best = candidates[0];
    // Prefer actual interactive host
    let target = best.el;
    const host =
      target.closest(
        '[data-test-id="thinking-level-option"], [data-test-id^="bard-mode-option"], [data-test-id^="bard-mode-sub-option"], button, [role="menuitem"], .mat-mdc-menu-item'
      ) || target;
    if (host) target = host;

    const selected =
      target.classList.contains("selected") ||
      target.getAttribute("aria-selected") === "true" ||
      target.getAttribute("aria-checked") === "true" ||
      !!target.querySelector(".thinking-level-check, [fontIcon='check'], .mode-check");

    return {
      target,
      text: best.text,
      score: best.score,
      why: best.why,
      selected,
      candidates: candidates.slice(0, 6).map((c) => ({
        why: c.why,
        score: c.score,
        text: c.text,
        el: describeEl(c.el),
      })),
    };
  }

  function findSlideToggle() {
    for (const host of queryAllDeep("mat-slide-toggle, .mat-mdc-slide-toggle")) {
      if (!isVisible(host)) continue;
      const ctx = textOf(host.parentElement || host);
      if (!matchesLabel(ctx) && !matchesLabel(textOf(host))) continue;
      const button =
        host.querySelector(
          'button[role="switch"], button.mdc-switch, .mdc-switch, input[type="checkbox"]'
        ) || host;
      const on =
        button.getAttribute("aria-checked") === "true" ||
        host.classList.contains("mat-mdc-slide-toggle-checked") ||
        host.classList.contains("mdc-switch--selected");
      return { host, button, on };
    }
    return null;
  }

  /**
   * Click without focusing (focus causes CDK keyboard ring / "Tab-selected" look).
   * Do NOT send Tab / Enter / Escape — those steal focus and close unrelated modals.
   */
  function nativeClick(el) {
    if (!el) return;
    try {
      el.scrollIntoView({ block: "nearest", inline: "nearest" });
    } catch (_) {
      /* ignore */
    }

    try {
      if (typeof el.click === "function") {
        el.click();
        return;
      }
    } catch (_) {
      /* fall through */
    }

    const rect = el.getBoundingClientRect();
    const opts = {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
      button: 0,
      buttons: 1,
      detail: 1,
    };
    el.dispatchEvent(new MouseEvent("mousedown", opts));
    el.dispatchEvent(new MouseEvent("mouseup", opts));
    el.dispatchEvent(new MouseEvent("click", opts));
  }

  /** Drop programmatic focus ring on mode/menu controls after our work. */
  function clearSpuriousFocus() {
    try {
      const ae = document.activeElement;
      if (!(ae instanceof HTMLElement) || ae === document.body) return;
      const isOurs =
        ae.matches?.(
          '[data-test-id="bard-mode-menu-button"], [data-test-id*="thinking"], [data-test-id*="bard-mode"], button.input-area-switch'
        ) ||
        ae.closest?.(
          '.cdk-overlay-pane, [data-test-id*="thinking"], [data-test-id*="bard-mode"], mat-menu'
        );
      if (isOurs) ae.blur();
    } catch (_) {
      /* ignore */
    }
  }

  function markSuccess(detail) {
    state.domEnableSucceeded = true;
    state.lastDomDetail = detail;
    clearSpuriousFocus();
  }

  // ---------------------------------------------------------------------------
  // Prompt input protection (IME / typing) — never steal the user's keystrokes
  // ---------------------------------------------------------------------------

  let promptInputCache = null;
  let promptInputCacheAt = 0;

  /**
   * Find the prompt composer (textarea / rich-textarea / contenteditable).
   * Cached briefly because it is consulted on every keydown while typing.
   */
  function findPromptInput() {
    if (
      promptInputCache &&
      promptInputCache.isConnected &&
      Date.now() - promptInputCacheAt < 1000 &&
      isVisible(promptInputCache)
    ) {
      return promptInputCache;
    }
    const selectors = [
      '[data-test-id="prompt-textarea"]',
      '[data-test-id="prompt-input"]',
      '[data-test-id="chat-input"]',
      "rich-textarea",
      ".rich-textarea",
      ".input-area textarea",
      "textarea",
    ];
    let el = null;
    for (const sel of selectors) {
      el = queryDeep(sel);
      if (el && isVisible(el)) break;
    }
    promptInputCache = el;
    promptInputCacheAt = Date.now();
    return el;
  }

  function isPromptElement(el) {
    if (!(el instanceof Element)) return false;
    const prompt = findPromptInput();
    if (prompt) {
      if (el === prompt || prompt.contains(el)) return true;
    }
    return !!el.closest?.(
      '[data-test-id*="prompt"], [data-test-id*="chat-input"], rich-textarea, .rich-textarea, .input-area'
    );
  }

  function installPromptInputWatchers() {
    const refresh = () => {
      const ae = document.activeElement;
      const inPrompt = ae instanceof Element && isPromptElement(ae);
      state.promptActive = inPrompt;
      if (inPrompt && !state.promptFocusAt) state.promptFocusAt = Date.now();
    };

    document.addEventListener("focusin", refresh, true);
    document.addEventListener(
      "compositionstart",
      () => {
        state.composing = true;
      },
      true
    );
    document.addEventListener(
      "compositionend",
      () => {
        state.composing = false;
      },
      true
    );
    const markTyping = () => {
      const ae = document.activeElement;
      if (!(ae instanceof Element)) return;
      if (state.promptActive || isPromptElement(ae)) {
        state.promptActive = true;
        state.promptIdleAt = Date.now();
      }
    };
    document.addEventListener("keydown", markTyping, true);
    document.addEventListener("input", markTyping, true);
  }

  /** True while the user is composing / actively typing in the prompt. */
  function userPromptActive() {
    if (state.composing) return true;
    return !!(
      state.promptIdleAt &&
      Date.now() - state.promptIdleAt < INPUT_IDLE_MS
    );
  }

  /** Resolve true once input is quiet; false if it stays busy for maxMs. */
  async function waitForInputQuiet(maxMs) {
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline) {
      if (!userPromptActive()) return true;
      await sleep(100);
    }
    return false;
  }

  function focusableIn(el) {
    if (!el) return null;
    if (el.matches?.('[contenteditable="true"], textarea, input')) return el;
    const inner = el.querySelector('[contenteditable="true"], textarea, input');
    return inner || el;
  }

  /** Put the caret back into the prompt composer. Returns true on success. */
  function restorePromptFocus() {
    const prompt = findPromptInput();
    const target = focusableIn(prompt);
    if (!target) return false;
    try {
      target.focus({ preventScroll: false });
    } catch (_) {
      try {
        target.focus();
      } catch (_) {
        return false;
      }
    }
    if (target.isContentEditable) {
      try {
        const range = document.createRange();
        range.selectNodeContents(target);
        range.collapse(false);
        const sel = window.getSelection();
        if (sel) {
          sel.removeAllRanges();
          sel.addRange(range);
        }
      } catch (_) {
        /* ignore */
      }
    }
    logInfo("restored focus to prompt bar", {
      tag: target.tagName,
      testId: target.getAttribute("data-test-id"),
    });
    return true;
  }

  /** Restore focus once after the menu close / Angular settle (one-shot). */
  function schedulePromptFocusRestore() {
    if (!state.promptWasActive) return;
    state.promptWasActive = false;
    let attempts = 0;
    const tryRestore = () => {
      attempts += 1;
      if (restorePromptFocus()) return;
      if (attempts < 5) setTimeout(tryRestore, 200);
    };
    setTimeout(tryRestore, 120);
  }

  // ---------------------------------------------------------------------------
  // Angular Ivy: find component instances and call yR / zR / onSelect
  // ---------------------------------------------------------------------------

  let ngCache = { at: 0, hits: [] };

  function collectNgObjects(limit = 5000) {
    const now = Date.now();
    if (ngCache.hits.length && now - ngCache.at < 2000) return ngCache.hits;

    const found = [];
    const seen = new Set();
    // Prefer menu/overlay subtree if present (faster + more relevant)
    const roots = [];
    for (const sel of [
      ".cdk-overlay-container",
      '[data-test-id="bard-mode-popover-menu"]',
      '[data-test-id="gem-mode-menu"]',
      "body",
    ]) {
      const r = document.querySelector(sel);
      if (r) roots.push(r);
    }
    if (!roots.length) roots.push(document.documentElement);

    for (const root of roots) {
      const els = root.querySelectorAll("*");
      for (let i = 0; i < els.length && found.length < limit; i++) {
        const el = els[i];
        const ctx = el.__ngContext__;
        if (!ctx) continue;

        const visit = (node, depth) => {
          if (!node || depth > 3) return;
          if (typeof node !== "object") return;
          if (seen.has(node)) return;
          seen.add(node);
          found.push({ obj: node, el });
          if (depth < 2 && !Array.isArray(node)) {
            try {
              for (const k of Object.keys(node)) {
                if (k.startsWith("_")) continue;
                const v = node[k];
                if (
                  v &&
                  typeof v === "object" &&
                  !seen.has(v) &&
                  (typeof v.yR === "function" ||
                    typeof v.zR === "function" ||
                    typeof v.onSelect === "function")
                ) {
                  visit(v, depth + 1);
                }
              }
            } catch (_) {
              /* ignore */
            }
          }
        };

        if (Array.isArray(ctx)) {
          for (const item of ctx) visit(item, 0);
        } else {
          visit(ctx, 0);
        }
      }
      if (found.length >= limit) break;
    }

    ngCache = { at: now, hits: found };
    return found;
  }

  function tryInvokeAngularThinkingExtended() {
    state.ngInvokeAttempted = true;
    const TARGET = THINKING_LEVEL_EXTENDED_STR;
    const hits = collectNgObjects();
    logInfo("ng object scan", { count: hits.length });

    const attempts = [];

    for (const { obj, el } of hits) {
      try {
        // thinking-level-picker: zR({checked:true}) → onSelect(EXTENDED)
        if (typeof obj.zR === "function") {
          attempts.push("zR");
          obj.zR({ checked: true });
          logInfo("invoked zR({checked:true})", { el: describeEl(el) });
          state.ngInvokeSucceeded = true;
          return true;
        }
      } catch (err) {
        logWarn("zR invoke failed", String(err));
      }
    }

    for (const { obj, el } of hits) {
      try {
        // mode switcher: yR("THINKING_LEVEL_EXTENDED")
        if (typeof obj.yR === "function") {
          // Heuristic: components that know thinking levels
          const hasThinkingHints =
            obj.hA !== undefined ||
            obj.sta !== undefined ||
            obj.pz !== undefined ||
            obj.Vb !== undefined ||
            obj.TVd !== undefined ||
            (obj.Qkc && typeof obj.Qkc.emit === "function");
          if (!hasThinkingHints && typeof obj.zR !== "function") {
            // Still try yR if method name exists alongside mode lists
            if (!obj.Zfa && !obj.Ab && !obj.Aa) continue;
          }
          attempts.push("yR");
          obj.yR(TARGET);
          logInfo("invoked yR(THINKING_LEVEL_EXTENDED)", {
            el: describeEl(el),
            keys: Object.keys(obj).slice(0, 20),
          });
          state.ngInvokeSucceeded = true;
          return true;
        }
      } catch (err) {
        logWarn("yR invoke failed", String(err));
      }
    }

    for (const { obj, el } of hits) {
      try {
        if (typeof obj.onSelect === "function" && typeof obj.pz === "function") {
          const list = obj.pz();
          if (Array.isArray(list)) {
            const cfg = list.find(
              (x) => x && (x.ti === TARGET || x.ti === "THINKING_LEVEL_EXTENDED")
            );
            if (cfg) {
              attempts.push("onSelect");
              obj.onSelect(cfg);
              logInfo("invoked onSelect(extended cfg)", {
                el: describeEl(el),
                ti: cfg.ti,
              });
              state.ngInvokeSucceeded = true;
              return true;
            }
          }
        }
      } catch (err) {
        logWarn("onSelect invoke failed", String(err));
      }
    }

    // BehaviorSubject-like: Aa.next(THINKING_LEVEL_EXTENDED)
    for (const { obj, el } of hits) {
      try {
        if (
          obj.Aa &&
          typeof obj.Aa.next === "function" &&
          (obj.Ga || obj.ha || typeof obj.Ab !== "undefined")
        ) {
          const cur = obj.Aa.value;
          if (cur === TARGET) {
            logInfo("Aa already EXTENDED", { el: describeEl(el) });
            state.ngInvokeSucceeded = true;
            return true;
          }
          attempts.push("Aa.next");
          obj.Aa.next(TARGET);
          logInfo("invoked Aa.next(EXTENDED)", {
            el: describeEl(el),
            prev: cur,
          });
          // Also try setValue path if present
          try {
            if (obj.Ga && obj.Ga.ha && obj.Ga.ha.ha && obj.Ga.ha.ha.setValue) {
              obj.Ga.ha.ha.setValue(265, 2);
            } else if (obj.ha && obj.ha.ha && obj.ha.ha.setValue) {
              obj.ha.ha.setValue(265, 2);
            }
          } catch (_) {
            /* ignore */
          }
          state.ngInvokeSucceeded = true;
          return true;
        }
      } catch (err) {
        logWarn("Aa.next invoke failed", String(err));
      }
    }

    logWarn("no Angular thinking controller invoked", { attempts });
    return false;
  }

  // ---------------------------------------------------------------------------
  // Menu open / enable flow
  // ---------------------------------------------------------------------------

  /**
   * Close the model menu ONLY if we opened it.
   * Never send Escape (closes unrelated dialogs). Never leave focus rings.
   */
  function closeMenuIfWeOpened() {
    if (!state.menuOpenedByUs) {
      clearSpuriousFocus();
      return;
    }
    if (!isModelMenuOpen()) {
      state.menuOpenedByUs = false;
      clearSpuriousFocus();
      return;
    }
    const btn = findMenuButton();
    if (btn && isVisible(btn)) {
      logInfo("closing menu we opened (re-click chip, no Escape)");
      nativeClick(btn);
    }
    state.menuOpenedByUs = false;
    // Let Angular settle then drop focus
    setTimeout(clearSpuriousFocus, 50);
    setTimeout(clearSpuriousFocus, 200);
  }

  async function ensureMenuOpen() {
    // Caller must only use this when chip is NOT already extended.
    if (hasThinkingUi()) {
      logInfo("thinking UI already visible (user or prior open)");
      return true;
    }

    if (isModelMenuOpen()) {
      logInfo("model menu already open; waiting for thinking UI (no re-click)");
      // ~1.25s max @ 50ms steps (was 2.5s @ 100ms)
      for (let i = 0; i < 25; i++) {
        await sleep(POLL_STEP_MS);
        if (hasThinkingUi()) return true;
        if (isExtendedActiveInUi()) return true;
        if (i === 8) {
          const nav = queryDeep('[data-test-id="thinking-level-nav-button"]');
          if (nav && isVisible(nav)) {
            logInfo("click thinking-level-nav-button (menu already open)");
            nativeClick(nav);
          }
        }
      }
      logWarn("menu open but thinking UI still missing");
      return hasThinkingUi();
    }

    const btn = findMenuButton();
    if (!btn) {
      logWarn("menu button not found");
      state.lastDomDetail = "menu-button-missing";
      return false;
    }

    logInfo("opening model menu", {
      button: describeEl(btn),
      text: textOf(btn),
    });
    state.menuOpenCount += 1;
    state.menuOpenedByUs = true;
    nativeClick(btn);

    // ~2s max @ 50ms (was 4s @ 100ms). Success usually within 1–3 frames.
    for (let i = 0; i < 40; i++) {
      await sleep(POLL_STEP_MS);
      if (isExtendedActiveInUi()) return true;
      if (hasThinkingUi()) {
        logInfo("thinking UI visible after open", {
          waitMs: (i + 1) * POLL_STEP_MS,
        });
        return true;
      }
      if (i === 10) {
        const nav = queryDeep('[data-test-id="thinking-level-nav-button"]');
        if (nav && isVisible(nav)) {
          logInfo("click thinking-level-nav-button");
          nativeClick(nav);
        }
      }
      // Reopen once only if the menu we opened vanished
      if (i === 20 && !isModelMenuOpen() && state.menuOpenedByUs) {
        logInfo("menu closed unexpectedly; reopening once");
        state.menuOpenCount += 1;
        nativeClick(btn);
      }
    }

    logWarn("thinking UI not found after opening menu", {
      menuOpen: isModelMenuOpen(),
      chip: textOf(findMenuButton()),
    });
    state.lastDomDetail = "thinking-ui-missing-after-open";
    return false;
  }

  async function waitForExtended(msTotal) {
    const steps = Math.max(1, Math.floor(msTotal / POLL_STEP_MS));
    for (let i = 0; i < steps; i++) {
      if (isExtendedActiveInUi()) return true;
      await sleep(POLL_STEP_MS);
    }
    return isExtendedActiveInUi();
  }

  async function enableViaDomAndNg() {
    if (state.userDisabledThisSession) {
      logInfo("skip: user disabled this session");
      return false;
    }

    state.domEnableAttempted = true;

    // ---- Fast path: already on → zero UI interaction ----
    if (isExtendedActiveInUi()) {
      logInfo("already extended (chip text) — skip menu/focus", {
        chip: textOf(findMenuButton()),
      });
      markSuccess("chip-already-extended");
      return true;
    }

    // Nothing to drive yet — avoid expensive ng scans on every early timer tick.
    // MutationObserver / early poll will re-arm as soon as the chip mounts.
    if (!findMenuButton() && !hasThinkingUi() && !isModelMenuOpen()) {
      state.lastDomDetail = "ui-not-ready";
      logInfo("ui not ready yet (no model chip)");
      return false;
    }

    // Strategy 0: Angular invoke WITHOUT opening menu (short confirm window)
    if (!state.ngInvokeSucceeded) {
      const ngOk = tryInvokeAngularThinkingExtended();
      if (ngOk && (await waitForExtended(350))) {
        markSuccess("ng-invoke-before-menu");
        logInfo("extended via Angular before menu");
        clearSpuriousFocus();
        return true;
      }
    }

    // Only open menu if still not extended
    if (isExtendedActiveInUi()) {
      markSuccess("chip-extended-after-ng");
      return true;
    }

    const opened = await ensureMenuOpen();
    if (!opened && !hasThinkingUi()) {
      logWarn("menu/thinking UI not confirmed; trying ng anyway");
    }

    // If opening the menu alone revealed chip already extended, stop.
    if (isExtendedActiveInUi()) {
      markSuccess("chip-extended-after-menu-open");
      closeMenuIfWeOpened();
      return true;
    }

    // Strategy 1: Angular with menu DOM present
    {
      const ngOk = tryInvokeAngularThinkingExtended();
      if (ngOk && (await waitForExtended(500))) {
        markSuccess("ng-invoke-with-menu");
        logInfo("extended via Angular with menu");
        closeMenuIfWeOpened();
        return true;
      }
      if (isExtendedActiveInUi()) {
        markSuccess("ng-invoke-chip");
        closeMenuIfWeOpened();
        return true;
      }
    }

    // Strategy 2: mat-slide-toggle if present
    const toggle = findSlideToggle();
    if (toggle) {
      logInfo("found slide toggle", { on: toggle.on, host: describeEl(toggle.host) });
      if (!toggle.on) {
        state.toggleClickCount += 1;
        nativeClick(toggle.button);
        if (await waitForExtended(600)) {
          markSuccess("slide-toggle-click");
          closeMenuIfWeOpened();
          return true;
        }
      } else if (isExtendedActiveInUi()) {
        markSuccess("slide-toggle-already-on");
        closeMenuIfWeOpened();
        return true;
      }
    }

    // Strategy 3: click option row (single native click, no focus/Enter)
    const opt = findExtendedOptionTarget();
    if (opt) {
      logInfo("extended option target", {
        text: opt.text,
        why: opt.why,
        score: opt.score,
        selected: opt.selected,
        target: describeEl(opt.target),
      });

      // Already selected in list + chip confirms → done (don't force re-click)
      if (opt.selected && isExtendedActiveInUi()) {
        markSuccess("option-already-selected");
        closeMenuIfWeOpened();
        return true;
      }

      // Selected in list but chip not yet — click once to apply
      if (opt.selected && !isExtendedActiveInUi()) {
        logInfo("option selected in menu but chip not 拡張 yet; click once");
      }

      state.toggleClickCount += 1;
      const chipBefore = textOf(findMenuButton());
      nativeClick(opt.target);
      logInfo("clicked extended option (native, no focus)", {
        chipBefore,
        target: describeEl(opt.target),
      });

      if (await waitForExtended(900)) {
        markSuccess("option-click-chip-extended");
        logInfo("success: chip shows extended after option click", {
          chip: textOf(findMenuButton()),
        });
        // Selection often auto-closes menu; only close if still open and we opened it
        closeMenuIfWeOpened();
        return true;
      }

      const parentBtn =
        opt.target.parentElement &&
        opt.target.parentElement.closest("button, [role='menuitem']");
      if (parentBtn && parentBtn !== opt.target) {
        logInfo("retry click parent", describeEl(parentBtn));
        nativeClick(parentBtn);
        if (await waitForExtended(600)) {
          markSuccess("option-parent-click");
          closeMenuIfWeOpened();
          return true;
        }
      }

      logWarn("option click did not produce 拡張 on chip", {
        chipAfter: textOf(findMenuButton()),
        menuOpen: isModelMenuOpen(),
      });
    } else {
      logWarn("extended option target not found", {
        menuOpen: isModelMenuOpen(),
        thinkingUi: hasThinkingUi(),
      });
    }

    // Strategy 4: re-invoke Angular after DOM
    if (tryInvokeAngularThinkingExtended() && (await waitForExtended(500))) {
      markSuccess("ng-invoke-after-dom");
      closeMenuIfWeOpened();
      return true;
    }

    state.lastDomDetail = "all-strategies-failed";
    state.domEnableSucceeded = false;
    // Do NOT Escape-close. Only close menu we opened so we don't leave junk open.
    closeMenuIfWeOpened();
    clearSpuriousFocus();
    return false;
  }

  // ---------------------------------------------------------------------------
  // Orchestration
  // ---------------------------------------------------------------------------

  let enableTimer = null;
  let enableInFlight = false;
  let attemptCount = 0;
  /** Coalesce concurrent scheduleEnable reasons while waiting for debounce. */
  let pendingReason = null;

  function scheduleEnable(reason) {
    if (state.userDisabledThisSession) return;
    // Never enable until the user has accepted the ToS / privacy policy.
    if (!state.consentAccepted) return;
    // Hard stop once success is confirmed by chip
    if (state.domEnableSucceeded && isExtendedActiveInUi()) return;
    if (isExtendedActiveInUi()) {
      markSuccess("schedule-chip-already-extended");
      return;
    }
    pendingReason = reason || pendingReason || "unknown";
    if (enableTimer) clearTimeout(enableTimer);
    const delay = isEarlyBoot()
      ? SCHEDULE_DEBOUNCE_EARLY_MS
      : SCHEDULE_DEBOUNCE_LATE_MS;
    enableTimer = setTimeout(() => {
      const r = pendingReason || reason;
      pendingReason = null;
      runEnable(r);
    }, delay);
  }

  async function runEnable(reason) {
    if (enableInFlight) return;
    if (state.userDisabledThisSession) return;
    // Consent gate: "enableNow" from popup is also blocked until accepted.
    if (!state.consentAccepted) {
      logWarn("skip: consent not granted");
      return;
    }

    // Already good — never open menu / never focus
    if (isExtendedActiveInUi()) {
      if (!state.domEnableSucceeded || reason === "popup" || reason === "manual") {
        logInfo("chip already extended; no UI action", {
          chip: textOf(findMenuButton()),
          reason,
        });
      }
      markSuccess("chip-already-extended");
      // Still persist pref once if we have token and never wrote
      if (state.atToken && !state.prefWriteAttempted) {
        state.prefWriteAttempted = true;
        writeThinkingPreference(THINKING_LEVEL_EXTENDED).catch(() => {});
      }
      emitToExtension("state", getPublicState());
      return;
    }

    // If we previously thought success but chip no longer shows 拡張, retry
    if (state.domEnableSucceeded && !isExtendedActiveInUi()) {
      logWarn("lost extended state; will retry");
      state.domEnableSucceeded = false;
    }

    // Pref may be written as soon as we have a token (does not need chip).
    if (state.atToken) {
      if (!state.prefWriteAttempted || !state.prefWriteSucceeded) {
        state.prefWriteAttempted = true;
        writeThinkingPreference(THINKING_LEVEL_EXTENDED).catch(() => {});
      }
    }

    // Cheap readiness gate — does NOT consume throttle / attemptCount so the
    // first real attempt can start the instant the model chip mounts.
    const uiReady =
      !!findMenuButton() || hasThinkingUi() || isModelMenuOpen();
    if (!uiReady && reason !== "popup" && reason !== "manual") {
      return;
    }

    const now = Date.now();
    const throttleMs = isEarlyBoot()
      ? ENABLE_THROTTLE_EARLY_MS
      : ENABLE_THROTTLE_LATE_MS;
    // Manual / popup always allowed; early boot uses short throttle.
    if (
      reason !== "popup" &&
      reason !== "manual" &&
      now - state.lastEnableAt < throttleMs &&
      attemptCount > 0
    ) {
      // Re-queue so a "chip just appeared" signal is not lost under throttle
      if (!enableTimer) {
        enableTimer = setTimeout(
          () => runEnable(reason || "throttled-retry"),
          throttleMs - (now - state.lastEnableAt) + 10
        );
      }
      return;
    }
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
        chip: textOf(findMenuButton()),
        early: isEarlyBoot(),
        elapsedMs: now - state.bootAt,
      });

      if (isExtendedActiveInUi()) {
        markSuccess("chip-before-dom");
        return;
      }

      if (!state.domEnableSucceeded) {
        // Never steal IME keystrokes / break composition while the user is
        // typing in the prompt. Wait until the input settles (変換確定); if the
        // user keeps typing, postpone this attempt — later triggers retry.
        if (userPromptActive() || state.promptActive) {
          state.promptWasActive = true;
          logInfo("user typing/composing; waiting for prompt input to settle", {
            composing: state.composing,
            promptActive: state.promptActive,
          });
          const settled = await waitForInputQuiet(MAX_INPUT_WAIT_MS);
          if (!settled) {
            logWarn("prompt input stayed busy; deferring UI enable");
            return;
          }
        }
        await enableViaDomAndNg();
      }

      emitToExtension("state", getPublicState());
    } catch (err) {
      logError("runEnable error", err);
      state.lastError = String(err);
    } finally {
      enableInFlight = false;
      clearSpuriousFocus();
      // Put the caret back into the prompt bar when the enable ran while the
      // user was composing / had focused the prompt.
      if (state.domEnableSucceeded || isExtendedActiveInUi()) {
        schedulePromptFocusRestore();
      }
      // Do not auto-reopen the menu here after a full attempt — that caused
      // multi-second thrashing. Early timers / mutation / poll re-arm when the
      // chip first mounts.
    }
  }

  function watchDom() {
    let scheduled = false;
    const observer = new MutationObserver(() => {
      if (state.userDisabledThisSession) return;
      if (isExtendedActiveInUi()) {
        if (!state.domEnableSucceeded) markSuccess("mutation-chip-extended");
        return;
      }
      if (state.domEnableSucceeded) return;
      if (scheduled) return;
      scheduled = true;
      setTimeout(() => {
        scheduled = false;
        if (state.domEnableSucceeded || isExtendedActiveInUi()) return;
        // React as soon as the model chip / thinking UI mounts — this is the
        // main path for "enable on first paint" (timers alone are too late).
        if (hasThinkingUi()) {
          scheduleEnable("mutation-thinking-ui");
        } else if (findMenuButton()) {
          scheduleEnable("mutation-menu-button");
        }
      }, isEarlyBoot() ? 40 : 120);
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

  function watchManualOff() {
    // If chip loses 拡張 after we enabled, and user interacted with menu, respect off
    document.addEventListener(
      "click",
      (ev) => {
        const t = ev.target;
        if (!(t instanceof Element)) return;
        const inModeUi = t.closest(
          '[data-test-id="bard-mode-menu-button"], [data-test-id*="thinking"], [data-test-id*="bard-mode"], mat-slide-toggle'
        );
        if (!inModeUi) return;
        setTimeout(() => {
          if (!state.domEnableSucceeded) return;
          if (!isExtendedActiveInUi()) {
            // Distinguish our failed run vs user off: only if we had success and chip lost 拡張 after user click
            state.userDisabledThisSession = true;
            state.domEnableSucceeded = false;
            logInfo("user appears to have disabled extended; stop re-enable");
            emitToExtension("state", getPublicState());
          }
        }, 400);
      },
      true
    );
  }

  function watchSpaNavigation() {
    const reset = () => {
      if (state.userDisabledThisSession) return;
      state.domEnableSucceeded = false;
      state.prefWriteAttempted = false;
      state.ngInvokeSucceeded = false;
      attemptCount = 0;
      state.lastEnableAt = 0;
      // Re-open early timing window so the new view enables as fast as load.
      state.bootAt = Date.now();
      scheduleEnable("navigation");
    };
    const wrap = (name) => {
      const orig = history[name];
      history[name] = function () {
        const ret = orig.apply(this, arguments);
        reset();
        return ret;
      };
    };
    wrap("pushState");
    wrap("replaceState");
    window.addEventListener("popstate", reset);
  }

  function listenExtensionMessages() {
    window.addEventListener("message", (event) => {
      if (event.source !== window) return;
      const data = event.data;
      if (!data || data.source !== SOURCE + "-bridge") return;
      if (data.type === "consentResult") {
        state.consentChecked = true;
        state.consentAccepted = !!(data.payload && data.payload.accepted);
        if (state.consentAccepted) {
          logInfo("consent granted; arming auto-enable");
          scheduleEnable("consent-granted");
        } else {
          logInfo("consent not granted; auto-enable stays off");
        }
      } else if (data.type === "getLogs") {
        emitToExtension("logs", { logs, state: getPublicState() });
      } else if (data.type === "getState") {
        emitToExtension("state", getPublicState());
      } else if (data.type === "enableNow") {
        state.domEnableSucceeded = false;
        state.userDisabledThisSession = false;
        state.ngInvokeSucceeded = false;
        state.menuOpenedByUs = false;
        attemptCount = 0;
        runEnable("popup");
      } else if (data.type === "clearLogs") {
        logs.length = 0;
        logInfo("logs cleared");
        emitToExtension("logs", { logs, state: getPublicState() });
      }
    });
  }

  function boot() {
    logInfo("boot", { href: location.href, ua: navigator.userAgent, v: "1.6.0" });
    patchFetch();
    patchXHR();
    watchDom();
    watchManualOff();
    watchSpaNavigation();
    installPromptInputWatchers();
    listenExtensionMessages();

    // Poll chip text — cheap success path if something else enables it
    setInterval(() => {
      if (state.userDisabledThisSession) return;
      if (isExtendedActiveInUi()) {
        if (!state.domEnableSucceeded) {
          markSuccess("poll-chip-extended");
          logInfo("poll: chip shows extended");
          emitToExtension("state", getPublicState());
        }
      }
    }, 2000);

    // Aggressive early timers: fire as soon as SPA shell might have the chip.
    // Old v1.3 schedule started at 600ms and throttled retries by 1200ms.
    const delays = [0, 80, 200, 400, 700, 1200, 2000, 3500, 6000, 10000];
    for (const d of delays) {
      setTimeout(() => {
        if (state.userDisabledThisSession) return;
        if (isExtendedActiveInUi()) return;
        scheduleEnable("timer-" + d);
      }, d);
    }

    // Dense early poll for menu button (covers gap between mutations)
    const earlyPollUntil = Date.now() + EARLY_WINDOW_MS;
    const earlyPollId = setInterval(() => {
      if (Date.now() > earlyPollUntil || state.userDisabledThisSession) {
        clearInterval(earlyPollId);
        return;
      }
      if (isExtendedActiveInUi()) {
        if (!state.domEnableSucceeded) markSuccess("early-poll-chip");
        clearInterval(earlyPollId);
        return;
      }
      if (state.domEnableSucceeded || enableInFlight) return;
      if (findMenuButton()) scheduleEnable("early-poll-chip-ready");
    }, 100);

    window.__geminiThinkingAuto = {
      state,
      logs,
      enable: () => {
        state.domEnableSucceeded = false;
        state.userDisabledThisSession = false;
        state.ngInvokeSucceeded = false;
        state.menuOpenedByUs = false;
        attemptCount = 0;
        return runEnable("manual");
      },
      writePref: () => writeThinkingPreference(THINKING_LEVEL_EXTENDED),
      getState: getPublicState,
      dump: () => ({ state: getPublicState(), logs: logs.slice() }),
      isExtended: isExtendedActiveInUi,
      tryNg: tryInvokeAngularThinkingExtended,
    };

    emitToExtension("ready", getPublicState());
  }

  boot();
})();
