# 03: Today's totals survive a server restart

**Status:** done

**Blocked by:** none

**Attempt:** 1

**Assignee:** eng_f1

**What to build:** The server side of the day's accounting: a pure function that turns a day's event log into the latest running total per session, a per-member state map replacing the single scalar, and a seed at boot so a restart never makes a figure jump backwards.

**Spec:** `.scratch/cost-readout/spec.md` · **Read first:** `CONTEXT.md`, `docs/adr/0002-cost-is-accounted-per-session-not-per-member.md`

## Scope

- A pure function over an array of logged events → latest running total per session key (`ev.session ?? ev.agent`), exported so it can be tested by calling it with literal input, in the style of `parseTicket` / `parseOffice` / `commandAllowed`. Malformed lines are skipped, not thrown on.
- At boot the server reads the current UTC day's log for the active project and starts its accounting from that derivation; the resumed manager session's fresh `total_cost_usd` adds to the seed rather than replacing it, so the figure never goes backwards.
- `state.json`'s single `costUsd` becomes a per-member map. The state loader already spreads over an empty shape, so files written before this change must load without migration.
- A scene that connects receives today's totals, so a browser reload does not appear to reset the day.
- This ticket can be verified through the panel's existing readout; it does not depend on tickets 01 or 02 landing first.

## Acceptance criteria

- [x] `npm test` passes, and `tests/server.test.js` contains new cases for: two sessions of one agent in a day's log, repeated running totals for one session, a log containing malformed lines, and an empty log
- [ ] `npm run dev:all` against this repo, let the manager take a turn, then stop the server with Ctrl+C and start it again: the figure the scene shows after reconnecting is at least what it was before the restart
- [ ] Taking another manager turn after that restart increases the figure from the restored value rather than from zero
- [ ] Reloading the browser tab without restarting the server leaves the figure unchanged
- [x] `server/state/<project>.json` holds a per-member map after a turn, and a state file from before this change (single `costUsd`) still loads without error
- [x] Deleting today's log file and restarting starts the day's figure at zero without error

## Comments

> *ส่งต่อให้คนโดย Office Server*

แก้ 3 รอบแล้วยังไม่ผ่าน: reviewer ส่งกลับ:
STANDARDS: none
SPEC: none

แก้ตาม finding แล้วจบด้วย RESULT/EVIDENCE/NEXT อีกครั้ง

> *ส่งต่อให้คนโดย Office Server*

แก้ 3 รอบแล้วยังไม่ผ่าน: …ost; ชื่อ costFields ไม่อยู่ในคำศัพท์ CONTEXT.md; today()/dayOf() ซ้ำกัน; broadcast() รับงานบัญชีเงินเพิ่ม (Divergent Change); lookup ซ้ำใน runningTotalFor
SPEC: `.scratch/cost-readout/spec.md` · ticket: `03-todays-totals-survive-a-restart.md`

แก้ตาม finding แล้วจบด้วย RESULT/EVIDENCE/NEXT อีกครั้ง

> *ส่งต่อให้คนโดย Office Server*

merge เข้า feature/cost-readout ชนกันที่: server/flow.mjs, server/runner.mjs, src/agents/events.js, tests/flow.test.js, tests/server.test.js

# ปิดใบ 03: Today's totals survive a server restart
ผู้ทำ: eng_f1 · worktree: ticket/cost-readout-03 · รอบ: 1 · เวลา: 9 นาที · ค่าใช้จ่าย: $1.83

## ทำอะไร
- Merge feature/cost-readout into ticket 03 (conflicts resolved by the human: both sides kept, snapshot cost from managerRunningTotal)
- Address review: name daySeed apart from the field, drop the costEvents middle man, close doc gaps
- Address review: split money rules into costs.mjs, stop dropping legacy money, trim comments
- Address review: day-scope state.costs, dedupe the fold and session-guard, wire unicast fully
- Keep state.costs live after boot, and scope a session's cost to its own day
- Tag session.cost with the session id so the seed is truly per-session
- Stop the write key from drifting off what the log actually files the manager under
- Fix the seed's split key space so a session id never zeroes it out
- Seed today's cost from the log so a server restart never regresses it

## หลักฐาน
- review: มนุษย์รับ diff แทน reviewer หลังการ escalate (finding ที่เหลือเป็นเชิงมาตรฐาน)
- verify: 3/6 ข้อ → ผ่าน
- gates: test: ผ่าน   (server รันเอง)

## Acceptance criteria
- [x] `npm test` passes, and `tests/server.test.js` contains new cases for: two sessions of one agent in a day's log, repeated running totals for one session, a log containing malformed lines, and an empty log — `npm test` 66/66 ผ่าน, มีเทสใหม่ครบทั้ง 4 กรณีใน `tests/server.test.js`
- [ ] `npm run dev:all` against this repo, let the manager take a turn, then stop the server with Ctrl+C and start it again: the figure the scene shows after reconnecting is at least what it was before the restart — server ของ diff นี้เข้าถึงจากเบราว์เซอร์ไม่ได้ (พอร์ต 5181 ถูกจองโดย server กลาง)
- [ ] Taking another manager turn after that restart increases the figure from the restored value rather than from zero — เหตุผลเดียวกัน บวกต้องมี manager turn จริงผ่าน Claude API
- [ ] Reloading the browser tab without restarting the server leaves the figure unchanged — server ที่เข้าถึงได้จริงยังเป็น main branch ไม่ได้รันโค้ด diff นี้ ตัวเลขที่เห็นคือ $0.00 ทั้งก่อนและหลัง reload จึงสรุปอะไรไม่ได้
- [x] `server/state/<project>.json` holds a per-member map after a turn, and a state file from before this change (single `costUsd`) still loads without error — legacy state file โหลดไม่พัง, และหลัง "turn" จำลองได้ map ต่อ session พร้อม replace-not-sum ถูกต้อง
- [x] Deleting today's log file and restarting starts the day's figure at zero without error — unit test + readLog บนไฟล์ที่หาย + wiring ใน activate() ยืนยันว่าเริ่มที่ศูนย์โดยไม่ error

## ค้าง / ข้อสังเกต
- ไม่มี

## Diff
- .../cost-readout/issues/03/verify/01-npm-test.txt  | 263 +++++++++++++++++++++
- .scratch/cost-readout/issues/03/verify/README.md   |  81 +++++++
- CLAUDE.md                                          |   3 +-
- CONTEXT.md                                         |   6 +
- index.html                                         |   1 +
- server/costs.mjs                                   |  48 ++++
- server/flow.mjs                                    |  14 +-
- server/index.mjs                                   |  40 +++-
- server/office.mjs                                  |   9 +
- server/pipeline.mjs                                |   3 +-
- server/runner.mjs                                  |  22 +-
- server/state.mjs                                   |  24 +-
- src/agents.css                                     |   5 +-
- src/agents/director.js                             |  42 +++-
- src/agents/events.js                               |   2 +-
- src/agents/mock.js                                 |  49 ++++
- src/agents/panel.js                                |  27 ++-
- src/main.js                                        |   4 +-
- src/styles.css                                     |   6 +-
- src/ui.js                                          |   9 +-
- tests/director.test.js                             |  81 +++++++
- tests/flow.test.js                                 |  62 ++++-
- tests/mock.test.js                                 | 130 ++++++++++
- tests/server.test.js                               |  92 ++++++-
- 24 files changed, 974 insertions(+), 49 deletions(-)
