import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseImplementResult, parseReviewResult, parseVerifyResult, pickImplementer, chargeJob, wasteAttempt, featureCosts, Pipeline } from '../server/pipeline.mjs';
import { ticketReport, validateReport, featureReportPrompt } from '../server/report.mjs';
import { runGates, runCommand } from '../server/gates.mjs';
import * as wt from '../server/worktree.mjs';

// ---------------------------------------------------------------- parsers
test('parseImplementResult reads RESULT/EVIDENCE/NEXT and the summary bullets', () => {
  const r = parseImplementResult('ทำเสร็จแล้ว\n- เพิ่ม field session\n- เขียน test 5 ข้อ\nRESULT: done\nEVIDENCE: node --test → 32 passed\nNEXT: none');
  assert.equal(r.result, 'done');
  assert.equal(r.evidence, 'node --test → 32 passed');
  assert.deepEqual(r.what, ['เพิ่ม field session', 'เขียน test 5 ข้อ']);
  assert.equal(parseImplementResult('RESULT: blocked\nNEXT: need DB').result, 'blocked');
  assert.equal(parseImplementResult('').result, 'blocked');
});

test('parseReviewResult splits finding lists and treats none as empty', () => {
  const r = parseReviewResult('...\nVERDICT: fail\nSTANDARDS: Duplicated Code in x; Mysterious Name y\nSPEC: missing field z');
  assert.equal(r.verdict, 'fail');
  assert.equal(r.standards.length, 2);
  assert.deepEqual(r.spec, ['missing field z']);
  assert.equal(r.byRule, undefined);
  assert.equal(parseReviewResult('no verdict line').verdict, 'fail');
});

test('parseReviewResult lets the Spec list decide: standards-only or empty fails pass by rule, a pass is never overruled', () => {
  // the two escalations of the first overnight run: `fail` above two empty lists
  const empty = parseReviewResult('VERDICT: fail\nSTANDARDS: none\nSPEC: none');
  assert.equal(empty.verdict, 'pass');
  assert.equal(empty.byRule, true);
  const advice = parseReviewResult('VERDICT: fail\nSTANDARDS: Long Function in a.js; today()/dayOf() ซ้ำกัน\nSPEC: none');
  assert.equal(advice.verdict, 'pass');
  assert.equal(advice.standards.length, 2);
  assert.equal(advice.byRule, true);
  const pass = parseReviewResult('VERDICT: pass\nSTANDARDS: none\nSPEC: nit, non-blocking');
  assert.equal(pass.verdict, 'pass');
  assert.equal(pass.byRule, undefined);
  assert.equal(parseReviewResult('VERDICT: pass\nSTANDARDS: none\nSPEC: none').byRule, undefined);
});

test('parseVerifyResult maps CRITERION lines onto the ticket criteria in order', () => {
  const criteria = [{ text: 'a' }, { text: 'b' }, { text: 'c' }];
  const r = parseVerifyResult('CRITERION 1: pass — ok\nCRITERION 2: fail — button missing\nCRITERION 3: skip — no browser\nVERDICT: fail\nCRITERIA: 1/3\nREPRO: open page, click X', criteria);
  assert.equal(r.verdict, 'fail');
  assert.deepEqual(r.criteria.map((c) => c.pass), [true, false, false]);
  assert.equal(r.criteria[1].note, 'button missing');
  assert.match(r.repro, /click X/);
});

test('pickImplementer prefers the specialty that matches the ticket text', () => {
  assert.equal(pickImplementer('touch server/runner.mjs and state.mjs', ['eng_m1', 'eng_f1', 'eng_m2']), 'eng_f1');
  assert.equal(pickImplementer('roster row in src/ui.js', ['eng_m1', 'eng_f1']), 'eng_m1');
  assert.equal(pickImplementer('anything', ['eng_m2']), 'eng_m2');
  assert.equal(pickImplementer('x', []), null);
});

