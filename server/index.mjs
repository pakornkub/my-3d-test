// index.mjs -- the Office Server: one WebSocket, one project at a time, the manager's flow.
//
//   npm run office            (port 5181, path /office; Vite proxies /office to it)
//
// Everything the scene sees goes out as events (src/agents/events.js); everything the
// scene sends comes in through the same schema. State is on disk (state.mjs), so a
// restart resumes the manager session and re-sends a snapshot to any scene that connects.

import { WebSocketServer } from 'ws';
import fs from 'node:fs';
import path from 'node:path';
import { make, validate } from '../src/agents/events.js';
import { loadRegistry, addProject, currentProject, saveRegistry } from './projects.mjs';
import * as state from './state.mjs';
import * as costs from './costs.mjs';
import { loadTeam } from './team.mjs';
import { readOffice } from './office.mjs';
import { Approvals } from './permissions.mjs';
import { Flow } from './flow.mjs';
import { runChecks, stepsWith, allRequiredPassed } from './onboard.mjs';
import { Pipeline } from './pipeline.mjs';
import { mergeFeatureToMain, featureBranch } from './worktree.mjs';
import { teamHash } from './team.mjs';

const PORT = Number(process.env.OFFICE_PORT ?? 5181);
const VERSION = 'ube-office-server/0.1';

const team = loadTeam();
const reg = loadRegistry();
const clients = new Set();

let project = currentProject(reg);
let st = project ? state.load(project.id) : null;
let flow = null;
let pipeline = null;
let onboarding = false;

/** True when `ev` passes schema validation; warns and returns false otherwise -- the one guard broadcast() and unicast() both run through, so it can't drift between the two send paths. */
function okToSend(ev) {
  const errs = validate(ev);
  if (errs.length) console.warn('[server] refusing to send malformed event', ev.type, errs);
  return errs.length === 0;
}

function broadcast(ev) {
  if (!okToSend(ev)) return;
  if (project) state.logEvent(project.id, ev);
  // keeps state.runningTotals (and the state file) live between boots, per session.cost
  if (st && ev.type === 'session.cost') { costs.recordCost(st, ev); saveState(); }
  const s = JSON.stringify(ev);
  for (const c of clients) if (c.readyState === 1) c.send(s);
  const tag = ev.agent ? `${ev.agent}` : 'flow';
  if (ev.type !== 'session.cost') console.info(`[${tag}] ${ev.type}${ev.summary ? ' ' + ev.summary : ev.text ? ' ' + String(ev.text).slice(0, 80).replace(/\n/g, ' ') : ''}`);
}

const approvals = new Approvals({ emit: broadcast });
const saveState = () => project && state.save(project.id, st);

/** Sends a freshly-built (not yet logged or broadcast) event to one newly-connected scene. */
function unicast(ws, ev) {
  if (okToSend(ev)) ws.send(JSON.stringify(ev));
}

// ---------------------------------------------------------------- project lifecycle
async function activate(p) {
  await flow?.close();
  project = p;
  st = state.load(p.id);
  // seed today's running totals from the log, not from the state file, so a restart never
  // shows stale money and deleting today's log starts the day back at zero
  st.runningTotals = costs.daySeed(state.readLog(p.id));
  st.runningTotalsDay = state.today();
  reg.current = p.id;
  saveRegistry(reg);
  await pipeline?.stop();
  const office = readOffice(p.path);
  flow = new Flow({ project: p, state: st, team, office, emit: broadcast, approvals, save: saveState });
  st.teamHash = teamHash();
  pipeline = new Pipeline({ project: p, state: st, team, office, emit: broadcast, approvals, save: saveState,
    manager: async (text) => { await flow.turn(text, { ask: false }); return flow.manager?.lastText ?? ''; } });
  broadcast(projectStatus());
  broadcast(make('flow.phase', { phase: st.phase, feature: st.feature }));
  flow.refreshBoard();
  maybeStartPipeline();
}

