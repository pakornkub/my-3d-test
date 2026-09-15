import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Flow, parseFrontierQuestions } from '../server/flow.mjs';
import { validate } from '../src/agents/events.js';
import { daySeed } from '../server/costs.mjs';
import { writeOffice, DEFAULTS } from '../server/office.mjs';

const setDailyBudget = (repo, usd) =>
  writeOffice(repo, { ...DEFAULTS, policy: { ...DEFAULTS.policy, 'daily-budget-usd': String(usd) } });

// an empty repo per test: a real .scratch/ would start an fs.watch and keep the runner alive
const emptyRepo = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ube-flow-'));

/** A stand-in for runner.Session: records what was sent, answers with canned text. */
function fakeSession(script = {}) {
  return {
    sent: [], init: { slash_commands: script.commands ?? [] }, closed: false, sessionId: 'sess-1',
    costUsd: 0.5, lastText: '',
    hasCommand(name) { return this.init.slash_commands.includes(name); },
    async start() {},
    async send(text) { this.sent.push(text); this.lastText = script.reply?.(text) ?? 'ถามกลับ: อยากได้แบบไหน?'; return { type: 'result', subtype: 'success' }; },
    async interrupt() {}, close() { this.closed = true; },
  };
}

function setup({ phase = 'implement', feature = null, commands, reply } = {}) {
  const events = [];
  const s = fakeSession({ commands, reply });
  const state = { phase, feature, managerSessionId: null, runningTotals: {} };
  const flow = new Flow({
    project: { id: 'p', path: emptyRepo(), mainBranch: 'main' },
    state, team: { manager: { prompt: 'คุณคือผู้จัดการ', model: 'claude-opus-5', tools: [] } },
    office: null, emit: (e) => events.push(e), approvals: null, save: () => {}, createSession: () => s,
  });
  return { flow, s, state, events, types: () => events.map((e) => e.type) };
}

test('an idea while idle starts the interview: phase grill, grill skill sent, question surfaced as flow.ask', async () => {
  const { flow, s, state, events } = setup();
  await flow.onCommand('อยากได้ X');
  assert.equal(state.phase, 'grill');
  assert.equal(s.sent.length, 1);
  assert.match(s.sent[0], /grilling|grill-with-docs/);
  assert.match(s.sent[0], /อยากได้ X/);
  const ask = events.find((e) => e.type === 'flow.ask');
  assert.ok(ask, 'flow.ask emitted');
  assert.equal(ask.kind, 'question');
  assert.match(ask.text, /อยากได้แบบไหน/);
  assert.equal(state.managerSessionId, 'sess-1');
});

test('a registered slash command is preferred over inlining the skill body', async () => {
  const { flow, s } = setup({ commands: ['/mattpocock-skills:grill-with-docs'] });
  await flow.onCommand('idea');
  assert.equal(s.sent[0], '/mattpocock-skills:grill-with-docs idea');
});

test('answering a flow.ask sends the text back as the next turn; an empty answer becomes an OK', async () => {
  const { flow, s, events } = setup({ phase: 'grill', feature: 'f' });
  await flow.onFlowAnswer('x', { text: 'เอาแบบ A' });
  assert.equal(s.sent.at(-1), 'เอาแบบ A');
  await flow.onFlowAnswer('y', { text: '', approved: true });
  assert.match(s.sent.at(-1), /โอเค/);
  assert.equal(events.filter((e) => e.type === 'flow.ask').length, 2);
});

test('settleIfMerged closes a finished feature only when every ticket is done and the branch is in main', () => {
  const { flow, state, types } = setup({ phase: 'implement', feature: 'f' });
  const issues = path.join(flow.repo, '.scratch', 'f', 'issues');
  fs.mkdirSync(issues, { recursive: true });
  fs.writeFileSync(path.join(issues, '01-a.md'), '# 01: A\n**Status:** done\n');
  fs.writeFileSync(path.join(issues, '02-b.md'), '# 02: B\n**Status:** in-progress\n');
  assert.equal(flow.settleIfMerged(() => true), false, 'an open ticket keeps the feature alive');
  fs.writeFileSync(path.join(issues, '02-b.md'), '# 02: B\n**Status:** done\n');
  assert.equal(flow.settleIfMerged(() => false), false, 'done tickets but the branch is not in main yet');
  assert.equal(state.phase, 'implement');
  assert.equal(flow.settleIfMerged(() => true), true);
  assert.equal(state.phase, 'done');
  assert.ok(types().includes('flow.phase'));
  assert.equal(flow.settleIfMerged(() => true), false, 'idempotent once done');
});

