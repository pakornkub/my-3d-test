# Cost readout: member cost on the roster, team cost on the panel

**Status:** ready-for-agent

## Problem Statement

You can watch the team work but not what it is spending. The only money on screen is a single
figure tucked into a `data-cost` attribute on the panel's mode badge, with the per-person
breakdown hidden in that element's tooltip — so answering "who is burning the budget?" means
hovering the right pixel, and answering "are we near the daily cap?" is impossible, because the
scene is never told what the cap is.

Worse, the figure quietly stops being true the moment the team grows. Cost is keyed by crew id and
overwritten on every event, which is only correct while a crew member has exactly one session for
life. From phase 2 an implementer gets a fresh session per ticket, so each new ticket would erase
the cost of the one before it and the total would drift down as the team does more work.

## Solution

Each crew member carries their own money on the roster: a small figure on their row, next to the
name, alongside the status they already show. The panel keeps one number — the team cost for
today — but says it out loud instead of hiding it in a tooltip, and shows it against the daily
budget so "$1.20 / $10" is legible at a glance and changes colour as the ceiling approaches.

The numbers are right by construction: money is tracked per session and summed per member, so a
member who has burned through six ticket sessions shows the sum of all six. The team figure covers
the whole UTC day and is seeded at boot from that day's event log, so it survives both a browser
reload and a server restart. Money from a session that belongs to nobody on the roster still lands
in the team figure and is listed in the panel's breakdown, so it is never silently dropped.

In demo mode — which is what the public GitHub Pages build runs — the mock supplies both fake
running totals and a fake budget, so the feature is visible and demonstrable without a server.

## User Stories

1. As the human manager, I want each crew member's cost on their roster row, so that I can see who is expensive without hovering anything.
2. As the human manager, I want a member's figure to be the sum of all their sessions, so that a person who has worked six tickets does not read as if they had worked one.
3. As the human manager, I want the figure hidden while a member has spent nothing, so that the five people without sessions in phase 1 do not look like a broken feature.
4. As the human manager, I want the roster figure right-aligned on the name row rather than appended to the status line, so that a long status like "กำลังทำ · ใบ 03" does not push the money out of view.
5. As the human manager, I want the team cost for today displayed as text on the panel, so that I do not have to hover the mode badge to read it.
6. As the human manager, I want the team cost shown against the daily budget, so that a number like "$1.20" means something instead of floating free.
7. As the human manager, I want the team figure to change colour as it approaches the budget, so that I notice the ceiling coming without reading digits.
8. As the human manager, I want the panel's breakdown to keep listing every agent id that has spent money, so that money attributed to a session outside the roster is still visible somewhere.
9. As the human manager, I want the team figure to equal today's real spend even when the roster's visible figures sum to less, so that I trust the total over the parts.
10. As the human manager, I want the figures to survive a browser reload, so that pressing F5 does not appear to reset the day's spending.
11. As the human manager, I want the figures to survive a server restart, so that restarting the Office Server does not make the manager's cost jump backwards.
12. As the human manager, I want the day's total to cut over to a fresh bucket while the server keeps running, so that yesterday's spending does not leak into today's budget comparison.
13. As the human manager, I want to know which day boundary is in use, so that a figure resetting at 07:00 Thai time reads as a decision rather than a bug.
14. As a visitor to the published demo, I want the roster and panel to show plausible money as the scripted flow plays, so that I can see the feature without running a server.
15. As a visitor to the published demo, I want the budget warning state to occur during the demo, so that the colour change is something I actually see.
16. As the human manager, I want a session that reports its running total twice to replace rather than add, so that a long conversation does not inflate the figures.
17. As the human manager, I want two sessions belonging to the same member to add up, so that per-ticket sessions accumulate correctly.
18. As a developer replaying an old event log, I want cost events recorded before this change to still be accepted, so that `replayScript` keeps working on logs already on disk.
19. As a developer, I want the aggregation rules unit-tested away from the browser, so that a regression in the money maths fails in `npm test` rather than in someone's eyes.
20. As QA, I want to tick every acceptance criterion from the running app in demo mode, so that verifying this ticket does not require an API key or a live server.
21. As the reviewer, I want the money rules in one place rather than split between the panel and the roster, so that the two readouts cannot disagree.

## Implementation Decisions

**The event carries the session.** `session.cost` gains a `session` field holding the SDK session
id, which the runner already has from both the init and result messages. Per ADR-0001 the field is
**optional**: it is not added to the schema's required list and `EVENT_VERSION` does not move, so
cost events logged before this change still validate and still replay. Readers key on
`ev.session ?? ev.agent`.

**Aggregation lives in the Director.** Per ADR-0002, the Director owns the money model and both
readouts render from it; the panel stops keeping its own `costs` map. The rules:

