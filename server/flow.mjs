// flow.mjs -- the manager's state machine: the upstream half of Matt Pocock's main flow.
//
//   onboard -> grill -> spec -> tickets -> implement -> done
//
// The manager session lives across all of it (context hygiene: grill, spec and tickets
// must share one context). The human drives the phase changes; the flow sends the slash
// commands, because those skills are disable-model-invocation and must come from the
// "user" side. Every finished turn in a HITL phase becomes a flow.ask so the scene shows
// the manager waiting for the human.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { make } from '../src/agents/events.js';
import { Session } from './runner.mjs';
import { readBoard, listFeatures, watchBoard } from './board.mjs';
import { agentDefinitions, teamHash } from './team.mjs';
import { managerRunningTotal } from './costs.mjs';
import { readOffice, dailyBudgetUsd } from './office.mjs';
import { featureMerged } from './worktree.mjs';

const PLUGIN = 'mattpocock-skills';
const PLUGIN_VERSION = '1.2.3';
const ORDER = ['onboard', 'grill', 'spec', 'tickets', 'implement', 'done'];
const HITL = new Set(['grill', 'spec', 'tickets']);
const DOC_RE = /(^|[\\/])(CONTEXT\.md|CLAUDE\.md|docs[\\/]adr[\\/].+\.md|\.scratch[\\/].+\.md)$/i;

export class Flow {
  /**
   * @param project  { id, path, mainBranch }
   * @param state    from state.mjs (mutated, caller saves)
   * @param team     from team.mjs loadTeam()
   * @param office   from office.mjs readOffice()
   * @param emit     (event) => void
   * @param approvals Approvals instance
   * @param save     () => void   persist state
   */
  constructor({ project, state, team, office, emit, approvals, save, createSession = (o) => new Session(o) }) {
    this.createSession = createSession;   // tests inject a fake
    this.project = project;
    this.state = state;
    this.team = team;
    this.office = office;
    this.emit = emit;
    this.approvals = approvals;
    this.save = save;
    this.manager = null;
    this.askN = 0;
    this.pendingAsk = null;
    this.unwatch = () => {};
  }

  get phase() { return this.state.phase; }
  get repo() { return this.project.path; }

  // ---------------------------------------------------------------- session
  async ensureManager() {
    if (this.manager && !this.manager.closed) return this.manager;
    const m = this.team.manager ?? { prompt: '', model: 'claude-opus-5' };
    const policy = this.office?.policy ?? {};
    const contextFiles = ['CLAUDE.md', 'CONTEXT.md', 'docs/agents/issue-tracker.md', 'docs/agents/domain.md', 'docs/agents/triage-labels.md', 'docs/agents/office.md']
      .filter((f) => fs.existsSync(path.join(this.repo, f)));
    const append = [
      m.prompt,
      '',
      '## โปรเจกต์นี้',
      `repo: ${this.repo} (branch หลัก: ${this.project.mainBranch})`,
      contextFiles.length ? 'อ่านไฟล์เหล่านี้ก่อนเริ่ม: ' + contextFiles.join(', ') : 'repo นี้ยังไม่มี CONTEXT.md หรือ docs/agents ทำตาม skill ที่ถูกเรียกเพื่อสร้าง',
      'ตอบมนุษย์เป็นภาษาไทย คำถามหนึ่งรอบต่อหนึ่งข้อความ ถ้ามีหลายคำถามให้เรียงเป็นข้อและถามให้ครบในข้อความเดียว',
    ].join('\n');
    this.manager = this.createSession({
      agent: 'manager',
      emit: this.emit,
      onFile: (p) => this.#onFile(p),
      stallMinutes: Number(policy['stall-minutes'] ?? 6),
      costSeed: managerRunningTotal(this.state),
      options: {
        cwd: this.repo,
        model: m.model,
        systemPrompt: { type: 'preset', preset: 'claude_code', append },
        settingSources: ['user', 'project'],
        agents: agentDefinitions(this.team),
        // only read-only tools are pre-approved: Write/Edit/Bash must pass canUseTool, which
        // fences the manager to docs and .scratch (allowedTools would skip that check)
        allowedTools: ['Read', 'Grep', 'Glob', 'Skill', 'TodoWrite'],
        permissionMode: 'default',
        canUseTool: this.approvals?.canUseToolFor({ agent: 'manager', repo: this.repo, policy, role: 'manager' }),
        maxTurns: Number(policy['max-turns'] ?? 60),
        maxBudgetUsd: dailyBudgetUsd(this.office) ?? 10,
        ...(this.state.managerSessionId ? { resume: this.state.managerSessionId } : {}),
        env: { ...process.env, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' },
      },
    });
    this.manager.start().then(() => {
      // the stream ended: forget the resume id if it never produced one
      if (this.manager?.sessionId) { this.state.managerSessionId = this.manager.sessionId; this.save(); }
    });
    return this.manager;
  }

  /** Manager started and its init message (tool + command list) seen, or `ms` elapsed. */
  async ready(ms = 8000) {
    const s = await this.ensureManager();
    const t0 = Date.now();
    while (!s.init && !s.closed && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 100));
    return s;
  }

