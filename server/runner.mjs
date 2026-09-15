// runner.mjs -- one Agent SDK session, as the scene sees it.
//
// Wraps query() in streaming-input mode so a session can take follow-up turns, and turns
// the SDK's message stream into the scene's events: tool_use -> agent.tool, text ->
// agent.say, result -> session.cost. Everything the SDK knows about the session (id,
// cost, last text, whether a turn is in flight) is exposed on the instance so flow.mjs can
// run its state machine without ever touching SDK types.

import { query } from '@anthropic-ai/claude-agent-sdk';
import { make } from '../src/agents/events.js';
import { costFields } from './costs.mjs';

const SHORT = (s, n = 90) => (s && s.length > n ? s.slice(0, n - 1) + '…' : s ?? '');

/** A one-line human summary of a tool call, for the bubble over the head. Paths are shown relative to `cwd`. */
export function summarizeTool(name, input = {}, cwd = null) {
  const rel = (p) => {
    if (!p) return '';
    let s = String(p).replace(/\\/g, '/');
    const root = cwd ? String(cwd).replace(/\\/g, '/').replace(/\/$/, '') + '/' : null;
    if (root && s.toLowerCase().startsWith(root.toLowerCase())) return s.slice(root.length);
    return s.split('/').slice(-3).join('/');
  };
  switch (name) {
    case 'Read': case 'Write': case 'Edit': case 'NotebookEdit': return rel(input.file_path ?? input.path);
    case 'Bash': return SHORT(input.description || input.command, 70);
    case 'Grep': return `"${SHORT(input.pattern, 30)}"${input.path ? ' ใน ' + rel(input.path) : ''}`;
    case 'Glob': return input.pattern ?? '';
    case 'Skill': return `เปิดคู่มือ ${input.skill ?? input.name ?? ''}`;
    case 'Agent': case 'Task': return `มอบงาน: ${SHORT(input.description ?? input.prompt, 60)}`;
    case 'WebFetch': return SHORT(input.url, 60);
    case 'WebSearch': return SHORT(input.query, 60);
    case 'TodoWrite': return 'อัปเดตรายการงาน';
    default: return SHORT(JSON.stringify(input), 60);
  }
}

export class Session {
  /**
   * @param agent    crew id this session speaks as (manager, eng_m1, ...)
   * @param emit     (event) => void
   * @param onFile   (path) => void after a Write/Edit lands, for docs/board refresh
   * @param costSeed this session's own running total as of the last time it was logged today
   *                 (looked up by session id, falling back to the plain agent id only for a
   *                 legacy entry that predates the `session` field, ADR-0001) -- so resuming
   *                 it after a restart never makes the figure the scene shows jump backwards.
   *                 The SDK documents `total_cost_usd` as starting fresh on a resumed session
   *                 (see SDKResultMessage in the Agent SDK type declarations), so a fresh
   *                 process must re-add the seed rather than read total_cost_usd alone.
   * @param options  everything for query(): cwd, model, systemPrompt, agents, allowedTools,
   *                 disallowedTools, permissionMode, canUseTool, settingSources, skills,
   *                 mcpServers, maxTurns, maxBudgetUsd, resume, env
   */
  constructor({ agent, emit, onFile = () => {}, stallMinutes = 6, timeoutMinutes = 0, ticket = null, costSeed = 0, options = {} }) {
    this.agent = agent;
    this.emit = emit;
    this.onFile = onFile;
    this.stallMs = stallMinutes * 60_000;
    this.timeoutMs = timeoutMinutes * 60_000;     // 0 = no hard limit
    this.ticket = ticket;
    this.turnStarted = 0;
    this.timedOut = false;
    this.options = options;
    this.sessionId = options.resume ?? null;
    this.costSeed = costSeed;
    this.costUsd = costSeed;
    this.turns = 0;
    this.busy = false;
    this.lastText = '';
    this.lastActivity = Date.now();
    this.closed = false;
    this.queue = [];
    this.wake = null;
    this.turnWaiters = [];
    this.init = null;          // the system/init message, for slash_commands and tools
    this.abort = new AbortController();
    this.stalledFlag = false;
  }