test('next: spec then tickets advance the phase in order and refuse to go backwards', async () => {
  const { flow, s, state, events } = setup({ phase: 'grill', feature: 'f' });
  await flow.onNext('spec');
  assert.equal(state.phase, 'spec');
  assert.match(s.sent.at(-1), /to-spec|Problem Statement/);
  assert.equal(events.filter((e) => e.type === 'flow.ask').at(-1).kind, 'seams');
  await flow.onNext('tickets');
  assert.equal(state.phase, 'tickets');
  assert.match(s.sent.at(-1), /to-tickets|tracer/i);
  const n = s.sent.length;
  await flow.onNext('grill');   // allowed: re-open the interview
  assert.equal(state.phase, 'grill');
  await flow.onNext('spec');    // forward again is fine
  assert.equal(state.phase, 'spec');
  await flow.onNext('grill');
  await flow.onNext('onboard'); // backwards to onboard is refused
  assert.equal(state.phase, 'grill');
  assert.ok(s.sent.length >= n);
});

test('the manager session is seeded from its own prior running total, filed under the plain agent id before any session id is known (legacy, ADR-0001)', async () => {
  const s = fakeSession();
  let seenSeed;
  const state = { phase: 'implement', feature: null, managerSessionId: null, runningTotals: { manager: { agent: 'manager', usd: 2 } } };
  const flow = new Flow({
    project: { id: 'p', path: emptyRepo(), mainBranch: 'main' },
    state, team: { manager: { prompt: 'คุณคือผู้จัดการ', model: 'claude-opus-5', tools: [] } },
    office: null, emit: () => {}, approvals: null, save: () => {},
    createSession: (opts) => { seenSeed = opts.costSeed; return s; },
  });
  await flow.onCommand('อยากได้ X');
  assert.equal(seenSeed, 2);          // the restart-safe seed reached the new session
});

test('the seed is still found once a session.cost event carries `session` (ADR-0002), not just by the literal agent id', async () => {
  // stands in for a boot-time reseed from a log written after the runner starts tagging
  // session.cost events with `session` -- the manager's entry moves off the 'manager' key
  // onto its SDK session id, and the seed lookup must follow it there. Building the fixture
  // through the real day-seed function (rather than a hand-rolled { 'sess-1': {...} }
  // literal) keeps this test honest about daySeed's actual output shape.
  const s = fakeSession();
  let seenSeed;
  const state = {
    phase: 'implement', feature: null, managerSessionId: 'sess-1',
    runningTotals: daySeed([{ v: 1, t: Date.now(), type: 'session.cost', agent: 'manager', session: 'sess-1', usd: 7 }]),
  };
  const flow = new Flow({
    project: { id: 'p', path: emptyRepo(), mainBranch: 'main' },
    state, team: { manager: { prompt: 'คุณคือผู้จัดการ', model: 'claude-opus-5', tools: [] } },
    office: null, emit: () => {}, approvals: null, save: () => {},
    createSession: (opts) => { seenSeed = opts.costSeed; return s; },
  });
  await flow.onCommand('อยากได้ X');
  assert.equal(seenSeed, 7);          // NOT 0 -- this is the restart AC the ticket exists for
});

test('a message during onboarding is refused without touching the session', async () => {
  const { flow, s, events } = setup({ phase: 'onboard' });
  await flow.onCommand('hi');
  assert.equal(s.sent.length, 0);
  assert.match(events.at(-1).text, /onboarding/);
});

test('snapshot carries daily-budget-usd from the office file on disk', () => {
  const { flow } = setup();
  setDailyBudget(flow.repo, 5);
  assert.equal(flow.snapshot().dailyBudgetUsd, 5);
});

test('snapshot has no budget when the repo has no office file', () => {
  const { flow } = setup();
  assert.equal(flow.snapshot().dailyBudgetUsd, undefined);
});