  /** A turn with the manager: send, wait for the result, remember the session id, then ask the human if we are in a HITL phase. */
  async turn(text, { askKind = 'question', ask = true } = {}) {
    const s = await this.ensureManager();
    this.emit(make('flow.phase', { phase: this.phase, hitl: HITL.has(this.phase), feature: this.state.feature }));
    const res = await s.send(text);
    if (s.sessionId && s.sessionId !== this.state.managerSessionId) { this.state.managerSessionId = s.sessionId; this.save(); }
    this.refreshBoard();
    if (res?.ended) return res;
    if (ask && HITL.has(this.phase) && s.lastText) this.askHuman(askKind);
    return res;
  }

  /**
   * Surface the manager's last message as something the human must answer.
   *
   * When the reply is written in the frontier-question convention it becomes a kind
   * "choice" ask -- the same widget the model's own AskUserQuestion gets -- carrying the
   * parsed questions and the intro above them. `text` is always the whole reply,
   * unchanged, so a client that ignores the extra fields still shows what was said
   * (ADR-0001: the schema grows by optional fields). Anything else asks as it always has.
   */
  askHuman(kind = 'question') {
    const text = this.manager?.lastText;
    if (!text) return null;
    const askId = `flow_${Date.now()}_${++this.askN}`;
    this.pendingAsk = askId;
    const parsed = parseFrontierQuestions(text);
    if (parsed) this.emit(make('flow.ask', { askId, kind: 'choice', text, intro: parsed.intro, questions: choiceQuestions(parsed) }));
    else this.emit(make('flow.ask', { askId, kind, text }));
    return askId;
  }

  // ---------------------------------------------------------------- phases
  setPhase(phase) {
    if (!ORDER.includes(phase)) throw new Error('unknown phase ' + phase);
    this.state.phase = phase;
    this.save();
    this.emit(make('flow.phase', { phase, hitl: HITL.has(phase), feature: this.state.feature }));
  }

  /** The human typed something in the chat. */
  async onCommand(text) {
    if (this.phase === 'onboard') {
      this.emit(make('agent.say', { agent: 'manager', text: 'ยังไม่ผ่าน onboarding ครับ ดูแท็บ "โปรเจกต์" ก่อน' }));
      return;
    }
    // idle (no feature in flight) or finished: a new message is a new idea, start the interview
    const idle = this.phase === 'done' || (this.phase === 'implement' && !this.state.feature);
    if (idle) {
      this.state.feature = null;
      this.setPhase('grill');
      this.emit(make('agent.say', { agent: 'manager', text: 'รับทราบ ขอสัมภาษณ์ให้ชัดก่อนเขียนสเปกนะครับ' }));
      await this.ready();
      await this.turn(this.skill('grill-with-docs', text));
      return;
    }
    await this.turn(text);
  }

  /** The human answered a flow.ask from the panel. */
  async onFlowAnswer(askId, { text = '', approved = true } = {}) {
    if (this.pendingAsk && askId !== this.pendingAsk) console.warn('[flow] stale answer', askId);
    this.pendingAsk = null;
    const reply = text.trim() || (approved ? 'โอเค ตามนั้นเลย ทำต่อได้' : 'ยังไม่โอเค ขอแก้ก่อน');
    await this.turn(reply);
  }