/** The downstream half runs whenever there is a feature with tickets and the flow is past to-tickets. */
function maybeStartPipeline() {
  if (!flow || !pipeline) return;
  if (st.phase === 'implement' && st.feature) {
    pipeline.office = readOffice(project.path);
    pipeline.start();
    console.info(`[pipeline] running on ${st.feature}`);
  }
}

function projectStatus() {
  const steps = stepsWith(Object.fromEntries((st?.onboarding ?? []).map((s) => [s.n, s])));
  return make('project.status', { project: project?.id ?? '-', path: project?.path, steps, ready: allRequiredPassed(Object.fromEntries(steps.map((s) => [s.n, s]))) });
}

function setStep(n, patch) {
  const list = st.onboarding ?? (st.onboarding = []);
  const i = list.findIndex((s) => s.n === n);
  const row = { n, ...(i >= 0 ? list[i] : {}), ...patch };
  if (i >= 0) list[i] = row; else list.push(row);
  saveState();
}

async function onboard({ rehearse = true } = {}) {
  if (!project || onboarding) return;
  onboarding = true;
  try {
    await runChecks(project, {
      rehearse,
      onStep: (n, row) => { setStep(n, row); broadcast(projectStatus()); },
    });
    flow.office = readOffice(project.path);
    const steps = Object.fromEntries((st.onboarding ?? []).map((s) => [s.n, s]));
    if (allRequiredPassed(steps) && st.phase === 'onboard') {
      st.phase = 'implement';   // idle with no feature: next idea starts a grill
      st.feature = null;
      saveState();
      broadcast(make('flow.phase', { phase: st.phase, feature: null }));
      broadcast(make('agent.say', { agent: 'manager', text: 'โปรเจกต์พร้อมแล้วครับ เล่าไอเดียมาได้เลย' }));
    }
    broadcast(projectStatus());
  } finally { onboarding = false; }
}

/** HITL onboarding steps go through the manager session. */
async function onboardWithManager(n) {
  if (!flow) return;
  setStep(n, { state: 'running', detail: 'ผู้จัดการกำลังทำ…' });
  broadcast(projectStatus());
  const prev = st.phase;
  st.phase = 'grill';          // HITL: the manager may ask; treat like an interview
  // onboarding turns may end with a question (the setup skill asks which tracker); a
  // question-shaped ending becomes a flow.ask, a plain summary does not
  const isQuestion = () => /\?|ไหม|หรือ|เลือก|ยืนยัน/.test(flow.manager?.lastText?.slice(-400) ?? '');
  await flow.ready();
  const onboardTurn = async (text) => {
    await flow.turn(text, { ask: false });
    if (isQuestion()) flow.askHuman('question');
  };
  if (n === 4) await onboardTurn('/init');
  if (n === 5) await onboardTurn(flow.skill('setup-matt-pocock-skills', ''));
  if (n === 6) await onboardTurn(flow.skill('wizard', 'ช่วยทำสคริปต์ให้ผมกรอกค่าใน .env ตาม .env.example'));
  st.phase = prev;
  saveState();
  await onboard({ rehearse: false });
}

