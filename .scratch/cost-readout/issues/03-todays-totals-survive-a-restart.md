# 03: Today's totals survive a server restart

**Status:** ready-for-agent

**Blocked by:** none

**What to build:** The server side of the day's accounting: a pure function that turns a day's event log into the latest running total per session, a per-member state map replacing the single scalar, and a seed at boot so a restart never makes a figure jump backwards.

**Spec:** `.scratch/cost-readout/spec.md` · **Read first:** `CONTEXT.md`, `docs/adr/0002-cost-is-accounted-per-session-not-per-member.md`

## Scope

- A pure function over an array of logged events → latest running total per session key (`ev.session ?? ev.agent`), exported so it can be tested by calling it with literal input, in the style of `parseTicket` / `parseOffice` / `commandAllowed`. Malformed lines are skipped, not thrown on.
- At boot the server reads the current UTC day's log for the active project and starts its accounting from that derivation; the resumed manager session's fresh `total_cost_usd` adds to the seed rather than replacing it, so the figure never goes backwards.
- `state.json`'s single `costUsd` becomes a per-member map. The state loader already spreads over an empty shape, so files written before this change must load without migration.
- A scene that connects receives today's totals, so a browser reload does not appear to reset the day.
- This ticket can be verified through the panel's existing readout; it does not depend on tickets 01 or 02 landing first.

## Acceptance criteria

- [ ] `npm test` passes, and `tests/server.test.js` contains new cases for: two sessions of one agent in a day's log, repeated running totals for one session, a log containing malformed lines, and an empty log
- [ ] `npm run dev:all` against this repo, let the manager take a turn, then stop the server with Ctrl+C and start it again: the figure the scene shows after reconnecting is at least what it was before the restart
- [ ] Taking another manager turn after that restart increases the figure from the restored value rather than from zero
- [ ] Reloading the browser tab without restarting the server leaves the figure unchanged
- [ ] `server/state/<project>.json` holds a per-member map after a turn, and a state file from before this change (single `costUsd`) still loads without error
- [ ] Deleting today's log file and restarting starts the day's figure at zero without error