test('editing daily-budget-usd on disk changes the next snapshot without reconstructing Flow', () => {
  const { flow } = setup();
  setDailyBudget(flow.repo, 5);
  assert.equal(flow.snapshot().dailyBudgetUsd, 5);
  setDailyBudget(flow.repo, 8);
  assert.equal(flow.snapshot().dailyBudgetUsd, 8);
});

// ---------------------------------------------------------------- frontier questions
// An ask captured from a real grill session. (Two were captured; they came out
// byte-identical, so one fixture stands for both.)
const SAMPLE = [
  "เอา to-do list app — ก่อนถามต่อ ผมตรวจของจริงมาก่อนหนึ่งอย่าง: **Office Server รองรับหลายโปรเจกต์อยู่แล้ว** (`server/projects.mjs` + `project.add` รับทั้ง path และ clone URL แล้วรัน onboarding 8 ขั้นให้เอง) ฉะนั้น \"ให้ทีมนี้ไปสร้าง to-do app ในอีก repo\" เป็นทางที่ระบบเปิดไว้แล้ว ไม่ต้องสร้างอะไรใหม่เพื่อรองรับ",
  "",
  "frontier รอบนี้มีสองข้อ",
  "",
  "❓ **Q2** — **โค้ดของ to-do app จะอยู่ที่ไหน**: อันนี้เปลี่ยนทุกอย่างที่ตามมา",
  "",
  "(ก) **repo ใหม่ ลงทะเบียนเป็นโปรเจกต์ที่สองของ Office** — ทีมเดิมทั้งหก ผู้จัดการคนเดิม แต่ไปทำงานในบ้านอีกหลัง มี `CONTEXT.md`, ADR, บอร์ดของตัวเอง ไม่ปนกับฉาก 3D",
  "(ข) **เป็นฟีเจอร์ใน `my-3d-test`** — เช่น แท็บใหม่บนแผงทีม หรือของในห้องที่คลิกแล้วเปิดรายการงาน",
  "(ค) **repo ที่คุณมีอยู่แล้ว** — บอก path มา ผมให้ onboarding วิ่งแล้วดูว่าขาดอะไร",
  "",
  "➡️ **(ก)** — repo นี้มีสัญญาไว้ชัดว่า `export/` คือ site root และ stack บางมาก (three + vite เท่านั้น) การยัด to-do app เข้าไปจะทำให้ `CONTEXT.md` ที่เพิ่งตกลงกันมีสองโดเมนในไฟล์เดียว และ reviewer จะยิง finding ใส่ทุกใบที่แตะ ถ้าแยก repo คุณจะได้ของแถมด้วย: เป็นการพิสูจน์ว่า Office จัดการโปรเจกต์ที่สองได้จริง",
  "",
  "---",
  "",
  "❓ **Q3** — **ของใช้จริงหรือของสาธิต**: สองอย่างนี้เกณฑ์ \"เสร็จ\" ไม่เหมือนกันเลย",
  "",
  "(ก) **ของใช้จริง** — คุณจะเปิดมันทุกวัน ฉะนั้นเรื่อง persistence, การกู้ข้อมูล, ใช้บนมือถือ กลายเป็นข้อบังคับ",
  "(ข) **ของสาธิต/สนามซ้อม** — เป้าหมายจริงคือทดสอบว่าทีม agent เฟส 2 ทำงานขนานกันได้ไหม to-do เป็นแค่โจทย์ที่เล็กพอจะจับตาดูได้ทั้งกระบวนการ",
  "(ค) **ทั้งสอง** — เริ่มเป็นสนามซ้อม แต่ถ้าออกมาดีก็ใช้จริง",
  "",
  "➡️ **(ข)** — ของค้างบนโต๊ะตอนนี้คือ \"ตัวเลขรายคนบน roster ยังว่างห้าคนเพราะยังไม่มี implementer session จริง\" to-do app เป็นโจทย์ขนาดพอดีที่จะดันเฟส 2 ให้เกิดโดยไม่ต้องเสี่ยงกับ repo ที่มีของจริงอยู่ ถ้าตอบ (ก) ผมจะถามเรื่อง sync/มือถือ/สำรองข้อมูลในรอบหน้าแทน",
].join('\n');

