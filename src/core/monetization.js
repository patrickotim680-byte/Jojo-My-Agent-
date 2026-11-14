// ── Monetization Scaffolder ──────────────────────────────────────────────────
//
// Feature: generates real, working Stripe billing starter code into a
// project — checkout session creation, webhook handling with signature
// verification, a pricing config, and a setup script.
//
// HARD RULE, not a preference: this module WRITES FILES ONLY. It never
// calls Stripe's (or any payment provider's) API itself, never creates a
// live product/price/account, never reads or writes a real secret key
// value, and never activates real billing. Every generated file reads
// secrets from process.env — the human supplies real values through their
// own environment/provider dashboard, entirely outside this tool's reach.
// This is the same category of decision as browser.js refusing to
// auto-accept a payment confirmation: setting up real recurring billing
// against real customers is a live financial/business action, and that
// decision — and the resulting liability — stays with a human, not this
// agent, no matter how the request is framed.
//
// What it generates:
//   1. billing/stripe_client.js       — a thin Stripe SDK wrapper, key read from env
//   2. billing/create_checkout_session.js — Express-style handler for Checkout
//   3. billing/webhook_handler.js     — signature-VERIFIED webhook handler
//      (rejects anything that doesn't verify — this is the #1 real-world
//      Stripe integration mistake: trusting an unverified webhook payload)
//   4. billing/pricing_config.js      — a plain data file the human edits
//      with real price IDs after creating them in their own Stripe account
//   5. scripts/setup_stripe_products.js — a script the HUMAN runs themselves
//      (never auto-executed by this module) to create the products/prices
//      in their own Stripe account using their own keys
//   6. README_BILLING.md              — exactly what the human still has to
//      do by hand before any of this can take real payments
//
// HONEST LIMITS:
//   - This is Node/Express-shaped starter code (matches this project's own
//     stack) — adapt the handler signatures if your app uses a different
//     framework or a different language entirely.
//   - It does not handle tax calculation, invoicing beyond what Stripe
//     Billing itself provides, currency/region-specific compliance, or
//     dispute/chargeback handling — those are real business/legal concerns
//     genuinely outside a code generator's scope.
//   - It assumes Checkout (Stripe-hosted payment page) rather than a custom
//     Elements-based payment form, because Checkout is meaningfully lower
//     effort AND lower PCI-scope for a first integration — a custom form is
//     a bigger, separate task if that's genuinely what's needed.
//   - Generated code is a solid, correct starting point, not a substitute
//     for testing against Stripe's own test mode before anything goes live.

import fs from 'fs/promises';
import path from 'path';

const VALID_MODELS = new Set(['subscription', 'one_time']);

function defaultTiers(model) {
  return model === 'subscription'
    ? [{ name: 'starter', priceEnvVar: 'STRIPE_PRICE_STARTER', amountUsd: 9, interval: 'month' },
       { name: 'pro',     priceEnvVar: 'STRIPE_PRICE_PRO',     amountUsd: 29, interval: 'month' }]
    : [{ name: 'one-time', priceEnvVar: 'STRIPE_PRICE_ONE_TIME', amountUsd: 49 }];
}

async function writeFile(dir, relPath, content) {
  const full = path.join(dir, relPath);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, content, 'utf-8');
  return relPath;
}

export class MonetizationScaffolder {
  /**
   * @param {string} dir - target project directory to write into.
   * @param {'subscription'|'one_time'} [model]
   * @param {Array<{name:string, priceEnvVar:string, amountUsd:number, interval?:string}>} [tiers] - defaults to a sane starter set for the chosen model.
   */
  async scaffoldStripe({ dir, model = 'subscription', tiers }) {
    if (!dir) return { ok: false, error: 'dir is required.' };
    if (!VALID_MODELS.has(model)) return { ok: false, error: `model must be one of: ${[...VALID_MODELS].join(', ')}` };
    const tierList = (tiers && tiers.length) ? tiers : defaultTiers(model);

    const written = [];
    written.push(await writeFile(dir, 'billing/stripe_client.js', this._stripeClientCode()));
    written.push(await writeFile(dir, 'billing/create_checkout_session.js', this._checkoutSessionCode(model, tierList)));
    written.push(await writeFile(dir, 'billing/webhook_handler.js', this._webhookHandlerCode(model)));
    written.push(await writeFile(dir, 'billing/pricing_config.js', this._pricingConfigCode(model, tierList)));
    written.push(await writeFile(dir, 'scripts/setup_stripe_products.js', this._setupScriptCode(model, tierList)));
    written.push(await writeFile(dir, 'README_BILLING.md', this._readmeText(model, tierList, written)));

    return {
      ok: true, dir, model, tiers: tierList, filesWritten: written,
      nextSteps: [
        `Run "npm install stripe" in ${dir} — the generated code imports the Stripe SDK, which isn't installed yet.`,
        'Create a real Stripe account (or use an existing one) and switch to TEST mode keys first.',
        'Set STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET in your own environment — never in code, never given to this agent.',
        'Run scripts/setup_stripe_products.js YOURSELF (this agent does not run it for you) to create the products/prices in your Stripe account, then fill the resulting price IDs into billing/pricing_config.js.',
        'Register the webhook endpoint URL in the Stripe dashboard, pointed at billing/webhook_handler.js\'s route.',
        'Test the full flow with a Stripe test card before switching any key to a live (non-test) value.',
      ],
    };
  }

