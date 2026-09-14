// office-client.mjs -- poke the Office Server from a terminal, no browser needed.
//
//   node scripts/office-client.mjs watch                      print every event
//   node scripts/office-client.mjs add <path|url> [branch]    register a repo and watch onboarding
//   node scripts/office-client.mjs say "<text>"               talk to the manager
//   node scripts/office-client.mjs answer <askId> "<text>"    answer a flow.ask
//   node scripts/office-client.mjs allow <askId> [yes|no]     decide a tool approval
//   node scripts/office-client.mjs next <phase>               spec | tickets | implement | done
//   node scripts/office-client.mjs recheck <step> [run|manager|skip]
//   node scripts/office-client.mjs cancel
//
// Every command keeps listening until Ctrl+C (or --once to exit after the first reply).

import WebSocket from 'ws';

const [, , cmd = 'watch', ...args] = process.argv;
const once = args.includes('--once');
const url = process.env.OFFICE_URL ?? 'ws://localhost:5181/office';
const now = () => Date.now();
const ws = new WebSocket(url);
let project = null;

const messages = {
  add: () => ({ type: 'project.add', path: args[0], mainBranch: args[1] ?? 'main' }),
  say: () => ({ type: 'command', text: args.join(' ') }),
  answer: () => ({ type: 'flow.answer', askId: args[0], text: args.slice(1).join(' '), approved: true }),
  allow: () => ({ type: 'answer', askId: args[0], allow: (args[1] ?? 'yes') !== 'no' }),
  next: () => ({ type: 'flow.next', phase: args[0] }),
  recheck: () => ({ type: 'project.recheck', project: project ?? '-', step: Number(args[0]), action: args[1] ?? 'run' }),
  cancel: () => ({ type: 'cancel' }),
};

let sent = !messages[cmd] || cmd === 'recheck';   // --once may only exit after our own message left the socket
ws.on('open', () => {
  console.log('connected', url);
  const m = messages[cmd];
  if (m && cmd !== 'recheck') ws.send(JSON.stringify({ v: 1, t: now(), ...m() }), () => { sent = true; });
});
const quit = () => { if (sent) process.exit(0); else setTimeout(quit, 50); };

ws.on('message', (d) => {
  const e = JSON.parse(String(d));
  if (e.type === 'hello') {
    project = e.project;
    console.log('hello', e.server, 'project=', e.project, 'phase=', e.phase, 'feature=', e.feature);
    if (cmd === "recheck") ws.send(JSON.stringify({ v: 1, t: now(), ...messages.recheck() }), () => { sent = true; });
    return;
  }
  if (e.type === 'project.status') {
    project = e.project;
    console.log(`project.status ${e.project} ${e.ready ? 'READY' : ''}`);
    for (const s of e.steps) console.log(`   ${s.n} ${s.state.padEnd(7)} ${s.title}${s.detail ? ' — ' + s.detail : ''}`);
    if (once && e.ready) quit();
    return;
  }
  const extra = e.text ?? e.summary ?? e.message ?? e.phase ?? e.path ?? (e.tickets ? `${e.tickets.length} tickets` : '');
  console.log(`${e.type}${e.agent ? ' [' + e.agent + ']' : ''}${e.askId ? ' askId=' + e.askId : ''} ${String(extra).replace(/\s+/g, ' ').slice(0, 300)}`);
  if (once && ["agent.say", "flow.ask", "error"].includes(e.type)) quit();
});

ws.on('error', (e) => { console.error('cannot connect:', e.message); process.exit(1); });
ws.on('close', () => process.exit(0));
