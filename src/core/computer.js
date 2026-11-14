// ── Computer Use Engine ──────────────────────────────────────────────────────
//
// Feature: "Real GUI computer-use — screenshot + mouse/keyboard control of any
// desktop app, not just a browser."
//
// browser.js automates a page inside an isolated Playwright context: every
// action target lives in a DOM the engine can query, form-state it can
// dry-run read without triggering, and (via rollout_sandbox.js) a forked
// session it can try against a disposable copy of live state. NONE of that
// exists here. This engine drives the actual OS mouse/keyboard/screen — there
// is no DOM to query, no dry-run read that doesn't require actually looking
// at a fresh screenshot, and no throwaway fork of "the user's real desktop"
// to test an action against. See HONEST LIMITS below before treating this as
// browser.js-with-pixels-instead-of-DOM — it is a strictly weaker safety
// position, not an equivalent one.
//
// Because of that gap, this engine does NOT attempt browser.js's
// irreversibility classifier (heuristically deciding some actions are safe to
// run unattended). EVERY action goes through the same pending-approval queue,
// unconditionally — the same human-gated shape as browser_act's irreversible
// path (see browser.js's act()), but applied to 100% of actions here rather
// than a keyword-classified subset.
//
// ── How targeting works ──────────────────────────────────────────────────
// 1. screen.grab() takes a real screenshot of the current display.
// 2. The screenshot is handed to the vision model with the instruction in
//    English ("click the Save button", "type into the search field") and the
//    model returns a pixel coordinate {x, y} plus its reasoning.
// 3. That single vision read is the ONLY grounding — there is no second,
//    independent read to cross-check against (contrast browser.js's
//    dual-ground DOM+vision cross-check). A misread coordinate is a
//    real click in a real place; nothing here re-verifies it beforehand.
// 4. A prediction is queued as a pending action. The human reviews the
//    screenshot, the target coordinate, and the model's stated reasoning,
//    then calls apply_computer_action(approval_id, human_approved=true) to
//    actually move the mouse/press the key, or dismiss_computer_action to
//    discard it.
// 5. After executing, a fresh screenshot is taken and returned so the human
//    (and the calling agent) can see what actually happened — not what was
//    predicted to happen.
//
// ── HONEST LIMITS ──────────────────────────────────────────────────────────
//   - No sandbox. This runs against the real, live desktop session — the
//     account, windows, and files that are actually open. There is no
//     disposable fork the way project_action/deploy_preview get one from
//     rollout_sandbox.js. Every executed action is a real side effect on the
//     first try, not a rehearsal.
//   - Single-pass vision grounding only. One screenshot, one model read, one
//     coordinate guess. No DOM-equivalent ground truth exists for a native
//     desktop app to cross-check against, so — unlike browser.js — there is
//     no automated disagreement detector here. The human review step is the
//     only check.
//   - No irreversibility classifier. Nothing here tries to guess "this click
//     is probably safe" — every single action queues for approval, always.
//     If that ever feels like friction, the fix is a better UI for reviewing
//     the queue, not weakening the gate.
//   - Coordinates only, no semantic target. browser.js can re-locate a
//     stale element by (role, accessible name) because the DOM carries that
//     structure. A screenshot doesn't — if a window moves or resizes between
//     the screenshot and execution, the coordinate can miss. Each apply call
//     re-grabs immediately before acting to shrink that window, but it is
//     not eliminated.
//   - No selector drift ledger. site_ledger.js's persistent healing history
//     has no equivalent here; nothing is learned across runs about which
//     targets tend to be misread.
//   - Requires a real display. On a headless Linux host with no X server /
//     Wayland compositor running, screen.grab() and mouse/keyboard control
//     will throw at runtime — this is a desktop-automation engine, not a
//     server-side one. It will not work inside e.g. a bare Docker container
//     the way sandbox.js's build/verify steps do.
//   - Typed text is echoed back into the pending-action record and the
//     approval prompt in full so the human can see exactly what will be
//     typed before approving — including into password fields. Don't queue
//     credentials this way if that visibility is a problem; type them by
//     hand instead.

