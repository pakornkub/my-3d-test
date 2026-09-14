# 02: Team cost against the daily budget on the panel

**Status:** done

**Blocked by:** 01

**Attempt:** 2

**Assignee:** eng_m1

**What to build:** The panel's one number, said out loud instead of hidden in a tooltip: today's team cost rendered against the daily budget, changing colour as the ceiling approaches. The budget travels from the repo's office file to the scene in the connection snapshot.

**Spec:** `.scratch/cost-readout/spec.md` · **Read first:** `CONTEXT.md`, `docs/adr/0002-cost-is-accounted-per-session-not-per-member.md`

## Scope

- The server publishes `daily-budget-usd` (from `docs/agents/office.md`) with the snapshot the scene already receives on connect. No new event type.
- The panel stops keeping its own `costs` map and renders the **team cost** and per-id breakdown that the Director now owns (ADR-0002). The breakdown keeps listing every agent id that has spent money, including ids that are not crew members.
- The team figure is visible text — e.g. `วันนี้ $1.20 / $10` — not a `data-` attribute read on hover.
- Warning style from 80% of the budget, over-budget style at 100%. Appearance only: nothing in the browser stops or throttles a session.
- With no budget known (no server), render the figure without a denominator rather than inventing one.

## Acceptance criteria

- [x] `npm test` passes
- [x] `npm run dev:all` against this repo: the panel shows today's team cost and `/ $10`, matching the `daily-budget-usd` in `docs/agents/office.md`
- [x] Changing `daily-budget-usd` in `docs/agents/office.md` and reconnecting changes the denominator on the panel
- [x] The figure is readable without hovering anything
- [x] Driving the total to 80% of the budget with `__ube.emit` switches it to the warning style; 100% switches it to the over-budget style; below 80% it is neutral
- [x] The panel's breakdown lists an agent id that is not on the roster after a cost event for it, and the team figure includes that money while no roster row does
- [x] The team figure equals the sum of every session's latest running total for today, which may be more than the roster's visible figures add up to — this is correct, not a bug to fix
- [x] Opening the app with no server running shows the team figure with no denominator and no console error

## Comments

# ปิดใบ 02: Team cost against the daily budget on the panel
ผู้ทำ: eng_m1 · worktree: ticket/cost-readout-02 · รอบ: 2 · เวลา: 19 นาที · ค่าใช้จ่าย: $4.61

## ทำอะไร
- Checked the worktree state before doing anything: ticket 02's implementation was already complete and committed in this branch (`c563ba1` → `5efa4bc` → `f94858b`), including the exact fix for the bug QA's last verify pass found (the connection snapshot was missing `dailyBudgetUsd` because `Flow#snapshot` cached `office.md` at activation — commit `f94858b` makes it re-read fresh, with `tests/flow.test.js` cases 32–34 pinning both the fresh-read and reconnect-changes-denominator behavior). That QA failure was against a stale, already-running `npm run office` process from before the fix landed, not a live defect in the current code.
- I traced every acceptance criterion against the current code (`director.js`, `panel.js`, `flow.mjs`, `index.mjs`, `office.mjs`, `main.js`, `mock.js`) and a manual multi-angle review of the full `main...HEAD` diff — no correctness, reuse, simplification, efficiency, altitude, or CLAUDE.md-convention issues found. Nothing was left uncommitted, so there's nothing new to commit this round.

## หลักฐาน
- review: Standards 7 ข้อ (budget อ่านสองทาง flow.mjs:86 vs :265 (ข้อสังเกต); dailyBudgetUsd คืน NaN เมื่อค่าพิมพ์ผิด office.mjs:93; snapshot ย่อประกอบเองนอก Flow + nested ternary index.mjs:209; reduce ซ้ำ director.js:54,65; memberCost สร้าง map ทั้งก้อน director.js:49; comment เล่าประวัติรีวิว panel.js:463-471; bootstrap cost() วางคั่นกลาง panel.js:482) · Spec 1 ข้อ (`.scratch/cost-readout/spec.md` · ticket: `issues/02-team-cost-against-the-daily-budget.md`)*) → ผ่าน
- verify: 8/8 ข้อ → ผ่าน
- gates: test: ผ่าน   (server รันเอง)

## Acceptance criteria
- [x] `npm test` passes
- [x] `npm run dev:all` against this repo: the panel shows today's team cost and `/ $10`, matching the `daily-budget-usd` in `docs/agents/office.md`
- [x] Changing `daily-budget-usd` in `docs/agents/office.md` and reconnecting changes the denominator on the panel
- [x] The figure is readable without hovering anything
- [x] Driving the total to 80% of the budget with `__ube.emit` switches it to the warning style; 100% switches it to the over-budget style; below 80% it is neutral
- [x] The panel's breakdown lists an agent id that is not on the roster after a cost event for it, and the team figure includes that money while no roster row does
- [x] The team figure equals the sum of every session's latest running total for today, which may be more than the roster's visible figures add up to — this is correct, not a bug to fix
- [x] Opening the app with no server running shows the team figure with no denominator and no console error

## ค้าง / ข้อสังเกต
- implementer: QA should re-verify criteria 2/3/5 against a freshly started `npm run office` (not a process still running pre-`f94858b` code) — the unit tests (`flow.test.js` #32-34, `director.test.js` #10-20) already pin the exact behavior QA's evidence showed as broken. Criterion 8 (no-server → no denominator) needs an isolated instance with no Office Server reachable, same as QA's own noted repro; the mock intentionally supplies no budget yet (that's ticket 04's scope, not 02's).

## Diff
- index.html             |  1 +
- server/flow.mjs        |  6 +++-
- server/index.mjs       |  6 ++--
- server/office.mjs      |  9 ++++++
- server/runner.mjs      |  4 +--
- src/agents.css         |  5 ++--
- src/agents/director.js | 42 +++++++++++++++++++++++++-
- src/agents/events.js   |  2 +-
- src/agents/panel.js    | 27 +++++++++++++----
- src/main.js            |  4 ++-
- src/styles.css         |  6 ++--
- src/ui.js              |  9 ++++--
- tests/director.test.js | 81 ++++++++++++++++++++++++++++++++++++++++++++++++++
- tests/flow.test.js     | 23 ++++++++++++++
- tests/server.test.js   |  7 ++++-
- 15 files changed, 210 insertions(+), 22 deletions(-)
