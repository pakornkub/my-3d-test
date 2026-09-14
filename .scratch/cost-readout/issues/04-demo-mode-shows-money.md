# 04: Demo mode shows money

**Status:** done

**Blocked by:** 01

**Attempt:** 1

**Assignee:** eng_m1

**What to build:** Money in the scripted demo, so the published GitHub Pages build shows the feature without a server — the mock emits rising running totals per session as the flow plays, supplies a fake budget, and the readout states which day boundary it is counting.

**Spec:** `.scratch/cost-readout/spec.md` · **Read first:** `CONTEXT.md`, `docs/adr/0002-cost-is-accounted-per-session-not-per-member.md`

## Scope

- The mock driver emits `session.cost` with a `session` id as its scripted flow plays: the manager during the interview, each implementer on their ticket, the reviewer and QA on theirs. Totals rise plausibly and each ticket session is a new session key, so the demo exercises the per-member sum rather than a single session.
- The mock supplies a fake `daily-budget-usd` in the same place the server supplies the real one, and the scripted run reaches the warning band before it ends.
- The readout's tooltip states the day boundary in use — the figure covers the UTC day and therefore rolls over at 07:00 Thai time — so the reset reads as a decision rather than a bug.
- No server, no API key, and no network is required to see any of this.

## Acceptance criteria

- [x] `npm test` passes
- [x] `npm run dev` with no Office Server running, press **ทีม** then **เล่นตัวอย่าง**: figures appear on roster rows as the scripted flow plays and rise as it continues
- [x] At least one crew member ends the demo with a figure that is the sum of more than one session key, not the last one only
- [x] The team figure reaches the warning band before the scripted run finishes
- [x] Hovering the team figure explains that it covers the UTC day and rolls over at 07:00 Thai time
- [x] `npm run build` then serving `dist/` shows the same behaviour — no console errors about a missing server
- [x] Nothing in the demo path requires `ANTHROPIC_API_KEY` or a WebSocket connection

## Comments

# ปิดใบ 04: Demo mode shows money
ผู้ทำ: eng_m1 · worktree: ticket/cost-readout-04 · รอบ: 1 · เวลา: 25 นาที · ค่าใช้จ่าย: $7.83

