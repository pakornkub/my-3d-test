// mock.js -- a scripted driver that emits the same events the server will, so the scene,
// the panel and the Director can be built and demoed without calling Claude.
//
// The script is a flat list of steps: an event, a wait, or an ask that blocks until the
// scene answers (or, in auto mode, answers itself after a beat). A driver is anything with
// { start, stop, send }; bridge.js will have the same shape for the real server.

import { make } from './events.js';

const ev = (type, fields) => ({ ev: make(type, fields) });
const wait = (s) => ({ wait: s });
const ask = (askId, kind, text, extra = {}) => ({ ask: make('flow.ask', { askId, kind, text, ...extra }) });
const toolAsk = (agent, askId, tool, summary, reason) => ({ toolAsk: make('agent.ask', { agent, askId, tool, summary, reason }) });

const PROJECT = 'my-3d-test';
const FEATURE = 'agent-office';

// The published GitHub Pages build has no server, so the mock supplies the same shape the
// server would: a `hello` snapshot with a daily-budget-usd, and session.cost events with a
// session id as the flow plays. The fake budget is tuned so the team figure crosses into the
// warning band partway through ticket 03/04 and stays there -- never reaching "over" -- so a
// visitor actually sees the colour change rather than a demo that ends before it fires.
const FAKE_BUDGET_USD = 2;
const cost = (agent, session, usd) => ev('session.cost', { agent, session, usd });

const CHECKLIST = (states) => [
  { n: 1, title: 'บอก repo และ branch หลัก', detail: 'D:\\Claude\\my-3d-test · main' },
  { n: 2, title: 'ตรวจ toolchain', detail: 'npm ci ผ่าน · vite 8 · test: node --test' },
  { n: 3, title: 'ยืนยันคำสั่งและพอร์ต', detail: 'dev :5180 · บันทึก docs/agents/office.md' },
  { n: 4, title: 'CLAUDE.md', detail: 'มีอยู่แล้ว' },
  { n: 5, title: '/setup-matt-pocock-skills', detail: 'tracker: local markdown (.scratch/)' },
  { n: 6, title: 'Secrets (/wizard)', detail: 'โปรเจกต์นี้ไม่ใช้' },
  { n: 7, title: 'นโยบาย', detail: 'verify: scripted · งบ $10/วัน' },
  { n: 8, title: 'ซ้อม worktree', detail: 'install + test + dev server ผ่าน' },
].map((s, i) => ({ ...s, state: states[i] }));

const TICKETS = [
  { id: '01', title: 'สัญญา event และตัวตรวจ schema', blockedBy: [], delivers: 'ทุก event ที่ยิงเข้าฉากถูกตรวจ และ event ผิดถูกทิ้งพร้อม log' },
  { id: '02', title: 'ป้ายลอยเหนือหัวตัวละคร', blockedBy: [], delivers: 'ตัวละครพูดผ่าน bubble ภาษาไทยที่ตามตัวไปทุกที่' },
  { id: '03', title: 'Director: event → เดิน/นั่ง', blockedBy: ['01', '02'], delivers: 'agent.start ทำให้คนเดินไปนั่งโต๊ะตัวเอง' },
  { id: '04', title: 'บอร์ด ticket ในแผง', blockedBy: ['01'], delivers: 'เห็น frontier เรืองแสงและใบเลื่อนคอลัมน์เอง' },
  { id: '05', title: 'mock เล่น flow ครบ', blockedBy: ['03', '04'], delivers: 'กดปุ่มเดียวแล้วดูทีมทำงานจนจบ' },
];

const withStatus = (patch) => TICKETS.map((t) => ({ ...t, status: 'ready', ...(patch[t.id] ?? {}) }));