// ---------------------------------------------------------------- scene -> server
async function handle(msg, ws) {
  const errs = validate(msg);
  if (errs.length) { ws.send(JSON.stringify(make('error', { message: 'bad message: ' + errs.join(', ') }))); return; }
  switch (msg.type) {
    case 'project.add': {
      try {
        const id = msg.id ?? path.basename(msg.path).replace(/\.git$/, '');
        const p = addProject(reg, { id, source: msg.path, mainBranch: msg.mainBranch ?? 'main' });
        await activate(p);
        onboard();
      } catch (e) { broadcast(make('error', { message: e.message })); }
      break;
    }
    case 'project.select': {
      const p = reg.projects.find((x) => x.id === msg.project);
      if (p) await activate(p); else broadcast(make('error', { message: 'ไม่รู้จักโปรเจกต์ ' + msg.project }));
      break;
    }
    case 'project.recheck':
      if (!project) break;
      if (msg.action === 'skip') { setStep(msg.step, { state: 'skip', detail: 'ข้าม' }); broadcast(projectStatus()); break; }
      if ([4, 5, 6].includes(msg.step) && msg.action === 'manager') { onboardWithManager(msg.step); break; }
      onboard({ rehearse: msg.step === 8 || msg.step === 0 });
      break;
    case 'command':
      if (!flow) { broadcast(make('error', { message: 'ยังไม่มีโปรเจกต์ เพิ่มก่อนที่แท็บ "โปรเจกต์"' })); break; }
      flow.onCommand(msg.text).catch((e) => broadcast(make('error', { message: e.message })));
      break;
    case 'flow.answer':
      // a multiple-choice question from a tool call is answered through permissions; a
      // conversational question goes back into the manager session as the next turn
      if (approvals.answerText(msg.askId, msg)) break;
      flow?.onFlowAnswer(msg.askId, msg).catch((e) => broadcast(make('error', { message: e.message })));
      break;
    case 'flow.next':
      flow?.onNext(msg.phase).then(() => maybeStartPipeline()).catch((e) => broadcast(make('error', { message: e.message })));
      break;
    case 'merge': {
      if (!project || !st.feature) break;
      const r = mergeFeatureToMain(project.path, st.feature, project.mainBranch);
      broadcast(make('agent.say', { agent: 'manager', text: r.ok
        ? `รวม ${featureBranch(st.feature)} เข้า ${project.mainBranch} แล้ว`
        : `รวมไม่ได้: ${r.error}` }));
      break;
    }
    case 'answer':
      if (!approvals.answer(msg.askId, msg.allow)) console.warn('[server] no pending ask', msg.askId);
      break;
    case 'cancel':
      await flow?.manager?.interrupt();
      broadcast(make('agent.say', { agent: 'manager', text: 'หยุดงานตามที่สั่ง' }));
      break;
    case 'replay': {
      const log = state.readLog(project?.id ?? '');
      for (const ev of log.slice(-200)) ws.send(JSON.stringify(ev));
      break;
    }
    default:
      break;
  }
}

function hello() {
  return make('hello', {
    server: VERSION,
    projects: reg.projects.map((p) => ({ id: p.id, path: p.path, current: p.id === reg.current })),
    project: project?.id ?? null,
    phase: st?.phase ?? null,
    feature: st?.feature ?? null,
    team: Object.keys(team),
    snapshot: flow?.snapshot() ?? null,
  });
}

// ---------------------------------------------------------------- boot
const wss = new WebSocketServer({ port: PORT, path: '/office' });
wss.on('connection', (ws) => {
  clients.add(ws);
  unicast(ws, hello());
  if (project) {
    unicast(ws, projectStatus());
    unicast(ws, make('flow.phase', { phase: st.phase, feature: st.feature }));
    if (flow) unicast(ws, make('board.update', { feature: st.feature, tickets: flow.snapshot().tickets }));
    // today's running totals, boot-seeded from the log and kept live by every broadcast()
    for (const ev of Object.values(st.runningTotals ?? {})) unicast(ws, { ...make('session.cost', ev), replayed: true });
    // the recent conversation, so a reloaded scene is not blank
    const recent = state.readLog(project.id).filter((e) => ['agent.say', 'flow.ask', 'docs.update', 'ticket.closed', 'feature.report'].includes(e.type)).slice(-40);
    for (const ev of recent) unicast(ws, { ...ev, replayed: true });
  }
  ws.on('message', (data) => { try { handle(JSON.parse(String(data)), ws); } catch (e) { console.warn('[server] bad frame', e.message); } });
  ws.on('close', () => clients.delete(ws));
});

console.info(`${VERSION} listening on ws://localhost:${PORT}/office · team: ${Object.keys(team).join(', ')}`);
if (project) {
  console.info(`project: ${project.id} (${project.path}) phase=${st.phase}`);
  activate(project).then(() => { if (st.phase === 'onboard') onboard(); });
} else {
  console.info('no project yet: add one from the panel (แท็บ โปรเจกต์) or create server/projects.json');
}

process.on('SIGINT', async () => { await pipeline?.stop(); await flow?.close(); process.exit(0); });
