// onboard.mjs -- the eight-step checklist a repo passes before the manager takes ideas.
//
// AFK steps run here (git, toolchain, rehearsal). The HITL steps (/init, Matt's setup
// skill, secrets) are handed to the manager session by flow.mjs; this module only checks
// their outcome on disk, so re-running it is always safe.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import net from 'node:net';
import { readOffice, writeOffice, guessCommands, DEFAULTS, OFFICE_FILE } from './office.mjs';

export const STEPS = [
  { n: 1, title: 'บอก repo และ branch หลัก' },
  { n: 2, title: 'ตรวจ toolchain' },
  { n: 3, title: 'ยืนยันคำสั่งและพอร์ต (docs/agents/office.md)' },
  { n: 4, title: 'CLAUDE.md' },
  { n: 5, title: '/setup-matt-pocock-skills (tracker, labels, domain docs)' },
  { n: 6, title: 'Secrets (.env)' },
  { n: 7, title: 'นโยบาย (allowlist, verify, งบ)' },
  { n: 8, title: 'ซ้อม worktree: install + test' },
];

const sh = (cmd, args, cwd, opts = {}) => execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32', ...opts }).trim();

export function stepsWith(states) {
  return STEPS.map((s) => ({ ...s, ...(states[s.n] ?? { state: 'pending', detail: '' }) }));
}

/** Everything that can be checked without a human. Returns { n: { state, detail } }. */
export async function runChecks(project, { onStep = () => {}, rehearse = true } = {}) {
  const repo = project.path;
  const out = {};
  const set = (n, state, detail = '') => { out[n] = { state, detail }; onStep(n, out[n]); };

  // 1 repo
  try {
    const branch = sh('git', ['rev-parse', '--abbrev-ref', 'HEAD'], repo);
    const dirty = sh('git', ['status', '--porcelain'], repo);
    set(1, dirty ? 'pass' : 'pass', `${repo} · ${branch}${dirty ? ' · มีไฟล์ค้างยังไม่ commit' : ' · สะอาด'}`);
  } catch (e) { set(1, 'fail', 'ไม่ใช่ git repo: ' + (e.message ?? e)); return out; }

  // 2 toolchain
  set(2, 'running', 'กำลังเดาและลองคำสั่ง…');
  const guess = guessCommands(repo);
  let detail = [];
  try {
    if (fs.existsSync(path.join(repo, 'package.json'))) {
      const hasLock = fs.existsSync(path.join(repo, 'package-lock.json'));
      const hasModules = fs.existsSync(path.join(repo, 'node_modules'));
      if (!hasModules) sh('npm', [hasLock ? 'ci' : 'install', '--no-audit', '--no-fund'], repo, { timeout: 180_000 });
      detail.push('npm ' + (hasModules ? 'มี node_modules แล้ว' : 'install ผ่าน'));
    }
    if (guess.test) {
      try { sh(guess.test.split(' ')[0], guess.test.split(' ').slice(1), repo, { timeout: 120_000 }); detail.push(`test: "${guess.test}" ผ่าน`); }
      catch (e) { detail.push(`test: "${guess.test}" ล้มเหลว (${(e.stderr ?? e.message ?? '').toString().split('\n').filter(Boolean).at(-1) ?? ''})`); }
    } else detail.push('ไม่พบคำสั่ง test');
    set(2, 'pass', detail.join(' · '));
  } catch (e) { set(2, 'fail', (e.stderr ?? e.message ?? String(e)).toString().slice(-200)); }

  // 3 office.md
  let office = readOffice(repo);
  if (!office) {
    office = { commands: guess, worktree: { ...DEFAULTS.worktree }, policy: { ...DEFAULTS.policy } };
    writeOffice(repo, office);
    set(3, 'pass', `เขียน ${OFFICE_FILE} จากที่เดาได้ แก้ได้เลยถ้าไม่ตรง`);
  } else set(3, 'pass', `${OFFICE_FILE} มีอยู่แล้ว: dev="${office.commands.dev || '-'}" test="${office.commands.test || '-'}"`);

  // 4 CLAUDE.md, 5 docs/agents
  set(4, fs.existsSync(path.join(repo, 'CLAUDE.md')) ? 'pass' : 'pending',
    fs.existsSync(path.join(repo, 'CLAUDE.md')) ? 'มีอยู่แล้ว' : 'ยังไม่มี กด "ให้ผู้จัดการทำ" เพื่อรัน /init');
  const tracker = fs.existsSync(path.join(repo, 'docs/agents/issue-tracker.md'));
  set(5, tracker ? 'pass' : 'pending', tracker ? readTrackerKind(repo) : 'ยังไม่มี docs/agents/issue-tracker.md กด "ให้ผู้จัดการทำ"');

  // 6 secrets
  const envExample = fs.existsSync(path.join(repo, '.env.example'));
  const envFile = fs.existsSync(path.join(repo, '.env'));
  if (!envExample) set(6, 'skip', 'โปรเจกต์นี้ไม่มี .env.example');
  else set(6, envFile ? 'pass' : 'pending', envFile ? 'มี .env แล้ว' : 'มี .env.example แต่ยังไม่มี .env สร้างเองหรือให้ผู้จัดการรัน /wizard');

  // 7 policy
  set(7, 'pass', `verify: ${office.policy.verify} · งบ $${office.policy['daily-budget-usd']}/วัน · allowlist: ${office.policy['bash-allowlist']}`);

  // 8 rehearsal
  if (rehearse) {
    set(8, 'running', 'สร้าง worktree ชั่วคราว…');
    const wt = path.join(repo, '.worktrees', 'onboard-rehearsal');
    try {
      fs.mkdirSync(path.dirname(wt), { recursive: true });
      try { sh('git', ['worktree', 'remove', '--force', wt], repo); } catch { /* none */ }
      sh('git', ['worktree', 'add', '--detach', wt, 'HEAD'], repo);
      let r = ['worktree ok'];
      if (fs.existsSync(path.join(wt, 'package.json'))) {
        // a real install per worktree: a junction to the parent's node_modules confuses
        // Vite's cache dir and would let two worktrees fight over one .vite folder
        const hasLock = fs.existsSync(path.join(wt, 'package-lock.json'));
        sh('npm', [hasLock ? 'ci' : 'install', '--no-audit', '--no-fund', '--prefer-offline'], wt, { timeout: 300_000 });
        r.push('npm install ผ่าน');
      }
      if (office.commands.test) { sh(office.commands.test.split(' ')[0], office.commands.test.split(' ').slice(1), wt, { timeout: 120_000 }); r.push('test ผ่าน'); }
      if (office.commands.dev) {
        const port = Number(office.worktree['port-base'] ?? 3100) + 99;
        const ok = await probeDevServer(office.commands.dev.replace('{port}', String(port)), wt, port);
        r.push(ok ? `dev server ขึ้นที่ :${port}` : `dev server ไม่ขึ้นที่ :${port} ภายใน 25 วิ`);
        if (!ok) throw new Error(r.join(' · '));
      }
      set(8, 'pass', r.join(' · '));
    } catch (e) {
      set(8, 'fail', (e.stderr ?? e.message ?? String(e)).toString().slice(-220));
    } finally {
      try { sh('git', ['worktree', 'remove', '--force', wt], repo); } catch { /* ignore */ }
      try { fs.rmSync(wt, { recursive: true, force: true }); } catch { /* ignore */ }
      try { sh('git', ['worktree', 'prune'], repo); } catch { /* ignore */ }
    }
  }
  // rehearse:false leaves step 8 untouched: a pass from an earlier run stays a pass

  return out;
}

