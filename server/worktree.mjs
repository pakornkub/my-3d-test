// worktree.mjs -- one git worktree per ticket, branched from the feature branch.
//
//   main ──► feature/<slug> ──► ticket/<slug>-<NN>   (worktree .worktrees/<slug>-<NN>)
//
// A closed ticket merges into the feature branch at once (--no-ff), and every other open
// ticket worktree is rebased onto it, so two implementers never drift for long. Merging
// the feature branch into main is the human's call (the `merge` message).

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import net from 'node:net';

const git = (repo, args, opts = {}) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim();
const tryGit = (repo, args) => { try { return git(repo, args); } catch { return null; } };

export const WORKTREES = '.worktrees';
export const featureBranch = (feature) => `feature/${feature}`;
export const ticketBranch = (feature, id) => `ticket/${feature}-${id}`;

export function branchExists(repo, name) {
  return tryGit(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`]) !== null;
}

/** feature/<slug> from the main branch if it does not exist yet. */
export function ensureFeatureBranch(repo, feature, mainBranch = 'main') {
  const b = featureBranch(feature);
  if (!branchExists(repo, b)) git(repo, ['branch', b, mainBranch]);
  return b;
}

/** Where a worktree for this ticket lives (may not exist yet). */
export function worktreePath(repo, feature, id) {
  return path.join(repo, WORKTREES, `${feature}-${id}`);
}

/**
 * Create (or reuse) the worktree for a ticket. A fresh attempt gets a fresh branch tip:
 * the previous branch is kept as ticket/<slug>-<NN>-attempt<k> for forensics.
 */
export function createTicketWorktree(repo, feature, id, { mainBranch = 'main', attempt = 1, install = true, commands = {} } = {}) {
  const fb = ensureFeatureBranch(repo, feature, mainBranch);
  const tb = ticketBranch(feature, id);
  const wt = worktreePath(repo, feature, id);
  fs.mkdirSync(path.join(repo, WORKTREES), { recursive: true });
  if (fs.existsSync(wt)) removeTicketWorktree(repo, feature, id, { keepBranch: false });
  if (branchExists(repo, tb)) {
    if (attempt > 1) tryGit(repo, ['branch', '-m', tb, `${tb}-attempt${attempt - 1}`]);
    else tryGit(repo, ['branch', '-D', tb]);
  }
  git(repo, ['worktree', 'add', '-b', tb, wt, fb]);
  const log = [];
  if (install && fs.existsSync(path.join(wt, 'package.json'))) {
    const hasLock = fs.existsSync(path.join(wt, 'package-lock.json'));
    execFileSync('npm', [hasLock ? 'ci' : 'install', '--no-audit', '--no-fund', '--prefer-offline'], { cwd: wt, stdio: 'ignore', shell: process.platform === 'win32', timeout: 300_000 });
    log.push('npm install');
  }
  if (commands.db) {
    try { execFileSync(commands.db, { cwd: wt, stdio: 'ignore', shell: true, timeout: 180_000 }); log.push('db'); }
    catch (e) { log.push('db failed: ' + (e.message ?? e)); }
  }
  return { path: wt, branch: tb, feature: fb, log };
}

export function removeTicketWorktree(repo, feature, id, { keepBranch = true } = {}) {
  const wt = worktreePath(repo, feature, id);
  tryGit(repo, ['worktree', 'remove', '--force', wt]);
  try { fs.rmSync(wt, { recursive: true, force: true }); } catch { /* gone */ }
  tryGit(repo, ['worktree', 'prune']);
  if (!keepBranch) tryGit(repo, ['branch', '-D', ticketBranch(feature, id)]);
}

/** Commits the implementer left on the ticket branch that the feature branch does not have. */
export function ticketCommits(repo, feature, id) {
  const out = tryGit(repo, ['log', '--oneline', `${featureBranch(feature)}..${ticketBranch(feature, id)}`]);
  return out ? out.split('\n').filter(Boolean) : [];
}

export function diffStat(repo, base, head) {
  return tryGit(repo, ['diff', '--stat', `${base}...${head}`]) ?? '';
}

export function diffPatch(repo, base, head, max = 60_000) {
  const p = tryGit(repo, ['diff', `${base}...${head}`], { maxBuffer: 50 * 1024 * 1024 }) ?? '';
  return p.length > max ? p.slice(0, max) + `\n… (${p.length - max} more bytes)` : p;
}

/** The feature branch checked out in its own worktree, so merges never touch the repo's main checkout. */
export function featureWorktree(repo, feature, mainBranch = 'main') {
  const fb = ensureFeatureBranch(repo, feature, mainBranch);
  const wt = path.join(repo, WORKTREES, `${feature}`);
  if (!fs.existsSync(wt)) {
    fs.mkdirSync(path.join(repo, WORKTREES), { recursive: true });
    git(repo, ['worktree', 'add', wt, fb]);
  }
  return { path: wt, branch: fb };
}

/**
 * Merge a closed ticket into the feature branch. Returns { ok, conflict, files } and leaves
 * a conflicting merge aborted, never half-done.
 */
export function mergeTicket(repo, feature, id, { mainBranch = 'main', message } = {}) {
  const fw = featureWorktree(repo, feature, mainBranch);
  const tb = ticketBranch(feature, id);
  try {
    git(fw.path, ['merge', '--no-ff', '-m', message ?? `Merge ${tb}`, tb]);
    return { ok: true, conflict: false, files: [] };
  } catch (e) {
    const files = (tryGit(fw.path, ['diff', '--name-only', '--diff-filter=U']) ?? '').split('\n').filter(Boolean);
    tryGit(fw.path, ['merge', '--abort']);
    return { ok: false, conflict: true, files, error: String(e.stderr ?? e.message ?? e).slice(-400) };
  }
}

/** Rebase every other open ticket worktree onto the feature branch. Conflicts are aborted and reported. */
export function rebaseOpenTickets(repo, feature, exceptId, openIds) {
  const results = [];
  for (const id of openIds) {
    if (id === exceptId) continue;
    const wt = worktreePath(repo, feature, id);
    if (!fs.existsSync(wt)) continue;
    const dirty = tryGit(wt, ['status', '--porcelain']);
    if (dirty) { results.push({ id, ok: false, reason: 'dirty worktree' }); continue; }
    try { git(wt, ['rebase', featureBranch(feature)]); results.push({ id, ok: true }); }
    catch (e) { tryGit(wt, ['rebase', '--abort']); results.push({ id, ok: false, reason: String(e.stderr ?? e.message ?? e).slice(-300) }); }
  }
  return results;
}

/** Merge the feature branch into main in the repo's own checkout (must be clean and on main). */
export function mergeFeatureToMain(repo, feature, mainBranch = 'main') {
  const cur = tryGit(repo, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (cur !== mainBranch) return { ok: false, error: `repo อยู่ที่ branch ${cur} ไม่ใช่ ${mainBranch}` };
  if (tryGit(repo, ['status', '--porcelain', '--untracked-files=no'])) return { ok: false, error: 'working tree ของ repo ไม่สะอาด commit หรือ stash ก่อน' };
  try {
    git(repo, ['merge', '--no-ff', '-m', `Merge ${featureBranch(feature)}`, featureBranch(feature)]);
    return { ok: true };
  } catch (e) {
    tryGit(repo, ['merge', '--abort']);
    return { ok: false, error: String(e.stderr ?? e.message ?? e).slice(-400) };
  }
}

/** `gh pr create` when the CLI exists and is logged in; otherwise a clear "not available". */
export function openPullRequest(repo, feature, { mainBranch = 'main', title, body } = {}) {
  try {
    execFileSync('gh', ['auth', 'status'], { cwd: repo, stdio: 'ignore' });
  } catch { return { ok: false, error: 'gh CLI ไม่มีหรือยังไม่ได้ login' }; }
  try {
    git(repo, ['push', '-u', 'origin', featureBranch(feature)]);
    const url = execFileSync('gh', ['pr', 'create', '--base', mainBranch, '--head', featureBranch(feature), '--title', title ?? `feature: ${feature}`, '--body', body ?? ''], { cwd: repo, encoding: 'utf8' }).trim();
    return { ok: true, url };
  } catch (e) { return { ok: false, error: String(e.stderr ?? e.message ?? e).slice(-300) }; }
}

/** Start the project's dev server inside a worktree on a given port; resolves with a stop() once it answers. */
export function startDevServer(command, cwd, port, timeoutMs = 40_000) {
  const cmd = command.replace('{port}', String(port));
  const child = spawn(cmd, { cwd, shell: true, stdio: 'ignore', windowsHide: true, env: { ...process.env, BROWSER: 'none', CI: '1', PORT: String(port) } });
  const stop = () => {
    if (process.platform === 'win32') { try { execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* gone */ } }
    try { child.kill(); } catch { /* gone */ }
  };
  return new Promise((resolve) => {
    const started = Date.now();
    let settled = false;
    const done = (ok) => { if (settled) return; settled = true; clearInterval(iv); if (!ok) stop(); resolve(ok ? { url: `http://localhost:${port}`, stop } : null); };
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
