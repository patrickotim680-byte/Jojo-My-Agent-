// ── n8n Tools ─────────────────────────────────────────────────────────────────
// Exposes N8nEngine (src/core/n8n.js). Context carries { n8n } — shared
// instance — injected by the agent. Same human-gate pattern as
// deploy_tools.js: destructive actions (delete a workflow, tear down the
// container WITH its volume) return a pending plan_id until the human
// approves it explicitly.

export const N8N_TOOLS = [

  {
    name: 'n8n_provision',
    declaration: {
      name: 'n8n_provision',
      description:
        'Spin up a self-hosted n8n instance locally via `docker compose` (nothing talks to a third-party ' +
        'cloud account). Reversible — tearing it down is n8n_teardown. n8n has no API to create the first ' +
        '("owner") account or mint an API key, so this returns the exact one-time browser steps a human ' +
        'needs to do (open the URL, create the owner account, Settings → API → create a key) — after that, ' +
        'call n8n_configure with the key and no browser step is needed again. Requires Docker installed and ' +
        'running; this tool never installs Docker itself.',
      parameters: {
        type: 'object',
        properties: {
          port: { type: 'number', description: 'Local port to expose n8n on. Defaults to 5678 (or $N8N_PORT).' },
        },
      },
    },
    async execute({ port }, { n8n }) {
      if (!n8n) return 'n8n engine unavailable.';
      const result = await n8n.provision({ port });
      if (!result.ok) return `Could not provision n8n: ${result.error}`;
      return `n8n is up at ${result.url}${result.healthy ? '' : ' (not yet responding — give it a moment)'}.\n\nNext steps:\n${result.nextSteps.join('\n')}`;
    },
  },

  {
    name: 'n8n_configure',
    declaration: {
      name: 'n8n_configure',
      description:
        'Point JOJO at an n8n instance (self-hosted here, self-hosted elsewhere, or n8n cloud) once a human ' +
        'has generated an API key in the n8n UI (Settings → API). Verifies the connection by listing ' +
        'workflows before accepting it. Required before any workflow create/list/verify/delete call.',
      parameters: {
        type: 'object',
        properties: {
          base_url: { type: 'string', description: 'e.g. "http://localhost:5678" or the instance URL.' },
          api_key: { type: 'string', description: 'API key from the n8n UI (Settings → API → Create an API key).' },
        },
        required: ['base_url', 'api_key'],
      },
    },
    async execute({ base_url, api_key }, { n8n }) {
      if (!n8n) return 'n8n engine unavailable.';
      const result = await n8n.configure({ baseUrl: base_url, apiKey: api_key });
      return result.ok ? result.message : `Could not connect: ${result.error}`;
    },
  },

  {
    name: 'n8n_create_workflow',
    declaration: {
      name: 'n8n_create_workflow',
      description:
        'Create a workflow from a JSON object you author: { name, nodes: [...], connections: {...}, settings? } ' +
        '— standard n8n workflow shape (same as a workflow export). Created INACTIVE. This only creates it; ' +
        'call n8n_verify_workflow afterward to actually activate it and, for webhook-triggered workflows, ' +
        'fire a real test request and confirm it ran successfully. Never describe a workflow as "working" ' +
        'off n8n_create_workflow alone — that only means n8n accepted the shape.',
      parameters: {
        type: 'object',
        properties: {
          workflow: {
            type: 'object',
            description: 'n8n workflow object: { name, nodes: [...], connections: {...}, settings?: {...} }.',
          },
        },
        required: ['workflow'],
      },
    },
    async execute({ workflow }, { n8n }) {
      if (!n8n) return 'n8n engine unavailable.';
      const result = await n8n.createWorkflow(workflow);
      if (!result.ok) return `Not created: ${result.error}`;
      return `Created workflow "${result.name}" [${result.id}] — inactive, unverified. Call n8n_verify_workflow(${result.id}) to activate and test it.`;
    },
  },

  {
    name: 'n8n_import_workflow',
    declaration: {
      name: 'n8n_import_workflow',
      description:
        'Import an already-fetched n8n workflow export (JSON string or object) — e.g. one pulled down with ' +
        'web_fetch from a shared link or gist. This tool does not fetch URLs itself. Validates the shape ' +
        'then creates it the same way n8n_create_workflow does (inactive, unverified).',
      parameters: {
        type: 'object',
        properties: {
          workflow_json: { type: 'string', description: 'The workflow export, as a raw JSON string.' },
        },
        required: ['workflow_json'],
      },
    },
    async execute({ workflow_json }, { n8n }) {
      if (!n8n) return 'n8n engine unavailable.';
      const result = await n8n.importWorkflowJson(workflow_json);
      if (!result.ok) return `Not imported: ${result.error}`;
      return `Imported workflow "${result.name}" [${result.id}] — inactive, unverified. Call n8n_verify_workflow(${result.id}) to activate and test it.`;
    },
  },

  {
    name: 'n8n_verify_workflow',
    declaration: {
      name: 'n8n_verify_workflow',
      description:
        'Activate a workflow and actually verify it. If it has a webhook trigger: fires a real HTTP request ' +
        'at it and polls n8n\'s execution log until that specific execution reports success or the poll ' +
        'window runs out — never reports "working" without having observed a real execution. For manual/' +
        'schedule-triggered workflows (no webhook to poke), it confirms activation only and says plainly ' +
        'that no execution test ran — trust "activated," not "tested end to end," in that case.',
      parameters: {
        type: 'object',
        properties: {
          workflow_id: { type: 'string', description: 'The workflow id from n8n_create_workflow / n8n_list_workflows.' },
          test_payload: { type: 'object', description: 'Optional body/query data to send with the test webhook request.' },
        },
        required: ['workflow_id'],
      },
    },
    async execute({ workflow_id, test_payload }, { n8n }) {
      if (!n8n) return 'n8n engine unavailable.';
      const result = await n8n.verifyWorkflow(workflow_id, { testPayload: test_payload || {} });
      if (result.error) return `${result.activated ? 'Activated, but not verified' : 'Not verified'}: ${result.error}`;
      return result.note || (result.ok ? 'Verified.' : 'Not verified.');
    },
  },

  {
    name: 'n8n_list_workflows',
    declaration: {
      name: 'n8n_list_workflows',
      description: 'List every workflow on the configured n8n instance, with id, name, and active state.',
      parameters: { type: 'object', properties: {} },
    },
    async execute(_args, { n8n }) {
      if (!n8n) return 'n8n engine unavailable.';
      const result = await n8n.listWorkflows();
      if (!result.ok) return `Could not list workflows: ${result.error}`;
      if (!result.workflows.length) return 'No workflows on this instance.';
      return result.workflows.map(w => `[${w.id}] ${w.name} — ${w.active ? 'active' : 'inactive'}`).join('\n');
    },
  },

  {
    name: 'n8n_delete_workflow',
    declaration: {
      name: 'n8n_delete_workflow',
      description:
        'Delete a workflow. Irreversible, so the first call without human_approved returns a pending plan_id ' +
        'and does nothing else. HARD RULE, same as apply_deployment: show the human which workflow (id, ' +
        'name) before calling this again with human_approved=true. Never call it speculatively.',
      parameters: {
        type: 'object',
        properties: {
          workflow_id: { type: 'string', description: 'The workflow id to delete, or the pending plan_id to confirm.' },
          human_approved: { type: 'boolean', description: 'Must be true to actually execute the deletion.' },
        },
        required: ['workflow_id'],
      },
    },
    async execute({ workflow_id, human_approved }, { n8n }) {
      if (!n8n) return 'n8n engine unavailable.';
      const result = await n8n.deleteWorkflow(workflow_id, !!human_approved);
      if (result.pending) return `${result.summary} (plan_id: ${result.planId})`;
      return result.ok ? `Deleted workflow ${workflow_id}.` : `Not deleted: ${result.error}`;
    },
  },

  {
    name: 'n8n_teardown',
    declaration: {
      name: 'n8n_teardown',
      description:
        'Stop the self-hosted n8n container (`docker compose down`). By default the data volume ' +
        '(workflows/credentials/execution history) is preserved. destroy_volume=true drops all of that — ' +
        'irreversible — and requires human_approved=true, returning a pending plan_id on the first call ' +
        'without it, same pattern as n8n_delete_workflow.',
      parameters: {
        type: 'object',
        properties: {
          destroy_volume: { type: 'boolean', description: 'If true, also delete the persistent data volume. Irreversible.' },
          human_approved: { type: 'boolean', description: 'Must be true when destroy_volume is true.' },
        },
      },
    },
    async execute({ destroy_volume, human_approved }, { n8n }) {
      if (!n8n) return 'n8n engine unavailable.';
      const result = await n8n.teardown({ destroyVolume: !!destroy_volume, humanApproved: !!human_approved });
      if (result.pending) return `${result.summary} (plan_id: ${result.planId})`;
      return result.ok ? 'n8n container stopped.' : `Teardown failed: ${result.error}`;
    },
  },

  {
    name: 'list_pending_n8n_actions',
    declaration: {
      name: 'list_pending_n8n_actions',
      description: 'List every pending destructive n8n action (workflow deletion, volume teardown) currently awaiting human approval.',
      parameters: { type: 'object', properties: {} },
    },
    async execute(_args, { n8n }) {
      if (!n8n) return 'n8n engine unavailable.';
      const all = n8n.listPending();
      if (!all.length) return 'No pending n8n actions.';
      return all.map(p => `[${p.id}] ${p.type}${p.workflowId ? ` (${p.workflowId})` : ''}`).join('\n');
    },
  },

  {
    name: 'dismiss_n8n_action',
    declaration: {
      name: 'dismiss_n8n_action',
      description: 'Discard a pending destructive n8n action without executing it. Safe without approval.',
      parameters: {
        type: 'object',
        properties: { plan_id: { type: 'string', description: 'The pending plan id to discard.' } },
        required: ['plan_id'],
      },
    },
    async execute({ plan_id }, { n8n }) {
      if (!n8n) return 'n8n engine unavailable.';
      const result = await n8n.dismissAction(plan_id);
      return result.ok ? result.message : result.error;
    },
  },

];