  /** The human pressed "next phase" in the panel. */
  async onNext(phase) {
    const i = ORDER.indexOf(phase), cur = ORDER.indexOf(this.phase);
    if (i < 0) return;
    await this.ready();
    if (i <= cur && phase !== 'grill') {
      this.emit(make('agent.say', { agent: 'manager', text: `อยู่ที่เฟส ${this.phase} แล้ว ไป ${phase} ไม่ได้` }));
      return;
    }
    switch (phase) {
      case 'grill':
        this.setPhase('grill');
        await this.turn(this.skill('grill-with-docs', ''));
        break;
      case 'spec':
        this.setPhase('spec');
        await this.turn(this.skill('to-spec', ''), { askKind: 'seams' });
        this.#detectFeature();
        break;
      case 'tickets':
        this.setPhase('tickets');
        await this.turn(this.skill('to-tickets', this.state.feature ? `.scratch/${this.state.feature}/spec.md` : ''), { askKind: 'tickets' });
        this.#detectFeature();
        this.refreshBoard();
        break;
      case 'implement':
        this.#detectFeature();
        this.setPhase('implement');
        this.refreshBoard();
        this.emit(make('agent.say', { agent: 'manager', text: 'บอร์ดพร้อมแล้ว ทีมจะหยิบใบที่เรืองแสงไปทำทันที' }));
        break;
      case 'done':
        this.setPhase('done');
        break;
      default:
        break;
    }
  }

  // ---------------------------------------------------------------- skills
  /**
   * Slash command when the CLI registered it, otherwise the SKILL.md body inlined -- the
   * text the command would have expanded to, so the effect is the same either way.
   */
  skill(name, args) {
    const cmd = `/${PLUGIN}:${name}`;
    if (this.manager?.hasCommand(cmd) || this.manager?.hasCommand(`/${name}`)) {
      const use = this.manager.hasCommand(cmd) ? cmd : '/' + name;
      console.info(`[flow] skill ${name}: registered as ${use}`);
      return `${use}${args ? ' ' + args : ''}`;
    }
    const body = readSkillBody(name);
    console.info(`[flow] skill ${name}: ${body ? 'not registered by the CLI, inlining SKILL.md' : 'not found on disk, sending the slash command anyway'}`
      + (this.manager?.init ? '' : ' (session not started yet: no command list to check)'));
    if (!body) return `${cmd}${args ? ' ' + args : ''}`;
    return `${body}\n\n---\n${args ? 'ARGUMENTS: ' + args : ''}`;
  }

  // ---------------------------------------------------------------- docs & board
  #onFile(p) {
    const abs = path.isAbsolute(p) ? p : path.join(this.repo, p);
    if (!DOC_RE.test(abs)) return;
    const rel = path.relative(this.repo, abs).replace(/\\/g, '/');
    if (/\.scratch\/[^/]+\/issues\//.test(rel)) { this.#detectFeature(); this.refreshBoard(); return; }
    let content = '';
    try { content = fs.readFileSync(abs, 'utf8').slice(0, 20_000); } catch { /* moved */ }
    const kind = /CONTEXT\.md$/i.test(rel) ? 'glossary' : /adr/i.test(rel) ? 'ADR' : /spec\.md$/i.test(rel) ? 'spec' : 'doc';
    this.emit(make('docs.update', { path: rel, kind, content }));
    if (kind === 'spec') { this.#detectFeature(); }
  }

  #detectFeature() {
    const feats = listFeatures(this.repo);
    const f = feats.find((x) => x.hasIssues) ?? feats.find((x) => x.hasSpec) ?? feats[0];
    if (f && f.slug !== this.state.feature) {
      this.state.feature = f.slug;
      this.save();
      this.unwatch();
      this.unwatch = watchBoard(this.repo, f.slug, () => this.refreshBoard());
    }
  }

