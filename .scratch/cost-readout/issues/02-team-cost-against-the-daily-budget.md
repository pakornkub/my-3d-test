# 02: Team cost against the daily budget on the panel

**Status:** ready-for-agent

**Blocked by:** 01

**What to build:** The panel's one number, said out loud instead of hidden in a tooltip: today's team cost rendered against the daily budget, changing colour as the ceiling approaches. The budget travels from the repo's office file to the scene in the connection snapshot.

**Spec:** `.scratch/cost-readout/spec.md` · **Read first:** `CONTEXT.md`, `docs/adr/0002-cost-is-accounted-per-session-not-per-member.md`

## Scope

- The server publishes `daily-budget-usd` (from `docs/agents/office.md`) with the snapshot the scene already receives on connect. No new event type.
- The panel stops keeping its own `costs` map and renders the **team cost** and per-id breakdown that the Director now owns (ADR-0002). The breakdown keeps listing every agent id that has spent money, including ids that are not crew members.
- The team figure is visible text — e.g. `วันนี้ $1.20 / $10` — not a `data-` attribute read on hover.
- Warning style from 80% of the budget, over-budget style at 100%. Appearance only: nothing in the browser stops or throttles a session.
- With no budget known (no server), render the figure without a denominator rather than inventing one.

## Acceptance criteria

- [ ] `npm test` passes
- [ ] `npm run dev:all` against this repo: the panel shows today's team cost and `/ $10`, matching the `daily-budget-usd` in `docs/agents/office.md`
- [ ] Changing `daily-budget-usd` in `docs/agents/office.md` and reconnecting changes the denominator on the panel
- [ ] The figure is readable without hovering anything
- [ ] Driving the total to 80% of the budget with `__ube.emit` switches it to the warning style; 100% switches it to the over-budget style; below 80% it is neutral
- [ ] The panel's breakdown lists an agent id that is not on the roster after a cost event for it, and the team figure includes that money while no roster row does
- [ ] The team figure equals the sum of every session's latest running total for today, which may be more than the roster's visible figures add up to — this is correct, not a bug to fix
- [ ] Opening the app with no server running shows the team figure with no denominator and no console error
