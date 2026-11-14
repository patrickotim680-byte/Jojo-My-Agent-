# Monetization Scaffolding (Code Generation Only)

`src/core/monetization.js` generates real, working Stripe billing starter code. It does not, and by
design never will, take a live financial or business action itself.

## The boundary — read this before the mechanics

This module **writes files only**. It never calls Stripe's (or any payment provider's) API, never
creates a live product/price/account, never reads or writes a real secret key value, and never
activates real billing. Every generated file reads secrets from `process.env` — the human supplies
real values through their own environment and provider dashboard, entirely outside this tool's
reach. `scripts/setup_stripe_products.js` is generated but **never run by the agent** — it's run by
the human, against their own account, when they choose to.

This is the same category of decision as `browser.js` refusing to auto-accept a payment
confirmation: setting up real recurring billing against real customers is a live financial/business
action. That decision, and the resulting liability, stays with a human — no matter how the request
is framed. `agent.js`'s system prompt makes this explicit to the agent itself, not just to this
module's code: if a human asks it to go further (call Stripe's API directly, activate live billing,
handle a real key), it's instructed to decline that specific step the same way it would decline an
unapproved production deployment.

## What it generates

- `billing/stripe_client.js` — thin SDK wrapper, key read from env, never hardcoded
- `billing/create_checkout_session.js` — Express-style Checkout session handler
- `billing/webhook_handler.js` — **signature-verified** webhook handler (rejects anything that
  doesn't verify — this is the most common real-world Stripe integration mistake)
- `billing/pricing_config.js` — human-edited config; the Stripe Price object is always the source of
  truth, not the display amount here
- `scripts/setup_stripe_products.js` — run by the human, creates real products/prices in their
  account using their own key
- `README_BILLING.md` — the exact remaining steps, in order, before anything can take a real payment

## Tool

- `scaffold_stripe_billing(dir, model?, tiers?)` — `model` is `subscription` (default) or `one_time`.

## Honest limits

- Node/Express-shaped starter code, matching this project's own stack — adapt if your app uses a
  different framework or language.
- Doesn't handle tax calculation, invoicing beyond what Stripe Billing itself provides,
  region-specific compliance, or chargeback handling — genuinely outside a code generator's scope.
- Assumes Stripe Checkout (hosted payment page) rather than a custom Elements-based form, since
  that's meaningfully lower effort and lower PCI-scope for a first integration.
- Solid starting code, not a substitute for testing against Stripe's own test mode before anything
  goes live.