- a cost event replaces the running total for its session key — running totals are not summed per event
- member cost = the sum of the latest running totals of that member's sessions
- team cost = the sum over every session key seen today, including agent ids that are not crew members
- events whose day differs from the current bucket start a new bucket; the old bucket is discarded

The Director exposes the member figure, the team figure and the per-id breakdown; the panel is
handed the breakdown and the budget, the roster renderer is handed the member figure the same way
it is already handed agent status.

**The roster renderer takes cost as a lookup, not as state.** The existing roster render already
receives a status lookup and rebuilds on every change; the member figure arrives the same way, so
the roster gains no state of its own and no new render trigger. A member with zero renders no
figure at all, not `$0.00`.

**The budget reaches the browser in the connection snapshot.** `daily-budget-usd` is read from the
repo's office file by the server and published with the snapshot the scene already receives on
connect. The mock publishes the same shape with a fake value so demo mode has a denominator.

**The server seeds today from the log.** At boot the server reads the current UTC day's event log,
derives the latest running total per session key, and starts its in-memory accounting from there.
The day is the UTC day because the log is already filed one file per UTC day (ADR-0002); the
readout's tooltip states the boundary so the 07:00 Thai rollover is explained where it is seen.

**Per-member persistence replaces the single scalar.** The state file's single `costUsd` becomes a
per-member map. The state loader spreads over an empty shape, so state files written before this
change load without migration.

**Warning thresholds.** The team figure renders in a warning style from 80% of the budget and an
over-budget style at 100%. Crossing the ceiling changes appearance only: the server's own
`maxBudgetUsd` remains the thing that actually stops a session.

**The mock emits money.** The scripted demo driver emits `session.cost` with a session id as the
flow plays, rising plausibly per agent, and reaches the warning band before the script ends.

## Testing Decisions

A good test here asserts what an observer of the scene would see — given this sequence of events,
what does a member's figure read, what does the team figure read — and never how the Director
stores its buckets. Tests drive the public event entry point, exactly as the existing Director
tests do.

**Seam 1 (existing, preferred): the Director.** `tests/director.test.js` already constructs a
Director over a fake crew, fake bubbles, a Proxy-based fake panel that records calls, and fake
places. Every rule above is reachable from that seam by handing the Director cost events and
reading the figures back, with no DOM and no three.js. New cases: replacement within one session;
accumulation across two sessions of one member; an agent id absent from the roster counted in the
team figure but absent from the member figures; a day rollover discarding the previous bucket; a
legacy event with no `session` field still accounted under its agent id.

**Seam 2 (existing): the server's day-seed function.** `tests/server.test.js` unit-tests pure
parsers (`parseTicket`, `parseOffice`, `commandAllowed`, `summarizeTool`) by calling them with
literal input — no server boot, no sockets. The log-to-totals derivation is written as a pure
function over an array of events and tested the same way, including a log containing two sessions
for one agent and a log containing malformed lines.

No new seam is introduced. The two rendering surfaces — the roster row and the panel figure — have
no test seam in this repo (there is no DOM test harness and adding one is not this ticket's job);
they are covered by QA opening the app in demo mode, which the mock's emissions make possible
without a server.

## Out of Scope

- **Per-ticket cost.** `session.cost` deliberately does not gain a `ticket` field; per ADR-0001 it
  can be added as another optional field when something actually displays it.
- **Cost history or charts.** No sparkline, no per-day series, no drill-down beyond today's figure
  and the breakdown that already exists.
- **Budget enforcement from the UI.** Nothing in the browser stops, throttles or warns a session;
  the colour change is informational.
- **Cost in the close-out reports.** Ticket and feature reports do not gain a money line here.
- **Changing the log's day boundary.** The UTC file-per-day naming stays as it is.
- **Real money in phase 1.** Only the manager has a session today; the other five will read empty
  until ticket sessions exist, and that is the correct display, not a gap to paper over.

## Further Notes

The vocabulary is fixed in `CONTEXT.md`: **running total** (what one session has spent so far, the
thing an event carries), **member cost** (the sum over a member's sessions, the roster figure),
**team cost** (today's sum over every session, the panel figure) and **today** (the UTC day). Use
those terms in tickets, tests and comments rather than inventing "spend", "delta" or "agent cost".

Two ADRs govern this area and should be read before touching the event contract:
`docs/adr/0001-event-schema-evolves-by-optional-fields.md` and
`docs/adr/0002-cost-is-accounted-per-session-not-per-member.md`.

One consequence is worth stating plainly for whoever reviews this: the roster's visible figures are
**allowed** to sum to less than the panel's team figure, because unattributable money is counted
but not shown per person. A reviewer who "fixes" that discrepancy would be reintroducing silently
dropped money.