// ---------------------------------------------------------------- servers
test('startOfficeServer pins the worktree and hands the port over as OFFICE_PORT', async () => {
  const port = 40000 + Math.floor(Math.random() * 20000);
  // the fake server refuses to listen unless it was started the way index.mjs expects
  const cmd = `node -e "if (process.env.OFFICE_PASSIVE !== '1' || !process.env.OFFICE_PROJECT) process.exit(1); require('net').createServer().listen(process.env.OFFICE_PORT)"`;
  const srv = await wt.startOfficeServer(cmd, process.cwd(), port, 15_000);
  assert.ok(srv, 'server answered on its port');
  assert.equal(srv.url, `ws://localhost:${port}/office`);
  srv.stop();
});

// ---------------------------------------------------------------- report
test('ticketReport follows the level-1 template and validateReport accepts it', () => {
  const md = ticketReport({
    id: '01', title: 'T', agent: 'eng_m1', branch: 'ticket/f-01', attempt: 1, ms: 60_000, usd: 0.4,
    what: ['did x'], gates: [{ gate: 'test', pass: true, output: '' }],
    review: { verdict: 'pass', standards: [], spec: [] },
    verify: { verdict: 'pass', criteria: [{ text: 'c1', pass: true }], evidence: 'screenshot' },
    criteria: [{ text: 'c1', pass: false }], open: [], diffStat: ' a.js | 2 +-',
  });
  assert.deepEqual(validateReport(md, 1), []);
  assert.match(md, /- \[x\] c1/);
  assert.match(md, /server รันเอง/);
  assert.ok(validateReport('# x\n## Diff\n## ทำอะไร', 1).length >= 3);
  assert.ok(validateReport('# r\n## 1. ขอมาว่าอะไร\n## 3. Tickets', 2).some((e) => e.includes('2. ได้อะไร')));
});

test('ticketReport totals every attempt and says what went to rounds that did not close the ticket', () => {
  const t = { id: '03', title: 'T', agent: 'eng_f1', branch: 'ticket/f-03', attempt: 1, ms: 60_000,
    what: ['did x'], gates: [], review: null, verify: null, criteria: [], open: [], diffStat: '' };
  assert.match(ticketReport({ ...t, usd: 4.2, usdWasted: 2.37 }), /ค่าใช้จ่าย: \$4\.20 \(รวมรอบที่ไม่ได้ปิดใบ \$2\.37\)/);
  assert.match(ticketReport({ ...t, usd: 4.2, usdWasted: 0 }), /ค่าใช้จ่าย: \$4\.20$/m);
  assert.match(ticketReport({ ...t, usd: 4.2 }), /ค่าใช้จ่าย: \$4\.20$/m);
});

test('featureReportPrompt shows the wasted column and a total row', () => {
  const md = featureReportPrompt({ feature: 'f', project: 'p', branch: 'feature/f', diffStat: '', spec: 's',
    tickets: [{ id: '01', title: 'T', assignee: 'eng_m1', status: 'done' }],
    costs: { eng_m1: { sessions: 3, usd: 14.1, usdWasted: 6 }, manager: { sessions: 1, usd: 2.5, usdWasted: 0 } } });
  assert.match(md, /\| eng_m1 \| 3 \| \$14\.10 \| \$6\.00 \|/);
  assert.match(md, /\| รวม \| - \| \$16\.60 \| \$6\.00 \|/);
});

// ---------------------------------------------------------------- what a ticket cost
test('chargeJob folds every session into the ticket total as it is spent', () => {
  const job = {};
  chargeJob(job, 1.25);                       // the implementer's first turn
  chargeJob(job, 0.5);                        // the reviewer of that round
  assert.equal(job.usd, 1.75);
  assert.equal(job.usdAttempt, 1.75);
  for (const bad of [undefined, null, 0, -1, NaN, 'x']) chargeJob(job, bad);
  assert.equal(job.usd, 1.75, 'a missing or nonsense figure changes nothing');
});

