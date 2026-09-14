// permissions.mjs -- who may run what, and the human as the last word.
//
// Every session gets a canUseTool built here. File tools inside the workspace pass;
// the manager's writes are fenced to docs and .scratch; Bash passes when it matches the
// repo's allowlist; anything else becomes an agent.ask on the scene and waits for the
// human's `answer`. No answer within the timeout is a deny, never a silent allow.

import path from 'node:path';
import { make } from '../src/agents/events.js';
import { allowlistRules, commandAllowed, readOffice } from './office.mjs';

const FILE_TOOLS = new Set(['Read', 'Write', 'Edit', 'NotebookEdit', 'Glob', 'Grep']);
const FREE_TOOLS = new Set(['Skill', 'TodoWrite', 'WebSearch', 'WebFetch', 'Agent', 'Task', 'AskUserQuestion']);
const MANAGER_WRITE = [/(^|[\\/])CONTEXT\.md$/i, /(^|[\\/])CLAUDE\.md$/i, /(^|[\\/])docs[\\/]/i, /(^|[\\/])\.scratch[\\/]/i];

export class Approvals {
  constructor({ emit, timeoutMs = 10 * 60_000 }) {
    this.emit = emit;
    this.timeoutMs = timeoutMs;
    this.pending = new Map();   // askId -> resolve(boolean)
    this.n = 0;
  }

  /** Called by index.mjs when the scene sends { type: 'answer', askId, allow }. */
  answer(askId, allow) {
    const r = this.pending.get(askId);
    if (!r) return false;
    this.pending.delete(askId);
    r(!!allow);
    return true;
  }

  /** Called by index.mjs for { type: 'flow.answer', askId, text, answers } when the askId is one of ours. */
  answerText(askId, msg) {
    const r = this.pending.get(askId);
    if (!r) return false;
    this.pending.delete(askId);
    r(msg);
    return true;
  }

  /**
   * The model's AskUserQuestion: 1-4 multiple-choice questions. Surfaced to the scene as a
   * flow.ask of kind "choice"; the human's picks come back as updatedInput.answers, which is
   * exactly how the CLI's own permission UI feeds the tool.
   */
  askChoice({ agent, input, ticket }) {
    const askId = `ask_${Date.now()}_${++this.n}`;
    const questions = (input?.questions ?? []).map((q) => ({
      question: q.question, header: q.header, multiSelect: !!q.multiSelect,
      options: (q.options ?? []).map((o) => ({ label: o.label, description: o.description })),
    }));
    const text = questions.map((q, i) => (questions.length > 1 ? `${i + 1}. ` : '') + q.question).join('\n');
    this.emit(make('flow.ask', { askId, kind: 'choice', text, questions, agent, ticket: ticket ?? null }));
    return new Promise((resolve) => {
      this.pending.set(askId, resolve);
      setTimeout(() => { if (this.pending.delete(askId)) resolve(null); }, this.timeoutMs);
    });
  }

  ask({ agent, tool, summary, reason, ticket }) {
    const askId = `ask_${Date.now()}_${++this.n}`;
    this.emit(make('agent.ask', { agent, askId, tool, summary, reason, ticket: ticket ?? null }));
    return new Promise((resolve) => {
      this.pending.set(askId, resolve);
      setTimeout(() => { if (this.pending.delete(askId)) resolve(false); }, this.timeoutMs);
    });
  }

  /**
   * @param agent   crew id
   * @param repo    absolute workspace root for this session (the repo, or a worktree)
   * @param policy  office.md policy section
   * @param role    manager | impl | review | qa
   */
  canUseToolFor({ agent, repo, policy, role, ticket = null, policyRepo = repo }) {
    // the allowlist is read from docs/agents/office.md on every Bash call, so editing the
    // file takes effect for sessions already running
    const rules = () => allowlistRules(readOffice(policyRepo)?.policy ?? policy);
    const inside = (p) => {
      if (!p) return true;
      const abs = path.resolve(repo, String(p));
      return abs.startsWith(path.resolve(repo) + path.sep) || abs === path.resolve(repo);
    };
    return async (toolName, input) => {
      const deny = (message) => ({ behavior: 'deny', message });
      const allow = () => ({ behavior: 'allow', updatedInput: input });
      if (toolName === 'AskUserQuestion') {
        const reply = await this.askChoice({ agent, input, ticket });
        if (!reply) return deny('มนุษย์ไม่ได้ตอบภายในเวลา ให้ตัดสินใจด้วยค่าที่แนะนำและระบุสมมติฐานไว้');
        const answers = { ...(reply.answers ?? {}) };
        // free text with no picks: it answers the first question (the CLI does the same)
        const qs = input?.questions ?? [];
        if (!Object.keys(answers).length && reply.text && qs[0]) answers[qs[0].question] = reply.text;
        return { behavior: 'allow', updatedInput: { ...input, answers, ...(reply.text ? { response: reply.text } : {}) } };
      }
      if (FREE_TOOLS.has(toolName) || toolName.startsWith('mcp__')) return allow();
      if (FILE_TOOLS.has(toolName)) {
        const p = input?.file_path ?? input?.path;
        if (!inside(p)) return deny(`${toolName} นอก workspace: ${p}`);
        const writes = toolName === 'Write' || toolName === 'Edit' || toolName === 'NotebookEdit';
        if (writes && role === 'manager' && !MANAGER_WRITE.some((re) => re.test(String(p))))
          return deny('ผู้จัดการเขียนได้เฉพาะ CONTEXT.md, CLAUDE.md, docs/ และ .scratch/ งานโค้ดเป็นของ implementer');
        if (writes && role === 'review' && !/\.md$/i.test(String(p)))
          return deny('reviewer แก้ได้เฉพาะไฟล์ .md');
        if (writes && role === 'qa' && !/[\\/]\.scratch[\\/]/.test(String(p)))
          return deny('QA เขียนได้เฉพาะหลักฐานใน .scratch/');
        return allow();
      }
      if (toolName === 'Bash') {
        const cmd = String(input?.command ?? '');
        if (role === 'manager' && !/^\s*(git (status|log|diff|show)|gh (issue|pr) (list|view))\b/.test(cmd))
          return deny('ผู้จัดการใช้ Bash ได้เฉพาะ git status/log/diff/show และ gh อ่านอย่างเดียว');
        if (commandAllowed(cmd, rules())) return allow();
        const ok = await this.ask({ agent, tool: 'Bash', summary: cmd.slice(0, 800), ticket,
          reason: 'อยู่นอก allowlist ของโปรเจกต์ (docs/agents/office.md)' });
        return ok ? allow() : deny('มนุษย์ไม่อนุมัติคำสั่งนี้');
      }
      const ok = await this.ask({ agent, tool: toolName, summary: JSON.stringify(input).slice(0, 160), ticket, reason: 'เครื่องมือที่ไม่รู้จัก' });
      return ok ? allow() : deny('มนุษย์ไม่อนุมัติ');
    };
  }
}