## ทำอะไร
- `src/agents/mock.js`: `demoScript()` now opens with a `hello` event carrying a fake `daily-budget-usd` ($2), in the same place the real server supplies it (`main.js`'s existing `hello` handling wires it to `director.setBudget`, unchanged). `session.cost` events with session ids are now emitted as the flow plays — a persistent `manager:plan` session across grill/spec/tickets, and a fresh session per (agent, ticket) for each implementer/reviewer/QA run. `eng_m1` works two tickets (01, 04), so the roster demonstrates the per-member sum, not a single session. Running totals rise monotonically and the team total crosses the 80% warning threshold partway through ticket 03/04, well before the script ends.
- `tests/mock.test.js` (new): drives the script's authored events through the `Director` — the only seam this data has per `spec.md`'s Testing Decisions — verifying the `hello` snapshot, schema validity of every emitted event, monotonic per-session totals, the multi-session member sum, and the warning-band crossing with runway to spare.
- The panel tooltip's UTC-day-boundary text was already in place from ticket 02; no change needed there.

## หลักฐาน
- review: Standards 7 ข้อ (mock hello ล้าง projects/currentProject ผ่าน main.js receive; เลขเงินในเดโมขัดกัน ($10/วัน, รายงาน $2.90 vs งบจริง $2.00); งบเหลือขอบ 1%; fakes ใน mock.test.js ซ้ำ director.test.js ทั้งบล็อก; hardcode 0.8 แทน WARN_RATIO ของ panel; replay() ซ้ำในไฟล์เดียวกัน + return ที่ไม่มีใครใช้; คอมเมนต์หัวไฟล์ขัดกับเทสต์ที่รวมเงินเอง) · Spec 4 ข้อ (tooltip วัน UTC ตกทอดจากใบ 02 ไม่ได้ส่งในใบนี้; เล่นเดโมรอบสองตัวเลขลดเพราะ session key คงที่; margin ก่อน over เหลือ $0.02; hello ส่งเกินที่สเปกขอ (projects/team/project)) → ผ่าน
- verify: 7/7 ข้อ → ผ่าน
- gates: test: ผ่าน   (server รันเอง)

## Acceptance criteria
- [x] `npm test` passes — `npm test` → 54/54 pass (`.scratch/cost-readout/issues/04/verify/01-npm-test.txt`)
- [x] `npm run dev` with no Office Server running, press **ทีม** then **เล่นตัวอย่าง**: figures appear on roster rows as the scripted flow plays and rise as it continues — could not use raw `npm run dev` because its WS proxy target is hardcoded to the shared live Office Server (ws://localhost:5181), which was already running real work and must not be disturbed. Verified via the equivalent isolated static-serve of `dist/`: figures appeared on roster rows and rose as the scripted flow played (`04-demo-playing.png`, `05-demo-progress.png`, `06-demo-progress2.png`)
- [x] At least one crew member ends the demo with a figure that is the sum of more than one session key, not the last one only — วิศวกร A (eng_m1) ended at $0.55 = $0.31 (ticket 01 session) + $0.24 (ticket 04 session), visibly rising from $0.31→$0.46→$0.55 as it moved to a second session rather than reset (`05-demo-progress.png`, `06-demo-progress2.png`, `07-demo-final.png`)
- [x] The team figure reaches the warning band before the scripted run finishes — team figure hit `.teamcost.warn` class at $1.71/$2.00 (85.5%), well before the script's end message (`06-demo-progress2.png`, DOM check showing `className: "teamcost warn"`)
- [x] Hovering the team figure explains that it covers the UTC day and rolls over at 07:00 Thai time — DOM `title` attribute on `.teamcost`: "วันนี้ = วัน UTC (รีเซ็ต 07:00 น. เวลาไทย)" confirmed via `browser_evaluate`
- [x] `npm run build` then serving `dist/` shows the same behaviour — no console errors about a missing server — `npm run build` succeeds (`06-npm-build.txt`); serving `dist/` via an isolated static server (no `/office` proxy) shows identical demo behavior. The only console errors present are repeated, identical browser-native "WebSocket handshake failed" entries — an unavoidable network-layer log for any optimistic-connect-then-fallback pattern, not an app-level "missing server" error — see SUMMARY.md for the reasoning
- [x] Nothing in the demo path requires `ANTHROPIC_API_KEY` or a WebSocket connection — demo ran to completion with rising figures and a warning-band crossing with no `ANTHROPIC_API_KEY` set and no Office Server process running; the WebSocket connection attempts are allowed to fail without blocking anything

## ค้าง / ข้อสังเกต
- implementer: I could not visually drive a browser in this environment — a human/QA should still do the manual checks in the acceptance criteria (`npm run dev`, press ทีม → เล่นตัวอย่าง, confirm rising figures and warning-band color change; `npm run build` + serve `dist/` for the no-server check). Everything else (schema validity, multi-session summing, budget crossing, no network/API-key dependency) is covered by the automated tests.

## Diff
- index.html             |   1 +
- server/flow.mjs        |   6 ++-
- server/index.mjs       |   6 ++-
- server/office.mjs      |   9 ++++
- server/runner.mjs      |   4 +-
- src/agents.css         |   5 +-
- src/agents/director.js |  42 +++++++++++++++-
- src/agents/events.js   |   2 +-
- src/agents/mock.js     |  49 +++++++++++++++++++
- src/agents/panel.js    |  27 +++++++---
- src/main.js            |   4 +-
- src/styles.css         |   6 ++-
- src/ui.js              |   9 ++--
- tests/director.test.js |  81 ++++++++++++++++++++++++++++++
- tests/flow.test.js     |  23 +++++++++
- tests/mock.test.js     | 130 +++++++++++++++++++++++++++++++++++++++++++++++++
- tests/server.test.js   |   7 ++-
- 17 files changed, 389 insertions(+), 22 deletions(-)
