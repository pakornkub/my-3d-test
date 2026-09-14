# 01: Member cost on the roster

**Status:** ready-for-agent

**Blocked by:** none

**What to build:** The spine of the feature — a cost event that names its session, the Director rules that turn a stream of those events into a member cost, and the figure on each roster row. After this ticket the left-hand roster shows money next to whoever has spent it.

**Spec:** `.scratch/cost-readout/spec.md` · **Read first:** `CONTEXT.md`, `docs/adr/0001-event-schema-evolves-by-optional-fields.md`, `docs/adr/0002-cost-is-accounted-per-session-not-per-member.md`

## Scope

- `session.cost` gains an **optional** `session` field carrying the SDK session id; the runner fills it. Do not add it to the schema's required list and do not move `EVENT_VERSION` (ADR-0001).
- The Director owns the money model, keyed on `ev.session ?? ev.agent`: a cost event **replaces** the running total for its session key; **member cost** is the sum of the latest running totals of that member's sessions.
- A cost event whose day differs from the current bucket starts a new bucket and discards the old one (UTC day, per ADR-0002).
- The roster renderer receives the member figure as a lookup, the same way it already receives agent status, and renders it right-aligned on the name row. A member with nothing spent renders no figure at all — not `$0.00`.
- The panel keeps working as it does today; moving the panel's own figure is ticket 02's job.

## Acceptance criteria

- [ ] `npm test` passes, and `tests/director.test.js` contains new cases for: replacement within one session, accumulation across two sessions of one member, an agent id that is not a crew member, a day rollover, and a legacy cost event with no `session` field
- [ ] With the app open, `__ube.emit('session.cost', { agent: 'eng_m1', session: 's1', usd: 0.42 })` puts `$0.42` on วิศวกร A's roster row
- [ ] Sending the same session key again with `usd: 0.90` changes that row to `$0.90` — it does not become `$1.32`
- [ ] Sending a second session key for the same member (`session: 's2', usd: 0.10`) changes the row to `$1.00`
- [ ] Rows for members who have received no cost event show no money at all, and the row's existing name and status text are unchanged
- [ ] A cost event for an unknown agent id (e.g. `agent: 'someone_else'`) changes no roster row and throws nothing in the console
- [ ] `npm run dev:all` with a real project: the manager's row shows a rising figure as the manager takes a turn
- [ ] Replaying a log line recorded before this change (a `session.cost` with no `session` field) is still accepted by the scene and lands on that agent's row
