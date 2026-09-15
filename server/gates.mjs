// gates.mjs -- the checks the harness runs itself before a ticket may close.
//
// A model saying "12 passed" is a claim; this module produces the evidence. Every command
// in docs/agents/office.md that exists (test, typecheck, e2e) runs in the ticket's
// worktree, and the report's evidence section is filled from these results only.

import { spawn } from 'node:child_process';

const TAIL = (s, n = 1500) => (s.length > n ? '…' + s.slice(-n) : s);

export function runCommand(command, cwd, { timeoutMs = 300_000, env = {} } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(command, { cwd, shell: true, windowsHide: true, env: { ...process.env, CI: '1', BROWSER: 'none', ...env } });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } out += '\n[timeout]'; }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, pass: code === 0, output: TAIL(out.trim()), ms: Date.now() - started });
    });
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, pass: false, output: String(e.message ?? e), ms: Date.now() - started }); });
  });
}

/**
 * @param commands  office.commands
 * @param which     gate names to run, in order; missing commands are skipped, not failed
 * @param onResult  (gate, result) called as each finishes
 * @param port      a port this worktree may bind (two tickets run gates at once): `{port}` in a
 *                  command is replaced and the child gets it as PORT, so an e2e config can read
 *                  process.env.PORT instead of hard-coding one
 * @returns [{ gate, pass, output, ms }]
 */
export async function runGates(cwd, commands, { which = ['typecheck', 'test', 'e2e'], onResult = () => {}, env = {}, port } = {}) {
  const results = [];
  const portEnv = port ? { PORT: String(port) } : {};
  for (const gate of which) {
    const raw = commands?.[gate];
    if (!raw) continue;
    const cmd = port ? raw.replace(/\{port\}/g, String(port)) : raw;
    const r = await runCommand(cmd, cwd, { env: { ...portEnv, ...env } });
    const row = { gate, pass: r.pass, output: r.output, ms: r.ms, command: cmd };
    results.push(row);
    onResult(gate, row);
  }
  return results;
}

export const allPassed = (results) => results.every((r) => r.pass);
export const failed = (results) => results.filter((r) => !r.pass);
