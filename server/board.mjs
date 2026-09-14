// board.mjs -- the ticket board, read straight from the local markdown tracker.
//
// Matt's local tracker (docs/agents/issue-tracker.md) puts one feature per
// .scratch/<feature>/ with spec.md and issues/<NN>-<slug>.md. Each issue carries a
// `Status:` line and a `Blocked by:` line near the top. This module turns that folder into
// the `tickets` array the scene's board expects, and writes claims back.

import fs from 'node:fs';
import path from 'node:path';

const STATUS_MAP = {
  'ready-for-agent': 'ready',
  'in-progress': 'in-progress',
  'claimed': 'in-progress',
  'review': 'review',
  'verify': 'verify',
  'done': 'done',
  'resolved': 'done',
  'ready-for-human': 'needs-human',
  'needs-human': 'needs-human',
  'blocked': 'blocked',
};

export function scratchDir(repo) { return path.join(repo, '.scratch'); }

/** Feature slugs that have an issues/ folder or a spec, newest first. */
export function listFeatures(repo) {
  const dir = scratchDir(repo);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => ({ slug: d.name, t: fs.statSync(path.join(dir, d.name)).mtimeMs,
      hasSpec: fs.existsSync(path.join(dir, d.name, 'spec.md')),
      hasIssues: fs.existsSync(path.join(dir, d.name, 'issues')) }))
    .sort((a, b) => b.t - a.t);
}

export function parseTicket(text, file) {
  const id = /^(\d+)-/.exec(path.basename(file))?.[1] ?? path.basename(file, '.md');
  const title = /^#\s+(?:\d+:\s*)?(.+)$/m.exec(text)?.[1]?.trim() ?? id;
  const status = /^\*{0,2}Status:?\*{0,2}\s*(.+)$/mi.exec(text)?.[1]?.trim().toLowerCase() ?? 'ready-for-agent';
  const blockedRaw = /^\*{0,2}Blocked by:?\*{0,2}\s*(.+)$/mi.exec(text)?.[1] ?? '';
  const blockedBy = /none/i.test(blockedRaw) ? [] : [...blockedRaw.matchAll(/\b(\d{2,})\b/g)].map((m) => m[1]);
  const assignee = /^\*{0,2}Assignee:?\*{0,2}\s*(\S+)/mi.exec(text)?.[1] ?? null;
  const attempt = Number(/^\*{0,2}Attempt:?\*{0,2}\s*(\d+)/mi.exec(text)?.[1] ?? 1);
  const delivers = /\*\*What to build:\*\*\s*([\s\S]*?)(?:\n\s*\n|\n\*\*)/.exec(text)?.[1]?.replace(/\s+/g, ' ').trim() ?? '';
  const criteria = [...text.matchAll(/^- \[( |x)\]\s+(.+)$/gm)].map((m) => ({ text: m[2].trim(), pass: m[1] === 'x' }));
  return { id, title, status: STATUS_MAP[status] ?? 'ready', rawStatus: status, blockedBy, assignee, attempt, delivers, criteria, file };
}

/** All tickets of a feature, with `blocked` derived for anything whose blockers are not done. */
export function readBoard(repo, feature) {
  const dir = path.join(scratchDir(repo), feature, 'issues');
  if (!fs.existsSync(dir)) return [];
  const tickets = fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort()
    .map((f) => parseTicket(fs.readFileSync(path.join(dir, f), 'utf8'), path.join(dir, f)));
  const done = new Set(tickets.filter((t) => t.status === 'done').map((t) => t.id));
  for (const t of tickets) {
    if (t.status === 'ready' && !t.blockedBy.every((b) => done.has(b))) t.status = 'blocked';
  }
  return tickets;
}

/** Rewrite (or insert) a `Key: value` line near the top of a ticket file. */
export function setTicketField(file, key, value) {
  let text = fs.readFileSync(file, 'utf8');
  const re = new RegExp(`^(\\*{0,2}${key}:?\\*{0,2}\\s*).*$`, 'mi');
  if (re.test(text)) text = text.replace(re, `$1${value}`);
  else {
    // after the Blocked by line, or after the title
    const anchor = /^\*{0,2}Blocked by:?\*{0,2}.*$/mi.exec(text) ?? /^#.*$/m.exec(text);
    const at = anchor ? anchor.index + anchor[0].length : 0;
    text = text.slice(0, at) + `\n\n**${key}:** ${value}` + text.slice(at);
  }
  fs.writeFileSync(file, text);
}

export function claimTicket(file, agent) {
  setTicketField(file, 'Status', 'in-progress');
  setTicketField(file, 'Assignee', agent);
}

export function appendComment(file, text) {
  let body = fs.readFileSync(file, 'utf8');
  if (!/^## Comments/m.test(body)) body = body.replace(/\s*$/, '\n\n## Comments\n');
  body = body.replace(/\s*$/, `\n\n${text.trim()}\n`);
  fs.writeFileSync(file, body);
}

/** Watch a feature's issues folder; `cb()` is debounced so one save does not fire twice. */
export function watchBoard(repo, feature, cb) {
  const dir = path.join(scratchDir(repo), feature, 'issues');
  if (!fs.existsSync(dir)) return () => {};
  let timer = 0;
  const w = fs.watch(dir, () => { clearTimeout(timer); timer = setTimeout(cb, 250); });
  return () => w.close();
}