function readTrackerKind(repo) {
  try {
    const t = fs.readFileSync(path.join(repo, 'docs/agents/issue-tracker.md'), 'utf8');
    return /Local Markdown/i.test(t) ? 'tracker: local markdown (.scratch/)' : /GitHub/i.test(t) ? 'tracker: GitHub Issues' : 'tracker: ตั้งค่าแล้ว';
  } catch { return 'ตั้งค่าแล้ว'; }
}

function probeDevServer(command, cwd, port, timeoutMs = 25_000) {
  return new Promise((resolve) => {
    const child = spawn(command, { cwd, shell: true, stdio: 'ignore', windowsHide: true, env: { ...process.env, BROWSER: 'none', CI: '1' } });
    const started = Date.now();
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      clearInterval(iv);
      // kill the whole tree first (shell -> npm -> vite); killing the shell alone orphans vite on Windows
      if (process.platform === 'win32') { try { execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* gone */ } }
      try { child.kill(); } catch { /* gone */ }
      resolve(ok);
    };
    // Vite binds "localhost", which is ::1 on many Windows boxes: try both families
    const iv = setInterval(() => {
      for (const host of ['127.0.0.1', '::1']) {
        const s = net.connect({ port, host });
        s.once('connect', () => { s.destroy(); done(true); });
        s.once('error', () => { s.destroy(); if (Date.now() - started > timeoutMs) done(false); });
      }
    }, 1000);
    child.on('exit', () => { if (Date.now() - started < timeoutMs) done(false); });
  });
}

export function allRequiredPassed(states) {
  const s = stepsWith(states);
  const req = [1, 2, 3, 4, 5, 8];
  return req.every((n) => s[n - 1].state === 'pass') && s.every((x) => x.state === 'pass' || x.state === 'skip' || x.state === 'pending' && (x.n === 6 || x.n === 7));
}