test('wasteAttempt counts an attempt that did not close the ticket, and only once', () => {
  const job = {};
  chargeJob(job, 2);                          // attempt 1: timed out
  wasteAttempt(job);
  wasteAttempt(job);                          // #retryOrEscalate then #escalate: idempotent
  assert.deepEqual([job.usd, job.usdWasted, job.usdAttempt], [2, 2, 0]);
  chargeJob(job, 3);                          // attempt 2 closes the ticket
  assert.deepEqual([job.usd, job.usdWasted, job.usdAttempt], [5, 2, 3]);
});

test('featureCosts counts every attempt of every ticket, not only the ones that closed', () => {
  // the shape of the first overnight run: two tickets whose escalated attempts were never counted
  const jobs = {
    '01': { agent: 'eng_m1', attempt: 1, stage: 'done', usd: 9.5, usdWasted: 6 },
    '02': { agent: 'eng_m1', attempt: 2, stage: 'done', usd: 4.6 },
    '03': { agent: 'eng_f1', attempt: 1, stage: 'escalated', usd: 3, usdWasted: 3 },
  };
  const costs = featureCosts(jobs, 2.5);
  assert.deepEqual(costs.eng_m1, { sessions: 3, usd: 14.1, usdWasted: 6 });
  assert.deepEqual(costs.eng_f1, { sessions: 1, usd: 3, usdWasted: 3 });
  assert.deepEqual(costs.manager, { sessions: 1, usd: 2.5, usdWasted: 0 });
  assert.deepEqual(featureCosts({}, 0).manager, { sessions: 1, usd: 0, usdWasted: 0 });
  assert.equal(featureCosts({ '01': { usd: 1 } }, 0).unknown.usd, 1);
});

// ---------------------------------------------------------------- the feature report
/** A Pipeline with the disk and the manager replaced: enough to drive maybeFeatureReport(). */
function reportRig(manager, jobs = { '01': { agent: 'eng_m1', attempt: 2, stage: 'done', usd: 5, usdWasted: 3 } }) {
  const state = { feature: 'f', jobs, runningTotals: {} };
  const events = [], saves = [];
  const p = new Pipeline({
    project: { id: 'proj', path: os.tmpdir(), mainBranch: 'main' },   // not a repo: every git call is a no-op
    state, team: {}, office: { policy: {}, commands: {} },
    emit: (e) => events.push(e),
    approvals: { canUseToolFor: () => () => ({}) },
    save: () => saves.push(state.featureReported),
    manager,
  });
  p.active = true;
  p.board = () => [{ id: '01', title: 'T', status: 'done', rawStatus: 'done', assignee: 'eng_m1', criteria: [] }];
  return { p, state, events, saves };
}

const L2 = ['# รายงานปิดงาน: f', '## 1. ขอมาว่าอะไร', '## 2. ได้อะไร', '## 3. Tickets',
  '## 4. ตัดสินใจระหว่างทาง', '## 5. ของที่เหลือ', '## 6. Diff รวมและการรวมโค้ด', '## 7. ค่าใช้จ่าย'].join('\n');

test('the feature report is handed every attempt of a ticket, and records itself as written', async () => {
  let prompt = '';
  const { p, state, events } = reportRig(async (text) => { prompt = prompt || text; return L2; });
  await p.maybeFeatureReport();
  assert.match(prompt, /\| eng_m1 \| 2 \| \$5\.00 \| \$3\.00 \|/, 'the closing session was not the only one that cost money');
  assert.match(prompt, /\| รวม \| - \| \$5\.00 \| \$3\.00 \|/);
  assert.equal(state.featureReported, true);
  assert.ok(events.some((e) => e.type === 'feature.report' && e.valid));
});

