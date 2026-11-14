// ── Monetization Tools ────────────────────────────────────────────────────────
// Exposes MonetizationScaffolder (src/core/monetization.js). HARD RULE
// inherited from that module: this tool writes starter code files only. It
// never calls a live payment API, never touches a real secret value, and
// never activates real billing — see monetization.js's header comment.

export const MONETIZATION_TOOLS = [

  {
    name: 'scaffold_stripe_billing',
    declaration: {
      name: 'scaffold_stripe_billing',
      description:
        'Generate Stripe billing starter code (Checkout session creation, a signature-verified webhook ' +
        'handler, pricing config, and a setup script) into a project. Writes FILES ONLY — never calls ' +
        'Stripe\'s API, never sees/handles a real secret key, never creates a live product or activates real ' +
        'billing. The generated scripts/setup_stripe_products.js must be run BY THE HUMAN themselves against ' +
        'their own Stripe account — this tool never runs it for them. Always walk the human through the ' +
        'generated README_BILLING.md\'s steps rather than implying billing is "done" after this call.',
      parameters: {
        type: 'object',
        properties: {
          dir: { type: 'string', description: 'Target project directory to write billing code into.' },
          model: { type: 'string', enum: ['subscription', 'one_time'], description: 'Pricing model. Defaults to "subscription".' },
          tiers: {
            type: 'array',
            description: 'Optional override of the default tiers.',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                price_env_var: { type: 'string', description: 'Env var name (not value) the real Stripe price id will be read from.' },
                amount_usd: { type: 'number', description: 'Display-only amount for the pricing page.' },
                interval: { type: 'string', description: 'For subscriptions: "month" or "year".' },
              },
              required: ['name', 'price_env_var', 'amount_usd'],
            },
          },
        },
        required: ['dir'],
      },
    },
    async execute({ dir, model, tiers }, { monetization }) {
      if (!monetization) return 'Monetization scaffolder unavailable.';
      try {
        const mappedTiers = tiers?.map(t => ({
          name: t.name, priceEnvVar: t.price_env_var, amountUsd: t.amount_usd, interval: t.interval,
        }));
        const result = await monetization.scaffoldStripe({ dir, model, tiers: mappedTiers });
        if (!result.ok) return `Not scaffolded: ${result.error}`;
        return `Wrote ${result.filesWritten.length} file(s) to ${dir}:\n${result.filesWritten.map(f => `  ${f}`).join('\n')}\n\n` +
          `This is starter code only — nothing is live. Next steps for the human:\n${result.nextSteps.map((s, i) => `  ${i + 1}. ${s}`).join('\n')}`;
      } catch (err) {
        return `Error scaffolding billing: ${err.message}`;
      }
    },
  },

];