function uid(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Expand a tightly-packed N-channel (e.g. RGB, 3 channels) buffer to RGBA for jimp. */
function addOpaqueAlpha(data, width, height, channels) {
  if (channels !== 3) {
    throw new Error(`Unexpected screenshot pixel format: ${channels} channels (expected 3 or 4 after toRGB()).`);
  }
  const out = Buffer.alloc(width * height * 4);
  for (let px = 0; px < width * height; px++) {
    out[px * 4] = data[px * 3];
    out[px * 4 + 1] = data[px * 3 + 1];
    out[px * 4 + 2] = data[px * 3 + 2];
    out[px * 4 + 3] = 255;
  }
  return out;
}

export class ComputerUseEngine {
  /**
   * @param {{genAI: any, geminiModel: string, secondOpinion?: any}} deps
   *   Same shape as BrowserSessionManager's constructor deps (see browser.js) —
   *   genAI/geminiModel do the vision read, secondOpinion is optional and, if
   *   present, gets an independent read on the prediction before the human
   *   sees it (mirrors browser.js's irreversible-action second-opinion call).
   */
  constructor({ genAI, geminiModel, secondOpinion } = {}) {
    this.genAI = genAI;
    this.geminiModel = geminiModel;
    this.secondOpinion = secondOpinion;
    this.pendingActions = new Map();
    this._nut = null; // lazy-loaded — see _loadNut()
  }

  /** Lazy-load nut-js so a missing/unsupported-platform install doesn't crash startup. */
  async _loadNut() {
    if (this._nut) return this._nut;
    try {
      const nut = await import('@nut-tree-fork/nut-js');
      this._nut = nut;
      return nut;
    } catch (err) {
      throw new Error(
        `Computer-use engine unavailable: @nut-tree-fork/nut-js failed to load (${err.message}). ` +
        `This requires a real display (X11/Wayland/macOS/Windows desktop session) — it will not run ` +
        `headless. Run "npm install" and confirm a display is attached.`
      );
    }
  }

  async _screenshotBase64() {
    const { screen } = await this._loadNut();
    const img = await screen.grab(); // nut-js Image: raw pixel Buffer, color mode is platform/provider-dependent.
    // Verified against @nut-tree-fork/shared's Image class source: it exposes
    // toRGB() (async, returns a new Image, normalizes BGR(A)->RGB(A)) but no
    // built-in JPEG/PNG encoder. jimp is already a transitive dependency of
    // nut-js itself (pulled in by its screen provider), so it's used here
    // directly rather than adding a new dependency for this one conversion.
    // toRGB() is always called (not conditionally skipped) since which
    // platform provider is active — and therefore whether raw data already
    // happens to be RGB — isn't something this code can detect generically;
    // toRGB() is nut-js's own documented normalization path for exactly this.
    const rgb = await img.toRGB();
    const rgba = rgb.channels === 4 ? rgb.data : addOpaqueAlpha(rgb.data, rgb.width, rgb.height, rgb.channels);
    const { Jimp } = await import('jimp');
    const jimpImg = Jimp.fromBitmap({ data: rgba, width: rgb.width, height: rgb.height });
    const jpegBuf = await jimpImg.getBuffer('image/jpeg', { quality: 80 });
    return jpegBuf.toString('base64');
  }

  /** Ask the vision model to locate a click/type target on the current screen. */
  async _locate(instruction) {
    const screenshotB64 = await this._screenshotBase64();
    const model = this.genAI.getGenerativeModel({
      model: this.geminiModel,
      generationConfig: { temperature: 0.1, maxOutputTokens: 512 },
    });
    const prompt =
      `This is a screenshot of the user's actual desktop, right now. Find the target for this ` +
      `instruction: "${instruction}".\n` +
      `Respond ONLY with strict JSON, no prose, no markdown fence: ` +
      `{"x": <int pixel x>, "y": <int pixel y>, "reasoning": "<one sentence: what you see there and why>", ` +
      `"confident": <true|false>}. ` +
      `If nothing on screen plausibly matches the instruction, set "confident": false and explain why in reasoning.`;
    const result = await model.generateContent({
      contents: [{ role: 'user', parts: [
        { text: prompt },
        { inlineData: { data: screenshotB64, mimeType: 'image/jpeg' } },
      ] }],
    });
    const raw = result.response.text().trim().replace(/^```(json)?/i, '').replace(/```$/, '').trim();
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`Vision model did not return valid JSON for target location: ${raw.slice(0, 300)}`);
    }
    return { ...parsed, screenshotB64 };
  }

  /**
   * Propose an action. ALWAYS returns a pending approval — see file header,
   * there is no irreversibility classifier here, unlike browser.js's act().
   * @param {{kind: 'click'|'type'|'key', instruction?: string, text?: string, key?: string}} action
   *   click: instruction describes what to click, e.g. "the blue Save button".
   *   type:  instruction locates the field to type into; text is what to type.
   *   key:   no vision lookup needed; key is a nut-js key name, e.g. "Enter".
   */
  async propose(action) {
    if (!['click', 'type', 'key'].includes(action.kind)) {
      throw new Error(`Unknown action kind "${action.kind}" — expected click, type, or key.`);
    }

    let locate = null;
    if (action.kind === 'click' || action.kind === 'type') {
      if (!action.instruction) throw new Error(`"${action.kind}" requires an instruction describing the target.`);
      locate = await this._locate(action.instruction);
      if (locate.confident === false) {
        return {
          ok: false, pending: false,
          summary: `Vision model was not confident it found a target for "${action.instruction}": ${locate.reasoning}. Not queued.`,
        };
      }
    }

    let secondOpinion = null;
    if (this.secondOpinion) {
      secondOpinion = await this.secondOpinion.getSecondOpinion({
        subject: `real OS-level ${action.kind} action: ${action.instruction || action.key || ''}`,
        detail:
          (locate ? `Vision-located target: (${locate.x}, ${locate.y}) — reasoning: ${locate.reasoning}\n` : '') +
          (action.kind === 'type' ? `Text to type: ${JSON.stringify(action.text)}\n` : '') +
          `This executes directly against the real desktop — there is no sandbox or dry-run for this action kind.`,
        question:
          'Does this look like a reasonable, intended target given the instruction? Flag anything that looks ' +
          'like it could hit the wrong element, an unrelated window, or something destructive.',
      });
    }

    const approvalId = uid('cact');
    this.pendingActions.set(approvalId, {
      action, locate, secondOpinion, createdAt: new Date().toISOString(),
    });

    const targetDesc = locate
      ? `(${locate.x}, ${locate.y}) — "${locate.reasoning}"`
      : action.kind === 'key' ? `key press: ${action.key}` : '(n/a)';

    return {
      ok: false, pending: true, approvalId, kind: action.kind, target: targetDesc,
      screenshotAvailable: !!locate,
      secondOpinion,
      summary:
        `Computer-use action queued, NOT executed (every action requires approval — no exceptions). ` +
        `Kind: ${action.kind}. Target: ${targetDesc}` +
        (action.kind === 'type' ? `. Text: ${JSON.stringify(action.text)}` : '') +
        `. Review this against the screenshot, then call apply_computer_action("${approvalId}", ` +
        `human_approved=true) to execute for real, or dismiss_computer_action("${approvalId}") to discard.` +
        (secondOpinion ? `\n\n${this.secondOpinion.format(secondOpinion)}` : ''),
    };
  }

  async applyPendingAction(approvalId, humanApproved) {
    const pending = this.pendingActions.get(approvalId);
    if (!pending) return `No pending computer-use action "${approvalId}" (already applied, dismissed, or invalid id).`;
    if (!humanApproved) return `human_approved must be true to execute "${approvalId}". Use dismiss_computer_action to discard it instead.`;

    this.pendingActions.delete(approvalId);
    const { mouse, keyboard, Point, Key } = await this._loadNut();
    const { action, locate } = pending;

    try {
      if (action.kind === 'click') {
        // Re-grab is implicit: nothing here re-verifies the coordinate is
        // still valid before moving — see HONEST LIMITS (coordinates only,
        // no semantic re-locate). Kept intentionally simple/fast rather than
        // adding a second vision call that itself would need trusting.
        await mouse.setPosition(new Point(locate.x, locate.y));
        await mouse.leftClick();
      } else if (action.kind === 'type') {
        await mouse.setPosition(new Point(locate.x, locate.y));
        await mouse.leftClick();
        await keyboard.type(action.text);
      } else if (action.kind === 'key') {
        const keyConst = Key[action.key];
        if (!keyConst) throw new Error(`Unknown nut-js key name "${action.key}".`);
        await keyboard.pressKey(keyConst);
        await keyboard.releaseKey(keyConst);
      }
    } catch (err) {
      return `Error executing computer-use action "${approvalId}": ${err.message}`;
    }

    let afterB64 = null;
    try { afterB64 = await this._screenshotBase64(); } catch { /* best-effort */ }

    return {
      ok: true, executed: true, approvalId, kind: action.kind,
      screenshotAfterB64: afterB64,
      summary: `Executed ${action.kind} action "${approvalId}" for real. ${afterB64 ? 'Post-action screenshot captured.' : '(Post-action screenshot failed — action still ran.)'}`,
    };
  }

  dismissPendingAction(approvalId) {
    const had = this.pendingActions.delete(approvalId);
    return had ? `Dismissed pending computer-use action "${approvalId}" without executing it.`
                : `No pending computer-use action "${approvalId}" to dismiss.`;
  }

  listPending() {
    if (this.pendingActions.size === 0) return 'No pending computer-use actions.';
    return [...this.pendingActions.entries()].map(([id, p]) =>
      `[${id}] ${p.action.kind}` +
      (p.locate ? ` @ (${p.locate.x}, ${p.locate.y}) — ${p.locate.reasoning}` : ` — key: ${p.action.key}`) +
      (p.action.kind === 'type' ? ` — text: ${JSON.stringify(p.action.text)}` : '') +
      ` (queued ${p.createdAt})`
    ).join('\n');
  }

  getContext() {
    if (this.pendingActions.size === 0) return 'No pending computer-use actions.';
    return `${this.pendingActions.size} pending computer-use action(s) awaiting human_approved=true:\n${this.listPending()}`;
  }
}