const REPORT_01 = `# ปิดใบ 01: สัญญา event และตัวตรวจ schema
ผู้ทำ: eng_m1 · worktree: ticket/01-events · เวลา: 11 นาที · ค่าใช้จ่าย: $0.31

## ทำอะไร
- ทุก event มี v, t, type และฟิลด์บังคับต่อชนิด
- event ที่ผิด schema ถูกทิ้งพร้อม console.warn ไม่ทำให้ฉากค้าง

## หลักฐาน
- review: Standards 1 ข้อ (แก้แล้ว) · Spec ครบ
- verify: 3/3 ข้อ · screenshot: .scratch/agent-office/issues/01/verify/*.png
- tests: 9 passed, 0 failed · typecheck ผ่าน   (server รันเอง)

## Acceptance criteria
- [x] event ที่ขาดฟิลด์ถูกปฏิเสธ
- [x] frontier คำนวณจาก blockedBy ถูกต้อง
- [x] มี test ครอบทั้งสองข้อ

## ค้าง / ข้อสังเกต
- ไม่มี

## Diff
- src/agents/events.js +84 · tests/events.test.js +41 · 2 files changed`;

const REPORT_FEATURE = `# รายงานปิดงาน: agent-office
โปรเจกต์: my-3d-test · branch: feature/agent-office · tickets: 4/5 · ค่าใช้จ่ายรวม: $2.90

## 1. ขอมาว่าอะไร
ให้ตัวละครในออฟฟิศ 3D สะท้อนการทำงานของทีม agent จริง โดยฉากรับ event
จาก server และมนุษย์สั่งงานผ่านผู้จัดการ

## 2. ได้อะไร
| user story | สถานะ | หลักฐาน |
| 1. เห็นว่าใครกำลังทำอะไรจากในฉาก | เสร็จ | ใบ 02, 03 |
| 2. เห็นบอร์ดงานและ frontier | เสร็จ | ใบ 04 |
| 3. กดปุ่มเดียวแล้วดู flow ครบ | เลื่อน | ใบ 05 รอคนตัดสินใจเรื่อง speed |

## 3. Tickets
| 01 | สัญญา event | eng_m1 | ผ่าน | 3/3 | ✓ |
| 02 | ป้ายเหนือหัว | eng_f1 | รอบ 2 ผ่าน | 4/4 | ✓ |
| 03 | Director | eng_m2 | — | — | ต้องให้คน |
| 04 | บอร์ด | eng_m1 | ผ่าน | 2/2 | ✓ |

## 4. ตัดสินใจระหว่างทาง
- ADR-0001 ใช้ CSS2DRenderer แทน sprite สำหรับข้อความไทย
- สมมติฐานที่ตัดสินเอง: bubble ยาวสุด 110 ตัวอักษร (ไม่ได้ถามคุณ)

## 5. ของที่เหลือ
- ใบ 03 ค้างสองรอบ: nav.findPath คืน null เมื่อ approach อยู่ในเก้าอี้ ต้องให้คนดู
- ข้อเสนอถัดไป: bridge.js ต่อ server จริง

## 6. Diff รวมและการรวมโค้ด
- 9 files changed, +612 −14
- สถานะ: รอคุณกด merge

## 7. ค่าใช้จ่าย
| manager | 1 session | 41k tokens | $0.95 |
| eng_m1 | 2 sessions | 38k | $0.62 |
| eng_f1 | 2 sessions | 44k | $0.71 |
| eng_m2 | 2 sessions | 29k | $0.40 |
| eng_f2 | 4 sessions | 18k | $0.14 |
| eng_m3 | 3 sessions | 12k | $0.08 |`;

