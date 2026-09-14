// team.mjs -- team/<id>.md -> Agent SDK definitions.
//
// The files use Claude Code's subagent frontmatter (name, description, tools, model,
// skills) followed by the system prompt, so the same folder could be dropped into
// .claude/agents/ and used from the CLI. Only the manager is not a subagent: their
// prompt becomes the system prompt of the long-lived upstream session.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const TEAM_DIR = path.resolve(here, '..', 'team');

/** Minimal YAML-ish frontmatter: scalars, and `key:\n  - item` lists. */
export function parseAgentFile(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) throw new Error('missing frontmatter');
  const meta = {};
  let listKey = null;
  for (const raw of m[1].split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) continue;
    const item = /^\s+-\s+(.*)$/.exec(line);
    if (item && listKey) { meta[listKey].push(item[1].trim()); continue; }
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const [, k, v] = kv;
    if (v === '') { meta[k] = []; listKey = k; }
    else { meta[k] = v.trim(); listKey = null; }
  }
  if (typeof meta.tools === 'string') meta.tools = meta.tools.split(',').map((s) => s.trim()).filter(Boolean);
  if (typeof meta.skills === 'string') meta.skills = meta.skills.split(',').map((s) => s.trim()).filter(Boolean);
  return { meta, prompt: m[2].trim() };
}

export function loadTeam(dir = TEAM_DIR) {
  const team = {};
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.md')) continue;
    const { meta, prompt } = parseAgentFile(fs.readFileSync(path.join(dir, f), 'utf8'));
    const id = meta.name ?? path.basename(f, '.md');
    team[id] = { id, ...meta, prompt, file: path.join(dir, f) };
  }
  return team;
}

/** The `agents` option for query(): everyone except the manager. */
export function agentDefinitions(team) {
  const out = {};
  for (const [id, a] of Object.entries(team)) {
    if (id === 'manager') continue;
    out[id] = {
      description: a.description,
      prompt: a.prompt,
      ...(a.tools ? { tools: a.tools } : {}),
      ...(a.model ? { model: a.model } : {}),
      ...(a.skills?.length ? { skills: a.skills } : {}),
    };
  }
  return out;
}

/** Fingerprint of the team folder, logged on every agent.start so a ticket can be traced to its prompts. */
export function teamHash(dir = TEAM_DIR) {
  const { createHash } = require_('node:crypto');
  const h = createHash('sha1');
  for (const f of fs.readdirSync(dir).sort()) if (f.endsWith('.md')) h.update(fs.readFileSync(path.join(dir, f)));
  return h.digest('hex').slice(0, 10);
}

import { createRequire } from 'node:module';
const require_ = createRequire(import.meta.url);