// The same convention with every decoration dropped: Latin keys, no bold, "-" as the
// separator, a detail wrapped onto the next line, and a prime on the id.
const LOOSE = [
  'สรุปก่อน: ผมอ่าน server/board.mjs มาแล้ว',
  '',
  "❓ Q7' - where does the board live: เลือกหนึ่งข้อ",
  '(a) local disk',
  '    keeps working offline',
  '(b) the server - one source of truth',
  '➡️ (b): fewer copies to reconcile',
].join('\n');

test('parseFrontierQuestions reads the manager convention: id, title, body, options, recommendation', () => {
  const p = parseFrontierQuestions(SAMPLE);
  assert.ok(p, 'the real ask parses');
  assert.match(p.intro, /^เอา to-do list app/);
  assert.match(p.intro, /frontier รอบนี้มีสองข้อ$/);
  assert.ok(!p.intro.includes('❓'), 'the intro stops at the first question');
  assert.deepEqual(p.questions.map((q) => q.id), ['Q2', 'Q3']);

  const [q2, q3] = p.questions;
  assert.equal(q2.header, 'โค้ดของ to-do app จะอยู่ที่ไหน');
  assert.equal(q2.question, 'อันนี้เปลี่ยนทุกอย่างที่ตามมา');
  assert.deepEqual(q2.options.map((o) => o.key), ['ก', 'ข', 'ค']);
  assert.equal(q2.options[0].label, 'repo ใหม่ ลงทะเบียนเป็นโปรเจกต์ที่สองของ Office');
  assert.equal(q2.options[1].label, 'เป็นฟีเจอร์ใน `my-3d-test`');
  assert.match(q2.options[0].description, /^ทีมเดิมทั้งหก/);
  assert.equal(q2.recommended, 'ก');
  assert.deepEqual(q2.options.map((o) => o.recommended), [true, false, false]);
  assert.match(q2.why, /^repo นี้มีสัญญาไว้ชัด/, 'the why keeps no leading separator');

  assert.equal(q3.header, 'ของใช้จริงหรือของสาธิต');
  assert.deepEqual(q3.options.map((o) => o.key), ['ก', 'ข', 'ค']);
  assert.equal(q3.recommended, 'ข');
  assert.deepEqual(q3.options.map((o) => o.recommended), [false, true, false]);
  assert.match(q3.why, /^ของค้างบนโต๊ะ/);
});

test('parseFrontierQuestions is tolerant: no bold, Latin keys, "-" separators, a wrapped detail', () => {
  const p = parseFrontierQuestions(LOOSE);
  assert.ok(p);
  assert.equal(p.intro, 'สรุปก่อน: ผมอ่าน server/board.mjs มาแล้ว');
  assert.equal(p.questions.length, 1);
  const q = p.questions[0];
  assert.equal(q.id, "Q7'");
  assert.equal(q.header, 'where does the board live');
  assert.equal(q.question, 'เลือกหนึ่งข้อ');
  assert.deepEqual(q.options.map((o) => o.key), ['a', 'b']);
  assert.equal(q.options[0].description, 'keeps working offline', 'a wrapped line joins the option above it');
  assert.equal(q.options[1].label, 'the server');
  assert.equal(q.options[1].description, 'one source of truth');
  assert.equal(q.recommended, 'b');
  assert.equal(q.why, 'fewer copies to reconcile');
});

