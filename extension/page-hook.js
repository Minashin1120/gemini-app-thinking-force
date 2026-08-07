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

  function nativeClick(el) {
    if (!el) return;
    try {
      el.scrollIntoView({ block: "nearest", inline: "nearest" });
    } catch (_) {
      /* ignore */
    }
    try {
      el.focus({ preventScroll: true });
    } catch (_) {
      try {
        el.focus();
      } catch (__) {
        /* ignore */
      }
    }

    // Prefer a single native click() — creates a trusted-ish activation path.
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
    };
    el.dispatchEvent(new MouseEvent("mousedown", opts));
    el.dispatchEvent(new MouseEvent("mouseup", opts));
    el.dispatchEvent(new MouseEvent("click", opts));
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

  async function ensureMenuOpen() {
    if (isExtendedActiveInUi()) {
      logInfo("UI already shows extended on model chip");
      return true;
    }

    if (hasThinkingUi()) {
      logInfo("thinking UI already visible");
      return true;
    }

    if (isModelMenuOpen()) {
      logInfo("model menu open; waiting for thinking UI");
      for (let i = 0; i < 25; i++) {
        await sleep(100);
        if (hasThinkingUi()) return true;
        if (isExtendedActiveInUi()) return true;
        // Nested thinking nav
        if (i === 8) {
          const nav = queryDeep('[data-test-id="thinking-level-nav-button"]');
          if (nav && isVisible(nav)) {
            logInfo("click thinking-level-nav-button (menu already open)");
            nativeClick(nav);
          }
        }
      }
      // Do NOT re-click menu button while open
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
    nativeClick(btn);

    for (let i = 0; i < 40; i++) {
      await sleep(100);
      if (isExtendedActiveInUi()) return true;
      if (hasThinkingUi()) {
        logInfo("thinking UI visible after open", { waitMs: (i + 1) * 100 });
        return true;
      }
      if (i === 10) {
        const nav = queryDeep('[data-test-id="thinking-level-nav-button"]');
        if (nav && isVisible(nav)) {
          logInfo("click thinking-level-nav-button");
          nativeClick(nav);
        }
      }
      // If menu closed unexpectedly, reopen once
      if (i === 20 && !isModelMenuOpen()) {
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

  function closeMenuSoft() {
    // Only Escape — do not click the model chip (that toggles)
    document.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        code: "Escape",
        keyCode: 27,
        bubbles: true,
      })
    );
  }

  async function waitForExtended(msTotal) {
    const steps = Math.max(1, Math.floor(msTotal / 100));
    for (let i = 0; i < steps; i++) {
      if (isExtendedActiveInUi()) return true;
      await sleep(100);
    }
    return isExtendedActiveInUi();
  }

  async function enableViaDomAndNg() {
    if (state.userDisabledThisSession) {
      logInfo("skip: user disabled this session");
      return false;
    }

    state.domEnableAttempted = true;

    if (isExtendedActiveInUi()) {
      logInfo("already extended (chip text)");
      state.domEnableSucceeded = true;
      state.lastDomDetail = "chip-already-extended";
      return true;
    }

    // Strategy 0: Angular invoke WITHOUT opening menu (state may already be ready)
    if (!state.ngInvokeSucceeded) {
      const ngOk = tryInvokeAngularThinkingExtended();
      if (ngOk && (await waitForExtended(800))) {
        state.domEnableSucceeded = true;
        state.lastDomDetail = "ng-invoke-before-menu";
        logInfo("extended via Angular before menu");
        return true;
      }
    }

    const opened = await ensureMenuOpen();
    if (!opened && !hasThinkingUi()) {
      // Still try ng with menu DOM present partially
      logWarn("menu/thinking UI not confirmed; trying ng + retry open");
    }

    // Strategy 1: Angular invoke with menu open (components exist)
    {
      const ngOk = tryInvokeAngularThinkingExtended();
      if (ngOk && (await waitForExtended(1000))) {
        state.domEnableSucceeded = true;
        state.lastDomDetail = "ng-invoke-with-menu";
        logInfo("extended via Angular with menu");
        closeMenuSoft();
        return true;
      }
      if (isExtendedActiveInUi()) {
        state.domEnableSucceeded = true;
        state.lastDomDetail = "ng-invoke-chip";
        closeMenuSoft();
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
        if (await waitForExtended(1000)) {
          state.domEnableSucceeded = true;
          state.lastDomDetail = "slide-toggle-click";
          closeMenuSoft();
          return true;
        }
      } else {
        state.domEnableSucceeded = true;
        state.lastDomDetail = "slide-toggle-already-on";
        closeMenuSoft();
        return true;
      }
    } else {
      logInfo("no mat-slide-toggle (expected on current UI)");
    }

    // Strategy 3: click option row (single native click)
    const opt = findExtendedOptionTarget();
    if (opt) {
      logInfo("extended option target", {
        text: opt.text,
        why: opt.why,
        score: opt.score,
        selected: opt.selected,
        target: describeEl(opt.target),
        candidates: opt.candidates,
      });

      if (opt.selected && isExtendedActiveInUi()) {
        state.domEnableSucceeded = true;
        state.lastDomDetail = "option-already-selected";
        closeMenuSoft();
        return true;
      }

      // If option looks selected but chip doesn't, still re-click to force apply
      state.toggleClickCount += 1;
      const chipBefore = textOf(findMenuButton());
      nativeClick(opt.target);
      logInfo("clicked extended option (native)", {
        chipBefore,
        target: describeEl(opt.target),
      });

      // Menu often closes on success → option becomes null; trust chip text
      if (await waitForExtended(1500)) {
        state.domEnableSucceeded = true;
        state.lastDomDetail = "option-click-chip-extended";
        logInfo("success: chip shows extended after option click", {
          chip: textOf(findMenuButton()),
        });
        return true;
      }

      // Retry click parent/child
      const parentBtn =
        opt.target.parentElement &&
        opt.target.parentElement.closest("button, [role='menuitem']");
      if (parentBtn && parentBtn !== opt.target) {
        logInfo("retry click parent", describeEl(parentBtn));
        nativeClick(parentBtn);
        if (await waitForExtended(1000)) {
          state.domEnableSucceeded = true;
          state.lastDomDetail = "option-parent-click";
          return true;
        }
      }

      // Keyboard activate
      try {
        opt.target.focus();
        opt.target.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Enter",
            code: "Enter",
            keyCode: 13,
            bubbles: true,
          })
        );
        opt.target.dispatchEvent(
          new KeyboardEvent("keyup", {
            key: "Enter",
            code: "Enter",
            keyCode: 13,
            bubbles: true,
          })
        );
      } catch (_) {
        /* ignore */
      }
      if (await waitForExtended(800)) {
        state.domEnableSucceeded = true;
        state.lastDomDetail = "option-enter-key";
        return true;
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

    // Strategy 4: re-invoke Angular after DOM interactions
    if (tryInvokeAngularThinkingExtended() && (await waitForExtended(1000))) {
      state.domEnableSucceeded = true;
      state.lastDomDetail = "ng-invoke-after-dom";
      return true;
    }

    state.lastDomDetail = "all-strategies-failed";
    state.domEnableSucceeded = false;
    // Leave menu as-is if open so user can see; soft-close only if open long
    if (isModelMenuOpen()) closeMenuSoft();
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
    if (state.domEnableSucceeded && isExtendedActiveInUi()) return;
    if (enableTimer) clearTimeout(enableTimer);
    enableTimer = setTimeout(() => runEnable(reason), 300);
  }

  async function runEnable(reason) {
    if (enableInFlight) return;
    if (state.userDisabledThisSession) return;

    // Already good
    if (isExtendedActiveInUi()) {
      state.domEnableSucceeded = true;
      if (reason !== "poll") {
        logInfo("chip already extended; marking success", {
          chip: textOf(findMenuButton()),
        });
      }
      return;
    }

    // If we previously thought success but chip no longer shows 拡張, retry
    if (state.domEnableSucceeded && !isExtendedActiveInUi()) {
      logWarn("lost extended state; will retry");
      state.domEnableSucceeded = false;
    }

    const now = Date.now();
    if (now - state.lastEnableAt < 1200 && attemptCount > 0) return;
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
      });

      if (state.atToken) {
        if (!state.prefWriteAttempted || !state.prefWriteSucceeded) {
          state.prefWriteAttempted = true;
          await writeThinkingPreference(THINKING_LEVEL_EXTENDED);
        }
      }

      if (!state.domEnableSucceeded) {
        await enableViaDomAndNg();
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
      if (state.userDisabledThisSession) return;
      if (isExtendedActiveInUi()) {
        state.domEnableSucceeded = true;
        return;
      }
      if (state.domEnableSucceeded) return;
      if (scheduled) return;
      scheduled = true;
      setTimeout(() => {
        scheduled = false;
        if (hasThinkingUi() || isModelMenuOpen()) {
          scheduleEnable("mutation-menu");
        }
      }, 250);
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
      if (data.type === "getLogs") {
        emitToExtension("logs", { logs, state: getPublicState() });
      } else if (data.type === "getState") {
        emitToExtension("state", getPublicState());
      } else if (data.type === "enableNow") {
        state.domEnableSucceeded = false;
        state.userDisabledThisSession = false;
        state.ngInvokeSucceeded = false;
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
    logInfo("boot", { href: location.href, ua: navigator.userAgent, v: "1.2.0" });
    patchFetch();
    patchXHR();
    watchDom();
    watchManualOff();
    watchSpaNavigation();
    listenExtensionMessages();

    // Poll chip text — cheap success path if something else enables it
    setInterval(() => {
      if (state.userDisabledThisSession) return;
      if (isExtendedActiveInUi()) {
        if (!state.domEnableSucceeded) {
          state.domEnableSucceeded = true;
          logInfo("poll: chip shows extended");
          emitToExtension("state", getPublicState());
        }
      }
    }, 2000);

    const delays = [600, 1500, 3000, 5000, 8000, 12000, 18000];
    for (const d of delays) {
      setTimeout(() => scheduleEnable("timer-" + d), d);
    }

    window.__geminiThinkingAuto = {
      state,
      logs,
      enable: () => {
        state.domEnableSucceeded = false;
        state.userDisabledThisSession = false;
        state.ngInvokeSucceeded = false;
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