  _stripeClientCode() {
    return `// billing/stripe_client.js
// Thin wrapper — the ONLY place the Stripe secret key is read from.
// Never hardcode a real key here. Never commit a .env file with a real key.
import Stripe from 'stripe';

if (!process.env.STRIPE_SECRET_KEY) {
  console.warn('[billing] STRIPE_SECRET_KEY is not set — billing routes will fail until it is.');
}

export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '', {
  apiVersion: '2024-06-20',
});
`;
  }

  _checkoutSessionCode(model, tiers) {
    const tierLines = tiers.map(t =>
      `  '${t.name}': process.env.${t.priceEnvVar},`).join('\n');
    return `// billing/create_checkout_session.js
// Express-style handler: POST /billing/create-checkout-session
// Body: { tier: '${tiers[0].name}', successUrl, cancelUrl }
//
// Price IDs come from Stripe (created via scripts/setup_stripe_products.js,
// run by a human against their own account) — never hardcoded amounts here.
import { stripe } from './stripe_client.js';

const PRICE_IDS = {
${tierLines}
};

export async function createCheckoutSession(req, res) {
  try {
    const { tier, successUrl, cancelUrl } = req.body || {};
    const priceId = PRICE_IDS[tier];
    if (!priceId) {
      return res.status(400).json({ error: \`Unknown or unconfigured tier "\${tier}".\` });
    }
    if (!successUrl || !cancelUrl) {
      return res.status(400).json({ error: 'successUrl and cancelUrl are required.' });
    }

    const session = await stripe.checkout.sessions.create({
      mode: ${model === 'subscription' ? "'subscription'" : "'payment'"},
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: successUrl,
      cancel_url: cancelUrl,
      // customer_email / client_reference_id: set these if you need to tie
      // the session back to a user in your own system.
    });

    return res.json({ url: session.url });
  } catch (err) {
    console.error('[billing] checkout session creation failed:', err.message);
    return res.status(500).json({ error: 'Could not create checkout session.' });
  }
}
`;
  }