test('parseFrontierQuestions reads bullet options with the key inside bold, and turns a recommendation-only question into one accept button', () => {
  // the shape the manager used in the todo-app interview, which the first parser fell back on
  const text = ['เรียก skill แล้ว', '', '---', '',
    '❓ **Q1** — **คำศัพท์หลักของ domain**: ชื่อที่จะไปอยู่ในชื่อฟังก์ชัน', '',
    '➡️ ใช้ TodoMVC canon: เอนทิตีชื่อ **Task**, ฟิลด์ `completed: boolean`', '', '---', '',
    '❓ **Q2** — **รูปร่างของโมดูล pure**: ข้อ (3) บอกว่าต้อง pure', '',
    '- **(a) ฟังก์ชันบนอาร์เรย์ immutable**: addTask(tasks, task) — state ข้างนอก',
    '- **(b) reducer ตัวเดียว**: reduce(state, action)',
    '- **(c) class ที่มี method** — ไม่ pure', '',
    '➡️ **(a)** — บางที่สุด เทสต์อ่านง่าย'].join('\n');
  const p = parseFrontierQuestions(text);
  assert.equal(p.questions.length, 2);
  const [q1, q2] = p.questions;
  assert.equal(q1.id, 'Q1');
  assert.deepEqual(q1.options.map((o) => [o.key, o.label, o.recommended]), [['✓', 'ตามที่แนะนำ', true]]);
  assert.match(q1.options[0].description, /TodoMVC canon/);
  assert.equal(q1.recommended, '✓');
  assert.deepEqual(q2.options.map((o) => o.key), ['a', 'b', 'c']);
  assert.equal(q2.options[0].label, 'ฟังก์ชันบนอาร์เรย์ immutable');
  assert.match(q2.options[0].description, /^addTask/);
  assert.equal(q2.options[2].label, 'class ที่มี method');
  assert.equal(q2.recommended, 'a');
  assert.equal(q2.why, 'บางที่สุด เทสต์อ่านง่าย');
  // a recommendation-only reply with no lettered options anywhere still becomes a widget
  assert.equal(parseFrontierQuestions('❓ **Q1** — **ชื่อ**: อะไรดี\n➡️ ใช้ Task').questions[0].recommended, '✓');
});

test('parseFrontierQuestions returns null for anything that is not a question with options', () => {
  assert.equal(parseFrontierQuestions('สรุปแล้วผมจะเริ่มจากใบ 01 ครับ ไม่มีคำถาม'), null);
  assert.equal(parseFrontierQuestions('❓ อยากได้แบบไหนครับ?'), null, 'a question with no options');
  assert.equal(parseFrontierQuestions('❓ **Q1** — **ที่เก็บ**: เลือก\n(ก) **อันเดียว** — พอ'), null, 'one option is not a choice');
  assert.equal(parseFrontierQuestions(''), null);
  assert.equal(parseFrontierQuestions(undefined), null);
});

test('a reply written as frontier questions is asked as a multiple choice; anything else stays a plain question', async () => {
  const a = setup({ phase: 'grill', feature: 'f', reply: () => SAMPLE });
  await a.flow.onCommand('ทำต่อ');
  const ask = a.events.filter((e) => e.type === 'flow.ask').at(-1);
  assert.equal(ask.kind, 'choice');
  assert.equal(ask.text, SAMPLE, 'the whole reply still travels, unchanged');
  assert.deepEqual(validate(ask), [], 'still a well-formed flow.ask');
  assert.match(ask.intro, /^เอา to-do list app/);
  assert.deepEqual(ask.questions.map((q) => q.id), ['Q2', 'Q3']);
  assert.equal(ask.questions[0].header, 'Q2 · โค้ดของ to-do app จะอยู่ที่ไหน');
  assert.equal(ask.questions[0].question, 'อันนี้เปลี่ยนทุกอย่างที่ตามมา');
  assert.deepEqual(ask.questions[0].options.map((o) => o.label), [
    '(ก) repo ใหม่ ลงทะเบียนเป็นโปรเจกต์ที่สองของ Office',
    '(ข) เป็นฟีเจอร์ใน `my-3d-test`',
    '(ค) repo ที่คุณมีอยู่แล้ว',
  ]);
  assert.equal(ask.questions[0].options[0].recommended, true);
  assert.equal(ask.questions[0].options[1].recommended, undefined, 'only the recommended one carries the flag');
  assert.match(ask.questions[0].why, /export\//);
  assert.equal(ask.questions[1].options[1].recommended, true);

  const b = setup({ phase: 'grill', feature: 'f' });   // the harness's canned prose reply
  await b.flow.onCommand('ทำต่อ');
  const plain = b.events.filter((e) => e.type === 'flow.ask').at(-1);
  assert.equal(plain.kind, 'question');
  assert.equal(plain.questions, undefined);
  assert.equal(plain.intro, undefined);
});
