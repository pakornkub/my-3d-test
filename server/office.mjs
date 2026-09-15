// office.mjs -- docs/agents/office.md: the per-repo contract the team runs against.
//
// Lives inside the repo (next to Matt's docs/agents/*.md) so it is versioned with the
// project. Sections are `## Name` followed by `key: value` lines; unknown keys are kept.

import fs from 'node:fs';
import path from 'node:path';

export const OFFICE_FILE = 'docs/agents/office.md';

export const DEFAULTS = {
  commands: { dev: '', test: '', typecheck: '', e2e: '', db: '' },
  worktree: { 'port-base': '3100', 'db-per-worktree': 'none', 'env-template': '' },
  policy: {
    verify: 'scripted',
    'bash-allowlist': 'cd, npm, npx, node, git status, git diff, git log, git add, git commit, git stash, ls, cat, head, tail, grep, wc, echo, find, dir',
    'daily-budget-usd': '10',
    'stall-minutes': '6',
    'max-turns': '60',
    'max-parallel': '2',        // implementers working at once
    'ticket-timeout-min': '30', // one implementer turn may not run longer than this
    'ticket-budget-usd': '4',   // per session
    'fix-rounds': '3',          // gate/review/verify fix loops before escalating
    'attempts': '2',            // fresh sessions per ticket before escalating
  },
};

export function parseOffice(text) {
  const out = { commands: {}, worktree: {}, policy: {} };
  let section = null;
  for (const raw of text.split(/\r?\n/)) {
    const h = /^##\s+(\w+)/.exec(raw);
    if (h) { section = h[1].toLowerCase(); if (!out[section]) out[section] = {}; continue; }
    const kv = /^([\w-]+):\s*(.*?)\s*(?:#.*)?$/.exec(raw);
    if (kv && section) out[section][kv[1]] = kv[2].trim();
  }
  return out;
}

export function readOffice(repo) {
  const file = path.join(repo, OFFICE_FILE);
  if (!fs.existsSync(file)) return null;
  const o = parseOffice(fs.readFileSync(file, 'utf8'));
  return {
    commands: { ...DEFAULTS.commands, ...o.commands },
    worktree: { ...DEFAULTS.worktree, ...o.worktree },
    policy: { ...DEFAULTS.policy, ...o.policy },
  };
}

export function renderOffice(o) {
  const sec = (name, obj, comments = {}) => `## ${name}\n` + Object.entries(obj)
    .map(([k, v]) => `${k}: ${v}${comments[k] ? `    # ${comments[k]}` : ''}`).join('\n');
  return `# Office\n\nสิ่งที่ทีม agent ต้องรู้เกี่ยวกับ repo นี้ แก้ไฟล์นี้ได้เลย server อ่านใหม่ทุกครั้งที่เริ่มงาน\n\n`
    + sec('Commands', o.commands, { dev: 'ใช้ {port} แทนพอร์ต', db: 'รันในทุก worktree ใหม่' }) + '\n\n'
    + sec('Worktree', o.worktree, { 'db-per-worktree': 'none | sqlite-file | postgres-docker | shared' }) + '\n\n'
    + sec('Policy', o.policy, { verify: 'none | scripted | exploratory', 'bash-allowlist': 'คั่นด้วย , จับคู่ตามคำขึ้นต้น' }) + '\n';
}

export function writeOffice(repo, o) {
  const file = path.join(repo, OFFICE_FILE);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, renderOffice(o));
  return file;
}

/** Best-effort guesses from package.json / pyproject so onboarding has something to show. */
export function guessCommands(repo) {
  const c = { ...DEFAULTS.commands };
  const pkgFile = path.join(repo, 'package.json');
  if (fs.existsSync(pkgFile)) {
    const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
    const s = pkg.scripts ?? {};
    if (s.dev) c.dev = 'npm run dev -- --port {port}';
    else if (s.start) c.dev = 'npm start';
    if (s.test && !/no test specified/.test(s.test)) c.test = 'npm test';
    if (s.typecheck) c.typecheck = 'npm run typecheck';
    else if (fs.existsSync(path.join(repo, 'tsconfig.json'))) c.typecheck = 'npx tsc --noEmit';
    if (s.e2e) c.e2e = 'npm run e2e';
    else if (pkg.devDependencies?.['@playwright/test']) c.e2e = 'npx playwright test';
    if (pkg.dependencies?.['@prisma/client'] || pkg.devDependencies?.prisma) c.db = 'npx prisma migrate dev';
  } else if (fs.existsSync(path.join(repo, 'pyproject.toml'))) {
    c.test = 'python -m pytest';
  }
  return c;
}

/**
 * daily-budget-usd as a number; undefined when the repo has no office file. One number, two
 * uses (CONTEXT.md): the session's hard cap (ensureManager) and the panel's display
 * denominator (Flow#snapshot) both read it here instead of each parsing the policy string.
 */
export function dailyBudgetUsd(office) {
  return office ? Number(office.policy['daily-budget-usd']) : undefined;
}

/** Split "npm, npx prisma, git status" into prefix rules; a command is allowed when it starts with one. */
export function allowlistRules(policy) {
  return (policy['bash-allowlist'] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}

export function commandAllowed(command, rules) {
  const cmd = command.trim().replace(/^\(|\)$/g, '');
  // never let a chained/ piped command sneak through on the strength of its first word
  const parts = cmd.split(/\s*(?:&&|\|\||;|\|)\s*/);
  return parts.every((p) => rules.some((r) => p === r || p.startsWith(r + ' ')))
    && !/\bgit\s+push\b/.test(cmd) && !/\brm\s+-rf\b/.test(cmd);
}
