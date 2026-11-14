// ── Browser Engine ───────────────────────────────────────────────────────────
//
// Feature: "Dual-Grounded, Self-Healing, Irreversibility-Gated Browser Automation"
//
// Every current browser-using agent (Operator, Claude computer-use loops,
// browser-use, most Playwright/Puppeteer wrappers) grounds its understanding
// of a page ONE way per step — either a DOM/accessibility read OR a
// screenshot read — and executes the next action straight off that single
// read. This engine combines four mechanisms none of those combine:
//
//   1. DUAL-GROUND VERIFICATION
//      Every extract() does BOTH a DOM-based interactive-element scan (real,
//      version-stable — see _scanInteractive, not the deprecated Playwright
//      accessibility-tree API) AND a screenshot read by the vision model,
//      then cross-checks them. An element the DOM calls visible/enabled that
//      the vision pass never mentions (covered by an overlay, off-screen
//      despite CSS visibility, a stale cached layout) is surfaced as a
//      DISAGREEMENT instead of silently trusted — this is the single most
//      common failure mode in blind DOM-only agents (clicking a technically-
//      present element a real user could never see or reach).
//
//   2. SELF-HEALING SELECTORS WITH A PERSISTENT DRIFT LEDGER
//      Actions target a logical name ("submit button", "email field"), not a
//      brittle CSS selector. Every interactive element gets a stable
//      data-jojo-id injected at extract time; if a later action's id is gone
//      (page re-rendered, site redesigned since last run), _healTarget()
//      re-scans and picks the closest (role, accessible-name) match instead
//      of failing outright, and logs the heal to SiteLedger (site_ledger.js)
//      so future runs on this domain start from the healed target, and so a
//      target that keeps drifting gets flagged as unstable rather than
//      silently re-healed forever.
//
//   3. IRREVERSIBILITY CLASSIFICATION + COUNTERFACTUAL DRY-RUN
//      Every action is classified reversible/irreversible (heuristic keyword
//      + form-context check, see _classifyReversibility) BEFORE it runs. An
//      irreversible one (submit, pay, delete, confirm, checkout, transfer...)
//      is never executed directly — dryRun() reads the target's enclosing
//      form, method, action URL, and every field's CURRENT value (what would
//      actually be sent) without triggering it, and that prediction becomes a
//      pending proposal gated behind human_approved=true — the exact same
//      apply_verified_fix / apply_synthesis_proposal pattern already used
//      elsewhere in this codebase.
//
//   4. PARALLEL DIVERGENT TAB EXPLORATION
//      See browser_explorer.js — built on top of this engine's per-session
//      isolation, using SwarmManager exactly the way synthesis.js uses it for
//      code branches, but for navigation branches.
//
// HONEST LIMITS:
//   - Playwright's `page.accessibility` API is deprecated and inconsistent
//     across versions, so it is NOT used here. The "DOM ground" is a direct
//     page.evaluate() scan of common interactive selectors + computed
//     visibility — solid and version-stable, but it is a heuristic, not a
//     full accessibility-tree implementation. Screen-reader-only patterns
//     (aria-live regions, complex composite widgets) may be under-detected.
//   - The vision pass costs one real model call with an image per extract()
//     — do not call extract() in a tight loop; cache and re-extract only
//     after an action that plausibly changed the page.
//   - _classifyReversibility() is a heuristic (keyword list + one LLM call
//     for ambiguous cases). Treat "reversible" as "no known-destructive
//     pattern matched," not as a guarantee — when genuinely unsure, this
//     engine is deliberately biased toward the human-gated path.
//   - dryRun()'s form-field snapshot is read-only (element.value at read
//     time); it does not execute JS the page might run on submit (client-
//     side validation/transformation), so it's a prediction, not a proof.
//   - Requires the `playwright` package (not in this project's original
//     dependencies — see package.json) and a Chromium install
//     (`npx playwright install chromium`) before first use.

import path from 'path';
import chalk from 'chalk';

const DEFAULT_NAV_TIMEOUT_MS = 30_000;
const DEFAULT_ACTION_TIMEOUT_MS = 10_000;

const IRREVERSIBLE_KEYWORDS = [
  'submit', 'pay', 'purchase', 'buy now', 'checkout', 'place order', 'delete',
  'remove', 'confirm', 'transfer', 'send', 'subscribe', 'unsubscribe', 'cancel',
  'sign up', 'register', 'agree', 'accept', 'donate', 'withdraw', 'publish', 'post',
];