  // ---------------------------------------------------------------- input
  async *#input() {
    while (!this.closed) {
      if (this.queue.length) { yield this.queue.shift(); continue; }
      await new Promise((r) => { this.wake = r; });
    }
  }

  /** Queue a user turn. Resolves with the SDK result message when that turn finishes. */
  send(text) {
    this.queue.push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null });
    this.busy = true;
    this.stalledFlag = false;
    this.timedOut = false;
    this.turnStarted = Date.now();
    this.lastActivity = Date.now();
    this.wake?.();
    return new Promise((resolve) => this.turnWaiters.push(resolve));
  }

  /** Start consuming the SDK stream. Resolves when the session ends (close() or error). */
  async start() {
    const hooks = {
      PostToolUse: [{ matcher: 'Write|Edit|NotebookEdit', hooks: [async (input) => {
        const p = input.tool_input?.file_path ?? input.tool_input?.path;
        if (p) this.onFile(String(p));
        return {};
      }] }],
      ...(this.options.hooks ?? {}),
    };
    const q = query({
      prompt: this.#input(),
      options: {
        ...this.options,
        hooks,
        abortController: this.abort,
        includePartialMessages: false,
      },
    });
    this.query = q;
    this.stallTimer = setInterval(() => this.#checkStall(), 20_000);
    try {
      for await (const msg of q) this.#onMessage(msg);
    } catch (e) {
      if (!this.closed) this.emit(make('error', { agent: this.agent, message: `session: ${e.message ?? e}` }));
    } finally {
      clearInterval(this.stallTimer);
      this.busy = false;
      for (const r of this.turnWaiters.splice(0)) r({ type: 'result', subtype: 'error_during_execution', ended: true });
    }
  }

  #checkStall() {
    if (!this.busy) return;
    if (this.timeoutMs && !this.timedOut && Date.now() - this.turnStarted > this.timeoutMs) {
      // a hard ceiling per turn: interrupt, and let the caller decide on a retry
      this.timedOut = true;
      this.emit(make('agent.stalled', { agent: this.agent, ticket: this.ticket ?? null, minutes: Math.round(this.timeoutMs / 60_000), reason: 'timeout' }));
      this.interrupt();
      return;
    }
    if (this.stalledFlag) return;
    if (Date.now() - this.lastActivity > this.stallMs) {
      this.stalledFlag = true;
      this.emit(make('agent.stalled', { agent: this.agent, ticket: this.ticket ?? null, minutes: Math.round(this.stallMs / 60_000) }));
    }
  }

  // ---------------------------------------------------------------- output
  #onMessage(msg) {
    this.lastActivity = Date.now();
    switch (msg.type) {
      case 'system':
        if (msg.subtype === 'init') {
          this.init = msg;
          this.sessionId = msg.session_id;
          console.info(`[${this.agent}] session ${msg.session_id} model=${msg.model} tools=${msg.tools?.length} commands=${msg.slash_commands?.length} key=${msg.apiKeySource}`);
        }
        break;
      case 'assistant': {
        if (msg.parent_tool_use_id) break;              // subagent chatter is reported by its own session
        for (const block of msg.message?.content ?? []) {
          if (block.type === 'tool_use') {
            this.emit(make('agent.tool', { agent: this.agent, ticket: this.ticket ?? null, tool: block.name, summary: summarizeTool(block.name, block.input, this.options.cwd) }));
          } else if (block.type === 'text' && block.text?.trim()) {
            this.lastText = block.text.trim();
            // the account's usage / session limit: not the agent's fault, the caller should pause and retry later
            if (/hit your (session|usage) limit|usage limit reached|rate limit/i.test(this.lastText)) this.limited = true;
            this.emit(make('agent.say', { agent: this.agent, ticket: this.ticket ?? null, text: this.lastText }));
          }
        }
        break;
      }
      case 'result': {
        this.turns += msg.num_turns ?? 1;
        if (msg.session_id) this.sessionId = msg.session_id;
        if (typeof msg.total_cost_usd === 'number') {
          this.costUsd = this.costSeed + msg.total_cost_usd;
          // tag the session id so this running total keys itself in state.mjs (ADR-0002)
          // instead of collapsing onto the plain agent id, which would make a second
          // session of the same agent overwrite the first rather than add to it
          this.emit(make('session.cost', { ...costFields(this.agent, this.costUsd, this.sessionId), turns: this.turns }));
        }
        if (msg.subtype !== 'success') {
          this.emit(make('error', { agent: this.agent, message: `${msg.subtype}: ${SHORT(msg.result ?? msg.errors?.join('; ') ?? '', 200)}` }));
        }
        this.busy = false;
        for (const r of this.turnWaiters.splice(0)) r(msg);
        break;
      }
      default:
        break;
    }
  }

  /** True when the CLI registered this slash command (plugin skills show up namespaced). */
  hasCommand(name) {
    const list = this.init?.slash_commands ?? [];
    const bare = name.replace(/^\//, '');
    return list.some((c) => c.replace(/^\//, '') === bare);
  }

  async interrupt() { try { await this.query?.interrupt(); } catch { /* not running */ } }

  close() {
    this.closed = true;
    this.wake?.();
    this.abort.abort();
    try { this.query?.close(); } catch { /* already closed */ }
  }
}