  /**
   * Close a feature the phase never followed: every ticket done and the feature branch already
   * in main (merged from the panel, by hand, or deleted after merging). Without this the phase
   * stays `implement` with the feature set, and the next idea typed into the chat is a plain
   * turn in the old context instead of a new interview -- see the idle test in onCommand.
   * Returns true when the phase moved. `merged` is injectable for tests.
   */
  settleIfMerged(merged = (f) => featureMerged(this.repo, f, this.project.mainBranch ?? 'main', { ifMissing: true })) {
    if (this.phase !== 'implement' || !this.state.feature) return false;
    const tickets = readBoard(this.repo, this.state.feature);
    if (!tickets.length || !tickets.every((t) => t.status === 'done')) return false;
    if (!merged(this.state.feature)) return false;
    this.setPhase('done');
    this.emit(make('agent.say', { agent: 'manager', text: `feature/${this.state.feature} อยู่ใน ${this.project.mainBranch ?? 'main'} แล้ว ปิดงานนี้ พร้อมรับไอเดียใหม่` }));
    return true;
  }

  refreshBoard() {
    if (!this.state.feature) return [];
    const tickets = readBoard(this.repo, this.state.feature);
    this.emit(make('board.update', { feature: this.state.feature, tickets: tickets.map(({ file, ...t }) => t) }));
    return tickets;
  }

  /** What a fresh scene needs to draw itself. Today's totals go out as their own session.cost events (index.mjs), not duplicated here. */
  snapshot() {
    return {
      phase: this.phase,
      feature: this.state.feature,
      tickets: this.state.feature ? readBoard(this.repo, this.state.feature).map(({ file, ...t }) => t) : [],
      teamHash: teamHash(),
      pluginVersion: PLUGIN_VERSION,
      costUsd: managerRunningTotal(this.state),
      // read fresh, not this.office (cached at activation): a reconnect must see an edit to
      // docs/agents/office.md without needing a full onboard recheck to refresh the cache
      dailyBudgetUsd: dailyBudgetUsd(readOffice(this.repo)),
    };
  }

  async close() { this.unwatch(); this.manager?.close(); }
}