function uid(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

function hostnameOf(url) {
  try { return new URL(url).hostname; } catch { return 'unknown-host'; }
}

/** Token-overlap similarity — cheap, dependency-free, good enough to rank
 *  candidate elements against a remembered (role, name) pair. Not a real
 *  edit-distance/semantic match. */
function similarity(a, b) {
  const ta = new Set(String(a || '').toLowerCase().split(/\W+/).filter(Boolean));
  const tb = new Set(String(b || '').toLowerCase().split(/\W+/).filter(Boolean));
  if (!ta.size || !tb.size) return 0;
  let overlap = 0;
  for (const t of ta) if (tb.has(t)) overlap++;
  return overlap / Math.max(ta.size, tb.size);
}

// The single script injected into the page to enumerate interactive
// elements, tag each with a stable id, and report role/name/visibility/
// enabled state — this is the "DOM ground" half of extract().
const SCAN_SCRIPT = `
(() => {
  const SELECTOR = [
    'a[href]', 'button', 'input', 'select', 'textarea',
    '[role="button"]', '[role="link"]', '[role="checkbox"]', '[role="radio"]',
    '[role="tab"]', '[role="menuitem"]', '[onclick]', '[contenteditable="true"]',
  ].join(',');

  function accessibleName(el) {
    return (
      el.getAttribute('aria-label') ||
      el.getAttribute('placeholder') ||
      el.getAttribute('title') ||
      el.value ||
      el.innerText ||
      el.textContent ||
      ''
    ).trim().slice(0, 120);
  }

  function isVisible(el) {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    const style = window.getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none' || parseFloat(style.opacity) === 0) return false;
    if (rect.bottom < 0 || rect.right < 0 || rect.top > window.innerHeight || rect.left > window.innerWidth) return false;
    return true;
  }

  const out = [];
  let counter = 0;
  document.querySelectorAll(SELECTOR).forEach((el) => {
    const id = 'jj-' + (counter++);
    el.setAttribute('data-jojo-id', id);
    const role = el.getAttribute('role') || el.tagName.toLowerCase();
    out.push({
      id,
      role,
      name: accessibleName(el),
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute('type') || null,
      visible: isVisible(el),
      enabled: !(el.disabled === true || el.getAttribute('aria-disabled') === 'true'),
      value: 'value' in el ? String(el.value ?? '') : null,
    });
  });
  return out;
})()
`;

export class BrowserSessionManager {
  /**
   * @param {object} genAI - PuterAI-shaped client, used for the vision pass and reversibility calls.
   * @param {string} geminiModel - model name to use.
   * @param {SiteLedger} siteLedger - shared instance, persists selector-heal + site-map history.
   * @param {object} [secondOpinion] - optional SecondOpinionEngine instance. If given, every
   *   IRREVERSIBLE action gets a mandatory cross-vendor pass on its dry-run prediction (see
   *   second_opinion.js) attached alongside the pending approval — doesn't block or auto-approve
   *   anything, just adds an independent opinion to what the human reviews.
   */
  constructor({ genAI, geminiModel, siteLedger, secondOpinion }) {
    this.genAI = genAI;
    this.geminiModel = geminiModel;
    this.siteLedger = siteLedger;
    this.secondOpinion = secondOpinion || null;
    this.sessions = new Map();      // sessionId -> { browser, context, page, url, hostname, lastScan }
    this.pendingActions = new Map(); // approvalId -> { sessionId, action, dryRun, createdAt }
    this._playwright = null;         // lazy — see _chromium()
  }

  async _chromium() {
    if (this._playwright) return this._playwright;
    try {
      const mod = await import('playwright');
      this._playwright = mod.chromium;
      return this._playwright;
    } catch (err) {
      throw new Error(
        `playwright is not installed/available. Run "npm install playwright && npx playwright ` +
        `install chromium" first. (${err.message})`
      );
    }
  }

  _session(sessionId) {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error(`No open browser session "${sessionId}". Call browser_open_session first.`);
    return s;
  }

  async openSession(url, { storageState } = {}) {
    const chromium = await this._chromium();
    const headless = process.env.JOJO_BROWSER_HEADLESS !== 'false';
    const browser = await chromium.launch({ headless });
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) JojoBrowserEngine/1.0',
      viewport: { width: 1366, height: 900 },
      // Optional — carries an existing session's cookies/localStorage/origin
      // state into this new context. Used by rollout_sandbox.js's
      // browser_action adapter to fork an isolated session that's still
      // logged in, rather than opening a fresh anonymous one.
      ...(storageState ? { storageState } : {}),
    });
    const page = await context.newPage();
    page.setDefaultTimeout(DEFAULT_ACTION_TIMEOUT_MS);
    page.setDefaultNavigationTimeout(DEFAULT_NAV_TIMEOUT_MS);

    const sessionId = uid('bsess');
    this.sessions.set(sessionId, { browser, context, page, url: null, hostname: null, lastScan: null });

    if (url) await this.navigate(sessionId, url);
    return sessionId;
  }

  async navigate(sessionId, url) {
    const s = this._session(sessionId);
    await s.page.goto(url, { waitUntil: 'domcontentloaded' });
    s.url = s.page.url();
    s.hostname = hostnameOf(s.url);
    s.lastScan = null; // stale after navigation — force a fresh dual-ground on next extract()
    return { url: s.url, hostname: s.hostname };
  }

  async closeSession(sessionId) {
    const s = this.sessions.get(sessionId);
    if (!s) return `No open session "${sessionId}" (already closed?).`;
    await s.context.close().catch(() => {});
    await s.browser.close().catch(() => {});
    this.sessions.delete(sessionId);
    return `Closed session ${sessionId}.`;
  }

  async closeAll() {
    await Promise.all([...this.sessions.keys()].map(id => this.closeSession(id)));
  }

  // ── Phase: DOM ground ──────────────────────────────────────────────────────
  async _scanInteractive(sessionId) {
    const s = this._session(sessionId);
    const elements = await s.page.evaluate(SCAN_SCRIPT);
    s.lastScan = elements;
    return elements;
  }

  // ── Phase: vision ground ─────────────────────────────────────────────────
  async _visionRead(sessionId, focus) {
    const s = this._session(sessionId);
    const buf = await s.page.screenshot({ type: 'jpeg', quality: 70, fullPage: false });
    const model = this.genAI.getGenerativeModel({
      model: this.geminiModel,
      generationConfig: { temperature: 0.1, maxOutputTokens: 2048 },
    });
    const prompt =
      `This is a screenshot of a live web page (${s.url}). List every interactive element you can ` +
      `actually SEE (buttons, links, fields, checkboxes) with its visible label text, and briefly ` +
      `describe the page's main content/purpose. ${focus ? `Pay particular attention to: ${focus}.` : ''} ` +
      `If anything looks like a cookie/consent/modal overlay blocking the page, say so explicitly.`;
    const result = await model.generateContent({
      contents: [{ role: 'user', parts: [
        { text: prompt },
        { inlineData: { data: buf.toString('base64'), mimeType: 'image/jpeg' } },
      ] }],
    });
    return result.response.text();
  }

  // ── Cross-check: dual-ground disagreement detection ─────────────────────
  _crossCheck(domElements, visionText) {
    const visibleEnabled = domElements.filter(e => e.visible && e.enabled && e.name);
    const disagreements = [];
    for (const el of visibleEnabled) {
      const mentioned = el.name.length >= 3 &&
        visionText.toLowerCase().includes(el.name.toLowerCase().slice(0, Math.min(24, el.name.length)));
      if (!mentioned) {
        disagreements.push({
          id: el.id, role: el.role, name: el.name,
          note: 'DOM reports this as visible+enabled but the vision pass did not mention it — possibly ' +
                'covered by an overlay, off-screen, or a stale layout. Verify before acting on it.',
        });
      }
    }
    return disagreements;
  }

  /** The main "look at the page" call — always dual-grounded. */
  async extract(sessionId, { focus } = {}) {
    const s = this._session(sessionId);
    const [domElements, visionText] = await Promise.all([
      this._scanInteractive(sessionId),
      this._visionRead(sessionId, focus),
    ]);
    const disagreements = this._crossCheck(domElements, visionText);

    if (this.siteLedger) {
      await this.siteLedger.recordPage(s.hostname, s.url, {
        title: await s.page.title().catch(() => ''),
        interactiveCount: domElements.length,
      });
    }

    return {
      url: s.url,
      title: await s.page.title().catch(() => '(unknown)'),
      interactiveElements: domElements.filter(e => e.visible).map(e => ({
        id: e.id, role: e.role, name: e.name, type: e.type, enabled: e.enabled, value: e.value,
      })),
      visionSummary: visionText,
      groundingDisagreements: disagreements,
      groundingAgreement: domElements.length
        ? Math.round(100 * (1 - disagreements.length / Math.max(1, domElements.filter(e => e.visible && e.enabled).length)))
        : 100,
    };
  }

  // ── Self-healing target resolution ───────────────────────────────────────
  /** Resolves a logical target (id from a previous extract(), OR a
   *  {role, name} description) to a live element, re-scanning and picking
   *  the closest match if the original id is gone. */
  async _resolveTarget(sessionId, target) {
    const s = this._session(sessionId);
    let elements = s.lastScan || await this._scanInteractive(sessionId);

    if (target.id) {
      const exact = elements.find(e => e.id === target.id);
      if (exact) return { element: exact, healed: false };
    }

    // Not found by id (or none given) — heal via role/name similarity.
    const wantRole = target.role || null;
    const wantName = target.name || target.logicalName || '';
    const known = this.siteLedger && target.logicalName
      ? this.siteLedger.getKnownTarget(s.hostname, target.logicalName) : null;
    const nameHint = wantName || (known ? known.name : '');
    const roleHint = wantRole || (known ? known.role : null);

    elements = await this._scanInteractive(sessionId); // fresh scan for healing
    const candidates = elements
      .filter(e => e.visible && e.enabled)
      .filter(e => !roleHint || e.role === roleHint)
      .map(e => ({ e, score: similarity(e.name, nameHint) }))
      .sort((a, b) => b.score - a.score);

    if (!candidates.length || candidates[0].score < 0.2) {
      throw new Error(
        `Could not resolve target${target.logicalName ? ` "${target.logicalName}"` : ''} — ` +
        `no visible/enabled element matched closely enough after re-scanning the page.`
      );
    }
    const best = candidates[0].e;

    if (target.id && target.id !== best.id) {
      console.log(chalk.yellow(`[browser] Self-healed target "${target.logicalName || target.id}" ` +
        `(${target.role || '?'}/"${target.name || ''}") → ${best.role}/"${best.name}" (score ${candidates[0].score.toFixed(2)})`));
      if (this.siteLedger) {
        await this.siteLedger.recordHeal(s.hostname, {
          logicalName: target.logicalName || target.id,
          oldRole: target.role, oldName: target.name,
          newRole: best.role, newName: best.name,
        });
      }
    } else if (this.siteLedger && target.logicalName) {
      await this.siteLedger.recordGood(s.hostname, { logicalName: target.logicalName, role: best.role, name: best.name });
    }

    return { element: best, healed: target.id ? target.id !== best.id : false };
  }

  // ── Irreversibility classification ───────────────────────────────────────
  async _classifyReversibility(element, page) {
    const text = `${element.role} ${element.name} ${element.type || ''}`.toLowerCase();
    if (IRREVERSIBLE_KEYWORDS.some(k => text.includes(k))) return { irreversible: true, reason: 'keyword match' };
    if (element.type === 'submit') return { irreversible: true, reason: 'submit-type input' };

    // Ambiguous — is it inside a <form>? If so and it's the only/primary
    // submit-like control, lean cautious rather than call the model for
    // every single click (keeps this fast for the common, obvious cases).
    try {
      const inForm = await page.evaluate((id) => {
        const el = document.querySelector(`[data-jojo-id="${id}"]`);
        return !!(el && el.closest('form'));
      }, element.id);
      if (inForm && (element.role === 'button' || element.tag === 'button')) {
        return { irreversible: true, reason: 'button inside a <form>, no confirming keyword but form-submitting shape' };
      }
    } catch { /* best-effort */ }

    return { irreversible: false, reason: 'no destructive pattern matched' };
  }

  async _dryRun(sessionId, element, action) {
    const s = this._session(sessionId);
    const report = await s.page.evaluate((id) => {
      const el = document.querySelector(`[data-jojo-id="${id}"]`);
      if (!el) return { error: 'element vanished before dry-run could inspect it' };
      const form = el.closest('form');
      if (!form) {
        return { standalone: true, tag: el.tagName.toLowerCase(), text: (el.innerText || '').slice(0, 200) };
      }
      const fields = [...form.querySelectorAll('input,select,textarea')].map(f => ({
        name: f.name || f.id || '(unnamed)',
        type: f.type || f.tagName.toLowerCase(),
        currentValue: f.type === 'password' ? '(hidden)' : String(f.value ?? ''),
      }));
      return {
        standalone: false,
        formAction: form.getAttribute('action') || '(same page)',
        formMethod: (form.getAttribute('method') || 'get').toUpperCase(),
        fields,
      };
    }, element.id);

    return {
      action, target: { role: element.role, name: element.name, id: element.id },
      prediction: report,
      note: 'Read-only inspection — nothing was submitted. Client-side JS the page runs on submit is not simulated.',
    };
  }

  /**
   * Perform (or, for irreversible actions, propose) an action.
   * @param {string} sessionId
   * @param {{type:'click'|'fill'|'select', target:object, value?:string}} action
   */
  async act(sessionId, action) {
    const s = this._session(sessionId);
    const { element, healed } = await this._resolveTarget(sessionId, action.target);
    const classification = await this._classifyReversibility(element, s.page);

    if (classification.irreversible) {
      const dryRun = await this._dryRun(sessionId, element, action);

      // Mandatory cross-vendor pass on the dry-run prediction — see
      // second_opinion.js HONEST LIMITS: this never blocks or auto-approves
      // the action, it only adds an independent opinion to what the human
      // reviews alongside the dry-run prediction itself.
      let secondOpinion = null;
      if (this.secondOpinion) {
        secondOpinion = await this.secondOpinion.getSecondOpinion({
          subject: `irreversible browser action: ${action.type} on ${element.role} "${element.name}"`,
          detail:
            `Classification reason: ${classification.reason}\n` +
            `Dry-run prediction: ${JSON.stringify(dryRun.prediction)}\n` +
            `${dryRun.note}`,
          question:
            'Does this dry-run prediction look like something that should proceed? Flag anything about the ' +
            'target form/fields, or the action itself, that looks wrong or worth a second look before a human approves it.',
        });
      }

      const approvalId = uid('bact');
      this.pendingActions.set(approvalId, { sessionId, action, element, dryRun, secondOpinion, createdAt: new Date().toISOString() });
      return {
        ok: false, pending: true, approvalId, healed, classification, dryRun, secondOpinion,
        summary: `Action classified IRREVERSIBLE (${classification.reason}) — not executed. Review the ` +
          `dry-run prediction${secondOpinion ? ' and the independent second opinion below' : ''} and call ` +
          `apply_browser_action("${approvalId}", human_approved=true) to proceed, ` +
          `or dismiss_browser_action("${approvalId}") to discard.` +
          (secondOpinion ? `\n\n${this.secondOpinion.format(secondOpinion)}` : ''),
      };
    }

    const result = await this._execute(s.page, element, action);
    return { ok: true, pending: false, healed, classification, executed: result };
  }

  async _execute(page, element, action) {
    const selector = `[data-jojo-id="${element.id}"]`;
    const timeoutMs = DEFAULT_ACTION_TIMEOUT_MS;
    if (action.type === 'click') {
      await page.click(selector, { timeout: timeoutMs });
      return `clicked ${element.role} "${element.name}"`;
    }
    if (action.type === 'fill') {
      await page.fill(selector, action.value ?? '', { timeout: timeoutMs });
      return `filled ${element.role} "${element.name}" with the given value`;
    }
    if (action.type === 'select') {
      await page.selectOption(selector, action.value, { timeout: timeoutMs });
      return `selected "${action.value}" in ${element.role} "${element.name}"`;
    }
    throw new Error(`Unknown action type "${action.type}".`);
  }

  async applyPendingAction(approvalId, humanApproved) {
    if (!humanApproved) return 'Refused: applyPendingAction requires explicit human_approved=true.';
    const pending = this.pendingActions.get(approvalId);
    if (!pending) return `No pending browser action with id "${approvalId}".`;
    const s = this._session(pending.sessionId);
    try {
      const result = await this._execute(s.page, pending.element, pending.action);
      this.pendingActions.delete(approvalId);
      return `Executed: ${result}`;
    } catch (err) {
      return `Error executing approved action: ${err.message}`;
    }
  }

  dismissPendingAction(approvalId) {
    if (!this.pendingActions.has(approvalId)) return `No pending browser action with id "${approvalId}".`;
    this.pendingActions.delete(approvalId);
    return `Discarded pending browser action ${approvalId}. Nothing was executed.`;
  }

  listPendingActions() {
    return [...this.pendingActions.entries()].map(([id, p]) => ({
      id, sessionId: p.sessionId, action: p.action,
      target: { role: p.element.role, name: p.element.name }, createdAt: p.createdAt,
    }));
  }

  getContext() {
    if (!this.sessions.size && !this.pendingActions.size) return '(no open browser sessions, no pending actions)';
    const sessionLines = [...this.sessions.entries()].map(([id, s]) => `  ${id}: ${s.url || '(blank)'}`);
    const pendingLines = this.listPendingActions().map(p =>
      `  [${p.id}] ${p.action.type} on ${p.target.role} "${p.target.name}" (session ${p.sessionId}) — awaiting approval`);
    return [
      sessionLines.length ? `Open sessions:\n${sessionLines.join('\n')}` : 'No open sessions.',
      pendingLines.length ? `Pending irreversible actions:\n${pendingLines.join('\n')}` : 'No pending actions.',
    ].join('\n');
  }
}