/** The full demo, in order. Times are seconds at speed 1. */
export function demoScript(idea = 'อยากให้ตัวละครในออฟฟิศสะท้อนการทำงานของทีม agent จริง') {
  return [
    // ---- connection snapshot: the same shape the server's hello() sends, so the panel has a
    // denominator without a server -- a real connection would replace this the moment one answers
    ev('hello', {
      server: 'mock', projects: [], project: null, phase: null, feature: null, team: [],
      snapshot: { dailyBudgetUsd: FAKE_BUDGET_USD, tickets: [] },
    }),

    // ---- onboarding: the checklist fills in step by step
    ev('project.status', { project: PROJECT, steps: CHECKLIST(['pass', 'running', 'pending', 'pending', 'pending', 'pending', 'pending', 'pending']) }),
    ev('flow.phase', { phase: 'onboard' }),
    wait(1.5),
    ev('project.status', { project: PROJECT, steps: CHECKLIST(['pass', 'pass', 'pass', 'pass', 'running', 'pending', 'pending', 'pending']) }),
    wait(1.5),
    ev('project.status', { project: PROJECT, steps: CHECKLIST(['pass', 'pass', 'pass', 'pass', 'pass', 'skip', 'pass', 'running']) }),
    wait(1.5),
    ev('project.status', { project: PROJECT, steps: CHECKLIST(['pass', 'pass', 'pass', 'pass', 'pass', 'skip', 'pass', 'pass']) }),
    ev('agent.say', { agent: 'manager', text: 'โปรเจกต์พร้อมแล้วครับ เล่าไอเดียมาได้เลย' }),
    wait(2),

    // ---- grill: manager goes to the meeting table and interviews you
    ev('agent.say', { agent: 'manager', text: `รับทราบ: "${idea}" ขอถามให้ชัดก่อนเขียนสเปกนะครับ` }),
    ev('flow.phase', { phase: 'grill', hitl: true, feature: FEATURE }),
    wait(7),
    ask('q1', 'question', 'เมื่อวิศวกรกำลังใช้เครื่องมือ (เช่นแก้ไฟล์) คุณอยากเห็นชื่อไฟล์บนหัวตัวละครเลย หรือแค่บอกว่า "กำลังแก้โค้ด"?'),
    wait(1.5),
    ev('docs.update', { path: 'CONTEXT.md', kind: 'glossary', content: '# Glossary\n\n- **ticket**: งานหนึ่งใบที่ตัดผ่านทุก layer ทำจบใน session เดียว\n- **frontier**: ticket ที่ blocker เสร็จหมดและยังไม่มีคนหยิบ\n- **bubble**: ป้ายข้อความเหนือหัวตัวละคร แสดงสิ่งที่ agent ทำอยู่\n- **verify**: การเปิดของจริงตรวจตาม acceptance criteria โดย QA' }),
    cost('manager', 'manager:plan', 0.04),
    wait(2),
    ask('q2', 'question', 'ถ้า reviewer ส่งงานกลับ ให้วิศวกรคนเดิมแก้ต่อ หรือหยิบคนที่ว่างมาแก้แทน?'),
    wait(1.5),
    ev('docs.update', { path: 'docs/adr/0001-css2d-bubbles.md', kind: 'ADR', content: '# ADR-0001: ป้ายเหนือหัวใช้ CSS2DRenderer\n\n## บริบท\nข้อความไทยบน sprite texture เบลอเมื่อ zoom และ wrap ไม่ได้\n\n## การตัดสินใจ\nใช้ CSS2DRenderer (DOM) วางเหนือ canvas หลัก\n\n## ผลที่ตามมา\n+ ฟอนต์ไทยคม stylesheet คุมได้\n− ป้ายไม่ถูกบังโดยวัตถุ 3D ต้องซ่อนเองเมื่อจำเป็น' }),
    cost('manager', 'manager:plan', 0.09),
    wait(2),
    ask('q3', 'question', 'ข้อสุดท้าย: ticket ที่ค้างเกินสองรอบ ให้หยุดรอคุณ หรือให้ผู้จัดการตัดสินใจข้ามไปก่อน?'),
    cost('manager', 'manager:plan', 0.15),
    wait(1),

    // ---- spec
    ev('flow.phase', { phase: 'spec', feature: FEATURE }),
    wait(5),
    ev('agent.tool', { agent: 'manager', tool: 'Read', summary: 'src/crew.js, src/hotspots.js' }),
    wait(3),
    ev('agent.tool', { agent: 'manager', tool: 'Write', summary: '.scratch/agent-office/spec.md' }),
    cost('manager', 'manager:plan', 0.20),
    wait(2),
    ask('seams', 'seams', 'seam ที่จะเทสต์: (1) Director รับ event → เรียก crew (fake crew) (2) events.validate ตรงตามนี้ไหมครับ?'),
    ev('docs.update', { path: '.scratch/agent-office/spec.md', kind: 'spec', content: '## Problem Statement\nมนุษย์มองไม่เห็นว่า agent แต่ละตัวกำลังทำอะไร ต้องอ่าน log\n\n## Solution\nฉาก 3D รับ event แล้วแสดงเป็นการเดิน นั่ง และ bubble\n\n## User Stories\n1. ในฐานะผู้จัดการ ฉันอยากเห็นว่าใครกำลังทำอะไร\n2. ...\n\n## Implementation Decisions\n- Director แยกจาก three.js ทดสอบด้วย fake crew\n\n## Testing Decisions\n- test ที่ seam: Director + events.validate\n\n## Out of Scope\n- การเชื่อม server จริง' }),
    ev('board.update', { tickets: [{ id: 'SPEC', title: 'spec: agent-office', blockedBy: [], status: 'done', delivers: 'ready-for-agent' }] }),
    wait(2),

    // ---- tickets: you approve the breakdown
    ev('flow.phase', { phase: 'tickets', feature: FEATURE }),
    wait(6),
    ask('breakdown', 'tickets', 'เสนอแตกเป็น 5 ใบแบบ tracer bullet หยาบไป ละเอียดไป หรือ blocker ผิดตรงไหนไหมครับ?', { tickets: TICKETS }),
    wait(1),
    ev('board.update', { tickets: withStatus({ '03': { status: 'blocked' }, '05': { status: 'blocked' } }) }),
    ev('agent.say', { agent: 'manager', text: 'ติดบอร์ดแล้ว 5 ใบ ใบ 01, 02, 04 เริ่มได้ทันที' }),
    cost('manager', 'manager:plan', 0.25),
    wait(2),

    // ---- implement: two in parallel
    ev('flow.phase', { phase: 'implement', feature: FEATURE }),
    wait(2),
    ev('board.update', { tickets: withStatus({ '01': { status: 'in-progress', assignee: 'eng_m1' }, '02': { status: 'in-progress', assignee: 'eng_f1' }, '03': { status: 'blocked' }, '05': { status: 'blocked' } }) }),
    ev('agent.start', { agent: 'eng_m1', ticket: '01', brief: 'สัญญา event และตัวตรวจ schema', mode: 'implement' }),
    wait(1.5),
    ev('agent.start', { agent: 'eng_f1', ticket: '02', brief: 'ป้ายลอยเหนือหัวตัวละคร', mode: 'implement' }),
    wait(7),
    ev('agent.tool', { agent: 'eng_m1', tool: 'Read', summary: 'CONTEXT.md, spec.md' }),
    cost('eng_m1', 'eng_m1:01', 0.05),
    ev('agent.tool', { agent: 'eng_f1', tool: 'Read', summary: 'src/characters.js' }),
    cost('eng_f1', 'eng_f1:02', 0.06),
    wait(3),
    ev('agent.tool', { agent: 'eng_m1', tool: 'Write', summary: 'tests/events.test.js (แดง)' }),
    cost('eng_m1', 'eng_m1:01', 0.12),
    wait(3),
    ev('agent.tool', { agent: 'eng_f1', tool: 'Write', summary: 'src/agents/bubbles.js' }),
    cost('eng_f1', 'eng_f1:02', 0.15),
    ev('agent.tool', { agent: 'eng_m1', tool: 'Edit', summary: 'src/agents/events.js (+84)' }),
    cost('eng_m1', 'eng_m1:01', 0.22),
    wait(3),
    ev('agent.tool', { agent: 'eng_m1', tool: 'Bash', summary: 'node --test → 9 passed (เขียว)' }),
    cost('eng_m1', 'eng_m1:01', 0.31),
    wait(2),
    ev('agent.done', { agent: 'eng_m1', ticket: '01', result: 'done', summary: 'validate + frontier พร้อม test 9 ข้อ' }),
    ev('gate.result', { agent: 'eng_m1', ticket: '01', gate: 'test', pass: true, output: '9 passed, 0 failed' }),
    ev('board.update', { tickets: withStatus({ '01': { status: 'review', assignee: 'eng_m1' }, '02': { status: 'in-progress', assignee: 'eng_f1' }, '03': { status: 'blocked' }, '05': { status: 'blocked' } }) }),
    wait(2),
    ev('agent.start', { agent: 'eng_f2', ticket: '01', brief: 'รีวิว diff ใบ 01', mode: 'review' }),
    wait(6),
    ev('agent.tool', { agent: 'eng_f2', tool: 'Bash', summary: 'git diff main...ticket/01-events' }),
    cost('eng_f2', 'eng_f2:01', 0.03),
    wait(3),
    cost('eng_f2', 'eng_f2:01', 0.05),
    ev('review.result', { agent: 'eng_f2', ticket: '01', assignee: 'eng_m1', standards: ['Mysterious Name: errs → problems'], spec: [], verdict: 'pass' }),
    ev('board.update', { tickets: withStatus({ '01': { status: 'verify', assignee: 'eng_m1' }, '02': { status: 'in-progress', assignee: 'eng_f1' }, '03': { status: 'blocked' }, '05': { status: 'blocked' } }) }),
    wait(2),
    ev('agent.start', { agent: 'eng_m3', ticket: '01', brief: 'ตรวจรับใบ 01 ตาม criteria 3 ข้อ', mode: 'verify' }),
    wait(8),
    ev('agent.tool', { agent: 'eng_m3', tool: 'Bash', summary: 'node --test tests/events.test.js' }),
    cost('eng_m3', 'eng_m3:01', 0.04),
    wait(3),
    cost('eng_m3', 'eng_m3:01', 0.07),
    ev('verify.result', { agent: 'eng_m3', ticket: '01', assignee: 'eng_m1', verdict: 'pass', criteria: [
      { text: 'event ที่ขาดฟิลด์ถูกปฏิเสธ', pass: true },
      { text: 'frontier คำนวณจาก blockedBy ถูกต้อง', pass: true },
      { text: 'มี test ครอบทั้งสองข้อ', pass: true },
    ] }),
    wait(2),
    ev('ticket.closed', { ticket: '01', assignee: 'eng_m1', report: REPORT_01 }),
    ev('board.update', { tickets: withStatus({ '01': { status: 'done' }, '02': { status: 'in-progress', assignee: 'eng_f1' }, '03': { status: 'blocked' }, '05': { status: 'blocked' } }) }),
    wait(3),

    // ---- ticket 02: review fails once, second round passes
    ev('agent.tool', { agent: 'eng_f1', tool: 'Bash', summary: 'npx vite build → ok' }),
    cost('eng_f1', 'eng_f1:02', 0.24),
    wait(2),
    ev('agent.done', { agent: 'eng_f1', ticket: '02', result: 'done', summary: 'CSS2DObject ต่อคน ตาม ADR-0001' }),
    ev('gate.result', { agent: 'eng_f1', ticket: '02', gate: 'typecheck', pass: true, output: 'ok' }),
    ev('board.update', { tickets: withStatus({ '01': { status: 'done' }, '02': { status: 'review', assignee: 'eng_f1' }, '03': { status: 'blocked' }, '05': { status: 'blocked' } }) }),
    wait(2),
    ev('agent.start', { agent: 'eng_f2', ticket: '02', brief: 'รีวิว diff ใบ 02', mode: 'review' }),
    cost('eng_f2', 'eng_f2:02', 0.04),
    wait(6),
    ev('review.result', { agent: 'eng_f2', ticket: '02', assignee: 'eng_f1', standards: ['Duplicated Code: resize() ซ้ำกับ scene.js'], spec: ['ป้ายไม่หายเมื่อ ttl หมด (spec ข้อ 4)'], verdict: 'fail' }),
    ev('board.update', { tickets: withStatus({ '01': { status: 'done' }, '02': { status: 'in-progress', assignee: 'eng_f1', attempt: 2 }, '03': { status: 'blocked' }, '05': { status: 'blocked' } }) }),
    wait(6),
    ev('agent.tool', { agent: 'eng_f1', tool: 'Edit', summary: 'src/agents/bubbles.js: ttl ใน update()' }),
    cost('eng_f1', 'eng_f1:02', 0.33),
    wait(3),
    cost('eng_f1', 'eng_f1:02', 0.42),
    ev('agent.done', { agent: 'eng_f1', ticket: '02', result: 'done', summary: 'แก้ตามรีวิว 2 ข้อ' }),
    ev('board.update', { tickets: withStatus({ '01': { status: 'done' }, '02': { status: 'review', assignee: 'eng_f1', attempt: 2 }, '03': { status: 'blocked' }, '05': { status: 'blocked' } }) }),
    wait(2),
    ev('agent.start', { agent: 'eng_f2', ticket: '02', brief: 'รีวิวรอบ 2 ใบ 02', mode: 'review' }),
    cost('eng_f2', 'eng_f2:02', 0.08),
    wait(5),
    cost('eng_f2', 'eng_f2:02', 0.13),
    ev('review.result', { agent: 'eng_f2', ticket: '02', assignee: 'eng_f1', standards: [], spec: [], verdict: 'pass' }),
    ev('board.update', { tickets: withStatus({ '01': { status: 'done' }, '02': { status: 'verify', assignee: 'eng_f1', attempt: 2 }, '03': { status: 'blocked' }, '05': { status: 'blocked' } }) }),
    wait(1),
    ev('agent.start', { agent: 'eng_m3', ticket: '02', brief: 'ตรวจรับใบ 02', mode: 'verify' }),
    cost('eng_m3', 'eng_m3:02', 0.05),
    wait(7),
    cost('eng_m3', 'eng_m3:02', 0.09),
    ev('verify.result', { agent: 'eng_m3', ticket: '02', assignee: 'eng_f1', verdict: 'pass', criteria: [
      { text: 'ข้อความไทยอ่านออกที่ zoom ปกติ', pass: true },
      { text: 'ป้ายตามตัวละครขณะเดิน', pass: true },
      { text: 'ป้ายหายเมื่อ ttl หมด', pass: true },
      { text: 'ไม่มี error ใน console', pass: true },
    ] }),
    wait(2),
    ev('ticket.closed', { ticket: '02', assignee: 'eng_f1', report: REPORT_01.replace('01: สัญญา event และตัวตรวจ schema', '02: ป้ายลอยเหนือหัวตัวละคร').replace('eng_m1', 'eng_f1') }),
    ev('board.update', { tickets: withStatus({ '01': { status: 'done' }, '02': { status: 'done' }, '04': { status: 'ready' } }) }),
    wait(3),

    // ---- ticket 03 (now unblocked) + 04 in parallel; 03 asks for approval, then stalls and escalates
    ev('board.update', { tickets: withStatus({ '01': { status: 'done' }, '02': { status: 'done' }, '03': { status: 'in-progress', assignee: 'eng_m2' }, '04': { status: 'in-progress', assignee: 'eng_m1' }, '05': { status: 'blocked' } }) }),
    ev('agent.start', { agent: 'eng_m2', ticket: '03', brief: 'Director: event → เดิน/นั่ง', mode: 'implement' }),
    wait(1.5),
    ev('agent.start', { agent: 'eng_m1', ticket: '04', brief: 'บอร์ด ticket ในแผง', mode: 'implement' }),
    wait(7),
    ev('agent.tool', { agent: 'eng_m2', tool: 'Read', summary: 'src/nav.js, src/crew.js' }),
    cost('eng_m2', 'eng_m2:03', 0.08),
    ev('agent.tool', { agent: 'eng_m1', tool: 'Write', summary: 'src/agents/panel.js' }),
    cost('eng_m1', 'eng_m1:04', 0.06),
    wait(4),
    toolAsk('eng_m2', 'push1', 'Bash', 'git push origin ticket/03-director', 'push อยู่นอก allowlist ของโปรเจกต์'),
    wait(4),
    ev('agent.tool', { agent: 'eng_m2', tool: 'Bash', summary: 'node --test → 2 failed' }),
    cost('eng_m2', 'eng_m2:03', 0.16),
    wait(3),
    ev('agent.stalled', { agent: 'eng_m2', ticket: '03', minutes: 6 }),
    wait(4),
    ev('agent.retry', { agent: 'eng_m2', ticket: '03', attempt: 2, note: 'รอบก่อนวนแก้ nav.findPath ไม่จบ ให้เริ่มจาก test ที่ fail' }),
    cost('eng_m2', 'eng_m2:03', 0.24),
    ev('board.update', { tickets: withStatus({ '01': { status: 'done' }, '02': { status: 'done' }, '03': { status: 'in-progress', assignee: 'eng_m2', attempt: 2 }, '04': { status: 'in-progress', assignee: 'eng_m1' }, '05': { status: 'blocked' } }) }),
    cost('eng_m1', 'eng_m1:04', 0.15),
    wait(6),
    ev('agent.done', { agent: 'eng_m1', ticket: '04', result: 'done', summary: 'kanban 7 คอลัมน์ frontier เรืองแสง' }),
    cost('eng_m1', 'eng_m1:04', 0.24),
    ev('gate.result', { agent: 'eng_m1', ticket: '04', gate: 'test', pass: true, output: '4 passed' }),
    ev('board.update', { tickets: withStatus({ '01': { status: 'done' }, '02': { status: 'done' }, '03': { status: 'in-progress', assignee: 'eng_m2', attempt: 2 }, '04': { status: 'review', assignee: 'eng_m1' }, '05': { status: 'blocked' } }) }),
    wait(2),
    ev('agent.tool', { agent: 'eng_m2', tool: 'Bash', summary: 'node --test → 2 failed (เดิม)' }),
    cost('eng_m2', 'eng_m2:03', 0.30),
    wait(3),
    ev('agent.stalled', { agent: 'eng_m2', ticket: '03', minutes: 5 }),
    wait(3),
    ev('agent.done', { agent: 'eng_m2', ticket: '03', result: 'blocked', summary: 'approach ของ MC2 อยู่ในเก้าอี้ findPath คืน null ต้องตัดสินใจเรื่อง repairApproaches' }),
    ev('ticket.escalated', { ticket: '03', reason: 'ค้าง 2 รอบ: approach ของ MC2 อยู่ในเก้าอี้ ต้องให้คนตัดสินใจ' }),
    ev('board.update', { tickets: withStatus({ '01': { status: 'done' }, '02': { status: 'done' }, '03': { status: 'needs-human', assignee: 'eng_m2', attempt: 2 }, '04': { status: 'review', assignee: 'eng_m1' }, '05': { status: 'blocked' } }) }),
    wait(3),
    ev('agent.start', { agent: 'eng_f2', ticket: '04', brief: 'รีวิว diff ใบ 04', mode: 'review' }),
    cost('eng_f2', 'eng_f2:04', 0.03),
    wait(5),
    cost('eng_f2', 'eng_f2:04', 0.06),
    ev('review.result', { agent: 'eng_f2', ticket: '04', assignee: 'eng_m1', standards: [], spec: [], verdict: 'pass' }),
    ev('board.update', { tickets: withStatus({ '01': { status: 'done' }, '02': { status: 'done' }, '03': { status: 'needs-human', assignee: 'eng_m2', attempt: 2 }, '04': { status: 'verify', assignee: 'eng_m1' }, '05': { status: 'blocked' } }) }),
    wait(1),
    ev('agent.start', { agent: 'eng_m3', ticket: '04', brief: 'ตรวจรับใบ 04', mode: 'verify' }),
    cost('eng_m3', 'eng_m3:04', 0.03),
    wait(7),
    cost('eng_m3', 'eng_m3:04', 0.06),
    ev('verify.result', { agent: 'eng_m3', ticket: '04', assignee: 'eng_m1', verdict: 'pass', criteria: [
      { text: 'frontier เรืองแสง', pass: true },
      { text: 'ใบเลื่อนคอลัมน์เมื่อ board.update', pass: true },
    ] }),
    wait(2),
    ev('ticket.closed', { ticket: '04', assignee: 'eng_m1', report: REPORT_01.replace('01: สัญญา event และตัวตรวจ schema', '04: บอร์ด ticket ในแผง') }),
    ev('board.update', { tickets: withStatus({ '01': { status: 'done' }, '02': { status: 'done' }, '03': { status: 'needs-human', assignee: 'eng_m2', attempt: 2 }, '04': { status: 'done' }, '05': { status: 'blocked' } }) }),
    wait(3),

    // ---- feature report: manager at the TV, everyone gathers
    ev('feature.report', { feature: FEATURE, report: REPORT_FEATURE }),
    ev('ci.status', { pr: 'https://github.com/pakornkub/my-3d-test/pull/12', state: 'success' }),
    wait(12),
    ev('flow.phase', { phase: 'done', feature: FEATURE }),
    ev('agent.say', { agent: 'manager', text: 'จบรอบสาธิต กด "เล่นตัวอย่าง" อีกครั้งได้ หรือต่อ server จริงในเฟส 1' }),
  ];
}

