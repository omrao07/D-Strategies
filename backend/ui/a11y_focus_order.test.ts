// a11yfocusordertests.ts
// Zero-dependency accessibility helpers to verify keyboard focus order & traps.
// Pure TS, framework-agnostic, browser-only (no Node globals).

/** Unique label to display an element in results. Prefers [data-focus-id], then id, then tag#idx. */
function focusLabel(el: Element, idxHint?: number): string {
  const d = (el as HTMLElement).getAttribute?.("data-focus-id");
  if (d) return d;
  const id = (el as HTMLElement).id;
  if (id) return `#${id}`;
  const name = el.tagName.toLowerCase();
  const role = (el as HTMLElement).getAttribute?.("role");
  const roleSeg = role ? `[role=${role}]` : "";
  const idxSeg = Number.isFinite(idxHint!) ? `:${idxHint}` : "";
  return `${name}${roleSeg}${idxSeg}`;
}

/** True if element can receive programmatic focus and should be in tab order. */
function isTabbable(el: Element): el is HTMLElement {
  const e = el as HTMLElement;

  // Cannot focus if not an HTMLElement
  if (!e || typeof e.focus !== "function") return false;

  // Disabled form controls
  // @ts-ignore - HTMLButtonElement/HTMLInputElement/HTMLSelectElement/HTMLTextAreaElement share "disabled"
  if ((e as any).disabled) return false;

  // Inert or contenteditable=false (explicit)
  if ((e as any).inert) return false;

  // Hidden via attribute or CSS
  const style = window.getComputedStyle(e);
  if (style.visibility === "hidden" || style.display === "none") return false;
  if ((e as any).hidden) return false;
  // Not visible in layout (0-sized & overflow hidden). Heuristic; still allow if it's a radio/checkbox etc.
  const rect = e.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0 && !isNativelyInteractive(e)) return false;

  // Not in the DOM, or in a disabled ancestor or inert subtree
  for (let n: Element | null = e; n; n = n.parentElement) {
    // @ts-ignore
    if (n.inert) return false;
    const st = window.getComputedStyle(n as HTMLElement);
    if (st.display === "none" || st.visibility === "hidden") return false;
  }

  // Explicitly negative tabindex removes from tab sequence
  const ti = getTabIndex(e);
  if (ti !== null && ti < 0) return false;

  // Native rules: links with href, buttons, inputs, selects, textareas, summary, details[open] summary, [tabindex>=0]
  if (ti !== null && ti >= 0) return true;
  if (isNativelyInteractive(e)) return true;

  // anchors without href are not tabbable by default
  if (e.tagName.toLowerCase() === "a") {
    const href = (e as HTMLAnchorElement).getAttribute("href");
    return !!href;
  }

  return false;
}

function isNativelyInteractive(e: HTMLElement): boolean {
  const t = e.tagName.toLowerCase();
  if (t === "button" || t === "input" || t === "select" || t === "textarea") return true;
  if (t === "summary") return true;
  if (t === "iframe") return true;
  if (t === "area" && (e as HTMLAreaElement).href) return true;
  if (t === "a" && (e as HTMLAnchorElement).href) return true;
  if (e.isContentEditable === true) return true;
  return false;
}

function getTabIndex(e: HTMLElement): number | null {
  const attr = e.getAttribute("tabindex");
  if (attr === null) return null;
  const n = Number(attr);
  return Number.isFinite(n) ? n : null;
}

/** Depth-first DOM order enumeration with stable index. */
function enumerateDOM(root: Element): HTMLElement[] {
  const out: HTMLElement[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, null);
  let node = walker.currentNode as Element | null;
  if (node) out.push(node as HTMLElement);
  while ((node = walker.nextNode() as Element | null)) {
    out.push(node as HTMLElement);
  }
  return out;
}

/** Collect tabbables honoring HTML spec ordering: tabindex>0 first (ascending), then DOM order (tabindex=0 or missing). */
function collectTabbables(root: Element): { pos: HTMLElement[]; norm: HTMLElement[]; all: HTMLElement[] } {
  const dom = enumerateDOM(root);
  const pos: HTMLElement[] = [];
  const norm: HTMLElement[] = [];
  for (let i = 0; i < dom.length; i++) {
    const el = dom[i];
    if (!isTabbable(el)) continue;
    const ti = getTabIndex(el);
    if (ti !== null && ti > 0) {
      pos.push(el);
    } else {
      norm.push(el);
    }
  }
  // Sort positive tabindex ascending; tie-break by DOM order (stable sort)
  pos.sort((a, b) => (getTabIndex(a)! - getTabIndex(b)!));
  const all = pos.concat(norm);
  return { pos, norm, all };
}

/** Move programmatic focus to element, returning previous active element for reference. */
function focusEl(el: HTMLElement): Element | null {
  const prev = document.activeElement;
  try { el.focus(); } catch {}
  return prev;
}

/** Simulate a Tab move *logically* by computing next tabbable; does not synthesize keyboard events. */
function nextTabTarget(root: Element, from?: HTMLElement, shift = false): HTMLElement | null {
  const { all } = collectTabbables(root);
  if (!all.length) return null;
  if (!from) return shift ? all[all.length - 1] : all[0];

  const idx = all.indexOf(from);
  if (idx === -1) return shift ? all[all.length - 1] : all[0];
  const nxt = shift ? (idx - 1 + all.length) % all.length : (idx + 1) % all.length;
  return all[nxt] ?? null;
}

/** Compute the expected tab sequence labels for a container (wraps by default). */
export function computeFocusOrder(root: Element, wrap = true): string[] {
  const { all } = collectTabbables(root);
  const labels = all.map((el, i) => focusLabel(el, i));
  if (!wrap) return labels;
  // With wrap, sequence is circular; we still return the linear list for comparison.
  return labels;
}

