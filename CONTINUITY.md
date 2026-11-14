# Cross-Device Continuity (daemon + push)

JOJO normally assumes one long-running process on one machine. This feature
(`src/core/continuity.js`) adds two things on top of that, without pretending
to be a full multi-device sync engine:

1. **A background daemon** that heartbeats "this device is here, this is
   what it's on" into a small state file, on its own schedule, independent
   of whether you're actively chatting — same pattern as `world_model.js`.
2. **Push** — when something needs you (a self-healing fix, a rollout or
   deployment plan, an n8n workflow, a pending computer-use/browser action,
   a world-model drift event) and *no device has checked in recently*, JOJO
   sends a notification out instead of just sitting there waiting for you to
   come back to that specific terminal.

Read the HONEST LIMITS block at the top of `src/core/continuity.js` before
relying on this — short version: JOJO's other state (tasks, memory, the
world-model watches themselves) is **not** synced by this module. Only one
small file is, and only if you point it somewhere shared yourself.

## What actually moves between devices

- `memory/continuity_state.json` (or wherever `JOJO_CONTINUITY_STATE_FILE`
  points) — the device registry, handoff marker, and push log. Point this at
  a Dropbox / Syncthing / git-synced folder and every device sharing that
  path can see each other. Leave it at the default and you get a
  single-device presence log (still fine — push still works from that one
  device).
- Nothing else. `memory/persistent.json`, `memory/world_model.json`, the
  skill ledger, etc. all stay local to whichever machine wrote them. If you
  want the *actual task board or watch list* to look the same on two
  machines, that's on you to sync separately (or just point the whole
  `memory/` dir at a synced folder yourself — see the warning below about
  `device_id.json` if you do).

## Setup

Nothing is required for the local, single-device parts (heartbeat, terminal
push narration, `devices` command) — they work out of the box. For actual
cross-device behavior, set some subset of these in `.env`:

```bash
# A friendly name for this machine, shown in `devices` and in push messages.
# Defaults to the OS hostname if unset.
JOJO_DEVICE_LABEL=work-laptop

# Point this at a path that's ALSO synced (Dropbox, Syncthing, git pull on a
# cron, rsync, whatever you already trust) so other devices see it.
JOJO_CONTINUITY_STATE_FILE=/Users/you/Dropbox/jojo/continuity_state.json

# Any endpoint that accepts a POST with a plain-text body — ntfy.sh, a
# Pushover/Slack/Discord incoming webhook, your own tiny server. This is
# the actual "text me on my phone" mechanism.
JOJO_CONTINUITY_PUSH_URL=https://ntfy.sh/your-private-topic

# Optional extra headers as JSON, e.g. an auth token some webhooks require.
JOJO_CONTINUITY_PUSH_HEADERS_JSON={"Authorization":"Bearer xxx"}
```

If the WhatsApp channel (`npm run whatsapp`, see `WHATSAPP_CHANNEL.md`) is
also running, push automatically tries that too — no extra config.

### ⚠️ If you sync the whole `memory/` directory instead of just the one file

`memory/device_id.json` is deliberately kept **out** of
`JOJO_CONTINUITY_STATE_FILE` and is always local — that's what lets two
machines have distinct identities. If you sync all of `memory/` wholesale
rather than pointing `JOJO_CONTINUITY_STATE_FILE` at just the shared file,
`device_id.json` will sync too and every device will collide on the same id.
Keep `device_id.json` excluded from whatever sync you use (e.g. an
ignore rule in Dropbox/Syncthing), or stick to syncing only the one
continuity state file.

## Using it

- **`devices`** in the REPL — shows every known device, status
  (active/idle/offline based on how recently it heartbeated), what task it
  was last on, any handoff marker, the configured push webhook, and recent
  pushes.
- **"I'm switching to my desktop now"** → JOJO calls `continuity_handoff`.
  Advisory only (see honest limits) — it marks a device as active so other
  devices (and you, via `devices`) know, but doesn't hard-lock anything.
- **"Text me when this is done" / "let me know"** → JOJO calls
  `continuity_push_now` with the result, once the work finishes. This always
  fires, regardless of whether another device looks active.
- **The automatic case** — you close your laptop mid-task with a pending
  self-healing fix or deploy plan sitting there. Nobody's device heartbeats
  for a few minutes (`JOJO_CONTINUITY_STALE_MS`, default 3min), and the next
  daemon tick pushes a notification summarizing what's waiting. Each pending
  source is debounced (`JOJO_CONTINUITY_PUSH_DEBOUNCE_MS`, default 15min) so
  it won't spam you every tick for the same unresolved item — only again if
  the count changes or enough time has passed.

## Honest limits (repeated from the code, because it matters)

- Not a sync engine — only the one state file moves, and only if you point
  it somewhere shared.
- "Handoff" is a marker, not a lock. Two devices can still both run their
  own background schedulers against locally-synced files at the same time;
  this surfaces that risk rather than preventing it.
- Push is best-effort. A bad webhook URL or a disconnected WhatsApp client
  never throws — it's logged in `delivered` / `failed` and the turn
  continues. Terminal narration always happens regardless, so this is never
  silently a no-op on the device that's actually running.

