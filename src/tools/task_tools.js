// ── Task Tools ─────────────────────────────────────────────────────────────────
// Explicit, model-callable controls over the TaskManager (src/core/tasks.js).
// The router in tasks.js handles the common case automatically (it infers
// continue/switch/new/complete from the message). These tools exist for when
// the user is explicit ("pause this, let's do something else", "mark the
// first one done", "what am I tracking right now?") and for when the model
// itself recognizes a request doesn't fit the currently active task and wants
// to manage that itself instead of waiting on the router.
//
// Context carries { tasks } — the shared TaskManager instance — injected by the agent.

export const TASK_TOOLS = [

  {
    name: 'list_tasks',
    declaration: {
      name: 'list_tasks',
      description:
        'List every task currently tracked in this conversation/session, with status ' +
        '(active/paused/blocked/done) and how recently each was touched. ' +
        'Use when the user asks "what are we working on", "what\'s open", or similar.',
      parameters: { type: 'object', properties: {} },
    },
    async execute(_args, { tasks }) {
      if (!tasks) return 'Task system unavailable.';
      const all = Object.values(tasks.tasks);
      if (!all.length) return 'No tasks tracked yet.';
      const activeId = tasks.memory.data.active_task_id;
      return all
        .sort((a, b) => new Date(b.updated) - new Date(a.updated))
        .map(t => `${t.id === activeId ? '▶ ' : '  '}[${t.id}] "${t.title}" — ${t.status}${t.summary ? ` — ${t.summary}` : ''}`)
        .join('\n');
    },
  },

  {
    name: 'create_task',
    declaration: {
      name: 'create_task',
      description:
        'Explicitly open a new tracked task and make it active, pausing whatever was active before. ' +
        'Use when the user clearly starts a new, separate piece of work mid-conversation ' +
        '("separately, can you also...", "new thing entirely") and you want to track it cleanly ' +
        'instead of letting it blur into the current task.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short (under ~80 char) descriptive title for the new task' },
        },
        required: ['title'],
      },
    },
    async execute({ title }, { tasks }) {
      if (!tasks) return 'Task system unavailable.';
      const t = await tasks.createTask(title);
      return `Created and activated task [${t.id}] "${t.title}". Previous active task (if any) was paused.`;
    },
  },

  {
    name: 'switch_task',
    declaration: {
      name: 'switch_task',
      description:
        'Switch the active task to an existing tracked task by id (get ids from list_tasks). ' +
        'Use when the user wants to resume something paused earlier ("back to the first thing", ' +
        '"let\'s pick up the API task again").',
      parameters: {
        type: 'object',
        properties: {
          task_id: { type: 'string', description: 'The id of the task to switch to, e.g. "t_a1b2c3"' },
        },
        required: ['task_id'],
      },
    },
    async execute({ task_id }, { tasks }) {
      if (!tasks) return 'Task system unavailable.';
      const t = await tasks.switchTo(task_id);
      if (!t) return `No task found with id "${task_id}". Use list_tasks to see valid ids.`;
      return `Switched active task to [${t.id}] "${t.title}".`;
    },
  },

  {
    name: 'update_task_status',
    declaration: {
      name: 'update_task_status',
      description:
        'Update a task\'s status, most commonly marking it "done" when the user indicates that ' +
        'piece of work is finished/resolved, or "blocked" if it can\'t proceed right now. ' +
        'Omit task_id to act on the currently active task.',
      parameters: {
        type: 'object',
        properties: {
          task_id: { type: 'string', description: 'Task id (optional — defaults to the active task)' },
          status:  { type: 'string', enum: ['active', 'paused', 'blocked', 'done'], description: 'New status' },
        },
        required: ['status'],
      },
    },
    async execute({ task_id, status }, { tasks }) {
      if (!tasks) return 'Task system unavailable.';
      const id = task_id || tasks.memory.data.active_task_id;
      if (!id) return 'No active task and no task_id given.';
      const t = await tasks.setStatus(id, status);
      if (!t) return `No task found with id "${id}".`;
      return `Task [${t.id}] "${t.title}" is now "${t.status}".`;
    },
  },

  {
    name: 'update_task_summary',
    declaration: {
      name: 'update_task_summary',
      description:
        'Set or refresh the one-line rolling summary for a task — what\'s been decided/done so far. ' +
        'Call this after meaningfully progressing a task so the Task Board stays accurate. ' +
        'Omit task_id to act on the currently active task.',
      parameters: {
        type: 'object',
        properties: {
          task_id: { type: 'string', description: 'Task id (optional — defaults to the active task)' },
          summary: { type: 'string', description: 'Short rolling summary of where this task currently stands' },
        },
        required: ['summary'],
      },
    },
    async execute({ task_id, summary }, { tasks }) {
      if (!tasks) return 'Task system unavailable.';
      const id = task_id || tasks.memory.data.active_task_id;
      const t  = tasks._get ? tasks._get(id) : tasks.tasks[id];
      if (!t) return `No task found with id "${id}".`;
      t.summary = String(summary).slice(0, 200);
      t.updated = new Date().toISOString();
      await tasks._save();
      return `Updated summary for [${t.id}] "${t.title}".`;
    },
  },

  {
    name: 'add_task_note',
    declaration: {
      name: 'add_task_note',
      description:
        'Append a short scratchpad note to a task — a decision made, a fact discovered, something ' +
        'to remember specifically for THIS task (kept isolated from other tasks\' notes). ' +
        'Omit task_id to act on the currently active task.',
      parameters: {
        type: 'object',
        properties: {
          task_id: { type: 'string', description: 'Task id (optional — defaults to the active task)' },
          note:    { type: 'string', description: 'The note to add' },
        },
        required: ['note'],
      },
    },
    async execute({ task_id, note }, { tasks }) {
      if (!tasks) return 'Task system unavailable.';
      const id = task_id || tasks.memory.data.active_task_id;
      if (!id) return 'No active task and no task_id given.';
      const t = await tasks.addNote(id, note);
      if (!t) return `No task found with id "${id}".`;
      return `Note added to [${t.id}] "${t.title}".`;
    },
  },

];

