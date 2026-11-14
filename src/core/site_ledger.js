// ── Site Ledger ──────────────────────────────────────────────────────────────
// Persistent, per-domain memory for the browser engine (src/core/browser.js).
// Two jobs, same file/pattern as skill_ledger.js's "log outcome, learn" idea:
//
//   1. SELECTOR HEALING HISTORY — every time performAction() can't find its
//      target and has to re-locate it by role/name similarity (see
//      BrowserSessionManager._healTarget in browser.js), that heal event is
//      logged here per domain. Next run on the same domain starts from the
//      last known-good (role, name) pair instead of a stale hardcoded one,
//      and a domain with a high heal-rate on a given logical target is
//      flagged so the agent knows that part of the site is unstable.
//
//   2. SITE MAP — a lightweight, growing record of what's been learned about
//      a domain's navigation (pages visited, interactive elements found on
//      each, irreversible-action patterns seen) so repeat visits get faster
//      and more reliable instead of rediscovering everything from scratch —
//      the same "don't be stateless across sessions" idea world_model.js
//      applies to file/URL drift, applied here to site structure.
//
// Nothing here is ever applied automatically to a live page — it's read as a
// hint (a starting guess for _healTarget's similarity search), never trusted
// blindly; the DOM at request time is always the final authority.

import fs from 'fs/promises';
import path from 'path';

const DIR  = './memory';
const FILE = path.join(DIR, 'site_ledger.json');
const MAX_HEAL_EVENTS_PER_DOMAIN = 100;
const MAX_PAGES_PER_DOMAIN       = 50;

function freshDomainRecord() {
  return {
    healEvents: [],          // [{ logicalName, oldRole, oldName, newRole, newName, at }]
    knownTargets: {},        // logicalName -> { role, name, lastGoodAt, healCount }
    pages: {},                // url -> { title, interactiveCount, lastVisitedAt }
  };
}

export class SiteLedger {
  constructor() {
    this.data = { domains: {} };
  }

  async init() {
    await fs.mkdir(DIR, { recursive: true });
    try {
      const raw = await fs.readFile(FILE, 'utf-8');
      this.data = { domains: {}, ...JSON.parse(raw) };
    } catch {
      await this._save();
    }
  }

  async _save() {
    await fs.writeFile(FILE, JSON.stringify(this.data, null, 2), 'utf-8');
  }

  _domain(hostname) {
    if (!this.data.domains[hostname]) this.data.domains[hostname] = freshDomainRecord();
    return this.data.domains[hostname];
  }

  /** Best-guess (role, name) to start a similarity search from, if this
   *  logical target has ever been seen (and possibly healed) on this domain. */
  getKnownTarget(hostname, logicalName) {
    return this._domain(hostname).knownTargets[logicalName] || null;
  }

  async recordHeal(hostname, { logicalName, oldRole, oldName, newRole, newName }) {
    const rec = this._domain(hostname);
    rec.healEvents.push({ logicalName, oldRole, oldName, newRole, newName, at: new Date().toISOString() });
    if (rec.healEvents.length > MAX_HEAL_EVENTS_PER_DOMAIN) rec.healEvents.shift();

    const known = rec.knownTargets[logicalName] || { healCount: 0 };
    rec.knownTargets[logicalName] = {
      role: newRole, name: newName, lastGoodAt: new Date().toISOString(),
      healCount: known.healCount + 1,
    };
    await this._save();
  }

  async recordGood(hostname, { logicalName, role, name }) {
    const rec = this._domain(hostname);
    const known = rec.knownTargets[logicalName] || { healCount: 0 };
    rec.knownTargets[logicalName] = { role, name, lastGoodAt: new Date().toISOString(), healCount: known.healCount };
    await this._save();
  }

  async recordPage(hostname, url, { title, interactiveCount }) {
    const rec = this._domain(hostname);
    rec.pages[url] = { title, interactiveCount, lastVisitedAt: new Date().toISOString() };
    const urls = Object.keys(rec.pages);
    if (urls.length > MAX_PAGES_PER_DOMAIN) delete rec.pages[urls[0]];
    await this._save();
  }

  /** Instability signal: logical targets on this domain that have healed
   *  more than once — worth the agent knowing before it relies on them. */
  getUnstableTargets(hostname) {
    const rec = this._domain(hostname);
    return Object.entries(rec.knownTargets)
      .filter(([, v]) => v.healCount > 1)
      .map(([logicalName, v]) => ({ logicalName, healCount: v.healCount }));
  }

  getContext(hostname) {
    if (!hostname) return '(no active browser session)';
    const rec = this.data.domains[hostname];
    if (!rec) return `${hostname}: no prior visits recorded.`;
    const unstable = this.getUnstableTargets(hostname);
    const pageCount = Object.keys(rec.pages).length;
    return `${hostname}: ${pageCount} page(s) previously mapped, ${rec.healEvents.length} selector-heal ` +
      `event(s) logged` + (unstable.length ? `, UNSTABLE targets: ${unstable.map(u => `${u.logicalName}(×${u.healCount})`).join(', ')}` : '.');
  }
}