/** Turn a recorded event log back into a script that replays with the original pacing. */
export function replayScript(events, { maxGap = 8 } = {}) {
  const out = [];
  let prev = null;
  for (const e of events) {
    if (prev != null) out.push(wait(Math.min(maxGap, Math.max(0, (e.t - prev) / 1000))));
    if (e.type === 'flow.ask') out.push({ ask: e });
    else if (e.type === 'agent.ask') out.push({ toolAsk: e });
    else out.push({ ev: e });
    prev = e.t;
  }
  return out;
}

export class MockDriver {
  /**
   * @param emit   (event) => void   -- into the Director
   * @param opts   { speed, auto, onState, autoDelay }
   */
  constructor({ emit, speed = 1, auto = true, autoDelay = 2.5, onState = () => {} }) {
    this.emit = emit;
    this.speed = speed;
    this.auto = auto;
    this.autoDelay = autoDelay;
    this.onState = onState;
    this.running = false;
    this.waiting = null;      // { askId, resolve }
    this.timer = 0;
    this.gen = 0;
  }

  start(script) {
    this.stop();
    this.running = true;
    this.onState(true);
    const gen = ++this.gen;
    this.#run(script, gen).finally(() => {
      if (gen === this.gen) { this.running = false; this.onState(false); }
    });
  }

  stop() {
    this.gen++;
    clearTimeout(this.timer);
    if (this.waiting) { this.waiting.resolve({ cancelled: true }); this.waiting = null; }
    if (this.running) { this.running = false; this.onState(false); }
  }

  /** Scene → driver. The mock only cares about answers; commands start a demo. */
  send(msg) {
    if ((msg.type === 'flow.answer' || msg.type === 'answer') && this.waiting?.askId === msg.askId) {
      const w = this.waiting;
      this.waiting = null;
      clearTimeout(this.timer);
      w.resolve(msg);
      return true;
    }
    if (msg.type === 'command' && !this.running) {
      this.start(demoScript(msg.text));
      return true;
    }
    if (msg.type === 'cancel') { this.stop(); return true; }
    return false;
  }

  #sleep(s) {
    return new Promise((res) => { this.timer = setTimeout(res, (s * 1000) / this.speed); });
  }

  #askAndWait(event, autoAnswer) {
    this.emit(event);
    return new Promise((resolve) => {
      this.waiting = { askId: event.askId, resolve };
      if (this.auto) {
        this.timer = setTimeout(() => {
          if (this.waiting?.askId !== event.askId) return;
          this.waiting = null;
          resolve({ ...autoAnswer, auto: true });
        }, (this.autoDelay * 1000) / this.speed);
      }
    });
  }

  async #run(script, gen) {
    for (const step of script) {
      if (gen !== this.gen) return;
      if (step.wait != null) { await this.#sleep(step.wait); continue; }
      if (step.ev) { this.emit({ ...step.ev, t: Date.now() }); continue; }
      if (step.ask) {
        const e = { ...step.ask, t: Date.now() };
        const r = await this.#askAndWait(e, { type: 'flow.answer', askId: e.askId, text: '', approved: true });
        if (r.cancelled) return;
        this.onAnswered?.(e, r);
        continue;
      }
      if (step.toolAsk) {
        const e = { ...step.toolAsk, t: Date.now() };
        const r = await this.#askAndWait(e, { type: 'answer', askId: e.askId, allow: true });
        if (r.cancelled) return;
        this.onAnswered?.(e, r);
        continue;
      }
    }
  }
}
