// pipeline.mjs -- the downstream half of the flow: tickets off the board, through
// implement -> gates -> review -> verify -> close, one fresh session per step.
//
//   frontier ticket ──claim──► worktree ──► implementer session (/implement)
//        │                                     │ gates (server runs test/typecheck/e2e)
//        │                                     │ reviewer session (/code-review)  ─┐ fail: back to
//        │                                     │ QA session (opens the real thing) ─┘ the implementer
//        │                                     ▼
//        └── escalate (ready-for-human) ◄── retries exhausted     close: merge into feature branch,
//                                                                 report, rebase the others
//
// Everything a human would want to know is an event; everything that must survive a
// restart is in state.jobs. The harness, not the model, decides when a ticket is done.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { make } from '../src/agents/events.js';
import { Session } from './runner.mjs';
import { readBoard, claimTicket, setTicketField, appendComment } from './board.mjs';
import { runGates } from './gates.mjs';
import { ticketReport, validateReport, featureReportPrompt } from './report.mjs';
import * as wt from './worktree.mjs';
import { STATE_DIR } from './state.mjs';
import { readOffice } from './office.mjs';
import { managerRunningTotal } from './costs.mjs';

const IMPLEMENTERS = ['eng_m1', 'eng_f1', 'eng_m2'];
const REVIEWER = 'eng_f2';
const QA = 'eng_m3';
const SPECIALTY = {
  eng_m1: [/\bsrc\/(?!agents\/events)/, /\.css\b/, /index\.html/, /roster|panel|director|bubble|three/i],
  eng_f1: [/\bserver\//, /\bscripts\//, /\bblender\//, /runner|state\.mjs|flow\.mjs|office\.mjs/],
  eng_m2: [/\bmock\.js/, /\btests?\//, /research|prototype/i],
};
const PLUGIN = 'mattpocock-skills';

const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
const tail = (s, n = 1200) => (s && s.length > n ? '…' + s.slice(-n) : s ?? '');

/** Find any installed skill's SKILL.md body: "plugin:skill" or a bare skill name. */
export function findSkillBody(name) {
  const cache = path.join(os.homedir(), '.claude', 'plugins', 'cache');
  const [plugin, skill] = name.includes(':') ? name.split(':') : [null, name];
  const roots = [];
  if (fs.existsSync(cache)) {
    for (const mk of fs.readdirSync(cache)) {
      const mkDir = path.join(cache, mk);
      if (!fs.statSync(mkDir).isDirectory()) continue;
      for (const pl of fs.readdirSync(mkDir)) {
        if (plugin && pl !== plugin) continue;
        const plDir = path.join(mkDir, pl);
        if (!fs.statSync(plDir).isDirectory()) continue;
        for (const ver of fs.readdirSync(plDir).sort().reverse()) roots.push(path.join(plDir, ver, 'skills'));
      }
    }
  }
  roots.push(path.join(os.homedir(), '.claude', 'skills'));
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    const direct = path.join(root, skill, 'SKILL.md');
    if (fs.existsSync(direct)) return strip(fs.readFileSync(direct, 'utf8'));
    for (const group of fs.readdirSync(root)) {
      const f = path.join(root, group, skill, 'SKILL.md');
      if (fs.existsSync(f)) return strip(fs.readFileSync(f, 'utf8'));
    }
  }
  return null;
  function strip(t) { return t.replace(/^---[\s\S]*?---\s*/, '').trim(); }
}

// ---------------------------------------------------------------- parsing the agents' last words
export function parseImplementResult(text = '') {
  const result = /RESULT:\s*(done|blocked|fail)/i.exec(text)?.[1]?.toLowerCase() ?? (text ? 'done' : 'blocked');
  const evidence = /EVIDENCE:\s*(.+)/i.exec(text)?.[1]?.trim() ?? '';
  const next = /NEXT:\s*(.+)/i.exec(text)?.[1]?.trim() ?? '';
  const before = text.split(/RESULT:/i)[0];
  const bullets = [...before.matchAll(/^\s*[-*]\s+(.+)$/gm)].map((m) => m[1].trim()).filter((b) => b.length > 3).slice(0, 5);
  const what = bullets.length ? bullets : before.trim().split(/\n+/).filter(Boolean).slice(0, 2);
  return { result, evidence, next, what };
}

/**
 * The verdict follows the team's own rule (team/eng_f2.md): a Spec finding fails the ticket,
 * Standards findings are advice. A `VERDICT: fail` above `SPEC: none` is therefore a pass by
 * rule (`byRule: true`, so the report can say so) -- the first overnight run escalated two
 * tickets on exactly that line and spent three fix rounds on standards-only findings. A
 * reviewer's `pass` is never overruled, and no VERDICT line at all stays a fail: the
 * reviewer never finished.
 */
export function parseReviewResult(text = '') {
  const said = /VERDICT:\s*(pass|fail)/i.exec(text)?.[1]?.toLowerCase() ?? null;
  const list = (key) => {
    const raw = new RegExp(`${key}:\\s*(.+)`, 'i').exec(text)?.[1]?.trim() ?? '';
    return /^none\b/i.test(raw) || !raw ? [] : raw.split(/\s*;\s*/).filter(Boolean);
  };
  const standards = list('STANDARDS'), spec = list('SPEC');
  const verdict = !said ? 'fail' : said === 'pass' || !spec.length ? 'pass' : 'fail';
  return { verdict, standards, spec, ...(said && said !== verdict ? { byRule: true } : {}) };
}

export function parseVerifyResult(text = '', criteria = []) {
  const verdict = /VERDICT:\s*(pass|fail)/i.exec(text)?.[1]?.toLowerCase() ?? 'fail';
  const repro = /REPRO:\s*([\s\S]+?)(?:\n\s*\n|$)/i.exec(text)?.[1]?.trim() ?? '';
  const rows = [...text.matchAll(/CRITERION\s+(\d+):\s*(pass|fail|skip)\s*[—-]?\s*(.*)/gi)];
  const out = criteria.map((c, i) => {
    const r = rows.find((m) => Number(m[1]) === i + 1);
    return { text: c.text, pass: r ? /pass/i.test(r[2]) : verdict === 'pass', note: r?.[3]?.trim() ?? '' };
  });
  return { verdict, criteria: out, repro, evidence: /EVIDENCE:\s*(.+)/i.exec(text)?.[1]?.trim() ?? '' };
}

/** Which idle implementer fits this ticket best: specialty hits in the ticket text, then order. */
export function pickImplementer(ticketText, idle) {
  let best = null;
  for (const id of idle) {
    const score = (SPECIALTY[id] ?? []).reduce((n, re) => n + (re.test(ticketText) ? 1 : 0), 0);
    if (!best || score > best.score) best = { id, score };
  }
  return best?.id ?? null;
}

// ---------------------------------------------------------------- what a ticket really cost
// A ticket's money is folded in as it is spent, not summed once at the close: an attempt that
// timed out, hit the usage limit or ended in a merge conflict spent real money too, and the first
// overnight run reported $19.97 of a ~$40 spend because only the sessions that closed a ticket
// were counted. `usd` is everything the ticket has ever cost; `usdAttempt` is what the attempt in
// flight has spent so far -- the part that becomes `usdWasted` when that attempt ends without
// closing the ticket (a retry, an escalation), so a report can say what went to retries.

/** Folds one session's spend into a job record. A non-positive or malformed figure changes nothing. */
export function chargeJob(job, usd) {
  const n = Number(usd);
  if (!job || !Number.isFinite(n) || n <= 0) return job;
  job.usd = (job.usd ?? 0) + n;
  job.usdAttempt = (job.usdAttempt ?? 0) + n;
  return job;
}

/** The attempt in flight ended without closing the ticket: its spend stays in `usd` and is counted as waste too. Idempotent. */
export function wasteAttempt(job) {
  if (!job) return job;
  job.usdWasted = (job.usdWasted ?? 0) + (job.usdAttempt ?? 0);
  job.usdAttempt = 0;
  return job;
}

/** The per-person cost rows of the level-2 report: every attempt of every ticket, not only the ones that closed. */
export function featureCosts(jobs, managerUsd = 0) {
  const costs = {};
  for (const j of Object.values(jobs ?? {})) {
    const k = j.agent ?? 'unknown';
    costs[k] = costs[k] ?? { sessions: 0, usd: 0, usdWasted: 0 };
    costs[k].sessions += j.attempt ?? 1;
    costs[k].usd += j.usd ?? 0;
    costs[k].usdWasted += j.usdWasted ?? 0;
  }
  costs.manager = { sessions: 1, usd: managerUsd, usdWasted: 0 };
  return costs;
}

/**
 * The browser Playwright MCP should drive: its own Chromium when `npx playwright install
 * chromium` succeeded, else the machine's Chrome or Edge (the CDN download is not always
 * reachable). null when nothing usable is installed.
 */
export function qaBrowser() {
  try {
    const { chromium } = require_('playwright');
    if (fs.existsSync(chromium.executablePath())) return 'chromium';
  } catch { /* playwright not installed */ }
  const candidates = [
    ['chrome', ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe', '/usr/bin/google-chrome', '/Applications/Google Chrome.app']],
    ['msedge', ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe']],
  ];
  for (const [name, paths] of candidates) if (paths.some((p) => fs.existsSync(p))) return name;
  return null;
}

import { createRequire } from 'node:module';
const require_ = createRequire(import.meta.url);

class Mutex {
  constructor() { this.p = Promise.resolve(); }
  run(fn) { const r = this.p.then(fn, fn); this.p = r.catch(() => {}); return r; }
}

// ---------------------------------------------------------------- the pipeline
export class Pipeline {
  /**
   * @param approvals  **required** -- an Approvals (permissions.mjs). Every session #session()
   *   builds gets its `canUseTool` from it, so there is no "no approvals" mode: leaving it out
   *   would hand the SDK its own permission flow behind the team's back, and the rule of this
   *   server is that an unanswered ask is a deny, never a silent allow. index.mjs always passes one.
   * @param createSession  seam for tests: (opts) => Session-shaped object.
   * @param tickMs  how often idle implementers are offered the frontier.
   */
  constructor({ project, state, team, office, emit, approvals, save, manager, createSession = (o) => new Session(o), tickMs = 15_000 }) {
    this.project = project;
    this.state = state;
    this.team = team;
    this.office = office;
    this.emit = emit;
    this.approvals = approvals;
    this.save = save;
    this.managerTurn = manager;          // async (text) => lastText ; the manager's session, for the feature report
    this.createSession = createSession;
    this.tickMs = tickMs;                // how often idle implementers are offered the frontier (a test drives tick() by hand)
    this.running = new Map();            // ticket id -> { agent, promise }
    this.locks = { [REVIEWER]: new Mutex(), [QA]: new Mutex() };
    this.active = false;
    this.slot = 0;        // verify: dev server base+1+n, the worktree's Office Server base+41+n
    this.gateSlot = 0;    // gates: base+81+n, its own counter so verify's ports stay predictable
    this.reported = false;
  }

  get repo() { return this.project.path; }
  get feature() { return this.state.feature; }
  get policy() { return this.office?.policy ?? {}; }
  get commands() { return this.office?.commands ?? {}; }

  start() {
    if (this.active) return;
    this.active = true;
    this.reported = !!this.state.featureReported;   // a restart must not write the report twice
    this.#resume();
    this.tick();
    this.timer = setInterval(() => this.tick(), this.tickMs);
  }

  /** Stop handing out tickets for a while (usage limit). Running jobs park themselves via pauseFor. */
  pause(why, minutes = 15) {
    if (this.pausedUntil && this.pausedUntil > Date.now()) return;
    this.pausedUntil = Date.now() + minutes * 60_000;
    this.emit(make('agent.say', { agent: 'manager', text: `หยุดพัก ${minutes} นาที: ${why} จะลองต่อเอง` }));
    this.emit(make('error', { message: `pipeline paused: ${why}` }));
  }

  /** Put an escalated ticket back on the board, resuming at review when its work is already committed. */
  /**
   * @param stage  where to resume: 'implement' | 'review' | 'verify'. Default: review when the
   *               work is committed. 'verify' means the human accepted the diff in place of the
   *               reviewer, so the review step is skipped once and recorded as such.
   *               ('gates' is the fourth value `resumeStage` can hold, but only pauseFor writes
   *               it -- a usage limit parked mid fix-loop -- never a human through requeue.)
   */
  requeue(id, stage = null) {
    const t = this.board().find((x) => x.id === id);
    if (!t) return false;
    const st = this.state.jobs[id] ?? (this.state.jobs[id] = { attempt: 0, usd: 0 });
    const hasCommits = wt.ticketCommits(this.repo, this.feature, id).length > 0;
    st.stage = 'pending'; st.attempt = 0; delete st.reason;
    st.resumeStage = stage ?? (hasCommits ? 'review' : 'implement');
    if (st.resumeStage !== 'implement' && !hasCommits) st.resumeStage = 'implement';
    setTicketField(t.file, 'Status', 'in-progress');
    this.reported = false; this.state.featureReported = false;   // the feature report must be written again after this closes
    this.save();
    this.emit(make('agent.say', { agent: 'manager', text: `ใบ ${id} กลับเข้าบอร์ด เริ่มที่ขั้น ${st.resumeStage}` }));
    this.emitBoard();
    this.tick();
    return true;
  }

  async stop() {
    this.active = false;
    clearInterval(this.timer);
    for (const r of this.running.values()) r.session?.close?.();
    this.running.clear();
  }

  /** Jobs that were mid-flight when the server died get a fresh attempt with a note. */
  #resume() {
    for (const [id, job] of Object.entries(this.state.jobs ?? {})) {
      if (job.stage && job.stage !== 'done' && job.stage !== 'escalated') {
        job.resume = `server restart ระหว่างขั้น ${job.stage} รอบ ${job.attempt}: worktree อาจมีงานค้าง ดู git status/log ก่อน`;
        // a restart is not the ticket's failure: the re-run keeps the same attempt number
        if (job.stage !== 'pending') { job.attempt = Math.max(0, (job.attempt ?? 1) - 1); }
        if (['review', 'verify', 'gates', 'close'].includes(job.stage)) job.resumeStage = 'review';
        job.stage = 'pending';
        this.save();
      }
    }
  }

  board() { return this.feature ? readBoard(this.repo, this.feature) : []; }

  emitBoard() {
    this.emit(make('board.update', { feature: this.feature, tickets: this.board().map(({ file, ...t }) => t) }));
  }

  /** Assign frontier tickets to idle implementers, up to max-parallel. */
  tick() {
    if (!this.active || !this.feature) return;
    if (this.pausedUntil && this.pausedUntil > Date.now()) return;
    const tickets = this.board();
    const done = new Set(tickets.filter((t) => t.status === 'done').map((t) => t.id));
    const maxPar = num(this.policy['max-parallel'], 2);
    // in-progress tickets nobody is running (claimed before a restart) count as work to resume
    const resumable = tickets.filter((t) => t.status === 'in-progress' && !this.running.has(t.id));
    const frontier = tickets.filter((t) => t.status === 'ready' && !t.assignee && (t.blockedBy ?? []).every((b) => done.has(b)));
    for (const t of [...resumable, ...frontier]) {
      if (this.running.size >= maxPar) break;
      const busy = new Set([...this.running.values()].map((r) => r.agent));
      const idle = IMPLEMENTERS.filter((a) => !busy.has(a));
      if (!idle.length) break;
      const text = fs.readFileSync(t.file, 'utf8');
      const agent = (t.assignee && idle.includes(t.assignee)) ? t.assignee : pickImplementer(text, idle);
      if (!agent) break;
      const job = { agent };
      this.running.set(t.id, job);
      job.promise = this.runTicket(t, agent, job).catch((e) => {
        this.emit(make('error', { agent, ticket: t.id, message: `pipeline: ${e.message ?? e}` }));
        // message first: tail() keeps the end of a stack trace, which would cut the message off
        this.#escalate(t, `pipeline error: ${e?.message ?? e}${e?.stack ? '\n' + tail(String(e.stack), 400) : ''}`);
      }).finally(() => { this.running.delete(t.id); this.tick(); this.#reportWhenDone(); });
    }
    if (!this.running.size) this.#reportWhenDone();
  }

  // ---------------------------------------------------------------- one ticket
  async runTicket(t, agent, job) {
    const id = t.id;
    const st = this.state.jobs[id] ?? (this.state.jobs[id] = { agent, attempt: 0, stage: 'pending', usd: 0, startedAt: Date.now() });
    st.agent = agent;
    st.attempt += 1;
    const maxAttempts = num(this.policy.attempts, 2);
    if (st.attempt > maxAttempts) { this.#escalate(t, `เกิน ${maxAttempts} รอบ`); return; }
    const note = st.resume ?? st.retryNote ?? null;
    const startAt = st.resumeStage ?? 'implement';     // 'gates' / 'review' / 'verify': skip straight to the fix loop
    delete st.resume; delete st.retryNote; delete st.resumeStage;
    st.stage = startAt;
    this.save();

    claimTicket(t.file, agent);
    setTicketField(t.file, 'Attempt', String(st.attempt));
    this.emitBoard();

    // worktree from the feature branch (a retry keeps the previous branch tip for forensics)
    const w = wt.createTicketWorktree(this.repo, this.feature, id, { mainBranch: this.project.mainBranch, commands: this.commands });
    st.branch = w.branch; st.worktree = w.path; this.save();

    if (st.attempt > 1) this.emit(make('agent.retry', { agent, ticket: id, attempt: st.attempt, note: note ?? 'เริ่มรอบใหม่' }));
    this.emit(make('agent.start', { agent, ticket: id, brief: t.title, mode: 'implement', attempt: st.attempt, teamHash: this.state.teamHash ?? null }));

    const ticketText = fs.readFileSync(t.file, 'utf8');
    const t0 = Date.now();
    // the implementer session is created on first use: a ticket resumed at review may never need one
    let session = null;
    const header = [
      `## Ticket ${id}: ${t.title}`,
      `ไฟล์ ticket: ${path.relative(this.repo, t.file).replace(/\\/g, '/')}`,
      `spec: .scratch/${this.feature}/spec.md`,
      `worktree นี้อยู่บน branch ${w.branch} (แตกจาก ${w.feature}) commit ที่นี่เท่านั้น ห้าม push`,
    ].join('\n');
    const impl = () => {
      if (session) return session;
      session = this.#session(agent, { cwd: w.path, ticket: id, role: 'impl' });
      job.session = session;
      session.start();
      return session;
    };
    // an implementer session's costUsd is that session's running total: charge the delta after
    // every turn, so a session that never reaches the close still lands in state.jobs[id].usd
    let implCharged = 0;
    const chargeImpl = () => {
      const delta = (session?.costUsd ?? 0) - implCharged;
      implCharged += delta;
      chargeJob(st, delta);
      this.save();
    };
    const limited = (sess) => sess?.limited;
    const pauseFor = (stage, why) => {
      // the account's usage limit, not the ticket's fault: park the job at this stage and try later
      st.resumeStage = stage; st.stage = 'pending'; st.attempt -= 1; this.save();
      session?.close();
      this.pause(why);
    };

    let res, parsed;
    if (startAt === 'implement') {
      const implementPrompt = [
        this.#skill('implement'),
        '',
        header,
        w.reused ? 'worktree นี้มีงานจากรอบก่อนอยู่แล้ว: ดู git status และ git log ก่อน อย่าเริ่มใหม่จากศูนย์' : '',
        note ? `\nหมายเหตุจากรอบก่อน: ${note}` : '',
        '',
        ticketText,
      ].join('\n');
      res = await impl().send(implementPrompt);
      chargeImpl();
      parsed = parseImplementResult(session.lastText);
      if (limited(session)) return pauseFor('implement', 'implementer hit the usage limit');
      if (res?.ended || session.timedOut || res?.subtype?.startsWith('error')) {
        st.retryNote = `รอบ ${st.attempt} ${session.timedOut ? 'หมดเวลา' : 'session จบผิดปกติ'} ข้อความสุดท้าย: ${tail(session.lastText, 300)}`;
        session.close();
        this.save();
        return this.#retryOrEscalate(t, agent, job);
      }
      this.emit(make('agent.done', { agent, ticket: id, result: parsed.result, summary: parsed.evidence || parsed.what.join(' · ') || '(ไม่มีสรุป)' }));
      if (parsed.result !== 'done') {
        st.retryNote = `รอบ ${st.attempt} รายงาน ${parsed.result}: ${parsed.next || tail(session.lastText, 300)}`;
        session.close();
        this.save();
        return this.#retryOrEscalate(t, agent, job);
      }
    } else {
      // resumed after the implementer already committed: the commits are the summary
      const commits = wt.ticketCommits(this.repo, this.feature, id).map((c) => c.replace(/^\S+\s+/, ''));
      parsed = { result: 'done', evidence: '', next: '', what: commits.length ? commits : ['(resumed at ' + startAt + ')'] };
      this.emit(make('agent.say', { agent, ticket: id, text: `ใบ ${id} กลับมาที่ขั้น ${startAt} (งาน commit ไว้แล้ว ${commits.length} ครั้ง)` }));
    }

    // ---- fix loop: gates -> review -> verify, each failure goes back to the same session
    const maxRounds = num(this.policy['fix-rounds'], 3);
    let gates = [], review = null, verify = null, rounds = 0;
    for (;;) {
      st.stage = 'gates'; this.save();
      // each gate run gets its own port (base + 81 + n) so two worktrees' e2e never bind the same one
      const gatePort = num(this.office?.worktree?.['port-base'], 3100) + 81 + (this.gateSlot++ % 40);
      gates = await runGates(w.path, this.commands, { port: gatePort, onResult: (g, r) => this.emit(make('gate.result', { agent, ticket: id, gate: g, pass: r.pass, output: tail(r.output, 600) })) });
      const failedGates = gates.filter((g) => !g.pass);
      let feedback = null;
      if (failedGates.length) {
        feedback = `gate ที่ server รันเองไม่ผ่าน:\n` + failedGates.map((g) => `### ${g.gate}: ${g.command}\n${tail(g.output, 1500)}`).join('\n\n') + '\n\nแก้ให้ผ่านแล้วจบด้วย RESULT/EVIDENCE/NEXT อีกครั้ง';
      } else {
        st.stage = 'review'; this.save();
        if (startAt === 'verify' && !review) {
          // the human took the reviewer's seat for this ticket: recorded, not re-run
          review = { verdict: 'pass', standards: [], spec: [], usd: 0, byHuman: true };
          this.emit(make('review.result', { agent: REVIEWER, ticket: id, assignee: agent, standards: [], spec: [], verdict: 'pass', byHuman: true }));
        } else review = await this.#review(t, w);
        chargeJob(st, review.usd); this.save();          // every round's reviewer, not just the last
        if (review.limited) return pauseFor('review', 'reviewer hit the usage limit');
        if (review.verdict !== 'pass') {
          feedback = `reviewer ส่งกลับ:\nSPEC: ${review.spec.join('; ') || 'none'}\nSTANDARDS: ${review.standards.join('; ') || 'none'}\n\nแก้ finding เชิง SPEC ให้ครบ (STANDARDS เป็นคำแนะนำ ทำเฉพาะที่ไม่บานปลาย) แล้วจบด้วย RESULT/EVIDENCE/NEXT อีกครั้ง`;
        } else if (this.policy.verify !== 'none') {
          st.stage = 'verify'; this.save();
          verify = await this.#verify(t, w);
          chargeJob(st, verify.usd); this.save();        // every round's QA, not just the last
          if (verify.limited) return pauseFor('verify', 'QA hit the usage limit');
          if (verify.verdict !== 'pass') {
            feedback = `QA ตรวจรับไม่ผ่าน (${verify.criteria.filter((c) => !c.pass).length} ข้อ):\n` + verify.criteria.filter((c) => !c.pass).map((c) => `- ${c.text}${c.note ? ' — ' + c.note : ''}`).join('\n') + `\n\nREPRO: ${verify.repro || '-'}\n\nแก้แล้วจบด้วย RESULT/EVIDENCE/NEXT อีกครั้ง`;
          }
        }
      }
      if (!feedback) break;
      rounds += 1;
      if (rounds > maxRounds) {
        st.retryNote = `แก้ ${maxRounds} รอบแล้วยังไม่ผ่าน: ${tail(feedback, 300)}`;
        session?.close();
        this.save();
        return this.#retryOrEscalate(t, agent, job);
      }
      this.emit(make('agent.start', { agent, ticket: id, brief: `${t.title} (แก้รอบ ${rounds})`, mode: 'implement', attempt: st.attempt }));
      st.stage = 'implement'; this.save();
      const fresh = !session;
      res = await impl().send((fresh ? header + '\nworktree นี้มีงานที่ commit ไว้แล้ว ดู git log ก่อน\n\n' : '') + feedback);
      chargeImpl();
      parsed = parseImplementResult(session.lastText);
      if (limited(session)) return pauseFor(review && review.verdict !== 'pass' ? 'review' : 'gates', 'implementer hit the usage limit');
      if (res?.ended || session.timedOut || res?.subtype?.startsWith('error')) {
        st.retryNote = `รอบแก้ ${rounds} ${session.timedOut ? 'หมดเวลา' : res?.subtype ?? 'session จบผิดปกติ'} (งานล่าสุด: ${tail(session.lastText, 200)})`;
        session.close();
        this.save();
        return this.#retryOrEscalate(t, agent, job);
      }
      this.emit(make('agent.done', { agent, ticket: id, result: parsed.result, summary: parsed.evidence || parsed.what.join(' · ') }));
    }

    // ---- close: merge, report, board
    st.stage = 'close'; this.save();
    const commits = wt.ticketCommits(this.repo, this.feature, id);
    if (!commits.length) {
      // nothing committed: ask once for a commit, then escalate
      await impl().send(header + '\n\nยังไม่มี commit บน branch นี้ ให้ git add และ git commit งานทั้งหมดตอนนี้ แล้วตอบสั้นๆ');
      chargeImpl();
      if (!wt.ticketCommits(this.repo, this.feature, id).length) {
        session?.close();
        return this.#escalate(t, 'implementer ไม่ได้ commit งาน');
      }
    }
    const merge = wt.mergeTicket(this.repo, this.feature, id, { mainBranch: this.project.mainBranch, message: `Merge ticket ${id}: ${t.title}` });
    if (!merge.ok) {
      session?.close();
      return this.#escalate(t, `merge เข้า ${wt.featureBranch(this.feature)} ชนกันที่: ${merge.files.join(', ') || merge.error}`);
    }
    const diff = wt.diffStat(this.repo, this.project.mainBranch, wt.featureBranch(this.feature));
    const usd = st.usd ?? 0, usdWasted = st.usdWasted ?? 0;   // every attempt and round of this ticket
    const report = ticketReport({
      id, title: t.title, agent, branch: w.branch, attempt: st.attempt, ms: Date.now() - t0, usd, usdWasted,
      what: parsed.what, gates, review, verify, criteria: t.criteria,
      open: [parsed.next && !/none|ไม่มี/i.test(parsed.next) ? `implementer: ${parsed.next}` : null].filter(Boolean),
      diffStat: wt.diffStat(this.repo, wt.featureBranch(this.feature), w.branch) || diff,
    });
    const errs = validateReport(report, 1);
    if (errs.length) console.warn('[pipeline] level-1 report invalid', errs);
    setTicketField(t.file, 'Status', 'done');
    for (const c of verify?.criteria ?? []) if (c.pass) {
      const re = new RegExp(`^- \\[ \\] ${c.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'm');
      const txt = fs.readFileSync(t.file, 'utf8');
      if (re.test(txt)) fs.writeFileSync(t.file, txt.replace(re, `- [x] ${c.text}`));
    }
    appendComment(t.file, report);
    st.stage = 'done'; st.finishedAt = Date.now(); st.usdAttempt = 0; this.save();
    this.#metrics({ ticket: id, agent, attempts: st.attempt, rounds, gates: gates.map((g) => [g.gate, g.pass]), review: review?.verdict, verify: verify?.verdict, ms: Date.now() - t0, usd, usdWasted, escalated: false });
    this.emit(make('ticket.closed', { ticket: id, assignee: agent, report, diffStat: diff }));
    session?.close();
    this.emitBoard();
    // keep the others current with what just landed
    const open = this.board().filter((x) => x.status === 'in-progress').map((x) => x.id);
    for (const r of wt.rebaseOpenTickets(this.repo, this.feature, id, open)) {
      if (!r.ok) this.emit(make('agent.say', { agent: 'manager', ticket: r.id, text: `ใบ ${r.id} rebase ทับ ${wt.featureBranch(this.feature)} ไม่ผ่าน (${r.reason}) ต้องแก้เอง` }));
    }
    wt.removeTicketWorktree(this.repo, this.feature, id, { keepBranch: true });
  }

  // ---------------------------------------------------------------- steps
  async #review(t, w) {
    return this.locks[REVIEWER].run(async () => {
      this.emit(make('agent.start', { agent: REVIEWER, ticket: t.id, brief: `รีวิว diff ใบ ${t.id}`, mode: 'review' }));
      const s = this.#session(REVIEWER, { cwd: w.path, ticket: t.id, role: 'review' });
      // the session is closed in a finally: a throw here (SDK error, a prompt that cannot be
      // built) must not leave a live session behind for the rest of the server's life
      try {
        s.start();
        const prompt = [
          this.#skill('code-review'),
          '',
          `fixed point: ${w.feature} (git diff ${w.feature}...HEAD)`,
          `spec: .scratch/${this.feature}/spec.md · ticket: ${path.relative(this.repo, t.file).replace(/\\/g, '/')}`,
          'มาตรฐานของ repo: CLAUDE.md, CONTEXT.md, docs/adr/',
          'ห้ามแก้โค้ด รายงานอย่างเดียว ถ้าแตกงานให้ sub-agent ให้รอผลก่อนตอบ (ห้ามใช้ background agent) แล้วจบด้วยสามบรรทัด VERDICT / STANDARDS / SPEC ตาม prompt ประจำตัวของคุณ',
        ].join('\n');
        await s.send(prompt);
        // the review skill fans out to sub-agents; if the reviewer ended its turn while they were
        // still running, their results land as later assistant messages in the same session, so
        // wait for a verdict line before judging, then ask for it once
        const hasVerdict = () => /VERDICT:/i.test(s.lastText);
        const waitFor = async (ms) => { const t0 = Date.now(); while (!hasVerdict() && !s.limited && !s.closed && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 10_000)); };
        if (!hasVerdict() && !s.limited) await waitFor(8 * 60_000);
        if (!hasVerdict() && !s.limited) {
          await s.send('รวมผลจาก sub-agent ทั้งสองแกน (รอให้เสร็จ ห้ามจบ turn ก่อน) แล้วจบด้วยสามบรรทัดเท่านั้น: VERDICT: pass|fail / STANDARDS: … หรือ none / SPEC: … หรือ none');
          if (!hasVerdict() && !s.limited) await waitFor(6 * 60_000);
        }
        const r = /VERDICT:/i.test(s.lastText) ? parseReviewResult(s.lastText) : { verdict: 'fail', standards: [], spec: ['reviewer ไม่ได้ให้ verdict: ' + tail(s.lastText, 200)] };
        r.usd = s.costUsd;
        r.limited = !!s.limited;
        if (r.limited) return r;
        this.emit(make('review.result', { agent: REVIEWER, ticket: t.id, assignee: this.state.jobs[t.id]?.agent, standards: r.standards, spec: r.spec, verdict: r.verdict, ...(r.byRule ? { byRule: true } : {}) }));
        return r;
      } finally {
        s.close();
      }
    });
  }

  async #verify(t, w) {
    return this.locks[QA].run(async () => {
      this.emit(make('agent.start', { agent: QA, ticket: t.id, brief: `ตรวจรับใบ ${t.id} (${t.criteria.length} ข้อ)`, mode: 'verify' }));
      const exploratory = this.policy.verify === 'exploratory';
      let dev = null, office = null, s = null;
      // whatever happens below, the two child servers and the session are torn down: a throw
      // here used to leave them holding their ports until the whole server exited
      try {
        if (exploratory && this.commands.dev) {
          const base = num(this.office?.worktree?.['port-base'], 3100), n = this.slot++ % 40;
          const port = base + 1 + n, officePort = base + 41 + n;
          // the worktree's own Office Server (passive, pinned to the worktree) first, so the dev
          // server's /office proxy reaches the diff's server code instead of the shared one on :5181
          if (this.commands.office) {
            office = await wt.startOfficeServer(this.commands.office, w.path, officePort);
            if (!office) this.emit(make('agent.say', { agent: QA, ticket: t.id, text: `Office Server ของ worktree ไม่ขึ้นที่ :${officePort} ข้อที่ต้องใช้ server ของ diff นี้จะถูก skip` }));
          }
          dev = await wt.startDevServer(this.commands.dev, w.path, port, 40_000, office ? { OFFICE_PORT: String(officePort) } : {});
          if (!dev) this.emit(make('agent.say', { agent: QA, ticket: t.id, text: `dev server ไม่ขึ้นที่ :${port} ตรวจได้เฉพาะแบบ scripted` }));
        }
        const browser = qaBrowser();
        if (exploratory && !browser) this.emit(make('agent.say', { agent: QA, ticket: t.id, text: 'ไม่พบเบราว์เซอร์สำหรับ Playwright (chromium/chrome/msedge) ตรวจได้เฉพาะแบบ scripted' }));
        const mcp = exploratory && browser ? { playwright: { command: 'npx', args: ['@playwright/mcp', '--headless', '--browser', browser] } } : undefined;
        s = this.#session(QA, { cwd: w.path, ticket: t.id, role: 'qa', mcp });
        s.start();
        const criteria = t.criteria.map((c, i) => `${i + 1}. ${c.text}`).join('\n');
        const prompt = [
          `ตรวจรับใบ ${t.id}: ${t.title}`,
          `ไฟล์ ticket: ${path.relative(this.repo, t.file).replace(/\\/g, '/')} · spec: .scratch/${this.feature}/spec.md`,
          `โหมด: ${this.policy.verify}` + (dev ? ` · หน้าเว็บของ worktree นี้เปิดอยู่ที่ ${dev.url} (ใช้เครื่องมือ playwright: navigate, click, evaluate, screenshot)` : ''),
          `คำสั่งที่รันได้: ${Object.entries(this.commands).filter(([k, v]) => v && k !== 'office').map(([k, v]) => `${k}: ${v}`).join(' · ')}`,
          '',
          'Acceptance criteria:',
          criteria,
          '',
          'ทำทีละข้อ เก็บหลักฐานลง .scratch/' + this.feature + '/issues/' + t.id + '/verify/ (สร้างโฟลเดอร์ได้)',
          'ข้อที่ต้องใช้เบราว์เซอร์แต่ไม่มีเบราว์เซอร์ให้ตอบ skip พร้อมเหตุผล ไม่ใช่ fail',
          office
            ? `Office Server ของ worktree นี้ (รันโค้ดของ diff นี้) เปิดอยู่ที่ ${office.url} แบบ passive: ผูกโปรเจกต์นี้ไว้แล้ว ไม่ทำ onboarding ไม่รัน pipeline และหน้าเว็บที่ ${dev?.url ?? '(dev server ไม่ขึ้น)'} เชื่อมกับ server นี้อยู่แล้ว ข้อที่ต้องให้ manager คุยกับ Claude จริง หรือต้องหยุด/รีสตาร์ต server ให้ตอบ skip พร้อมเหตุผล ห้ามแตะ server กลางที่ ws://localhost:5181`
            : 'Office Server ที่ ws://localhost:5181 รันโค้ดของ branch หลัก ไม่ใช่ของ worktree นี้: ข้อที่ต้องให้ server ส่งข้อมูลใหม่จาก diff นี้ (เช่น field ใหม่ใน hello/snapshot) หรือต้องหยุด server นั้น ให้ตอบ skip พร้อมเหตุผล ห้ามนับเป็น fail และห้ามหยุดหรือรบกวน server ที่ใช้ร่วมกัน',
          'อย่าแก้ไฟล์ของโปรเจกต์เพื่อทดสอบ ถ้าข้อไหนต้องแก้ไฟล์นอก .scratch ให้ตอบ skip',
          'จบด้วยบรรทัดต่อข้อ "CRITERION n: pass|fail|skip — หลักฐานสั้นๆ" แล้วตามด้วย VERDICT / CRITERIA / REPRO (VERDICT เป็น fail เมื่อมีข้อใด fail)',
        ].join('\n');
        await s.send(prompt);
        const r = parseVerifyResult(s.lastText, t.criteria);
        r.usd = s.costUsd;
        r.limited = !!s.limited;
        if (r.limited) return r;
        this.emit(make('verify.result', { agent: QA, ticket: t.id, assignee: this.state.jobs[t.id]?.agent, criteria: r.criteria, verdict: r.verdict, repro: r.repro }));
        return r;
      } finally {
        s?.close();
        dev?.stop();
        office?.stop();
      }
    });
  }

  #retryOrEscalate(t, agent, job) {
    const st = this.state.jobs[t.id];
    wasteAttempt(st); this.save();   // this attempt is being redone: what it spent was retry money
    const maxAttempts = num(this.policy.attempts, 2);
    if (st.attempt >= maxAttempts) return this.#escalate(t, st.retryNote ?? 'หมดรอบ');
    st.stage = 'pending'; this.save();
    // the tick picks it up again as an in-progress ticket assigned to the same person
    this.emit(make('agent.say', { agent, ticket: t.id, text: `ใบ ${t.id} จะเริ่มรอบ ${st.attempt + 1} ด้วย session ใหม่` }));
  }

  #escalate(t, reason) {
    const st = this.state.jobs[t.id] ?? (this.state.jobs[t.id] = {});
    wasteAttempt(st);
    st.stage = 'escalated'; st.reason = reason; this.save();
    setTicketField(t.file, 'Status', 'ready-for-human');
    appendComment(t.file, `> *ส่งต่อให้คนโดย Office Server*\n\n${reason}`);
    this.#metrics({ ticket: t.id, agent: st.agent, attempts: st.attempt, escalated: true, reason, usd: st.usd ?? 0, usdWasted: st.usdWasted ?? 0 });
    this.emit(make('ticket.escalated', { ticket: t.id, reason, agent: st.agent }));
    this.emitBoard();
  }

  // ---------------------------------------------------------------- feature report
  /** tick() fires the report and walks away: a throw in there must not become an unhandled rejection. */
  #reportWhenDone() {
    this.maybeFeatureReport().catch((e) => this.emit(make('error', { message: `feature report: ${e.message ?? e}` })));
  }

  async maybeFeatureReport() {
    if (!this.active || this.reported || this.running.size) return;
    const tickets = this.board();
    if (!tickets.length) return;
    const open = tickets.filter((t) => ['ready', 'blocked', 'in-progress', 'review', 'verify'].includes(t.status));
    if (open.length) return;
    this.reported = true;
    const costs = featureCosts(this.state.jobs, managerRunningTotal(this.state));
    const branch = wt.featureBranch(this.feature);
    const diff = wt.diffStat(this.repo, this.project.mainBranch, branch);
    const prompt = featureReportPrompt({
      feature: this.feature, project: this.project.id, branch,
      tickets: tickets.map((t) => ({ id: t.id, title: t.title, assignee: t.assignee, status: t.rawStatus,
        review: this.state.jobs[t.id]?.stage === 'done' ? 'ผ่าน' : this.state.jobs[t.id]?.stage ?? '-',
        verify: this.state.jobs[t.id]?.stage === 'done' ? 'ผ่าน' : '-' })),
      costs, diffStat: diff, spec: `.scratch/${this.feature}/spec.md`,
    });
    let report, errs;
    try {
      report = await this.managerTurn(prompt);
      errs = validateReport(report ?? '', 2);
      if (errs.length) {
        report = await this.managerTurn(`รายงานยังไม่ตรง template: ${errs.join(', ')} เขียนใหม่ทั้งฉบับให้ครบ 7 หัวข้อตามลำดับ`);
        errs = validateReport(report ?? '', 2);
      }
    } catch (e) {
      // the manager's turn blew up (dead session, usage limit): no report was written, so put the
      // claim back instead of leaving `reported` set on a report that does not exist
      this.reported = false; this.state.featureReported = false; this.save();
      this.emit(make('error', { message: `feature report: ${e.message ?? e}` }));
      return;
    }
    this.state.featureReported = true; this.save();
    this.emit(make('feature.report', { feature: this.feature, report: report ?? '(ไม่มีรายงาน)', valid: !errs.length, diffStat: diff }));
    const pr = wt.openPullRequest(this.repo, this.feature, { mainBranch: this.project.mainBranch, title: `feature: ${this.feature}`, body: report ?? '' });
    if (pr.ok) this.emit(make('ci.status', { pr: pr.url, state: 'opened' }));
    else this.emit(make('agent.say', { agent: 'manager', text: `ไม่ได้เปิด PR: ${pr.error} รวมเข้า ${this.project.mainBranch} ได้ด้วยปุ่ม merge ในแผง` }));
  }

  // ---------------------------------------------------------------- helpers
  #session(agent, { cwd, ticket, role, mcp }) {
    this.office = readOffice(this.repo) ?? this.office;   // policy edits apply to the next session, no restart
    const a = this.team[agent];
    const pol = this.policy;
    const preload = (a.skills ?? []).map((s) => {
      const body = findSkillBody(s);
      return body ? `\n\n## Skill: ${s}\n${body}` : '';
    }).join('');
    const append = `${a.prompt}\n\n## โปรเจกต์นี้\nrepo: ${this.repo} · worktree: ${cwd}\nอ่าน CLAUDE.md, CONTEXT.md และ docs/adr/ ก่อนเริ่ม${preload}`;
    const allowed = ['Read', 'Grep', 'Glob', 'Skill', 'TodoWrite', ...(mcp ? ['mcp__playwright__*'] : [])];
    return this.createSession({
      agent, emit: this.emit, ticket,
      stallMinutes: num(pol['stall-minutes'], 6),
      timeoutMinutes: num(pol['ticket-timeout-min'], 30),
      options: {
        cwd, model: a.model,
        systemPrompt: { type: 'preset', preset: 'claude_code', append },
        settingSources: ['user', 'project'],
        allowedTools: allowed,
        permissionMode: 'default',
        canUseTool: this.approvals.canUseToolFor({ agent, repo: cwd, policy: pol, role, ticket, policyRepo: this.repo }),
        maxTurns: num(pol['max-turns'], 60),
        maxBudgetUsd: num(pol['ticket-budget-usd'], 4),
        ...(mcp ? { mcpServers: mcp } : {}),
        env: { ...process.env, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' },
      },
    });
  }

  #skill(name) {
    return findSkillBody(`${PLUGIN}:${name}`) ?? `/${PLUGIN}:${name}`;
  }

  #metrics(row) {
    try {
      fs.mkdirSync(STATE_DIR, { recursive: true });
      fs.appendFileSync(path.join(STATE_DIR, 'metrics.jsonl'), JSON.stringify({ t: Date.now(), project: this.project.id, feature: this.feature, ...row }) + '\n');
    } catch { /* metrics are best-effort */ }
  }
}
