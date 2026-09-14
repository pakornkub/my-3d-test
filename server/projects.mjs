// projects.mjs -- the registry of repos the team can work on.
//
// One entry per repo. Everything that is *about the repo* (commands, allowlist, verify
// level) lives inside the repo at docs/agents/office.md so it travels with it; this file
// only knows where the repo is.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const REGISTRY = path.join(here, 'projects.json');
export const PROJECTS_DIR = path.resolve(here, '..', 'projects');

export function loadRegistry() {
  try { return JSON.parse(fs.readFileSync(REGISTRY, 'utf8')); }
  catch { return { current: null, projects: [] }; }
}

export function saveRegistry(reg) {
  fs.writeFileSync(REGISTRY, JSON.stringify(reg, null, 2) + '\n');
}

/** Register a repo by local path (must exist) or by clone URL (cloned into projects/<id>). */
export function addProject(reg, { id, source, mainBranch = 'main' }) {
  if (!id || !/^[a-z0-9._-]+$/i.test(id)) throw new Error('project id must be [a-z0-9._-]');
  if (reg.projects.some((p) => p.id === id)) throw new Error(`project "${id}" already registered`);
  let repoPath;
  if (/^(https?:|git@)/.test(source)) {
    repoPath = path.join(PROJECTS_DIR, id);
    fs.mkdirSync(PROJECTS_DIR, { recursive: true });
    if (!fs.existsSync(repoPath)) {
      const { execFileSync } = require_('node:child_process');
      execFileSync('git', ['clone', source, repoPath], { stdio: 'inherit' });
    }
  } else {
    repoPath = path.resolve(source);
    if (!fs.existsSync(path.join(repoPath, '.git'))) throw new Error(`${repoPath} is not a git repository`);
  }
  const project = { id, path: repoPath, mainBranch, addedAt: new Date().toISOString() };
  reg.projects.push(project);
  if (!reg.current) reg.current = id;
  saveRegistry(reg);
  return project;
}

export function currentProject(reg) {
  return reg.projects.find((p) => p.id === reg.current) ?? null;
}

// tiny helper so this module stays ESM but can require a builtin lazily
import { createRequire } from 'node:module';
const require_ = createRequire(import.meta.url);
