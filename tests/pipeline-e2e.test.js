// pipeline-e2e.test.js -- one ticket through the whole Pipeline, with no Claude anywhere.
//
// A throwaway git repo, a real docs/agents/office.md, a real .scratch/<feature>/issues file,
// real worktrees, real git merges, real child processes for the dev/Office servers -- and
// fake Sessions injected through `createSession` that answer with the exact RESULT/VERDICT
// lines the parsers in pipeline.mjs expect. What is asserted is the harness's own work:
// claim -> worktree -> implement -> gates -> review -> verify -> merge -> report, and that a
// session that blows up mid-verify still takes its two child servers down with it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Pipeline } from '../server/pipeline.mjs';
import { writeOffice, readOffice } from '../server/office.mjs';
import { validate } from '../src/agents/events.js';
import * as wt from '../server/worktree.mjs';

const FEATURE = 'e2e';
const IMPLEMENTERS = ['eng_m1', 'eng_f1', 'eng_m2'];
const REVIEWER = 'eng_f2';
const QA = 'eng_m3';
const CRITERION = 'marker.txt exists on the ticket branch';

// a tiny TCP listener stands in for the dev server; the office one refuses to start unless it
// was handed the worktree the way index.mjs's OFFICE_* block expects (passive + pinned).
// Windows: the command goes through `shell: true`, so double quotes outside, single inside.
const DEV_CMD = `node -e "require('net').createServer().listen(process.env.PORT)"`;
const OFFICE_CMD = `node -e "if (process.env.OFFICE_PASSIVE !== '1' || !process.env.OFFICE_PROJECT) process.exit(1); require('net').createServer().listen(process.env.OFFICE_PORT)"`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(what, fn, ms = 30_000) {
  const t0 = Date.now();
  for (;;) {
    if (await fn()) return true;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

const canListen = (port) => new Promise((resolve) => {
  const s = net.createServer();
  s.once('error', () => resolve(false));
  s.once('listening', () => s.close(() => resolve(true)));
  s.listen(port, '127.0.0.1');
});

/** A throwaway repo with one commit on main, a ticket on the board and a real office.md. */
function fixture({ qaSend = null } = {}) {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ube-e2e-')));
  const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  git('config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(repo, 'README.md'), 'e2e fixture\n');
  git('add', '.');
  git('commit', '-q', '-m', 'init');

  const issues = path.join(repo, '.scratch', FEATURE, 'issues');
  fs.mkdirSync(issues, { recursive: true });
  const ticketFile = path.join(issues, '01-marker.md');
  fs.writeFileSync(ticketFile, [
    '# 01: Leave a marker on the branch', '',
    '**Status:** ready-for-agent',
    '**Blocked by:** none', '',
    '**What to build:** a marker file committed on the ticket branch', '',
    '## Acceptance criteria', '',
    `- [ ] ${CRITERION}`, '',
  ].join('\n'));

  // a high random base so two test files running at once never fight over a port
  const portBase = 21000 + Math.floor(Math.random() * 30000);
  writeOffice(repo, {
    commands: { dev: DEV_CMD, test: `node -e "console.log('gate ok')"`, office: OFFICE_CMD },
    worktree: { 'port-base': String(portBase) },
    // exploratory: the QA step must start both child servers and tell QA where they are
    policy: { verify: 'exploratory', attempts: '1', 'fix-rounds': '1', 'max-parallel': '1' },
  });

  const events = [];
  const emit = (ev) => {
    assert.deepEqual(validate(ev), [], `malformed ${ev.type}: ${JSON.stringify(ev)}`);
    events.push(ev);
  };

  // ---- fake sessions: one canned reply per role, and a real git commit for the implementer
  const sessions = [];
  let committed = false;
  const reply = (agent, cwd) => {
    if (IMPLEMENTERS.includes(agent)) {
      if (!committed) {
        fs.writeFileSync(path.join(cwd, 'marker.txt'), 'left by the fake implementer\n');
        execFileSync('git', ['add', '.'], { cwd, stdio: 'ignore' });
        execFileSync('git', ['commit', '-q', '-m', 'ticket 01: add marker.txt'], { cwd, stdio: 'ignore' });
        committed = true;
      }
      return '- เพิ่ม marker.txt\nRESULT: done\nEVIDENCE: git log บน branch นี้มี 1 commit\nNEXT: none';
    }
    // the reviewer writes `fail` over an empty Spec list: a pass by rule (parseReviewResult)
    if (agent === REVIEWER) return 'ดู diff แล้ว\nVERDICT: fail\nSTANDARDS: ชื่อไฟล์ marker.txt กว้างไป\nSPEC: none';
    return `CRITERION 1: pass — ${CRITERION}\nVERDICT: pass\nCRITERIA: 1/1\nREPRO: -`;
  };
  const createSession = ({ agent, ticket, options }) => {
    const s = {
      agent, ticket, cwd: options.cwd, mcp: options.mcpServers ?? null, env: options.env,
      sent: [], lastText: '', costUsd: 0.25, closed: false, limited: false, timedOut: false,
      async start() {},
      async interrupt() {},
      close() { this.closed = true; },
      async send(text) {
        this.sent.push(text);
        if (agent === QA && qaSend) return qaSend(text);   // may throw: an SDK error mid-verify
        this.lastText = reply(agent, this.cwd);
        return { type: 'result', subtype: 'success' };
      },
    };
    sessions.push(s);
    return s;
  };

  const managerPrompts = [];
  const manager = async (text) => {
    managerPrompts.push(text);
    return [
      `# รายงานปิดงาน: ${FEATURE}`,
      '## 1. ขอมาว่าอะไร', 'marker', '## 2. ได้อะไร', 'marker', '## 3. Tickets', '01',
      '## 4. ตัดสินใจระหว่างทาง', '-', '## 5. ของที่เหลือ', '-',
      '## 6. Diff รวมและการรวมโค้ด', 'รอมนุษย์กด merge', '## 7. ค่าใช้จ่าย', '$0.75',
    ].join('\n');
  };

  const state = { feature: FEATURE, phase: 'implement', jobs: {}, runningTotals: {}, managerSessionId: null };
  const team = Object.fromEntries([...IMPLEMENTERS, REVIEWER, QA]
    .map((id) => [id, { prompt: `คุณคือ ${id}`, model: 'claude-sonnet-4-5', skills: [] }]));

  const pipeline = new Pipeline({
    project: { id: 'e2e', path: repo, mainBranch: 'main' },
    state, team, office: readOffice(repo), emit, save: () => {}, manager, createSession,
    // #session always builds a canUseTool, so `approvals` is required, never optional
    approvals: { canUseToolFor: () => async () => ({ behavior: 'allow', updatedInput: {} }) },
    tickMs: 3_600_000,   // the test drives the ticket itself; no background tick
  });

  const cleanup = async () => {
    await pipeline.stop();
    wt.removeTicketWorktree(repo, FEATURE, '01', { keepBranch: true });
    // a successful mergeTicket leaves the feature branch checked out in .worktrees/<slug>
    try { git('worktree', 'remove', '--force', path.join(repo, wt.WORKTREES, FEATURE)); } catch { /* never created */ }
    try { git('worktree', 'prune'); } catch { /* fine */ }
    for (let i = 0; i < 5; i++) {
      try { fs.rmSync(repo, { recursive: true, force: true }); break; } catch { await sleep(300); }
    }
  };

  return {
    repo, git, ticketFile, state, events, sessions, managerPrompts, pipeline, cleanup,
    devPort: portBase + 1, officePort: portBase + 41,
    of: (type) => events.filter((e) => e.type === type),
  };
}

/** Hand the frontier ticket out and wait for the whole run, feature report included. */
async function runOneTicket(f) {
  f.pipeline.start();
  const job = f.pipeline.running.get('01');
  assert.ok(job, 'the frontier ticket was handed to an implementer at once');
  assert.ok(IMPLEMENTERS.includes(job.agent), `picked an implementer, got ${job.agent}`);
  await job.promise;
  await waitFor('the feature report', () => f.of('feature.report').length > 0);
  return job;
}

test('one ticket end to end: claim, worktree, implement, gates, review by rule, exploratory verify, merge, report', { timeout: 180_000 }, async () => {
  const f = fixture();
  const { git, of, state, devPort, officePort } = f;
  try {
    const job = await runOneTicket(f);

    // ---------------------------------------------------------------- 1. the ticket closed
    assert.deepEqual(of('error'), [], 'no error event anywhere in the run');
    const ticketText = fs.readFileSync(f.ticketFile, 'utf8');
    assert.match(ticketText, /^\*\*Status:\*\* done$/m, 'the ticket file ends at Status: done');
    assert.match(ticketText, new RegExp(`^- \\[x\\] ${CRITERION.replace(/\./g, '\\.')}`, 'm'), 'the passed criterion is ticked');
    assert.match(ticketText, /## Comments/, 'the level-1 report was appended');

    const statuses = of('board.update').map((e) => e.tickets[0].status);
    assert.deepEqual([statuses[0], statuses.at(-1)], ['in-progress', 'done'], 'the board went in-progress → done');
    assert.equal(of('ticket.escalated').length, 0);

    const closed = of('ticket.closed');
    assert.equal(closed.length, 1);
    assert.equal(closed[0].ticket, '01');
    assert.match(closed[0].report, /^# ปิดใบ 01/, 'the level-1 report is the closing event payload');

    // the ticket branch is in the feature branch, merged with --no-ff
    assert.equal(wt.featureBranch(FEATURE), `feature/${FEATURE}`);
    git('merge-base', '--is-ancestor', `ticket/${FEATURE}-01`, `feature/${FEATURE}`);
    assert.match(git('log', '--merges', '--oneline', `feature/${FEATURE}`), /Merge ticket 01:/, '--no-ff left a merge commit');
    assert.equal(git('show', `feature/${FEATURE}:marker.txt`), 'left by the fake implementer');
    assert.equal(git('log', '--oneline', 'main').split('\n').length, 1, 'main is untouched: the human merges the feature');

    // the standards-only `fail` passed by rule
    const review = of('review.result');
    assert.equal(review.length, 1);
    assert.equal(review[0].verdict, 'pass');
    assert.equal(review[0].byRule, true);
    assert.equal(review[0].spec.length, 0);
    assert.equal(review[0].standards.length, 1);

    // the gate the server ran itself, and QA's verdict
    assert.deepEqual(of('gate.result').map((e) => [e.gate, e.pass]), [['test', true]]);
    assert.equal(of('verify.result')[0].verdict, 'pass');
    assert.deepEqual(of('verify.result')[0].criteria.map((c) => c.pass), [true]);

    // the feature report is the manager's, validated against the level-2 template
    assert.equal(f.managerPrompts.length, 1, 'the level-2 report was accepted on the first try');
    assert.match(f.managerPrompts[0], new RegExp(FEATURE));
    assert.equal(of('feature.report')[0].valid, true);
    assert.equal(state.featureReported, true);

    // ---------------------------------------------------------------- 2. what QA was handed
    const qa = f.sessions.find((s) => s.agent === QA);
    assert.ok(qa, 'a QA session was created');
    const prompt = qa.sent[0];
    assert.match(prompt, new RegExp(`ws://localhost:${officePort}/office`), "QA was told the worktree's own Office Server url");
    assert.match(prompt, new RegExp(`http://localhost:${devPort}`), "QA was told the worktree's dev server url");
    assert.match(prompt, /ห้ามแตะ server กลางที่ ws:\/\/localhost:5181/, 'and warned off the shared server');
    assert.doesNotMatch(prompt, /dev server ไม่ขึ้น/, 'the dev server came up');
    assert.deepEqual(of('agent.say').filter((e) => /ไม่ขึ้นที่/.test(e.text)), [], 'neither child server failed to start');

    // both children were stopped when verify finished
    for (const port of [devPort, officePort]) {
      await waitFor(`:${port} to be free again`, () => canListen(port), 20_000);
    }

    // one fresh session per role, each closed
    assert.deepEqual(f.sessions.map((s) => s.agent).sort(), [job.agent, REVIEWER, QA].sort());
    assert.ok(f.sessions.every((s) => s.closed), 'every session was closed');
    assert.equal(state.jobs['01'].stage, 'done');
    assert.equal(state.jobs['01'].attempt, 1);
    assert.ok(state.jobs['01'].usd > 0, 'the ticket carries the cost of its three sessions');
    const implSession = f.sessions.find((s) => s.agent !== REVIEWER && s.agent !== QA);
    assert.equal(implSession.env.PORT, String(state.jobs['01'].port), 'the implementer sees the same PORT its gates run with');
    assert.equal(implSession.env.OFFICE_PORT, undefined, 'the server\'s own OFFICE_* never reach a session');
  } finally {
    await f.cleanup();
  }
});

test('a QA session that throws escalates the ticket and still takes its two child servers down', { timeout: 180_000 }, async () => {
  const f = fixture({ qaSend() { throw new Error('QA session exploded'); } });
  const { of, state, devPort, officePort } = f;
  try {
    await runOneTicket(f);

    // the throw came out of #verify, was caught by tick(), and became an event + an escalation
    const errs = of('error');
    assert.equal(errs.length, 1, 'exactly one error event, not a crashed process');
    assert.match(errs[0].message, /QA session exploded/);
    const esc = of('ticket.escalated');
    assert.equal(esc.length, 1);
    assert.equal(esc[0].ticket, '01');
    // note: the reason is `tail(e.stack, 400)`, so it is the deepest frames, not the message --
    // the message only survives on the error event above
    assert.match(esc[0].reason, /^pipeline error: /);
    assert.match(fs.readFileSync(f.ticketFile, 'utf8'), /^\*\*Status:\*\* ready-for-human$/m);
    assert.equal(state.jobs['01'].stage, 'escalated');
    assert.equal(of('ticket.closed').length, 0, 'nothing was merged');

    // the servers really were up before the throw, so the ports below mean something
    const qa = f.sessions.find((s) => s.agent === QA);
    assert.match(qa.sent[0], new RegExp(`ws://localhost:${officePort}/office`));
    assert.match(qa.sent[0], new RegExp(`http://localhost:${devPort}`));
    assert.ok(qa.closed, 'the QA session was closed by the finally');
    for (const port of [devPort, officePort]) {
      await waitFor(`:${port} to be free again after the throw`, () => canListen(port), 20_000);
    }
  } finally {
    await f.cleanup();
  }
});