/** Assert that the actual (computed) focus order matches an expected list of CSS selectors, ids, or [data-focus-id] values. */
export function assertFocusOrder(root: Element, expected: (string | HTMLElement)[]): {
  pass: boolean;
  expected: string[];
  actual: string[];
  message: string;
} {
  const expEls = expected.map((x) => {
    if (typeof x !== "string") return x;
    if (x.startsWith("#")) return document.getElementById(x.slice(1)) as HTMLElement | null;
    // data-focus-id= value
    const byData = document.querySelector(`[data-focus-id="${cssEscape(x)}"]`) as HTMLElement | null;
    if (byData) return byData;
    const q = document.querySelector(x) as HTMLElement | null;
    return q;
  });

  const missing: string[] = [];
  const expLabels = expEls.map((el, i) => {
    if (!el) {
      const raw = String(expected[i]);
      missing.push(raw);
      return `!missing(${raw})`;
    }
    return focusLabel(el);
  });

  const actual = computeFocusOrder(root);
  // Compare arrays strictly by string match
  const pass = arraysEqual(expLabels, actual);

  const msg = pass
    ? "✅ Focus order matches."
    : [
        "❌ Focus order mismatch.",
        missing.length ? `Missing selectors: ${missing.join(", ")}` : "",
        `Expected: [${expLabels.join(" → ")}]`,
        `Actual:   [${actual.join(" → ")}]`,
      ].filter(Boolean).join("\n");

  return { pass, expected: expLabels, actual, message: msg };
}

/** Verify a focus trap: Tab/Shift+Tab from ends should wrap within container. */
export function assertFocusTrap(root: Element): {
  pass: boolean;
  message: string;
  first?: string;
  last?: string;
} {
  const { all } = collectTabbables(root);
  if (all.length === 0) {
    return { pass: false, message: "❌ No tabbable elements in container." };
  }
  const first = all[0];
  const last = all[all.length - 1];

  // From last, Tab should go to first (wrap)
  const afterLast = nextTabTarget(root, last, /*shift*/ false);
  // From first, Shift+Tab should go to last (wrap)
  const beforeFirst = nextTabTarget(root, first, /*shift*/ true);

  const ok1 = afterLast === first;
  const ok2 = beforeFirst === last;

  const pass = !!(ok1 && ok2);
  const msg = pass
    ? "✅ Focus trap validated (wraps at both ends)."
    : [
        "❌ Focus trap failed.",
        ok1 ? "" : `Tab from last did not wrap to first (got ${afterLast ? focusLabel(afterLast) : "null"}).`,
        ok2 ? "" : `Shift+Tab from first did not wrap to last (got ${beforeFirst ? focusLabel(beforeFirst) : "null"}).`,
      ].filter(Boolean).join("\n");

  return { pass, message: msg, first: focusLabel(first), last: focusLabel(last) };
}

/** Run a suite of focus order tests and print to console. */
export type FocusOrderTest = {
  name: string;
  root: Element | string;                // container element or selector
  expectedOrder?: (string | HTMLElement)[]; // optional; if omitted we just print computed order
  assertTrap?: boolean;                  // also assert focus trap behavior
};

export function runFocusOrderSuite(tests: FocusOrderTest[]): { name: string; pass: boolean; message: string }[] {
  const results: { name: string; pass: boolean; message: string }[] = [];
  for (let i = 0; i < tests.length; i++) {
    const t = tests[i];
    const root = typeof t.root === "string" ? document.querySelector(t.root)! : t.root;
    if (!root) {
      const msg = `❌ [${t.name}] root not found: ${typeof t.root === "string" ? t.root : "(element)"}`
      console.error(msg);
      results.push({ name: t.name, pass: false, message: msg });
      continue;
    }

    let pass = true;
    const msgs: string[] = [];

    if (t.expectedOrder && t.expectedOrder.length) {
      const r = assertFocusOrder(root, t.expectedOrder);
      pass &&= r.pass;
      msgs.push(r.message);
      if (!r.pass) {
        console.groupCollapsed(`%cFocus order FAILED: ${t.name}`, "color:#b91c1c");
        console.log("Expected:", r.expected);
        console.log("Actual  :", r.actual);
        console.groupEnd();
      } else {
        console.log(`%cFocus order OK: ${t.name}`, "color:#059669");
      }
    } else {
      const order = computeFocusOrder(root);
      msgs.push(`ℹ️ Computed focus order: [${order.join(" → ")}]`);
      console.log(`%c[${t.name}]`, "color:#2563eb", order);
    }

    if (t.assertTrap) {
      const trap = assertFocusTrap(root);
      pass &&= trap.pass;
      msgs.push(trap.message);
      if (!trap.pass) {
        console.warn(`Focus trap failed in "${t.name}"`, trap);
      }
    }

    const message = msgs.join("\n");
    results.push({ name: t.name, pass, message });
  }
  return results;
}

// ---------- Tiny utils ----------

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// Minimal CSS.escape polyfill for attribute values (covers common cases)
function cssEscape(value: string): string {
  // Escape quotes and brackets commonly used in selectors
  return value.replace(/["\\]/g, "\\$&").replace(/([\[\]=:])/g, "\\$1");
}

/*
Usage examples (run in browser console or test harness):

// Mark elements for readable labels:
<button id="save" data-focus-id="save-btn">Save</button>

// Test expected order by selectors or [data-focus-id] values:
runFocusOrderSuite([
  {
    name: "Dialog tab order",
    root: "#my-dialog",
    expectedOrder: ["close", "#name", "#email", "#submit"], // data-focus-id or CSS selector
    assertTrap: true,
  },
  {
    name: "Print computed order only",
    root: document.querySelector("#toolbar")!,
  },
]);
*/
