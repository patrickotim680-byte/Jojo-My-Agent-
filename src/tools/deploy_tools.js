// ── Deploy Tools ──────────────────────────────────────────────────────────────
// Exposes DeployEngine (src/core/deploy.js). Context carries { deploy } —
// shared instance — injected by the agent. prepare/apply/dismiss/list mirror
// the same human-gate pattern as heal_tools.js / synthesis_tools.js /
// browser_tools.js.

export const DEPLOY_TOOLS = [

  {
    name: 'prepare_deployment',
    declaration: {
      name: 'prepare_deployment',
      description:
        'Verify (build + test) a project and prepare a deployment plan for a provider (vercel, netlify, ' +
        'fly, or docker). Refuses immediately if the build/tests fail. A "preview" environment deploy ' +
        'executes right away (reversible — not real traffic). A "production" deploy (or ANY fly.io deploy — ' +
        'see honest limits in deploy.js) is NEVER executed directly — it returns a pending plan_id requiring ' +
        'apply_deployment with human_approved=true. Always show the human the env var names the code ' +
        'references and the verification result before they approve a production plan.',
      parameters: {
        type: 'object',
        properties: {
          dir: { type: 'string', description: 'Project directory to deploy.' },
          provider: { type: 'string', enum: ['vercel', 'netlify', 'fly', 'docker'], description: 'Deployment target.' },
          environment: { type: 'string', enum: ['preview', 'production'], description: 'Defaults to "preview".' },
          task: { type: 'string', description: 'What this deployment is for, for the record.' },
          stack: { type: 'string', description: 'Optional stack hint — otherwise auto-detected.' },
          image_tag: { type: 'string', description: 'Required for provider "docker" — e.g. "myregistry/myapp:1.2.3".' },
        },
        required: ['dir', 'provider'],
      },
    },
    async execute({ dir, provider, environment, task, stack, image_tag }, { deploy }) {
      if (!deploy) return 'Deploy engine unavailable.';
      try {
        const result = await deploy.prepareDeployment({
          dir, provider, environment, task, stack, options: image_tag ? { imageTag: image_tag } : {},
        });
        if (result.pending) return `${result.summary}\n\nPlan:\n${JSON.stringify(result.plan, null, 2)}`;
        if (!result.ok) return `Not deployed: ${result.error}${result.verification ? `\n${JSON.stringify(result.verification)}` : ''}`;
        return `Deployed (${provider}/${result.plan.environment}):\n${JSON.stringify(result.result, null, 2)}`;
      } catch (err) {
        return `Error preparing deployment: ${err.message}`;
      }
    },
  },

  {
    name: 'apply_deployment',
    declaration: {
      name: 'apply_deployment',
      description:
        'Execute a deployment plan that was classified production and is awaiting approval. HARD RULE, same ' +
        'as apply_verified_fix/apply_synthesis_proposal/apply_browser_action: always show the human the plan ' +
        '(command, env vars, verification result) first, and only call this with human_approved=true after ' +
        'they explicitly agree. Never call it speculatively.',
      parameters: {
        type: 'object',
        properties: {
          plan_id: { type: 'string', description: 'The pending plan id from prepare_deployment or list_pending_deployments.' },
          human_approved: { type: 'boolean', description: 'Must be true.' },
        },
        required: ['plan_id', 'human_approved'],
      },
    },
    async execute({ plan_id, human_approved }, { deploy }) {
      if (!deploy) return 'Deploy engine unavailable.';
      return deploy.applyDeployment(plan_id, !!human_approved);
    },
  },

  {
    name: 'dismiss_deployment',
    declaration: {
      name: 'dismiss_deployment',
      description: 'Discard a pending production deployment plan without executing it. Safe without approval.',
      parameters: {
        type: 'object',
        properties: { plan_id: { type: 'string', description: 'The pending plan id to discard.' } },
        required: ['plan_id'],
      },
    },
    async execute({ plan_id }, { deploy }) {
      if (!deploy) return 'Deploy engine unavailable.';
      return deploy.dismissDeployment(plan_id);
    },
  },

  {
    name: 'list_pending_deployments',
    declaration: {
      name: 'list_pending_deployments',
      description: 'List every production deployment plan currently awaiting human approval.',
      parameters: { type: 'object', properties: {} },
    },
    async execute(_args, { deploy }) {
      if (!deploy) return 'Deploy engine unavailable.';
      const all = deploy.listPending();
      if (!all.length) return 'No pending deployment plans.';
      return all.map(p => `[${p.id}] ${p.provider}/${p.environment} — ${p.dir}`).join('\n');
    },
  },

  {
    name: 'rollback_deployment',
    declaration: {
      name: 'rollback_deployment',
      description:
        'Roll back a previously executed deployment (from the ledger). Uses the provider\'s real rollback ' +
        'command where one exists (vercel, fly); for providers without one (netlify, docker) this tells you ' +
        'exactly what to manually redeploy instead of pretending to roll back.',
      parameters: {
        type: 'object',
        properties: { deployment_id: { type: 'string', description: 'The deployment record id (from a prior deploy result, or the ledger).' } },
        required: ['deployment_id'],
      },
    },
    async execute({ deployment_id }, { deploy }) {
      if (!deploy) return 'Deploy engine unavailable.';
      return deploy.rollback(deployment_id);
    },
  },

];