test('a feature report the manager cannot write is not recorded as written', async () => {
  // the flag used to be set after the manager's turn: a throw there left the pipeline believing
  // it had reported (this.reported) while the state file said nothing had been written
  const { p, state, events, saves } = reportRig(async () => { throw new Error('manager session died'); });
  await p.maybeFeatureReport();
  assert.equal(state.featureReported, false);
  assert.equal(p.reported, false, 'a later tick must be free to try again');
  assert.ok(saves.length, 'the rollback is saved, not only held in memory');
  assert.ok(events.some((e) => e.type === 'error' && /manager session died/.test(e.message)));
  assert.ok(!events.some((e) => e.type === 'feature.report'));
  // and the next try is free to write it
  p.managerTurn = async () => L2;
  await p.maybeFeatureReport();
  assert.equal(state.featureReported, true);
  assert.ok(events.some((e) => e.type === 'feature.report'));
});

// ---------------------------------------------------------------- gates
test('runGates runs only the commands that exist and reports pass/fail with output', async () => {
  const r = await runGates(process.cwd(), { test: 'node -e "console.log(1)"', typecheck: '', e2e: 'node -e "process.exit(3)"' });
  assert.deepEqual(r.map((g) => [g.gate, g.pass]), [['test', true], ['e2e', false]]);
  assert.equal(r[0].output, '1');
  const t = await runCommand('node -e "setTimeout(()=>{},5000)"', process.cwd(), { timeoutMs: 300 });
  assert.equal(t.pass, false);
  assert.match(t.output, /timeout/);
});

// ---------------------------------------------------------------- worktrees
test('ticket worktrees branch from the feature branch, merge back, and rebase the others', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ube-wt-'));
  const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
  git('add', '.'); git('commit', '-q', '-m', 'init');

  const w1 = wt.createTicketWorktree(repo, 'f', '01', { install: false });
  const w2 = wt.createTicketWorktree(repo, 'f', '02', { install: false });
  assert.ok(fs.existsSync(w1.path) && fs.existsSync(w2.path));
  assert.equal(git('branch', '--list', 'feature/f').trim(), 'feature/f');

  fs.writeFileSync(path.join(w1.path, 'b.txt'), 'b\n');
  execFileSync('git', ['add', '.'], { cwd: w1.path }); execFileSync('git', ['commit', '-q', '-m', 'b'], { cwd: w1.path });
  assert.equal(wt.ticketCommits(repo, 'f', '01').length, 1);
  assert.equal(wt.ticketCommits(repo, 'f', '02').length, 0);

  const m = wt.mergeTicket(repo, 'f', '01');
  assert.equal(m.ok, true);
  assert.match(wt.diffStat(repo, 'main', 'feature/f'), /b\.txt/);
  const rb = wt.rebaseOpenTickets(repo, 'f', '01', ['02']);
  assert.deepEqual(rb, [{ id: '02', ok: true }]);
  assert.ok(fs.existsSync(path.join(w2.path, 'b.txt')), 'rebased worktree sees the merged file');

  wt.removeTicketWorktree(repo, 'f', '01');
  assert.ok(!fs.existsSync(w1.path));
  assert.equal(wt.featureMerged(repo, 'f'), false, 'feature has a commit main lacks');
  const mm = wt.mergeFeatureToMain(repo, 'f');
  assert.equal(mm.ok, true);
  assert.ok(fs.existsSync(path.join(repo, 'b.txt')));
  assert.equal(wt.featureMerged(repo, 'f'), true);
  assert.deepEqual(wt.mergeFeatureToMain(repo, 'f'), { ok: true, already: true }, 'pressing merge twice is not an error');
  git('worktree', 'remove', '--force', path.join(repo, '.worktrees', 'f'));   // mergeTicket keeps the feature branch checked out there
  git('branch', '-D', 'feature/f');
  assert.equal(wt.featureMerged(repo, 'f'), false, 'a missing branch is not merged by default');
  assert.equal(wt.featureMerged(repo, 'f', 'main', { ifMissing: true }), true);
  wt.removeTicketWorktree(repo, 'f', '02');
  fs.rmSync(repo, { recursive: true, force: true });
});
