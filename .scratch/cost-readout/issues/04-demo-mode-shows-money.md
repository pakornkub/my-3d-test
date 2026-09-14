# 04: Demo mode shows money

**Status:** ready-for-agent

**Blocked by:** 01

**What to build:** Money in the scripted demo, so the published GitHub Pages build shows the feature without a server — the mock emits rising running totals per session as the flow plays, supplies a fake budget, and the readout states which day boundary it is counting.

**Spec:** `.scratch/cost-readout/spec.md` · **Read first:** `CONTEXT.md`, `docs/adr/0002-cost-is-accounted-per-session-not-per-member.md`

## Scope

- The mock driver emits `session.cost` with a `session` id as its scripted flow plays: the manager during the interview, each implementer on their ticket, the reviewer and QA on theirs. Totals rise plausibly and each ticket session is a new session key, so the demo exercises the per-member sum rather than a single session.
- The mock supplies a fake `daily-budget-usd` in the same place the server supplies the real one, and the scripted run reaches the warning band before it ends.
- The readout's tooltip states the day boundary in use — the figure covers the UTC day and therefore rolls over at 07:00 Thai time — so the reset reads as a decision rather than a bug.
- No server, no API key, and no network is required to see any of this.

## Acceptance criteria

- [ ] `npm test` passes
- [ ] `npm run dev` with no Office Server running, press **ทีม** then **เล่นตัวอย่าง**: figures appear on roster rows as the scripted flow plays and rise as it continues
- [ ] At least one crew member ends the demo with a figure that is the sum of more than one session key, not the last one only
- [ ] The team figure reaches the warning band before the scripted run finishes
- [ ] Hovering the team figure explains that it covers the UTC day and rolls over at 07:00 Thai time
- [ ] `npm run build` then serving `dist/` shows the same behaviour — no console errors about a missing server
- [ ] Nothing in the demo path requires `ANTHROPIC_API_KEY` or a WebSocket connection