/** Find the plugin's SKILL.md on disk so a skill can be inlined when the CLI did not register it. */
export function readSkillBody(name) {
  const base = path.join(os.homedir(), '.claude', 'plugins', 'cache', 'claude-plugins-official', PLUGIN);
  if (!fs.existsSync(base)) return null;
  const versions = fs.readdirSync(base).sort().reverse();
  for (const v of versions) {
    const root = path.join(base, v, 'skills');
    if (!fs.existsSync(root)) continue;
    for (const group of fs.readdirSync(root)) {
      const f = path.join(root, group, name, 'SKILL.md');
      if (fs.existsSync(f)) {
        const text = fs.readFileSync(f, 'utf8');
        return text.replace(/^---[\s\S]*?---\s*/, '').trim();
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------- frontier questions
//
// The manager writes the questions it wants answered in one stable markdown convention:
//
//   ❓ **Q2** — **title**: body…
//   (ก) **label** — detail
//   ➡️ **(ก)** — why…
//
// Parsing that turns a wall of text into the panel's multiple-choice widget instead of a
// paragraph the human has to answer by typing. Be tolerant of everything that is only
// decoration: the bold markers, the separator (— – - :), the recommendation line, and the
// alphabet of the keys (ก ข ค ง, a b c, 1 2 3). An option's detail may wrap onto the
// following lines. Nothing here is required -- when the text is just prose the parse
// returns null and the ask stays the plain paragraph it is today.

const Q_LINE = /^(?:❓|❔)\s*(.*)$/u;
const REC_LINE = /^(?:➡️|➡|→|=>|->)\s*(.*)$/u;
// an option may be a bullet ("- (a) …") and the key may sit inside bold ("- **(a) label**: …")
const OPT_LINE = /^(?:[-*•]\s+)?\*{0,2}\s*[(（]\s*([^)）]{1,8}?)\s*[)）]\s*(.+)$/u;
const RULE_LINE = /^(?:-{3,}|={3,}|_{3,}|\*{3,})$/;
const ID_RE = /^\*{0,2}\s*(Q\s*\d+\s*['’ʼ′`]?)\s*\*{0,2}/iu;

const clean = (s) => s.replace(/\*\*/g, '').replace(/\s+/g, ' ').trim();
const stripSep = (s) => s.replace(/^[\s—–:•-]+/u, '').trim();
const join = (a, b) => (a ? a + ' ' + b : b);

/** "**label** — detail" | "label: detail" | "label"  ->  [label, detail] */
function splitLabel(rest) {
  const s = rest.trim();
  const bold = s.match(/^\*\*\s*(.+?)\s*\*\*\s*(.*)$/su);
  if (bold) return [clean(bold[1]), stripSep(clean(bold[2]))];
  const sep = s.match(/^(.+?)\s*(?:—|–|--|-|:)\s+(.*)$/su);
  if (sep) return [clean(sep[1]), clean(sep[2])];
  return [clean(s), ''];
}

/**
 * @param text  the manager's whole reply
 * @returns {{intro: string, questions: Array}|null}  null when no ❓ question with at
 *          least two options is in there -- the caller then asks the way it always has.
 */
export function parseFrontierQuestions(text) {
  if (typeof text !== 'string' || !/[❓❔]/u.test(text)) return null;
  const intro = [];
  const questions = [];
  let q = null;
  let tail = 'question';   // where a wrapped line belongs: question | option | why | null
  const push = () => { if (q) questions.push(q); };

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (RULE_LINE.test(line)) { tail = null; continue; }
    const qm = line.match(Q_LINE);
    if (qm) {
      push();
      const rest = qm[1].trim();
      const idm = rest.match(ID_RE);
      const id = idm ? idm[1].replace(/\s+/g, '') : `Q${questions.length + 1}`;
      const [header, body] = splitLabel(stripSep(idm ? rest.slice(idm[0].length) : rest));
      q = { id, header, question: body, options: [], recommended: null, why: '', recKey: null, recText: '' };
      tail = 'question';
      continue;
    }
    if (!q) { intro.push(raw); continue; }
    const rm = line.match(REC_LINE);
    if (rm) {
      const body = rm[1];
      q.recText = clean(body);
      const km = body.match(/[(（]\s*\*{0,2}\s*([^)）*]{1,8}?)\s*\*{0,2}\s*[)）]/u);
      if (km) {
        q.recKey = clean(km[1]);
        q.why = stripSep(clean(body.slice(km.index + km[0].length)));
      } else {
        const [label, why] = splitLabel(body);
        const first = label.split(/\s+/)[0] ?? '';
        q.recKey = first.length <= 8 ? first : null;
        q.why = why || (q.recKey ? '' : label);
      }
      tail = 'why';
      continue;
    }
    const om = line.match(OPT_LINE);
    if (om) {
      const [label, description] = splitLabel(om[2]);
      q.options.push({ key: clean(om[1]), label, description, recommended: false });
      tail = 'option';
      continue;
    }
    if (!line) { tail = null; continue; }
    if (tail === 'option' && q.options.length) {
      const o = q.options.at(-1);
      o.description = join(o.description, clean(line));
    } else if (tail === 'why') q.why = join(q.why, clean(line));
    else if (tail === 'question' || !q.options.length) q.question = join(q.question, clean(line));
  }
  push();

  for (const item of questions) {
    const key = item.recKey;
    delete item.recKey;
    // a question the manager answered itself ("➡️ do X because …") with no lettered options:
    // one button that accepts the recommendation, so the whole reply still becomes a widget
    if (!item.options.length && item.recText) {
      item.options.push({ key: '✓', label: 'ตามที่แนะนำ', description: item.recText, recommended: true });
      item.recommended = '✓';
      item.why = '';   // the whole recommendation is the option's description already
      delete item.recText;
      continue;
    }
    delete item.recText;
    if (!key) continue;
    const low = key.toLowerCase();
    const hit = item.options.find((o) => o.key.toLowerCase() === low)
      ?? item.options.find((o) => o.label.toLowerCase().startsWith(low));
    if (hit) { hit.recommended = true; item.recommended = hit.key; }
  }
  if (!questions.some((item) => item.options.length >= 2 || item.recommended === '✓')) return null;
  return { intro: intro.join('\n').replace(/\n{3,}/g, '\n\n').trim(), questions };
}

/** The parsed questions in the shape the panel's multiple-choice widget reads. */
export function choiceQuestions({ questions }) {
  return questions.map((q) => ({
    id: q.id,
    header: q.header ? `${q.id} · ${q.header}` : q.id,
    question: q.question || q.header || '',
    multiSelect: false,
    options: q.options.map((o) => ({
      label: `(${o.key}) ${o.label}`,
      description: o.description,
      ...(o.recommended ? { recommended: true } : {}),
    })),
    ...(q.why ? { why: q.why } : {}),
  }));
}