  _webhookHandlerCode(model) {
    return `// billing/webhook_handler.js
// Express-style handler: POST /billing/webhook
// IMPORTANT: this route needs the RAW request body (not JSON-parsed) for
// signature verification — e.g. app.post('/billing/webhook',
// express.raw({ type: 'application/json' }), stripeWebhookHandler).
//
// This handler REJECTS anything that doesn't verify against
// STRIPE_WEBHOOK_SECRET. Trusting an unverified webhook payload is the most
// common real-world Stripe integration mistake — don't relax this.
import { stripe } from './stripe_client.js';

export async function stripeWebhookHandler(req, res) {
  const signature = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, signature, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('[billing] webhook signature verification FAILED:', err.message);
    return res.status(400).send(\`Webhook signature verification failed.\`);
  }

  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object;
      // TODO: mark the corresponding user/order as paid in YOUR data store.
      // session.client_reference_id / session.customer_email identify who paid.
      console.log('[billing] checkout completed:', session.id);
      break;
    }
${model === 'subscription' ? `    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const subscription = event.data.object;
      // TODO: sync subscription status (active/canceled/past_due) to YOUR data store.
      console.log('[billing] subscription event:', event.type, subscription.id, subscription.status);
      break;
    }
` : ''}    default:
      // Unhandled event types are normal — Stripe sends many; only act on what you need.
      break;
  }

  return res.json({ received: true });
}
`;
  }

  _pricingConfigCode(model, tiers) {
    const entries = tiers.map(t =>
      `  {\n    name: '${t.name}',\n    priceEnvVar: '${t.priceEnvVar}', // set this env var to the REAL Stripe price id after running scripts/setup_stripe_products.js\n    amountUsd: ${t.amountUsd},${t.interval ? `\n    interval: '${t.interval}',` : ''}\n  }`
    ).join(',\n');
    return `// billing/pricing_config.js
// Human-edited. amountUsd here is DISPLAY-ONLY (for your pricing page) —
// the actual charged amount always comes from the Stripe Price object
// referenced by priceEnvVar, which is the source of truth.
export const PRICING_MODEL = '${model}';

export const TIERS = [
${entries}
];
`;
  }

  _setupScriptCode(model, tiers) {
    const createCalls = tiers.map(t => model === 'subscription'
      ? `  const ${t.name.replace(/[^a-zA-Z0-9]/g, '_')} = await stripe.prices.create({
    unit_amount: ${t.amountUsd * 100},
    currency: 'usd',
    recurring: { interval: '${t.interval || 'month'}' },
    product_data: { name: '${t.name}' },
  });
  console.log('${t.priceEnvVar}=' + ${t.name.replace(/[^a-zA-Z0-9]/g, '_')}.id);`
      : `  const ${t.name.replace(/[^a-zA-Z0-9]/g, '_')} = await stripe.prices.create({
    unit_amount: ${t.amountUsd * 100},
    currency: 'usd',
    product_data: { name: '${t.name}' },
  });
  console.log('${t.priceEnvVar}=' + ${t.name.replace(/[^a-zA-Z0-9]/g, '_')}.id);`
    ).join('\n\n');

    return `// scripts/setup_stripe_products.js
//
// RUN THIS YOURSELF: \`node scripts/setup_stripe_products.js\`
// This agent does not and will not execute this script for you — creating
// real products/prices against your Stripe account is a live business
// action and stays in your hands. Uses your own STRIPE_SECRET_KEY from the
// environment. Run against a TEST MODE key first.
import Stripe from 'stripe';

if (!process.env.STRIPE_SECRET_KEY) {
  console.error('Set STRIPE_SECRET_KEY in your environment first.');
  process.exit(1);
}
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

async function main() {
  console.log('Creating products/prices in your Stripe account (test mode if using a test key)...\\n');

${createCalls}

  console.log('\\nCopy the printed env var lines above into your real environment (and into');
  console.log('billing/pricing_config.js\\'s priceEnvVar values if you renamed anything), then');
  console.log('re-deploy. Nothing is charged to anyone until a real customer completes Checkout.');
}

main().catch((err) => { console.error(err); process.exit(1); });
`;
  }

  _readmeText(model, tiers, filesWritten) {
    return `# Billing setup (generated — read before going live)

This scaffolding was generated for a **${model}** pricing model with tiers: ${tiers.map(t => t.name).join(', ')}.

Files written:
${filesWritten.map(f => `- \`${f}\``).join('\n')}

## What this agent did NOT do, on purpose

- It did not create a Stripe account for you.
- It did not create any real product, price, or webhook in Stripe.
- It did not see, store, or transmit any real API key or secret.
- It did not enable real payment collection from anyone.

All of that stays a deliberate, human decision — see the HARD RULE comment at
the top of \`src/core/monetization.js\` (the module that generated this) for why.

## What YOU still need to do, in order

1. Run \`npm install stripe\` in this project — the generated code imports the Stripe SDK.
2. Create (or log into) your Stripe account. Stay in **test mode** to start.
3. Set \`STRIPE_SECRET_KEY\` and \`STRIPE_WEBHOOK_SECRET\` in your own
   environment — never paste real values into a chat with this agent, and
   never commit them to source control.
4. Run \`node scripts/setup_stripe_products.js\` **yourself** — this creates
   the products/prices in your Stripe account using your own key.
5. Copy the price IDs it prints into \`billing/pricing_config.js\`'s
   \`priceEnvVar\` env vars.
6. Wire \`billing/create_checkout_session.js\` and
   \`billing/webhook_handler.js\` into your actual route setup (the webhook
   route needs the RAW body — see the comment at the top of that file).
7. Register the webhook URL in the Stripe dashboard.
8. Test the entire flow with [Stripe's test cards](https://stripe.com/docs/testing)
   before switching any key from test to live.
9. Only after a real, successful test run: switch \`STRIPE_SECRET_KEY\` and
   \`STRIPE_WEBHOOK_SECRET\` to their live values, and re-run step 4 against
   live mode to create the real products.
`;
  }
}

