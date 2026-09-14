// panel.js -- the team dock: chat with the manager, ticket board, docs, project checklist,
// and the "TV" (reports and verify results). Plain DOM, same as ui.js.
//
// The Director calls in (transcript, ask, approval, board, docs, project, tv, report,
// phase, status); the panel calls out through the handlers passed to createPanel, and it
// never touches the 3D scene.

import { PHASES, PHASE_LABEL, STATUS_LABEL, ROLE, ROLE_LABEL } from './team.js';

const TAB_LABEL = { chat: 'คุย', board: 'บอร์ด', docs: 'เอกสาร', project: 'โปรเจกต์', tv: 'TV' };
const COLS = [
  ['ready', 'พร้อมหยิบ'], ['blocked', 'รอใบอื่น'], ['in-progress', 'กำลังทำ'],
  ['review', 'รีวิว'], ['verify', 'ตรวจรับ'], ['done', 'เสร็จ'], ['needs-human', 'ต้องให้คน'],
];

const NEXT_OF = { grill: ['spec', 'เขียนสเปก'], spec: ['tickets', 'แตกเป็น ticket'], tickets: ['implement', 'ให้ทีมลงมือ'], implement: ['done', 'ปิดงาน'] };

export function createPanel({ labels, onCommand, onFlowAnswer, onAnswer, onMock, onTab, onNext, onProjectAdd, onProjectSelect, onRecheck, onCancel, onMerge }) {
  const root = document.getElementById('panel');
  const tabs = root.querySelector('.tabs');
  const sections = Object.fromEntries([...root.querySelectorAll('section[data-tab]')].map((s) => [s.dataset.tab, s]));
  const modeEl = root.querySelector('.mode');
  const teamCostEl = root.querySelector('.teamcost');
  const transcriptEl = sections.chat.querySelector('.transcript');
  const askEl = sections.chat.querySelector('.ask');
  const composer = sections.chat.querySelector('form.composer');
  const composerInput = composer.querySelector('input');
  const phaseStrip = sections.chat.querySelector('.phase-strip');
  const boardEl = sections.board;
  const docsEl = sections.docs;
  const projectEl = sections.project;
  const tvEl = sections.tv;
  const mockbar = root.querySelector('.mockbar');
  const toggle = document.getElementById('panel-toggle');
  const badge = toggle.querySelector('.badge');

  let current = 'chat';
  const unread = {};
  const docs = new Map();
  const reports = [];
  let statuses = {};

  // ---------------------------------------------------------------- tabs / open
  tabs.replaceChildren(...Object.keys(TAB_LABEL).map((k) => {
    const b = document.createElement('button');
    b.dataset.tab = k;
    b.innerHTML = `<span>${TAB_LABEL[k]}</span><i class="dot"></i>`;
    b.addEventListener('click', () => open(k));
    return b;
  }));

  function open(tab = current) {
    current = tab;
    for (const b of tabs.children) b.classList.toggle('on', b.dataset.tab === tab);
    for (const [k, s] of Object.entries(sections)) s.hidden = k !== tab;
    unread[tab] = 0;
    refreshDots();
    root.classList.add('open');
    document.body.classList.add('panel-open');
    toggle.classList.add('on');
    onTab?.(tab);
  }
  function close() {
    root.classList.remove('open');
    document.body.classList.remove('panel-open');
    toggle.classList.remove('on');
  }
  function mark(tab) {
    if (!root.classList.contains('open') || current !== tab) unread[tab] = (unread[tab] ?? 0) + 1;
    refreshDots();
  }
  function refreshDots() {
    for (const b of tabs.children) b.classList.toggle('unread', (unread[b.dataset.tab] ?? 0) > 0);
    const total = Object.values(unread).reduce((a, b) => a + b, 0);
    badge.textContent = total ? String(total) : '';
    badge.hidden = !total;
  }
  toggle.addEventListener('click', () => (root.classList.contains('open') ? close() : open()));
  root.querySelector('.panel-close').addEventListener('click', close);

  // ---------------------------------------------------------------- phase strip
  const phaseBar = sections.chat.querySelector('.phase-actions');
  let currentPhase = 'onboard';
  let live = false;
  function phase(p, ev = {}) {
    if (p !== currentPhase && askEl.dataset.askId) {   // a question from the previous phase is moot now
      askEl.hidden = true;
      askEl.dataset.askId = '';
    }
    currentPhase = p;
    phaseStrip.replaceChildren(...PHASES.map((k) => {
      const s = document.createElement('span');
      s.textContent = PHASE_LABEL[k];
      const i = PHASES.indexOf(k), c = PHASES.indexOf(p);
      s.className = i < c ? 'past' : i === c ? 'now' : '';
      return s;
    }));
    renderPhaseActions(ev.feature);
  }
  function renderPhaseActions(feature) {
    phaseBar.innerHTML = '';
    if (!live) { phaseBar.hidden = true; return; }
    phaseBar.hidden = false;
    const next = NEXT_OF[currentPhase];
    const idle = currentPhase === 'implement' && !feature;
    if (next && !idle) {
      const b = document.createElement('button');
      b.className = 'primary';
      b.textContent = next[1] + ' →';
      b.addEventListener('click', () => onNext?.(next[0]));
      phaseBar.appendChild(b);
    }
    const stop = document.createElement('button');
    stop.textContent = 'หยุดผู้จัดการ';
    stop.addEventListener('click', () => onCancel?.());
    phaseBar.appendChild(stop);
    if (idle) {
      const hint = document.createElement('span');
      hint.className = 'hint';
      hint.textContent = 'พิมพ์ไอเดียใหม่เพื่อเริ่มสัมภาษณ์';
      phaseBar.appendChild(hint);
    }
  }
  phase('onboard');

  // ---------------------------------------------------------------- transcript
  function transcript({ agent, kind = 'say', text, who, replayed = false }) {
    const row = document.createElement('div');
    row.className = 'msg ' + kind + (replayed ? ' replayed' : '');
    const name = who ?? (agent === 'you' ? 'คุณ' : labels[agent] ?? agent);
    const role = agent && ROLE[agent] ? ROLE_LABEL[ROLE[agent]] : '';
    row.innerHTML = `<span class="who"></span><span class="txt"></span>`;
    row.querySelector('.who').textContent = name + (role ? ' · ' + role : '');
    row.querySelector('.txt').textContent = text;
    transcriptEl.appendChild(row);
    while (transcriptEl.children.length > 400) transcriptEl.firstChild.remove();
    transcriptEl.scrollTop = transcriptEl.scrollHeight;
    mark('chat');
  }

  // ---------------------------------------------------------------- asks (HITL)
  function ask(ev) {
    askEl.hidden = false;
    askEl.dataset.askId = ev.askId;
    askEl.innerHTML = '';
    const h = document.createElement('p');
    h.className = 'q';
    h.textContent = ev.text;
    askEl.appendChild(h);
    if (ev.kind === 'tickets' && Array.isArray(ev.tickets)) {
      const ul = document.createElement('ol');
      for (const t of ev.tickets) {
        const li = document.createElement('li');
        li.innerHTML = `<b></b> <small></small><br><span></span>`;
        li.querySelector('b').textContent = `${t.id} ${t.title}`;
        li.querySelector('small').textContent = t.blockedBy?.length ? 'รอ ' + t.blockedBy.join(', ') : 'เริ่มได้เลย';
        li.querySelector('span').textContent = t.delivers ?? '';
        ul.appendChild(li);
      }
      askEl.appendChild(ul);
    }
    // multiple choice (the model's AskUserQuestion): one row of option buttons per question
    const picks = {};
    if (ev.kind === 'choice' && Array.isArray(ev.questions)) {
      h.hidden = true;
      for (const q of ev.questions) {
        const box = document.createElement('div');
        box.className = 'choice';
        box.innerHTML = `<p class="q"><small></small> <span></span></p><div class="opts"></div>`;
        box.querySelector('small').textContent = q.header ?? '';
        box.querySelector('span').textContent = q.question;
        const opts = box.querySelector('.opts');
        for (const o of q.options ?? []) {
          const b = document.createElement('button');
          b.type = 'button';
          b.innerHTML = `<b></b><i></i>`;
          b.querySelector('b').textContent = o.label;
          b.querySelector('i').textContent = o.description ?? '';
          b.addEventListener('click', () => {
            if (q.multiSelect) {
              b.classList.toggle('on');
              picks[q.question] = [...opts.querySelectorAll('button.on b')].map((x) => x.textContent).join(', ');
            } else {
              for (const x of opts.children) x.classList.toggle('on', x === b);
              picks[q.question] = o.label;
            }
          });
          opts.appendChild(b);
        }
        askEl.appendChild(box);
      }
    }
    const form = document.createElement('form');
    const isQ = ev.kind === 'question' || ev.kind === 'choice';
    form.innerHTML = `<input type="text" placeholder="${ev.kind === 'choice' ? 'หรือพิมพ์คำตอบเอง…' : isQ ? 'พิมพ์คำตอบ…' : 'ความเห็นเพิ่มเติม (ไม่บังคับ)'}" />`
      + `<button type="submit" class="primary">${isQ ? 'ตอบ' : 'อนุมัติ'}</button>`;
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const text = form.querySelector('input').value.trim();
      const answers = Object.keys(picks).length ? { ...picks } : undefined;
      if (ev.kind === 'choice' && !answers && !text) return;
      answerAsk(ev.askId, { text: text || Object.values(picks).join(' · '), approved: !isQ, answers });
    });
    askEl.appendChild(form);
    setTimeout(() => form.querySelector('input').focus(), 50);
    // the live server emits the same text as agent.say just before the ask: do not show it twice
    const lastTxt = transcriptEl.querySelector('.msg:last-child .txt')?.textContent;
    if (lastTxt !== ev.text) transcript({ agent: ev.agent ?? 'manager', kind: 'ask', text: ev.text });
    open('chat');
  }

  function answerAsk(askId, { text = '', approved = true, auto = false, answers } = {}) {
    if (askEl.dataset.askId !== askId) return;
    askEl.hidden = true;
    askEl.dataset.askId = '';
    transcript({ agent: 'you', kind: 'you', who: auto ? 'คุณ (ตอบอัตโนมัติ)' : 'คุณ',
      text: text || (approved ? 'อนุมัติ' : 'ปฏิเสธ') });
    onFlowAnswer?.(askId, { text, approved, ...(answers ? { answers } : {}) });
  }

  /** Tool approval from an engineer: allow / deny. */
  function approval(ev) {
    const box = document.createElement('div');
    box.className = 'approval';
    box.dataset.askId = ev.askId;
    box.innerHTML = `<p><b></b> ขออนุมัติ <code></code></p><p class="why"></p>`
      + `<div class="row"><button class="allow primary">อนุมัติ</button><button class="deny">ปฏิเสธ</button></div>`;
    box.querySelector('b').textContent = labels[ev.agent] ?? ev.agent;
    box.querySelector('code').textContent = `${ev.tool} ${ev.summary}`;
    box.querySelector('.why').textContent = ev.reason ?? '';
    const finish = (allow, auto = false) => {
      box.classList.add('decided');
      box.querySelector('.row').innerHTML = `<em>${allow ? 'อนุมัติแล้ว' : 'ปฏิเสธแล้ว'}${auto ? ' (อัตโนมัติ)' : ''}</em>`;
      onAnswer?.(ev.askId, allow);
    };
    box.querySelector('.allow').addEventListener('click', () => finish(true));
    box.querySelector('.deny').addEventListener('click', () => finish(false));
    box._finish = finish;
    transcriptEl.appendChild(box);
    transcriptEl.scrollTop = transcriptEl.scrollHeight;
    mark('chat');
    open('chat');
  }

  function decideApproval(askId, allow, auto = false) {
    const box = transcriptEl.querySelector(`.approval[data-ask-id="${askId}"]:not(.decided)`);
    box?._finish(allow, auto);
  }

  composer.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = composerInput.value.trim();
    if (!text) return;
    composerInput.value = '';
    transcript({ agent: 'you', kind: 'you', text });
    onCommand?.(text);
  });

  // ---------------------------------------------------------------- board
  function board(tickets, frontierList = []) {
    const front = new Set(frontierList.map((t) => t.id));
    boardEl.innerHTML = '';
    if (!tickets.length) { boardEl.innerHTML = '<p class="empty">ยังไม่มี ticket</p>'; return; }
    const grid = document.createElement('div');
    grid.className = 'kanban';
    for (const [status, label] of COLS) {
      const items = tickets.filter((t) => t.status === status);
      if (!items.length && status !== 'ready') continue;
      const col = document.createElement('div');
      col.className = 'col ' + status;
      col.innerHTML = `<h4>${label} <span>${items.length}</span></h4>`;
      for (const t of items) {
        const c = document.createElement('div');
        c.className = 'ticket' + (front.has(t.id) ? ' frontier' : '');
        c.innerHTML = `<b></b><span class="title"></span><span class="meta"></span>`;
        c.querySelector('b').textContent = t.id;
        c.querySelector('.title').textContent = t.title;
        const meta = [];
        if (t.assignee) meta.push(labels[t.assignee] ?? t.assignee);
        if (t.blockedBy?.length && status === 'blocked') meta.push('รอ ' + t.blockedBy.join(', '));
        if (t.attempt > 1) meta.push('รอบ ' + t.attempt);
        c.querySelector('.meta').textContent = meta.join(' · ');
        c.title = t.delivers ?? '';
        col.appendChild(c);
      }
      grid.appendChild(col);
    }
    boardEl.appendChild(grid);
    mark('board');
  }

  // ---------------------------------------------------------------- docs
  function docsUpdate(ev) {
    docs.set(ev.path, { content: ev.content ?? '', t: ev.t, kind: ev.kind });
    renderDocs(ev.path);
    mark('docs');
  }
  function renderDocs(selected) {
    docsEl.innerHTML = '';
    if (!docs.size) { docsEl.innerHTML = '<p class="empty">ยังไม่มีเอกสาร ผู้จัดการจะสร้าง CONTEXT.md และ ADR ระหว่างสัมภาษณ์</p>'; return; }
    const list = document.createElement('ul');
    list.className = 'doclist';
    const view = document.createElement('pre');
    view.className = 'docview';
    for (const [path, d] of docs) {
      const li = document.createElement('li');
      li.textContent = path;
      li.className = path === selected ? 'on' : '';
      li.addEventListener('click', () => renderDocs(path));
      list.appendChild(li);
    }
    view.textContent = docs.get(selected)?.content || '(ไม่มีเนื้อหาแนบมา)';
    docsEl.append(list, view);
  }
  renderDocs();

  // ---------------------------------------------------------------- project
  let projects = [];
  let lastStatus = null;
  function setProjects(list) { projects = list ?? []; if (lastStatus) project(lastStatus); else renderProjectHome(); }

  function projectPicker() {
    const wrap = document.createElement('div');
    wrap.className = 'projects';
    if (projects.length) {
      const sel = document.createElement('select');
      sel.id = 'project-select';
      for (const p of projects) {
        const o = document.createElement('option');
        o.value = p.id; o.textContent = `${p.id} · ${p.path}`; o.selected = !!p.current;
        sel.appendChild(o);
      }
      sel.addEventListener('change', () => onProjectSelect?.(sel.value));
      wrap.appendChild(sel);
    }
    const form = document.createElement('form');
    form.className = 'add';
    form.innerHTML = `<input type="text" id="project-path" placeholder="path ของ repo บนเครื่อง หรือ URL ให้ clone" />`
      + `<input type="text" id="project-branch" placeholder="branch หลัก" value="main" size="8" />`
      + `<button type="submit" class="primary">เพิ่ม</button>`;
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const path = form.querySelector('#project-path').value.trim();
      if (!path) return;
      onProjectAdd?.({ path, mainBranch: form.querySelector('#project-branch').value.trim() || 'main' });
      form.querySelector('#project-path').value = '';
    });
    wrap.appendChild(form);
    return wrap;
  }

  function renderProjectHome() {
    projectEl.innerHTML = '';
    const h = document.createElement('h3');
    h.textContent = live ? 'โปรเจกต์' : 'โปรเจกต์ (โหมดสาธิต)';
    projectEl.appendChild(h);
    if (live) projectEl.appendChild(projectPicker());
    else projectEl.insertAdjacentHTML('beforeend', '<p class="empty">ต่อ server แล้วจะลงทะเบียน repo ได้ที่นี่ (npm run office)</p>');
  }

  function project(ev) {
    lastStatus = ev;
    projectEl.innerHTML = '';
    const h = document.createElement('h3');
    h.textContent = ev.project + (ev.path ? ' · ' + ev.path : '');
    projectEl.appendChild(h);
    if (live) projectEl.appendChild(projectPicker());
    const ul = document.createElement('ol');
    ul.className = 'checklist';
    for (const s of ev.steps) {
      const li = document.createElement('li');
      li.className = s.state;   // pass | fail | skip | pending | running
      li.innerHTML = `<i></i><span class="t"></span><span class="d"></span><span class="b"></span>`;
      li.querySelector('.t').textContent = `${s.n}. ${s.title}`;
      li.querySelector('.d').textContent = s.detail ?? '';
      const b = li.querySelector('.b');
      if (live && s.state !== 'running') {
        if ([4, 5, 6].includes(s.n) && s.state !== 'pass') {
          const m = document.createElement('button'); m.textContent = 'ให้ผู้จัดการทำ';
          m.addEventListener('click', () => onRecheck?.(s.n, 'manager')); b.appendChild(m);
        }
        if ([6, 7].includes(s.n) && s.state !== 'pass' && s.state !== 'skip') {
          const k = document.createElement('button'); k.textContent = 'ข้าม';
          k.addEventListener('click', () => onRecheck?.(s.n, 'skip')); b.appendChild(k);
        }
        const r = document.createElement('button'); r.textContent = s.n === 8 ? 'ซ้อมอีกครั้ง' : 'ตรวจอีกครั้ง';
        r.addEventListener('click', () => onRecheck?.(s.n, 'run')); b.appendChild(r);
      }
      ul.appendChild(li);
    }
    const ok = ev.ready ?? ev.steps.every((s) => s.state === 'pass' || s.state === 'skip');
    const p = document.createElement('p');
    p.className = 'gate ' + (ok ? 'ok' : 'no');
    p.textContent = ok ? 'พร้อมคุยกับผู้จัดการ' : 'ช่องคุยจะเปิดเมื่อข้อ 1–5 และ 8 ผ่าน';
    composerInput.disabled = !ok;
    composerInput.placeholder = ok ? 'พิมพ์ไอเดีย หรือตอบผู้จัดการ…' : 'รอ onboarding ให้ผ่านก่อน';
    projectEl.append(ul, p);
    mark('project');
  }
  renderProjectHome();

  // ---------------------------------------------------------------- tv / reports
  function tv({ title, criteria, markdown, merge }) {
    tvEl.innerHTML = '';
    const h = document.createElement('h3');
    h.textContent = title;
    tvEl.appendChild(h);
    if (merge && live) {
      const row = document.createElement('div');
      row.className = 'row';
      const b = document.createElement('button');
      b.className = 'primary';
      b.textContent = `รวม ${merge.branch} เข้า ${merge.mainBranch ?? 'main'}`;
      b.addEventListener('click', () => { b.disabled = true; onMerge?.(merge.branch); });
      row.appendChild(b);
      tvEl.appendChild(row);
    }
    if (criteria) {
      const ul = document.createElement('ul');
      ul.className = 'criteria';
      for (const c of criteria) {
        const li = document.createElement('li');
        li.className = c.pass ? 'pass' : 'fail';
        li.innerHTML = `<i></i><span></span>`;
        li.querySelector('span').textContent = c.text + (c.note ? ' — ' + c.note : '');
        ul.appendChild(li);
      }
      tvEl.appendChild(ul);
    }
    if (markdown) {
      const pre = document.createElement('pre');
      pre.className = 'report';
      pre.textContent = markdown;
      tvEl.appendChild(pre);
    }
    if (reports.length) {
      const h4 = document.createElement('h4');
      h4.textContent = 'รายงานก่อนหน้า';
      const ul = document.createElement('ul');
      ul.className = 'reportlist';
      for (const r of [...reports].reverse()) {
        const li = document.createElement('li');
        li.textContent = r.level === 2 ? `ปิดงาน ${r.feature}` : `ปิดใบ ${r.ticket}`;
        li.addEventListener('click', () => tv({ title: li.textContent, markdown: r.markdown }));
        ul.appendChild(li);
      }
      tvEl.append(h4, ul);
    }
    mark('tv');
  }
  function report(r) {
    reports.push(r);
    if (r.level === 1) transcript({ agent: 'manager', kind: 'done', text: `ปิดใบ ${r.ticket} · รายงานอยู่ในแท็บ TV` });
  }
  tv({ title: 'ยังไม่มีอะไรฉาย', markdown: 'ผลตรวจรับของ QA และรายงานปิดงานของผู้จัดการจะขึ้นที่นี่' });

  // ---------------------------------------------------------------- status / mode
  function status(id, state, ticket) {
    statuses[id] = { state, ticket };
  }
  function statusOf(id) { return statuses[id]; }
  const WARN_RATIO = 0.8;
  const OVER_RATIO = 1;
  /**
   * The team figure -- today's team cost against the daily budget, with no server this
   * still renders (as `team`, defaulting to 0) but `budget` is undefined so no denominator
   * is invented. `breakdown` lists every agent id that has spent money, roster or not.
   */
  function cost({ team, budget, breakdown }) {
    const ratio = budget ? team / budget : 0;
    teamCostEl.textContent = `วันนี้ $${team.toFixed(2)}` + (budget != null ? ` / $${budget}` : '');
    teamCostEl.classList.toggle('over', budget != null && ratio >= OVER_RATIO);
    teamCostEl.classList.toggle('warn', budget != null && ratio >= WARN_RATIO && ratio < OVER_RATIO);
    const rows = Object.entries(breakdown).map(([k, v]) => `${labels[k] ?? k}: $${v.toFixed(2)}`);
    teamCostEl.title = [...rows, 'วันนี้ = วัน UTC (รีเซ็ต 07:00 น. เวลาไทย)'].join('\n');
  }
  cost({ team: 0, budget: undefined, breakdown: {} });
  function mode(text, kind = '') {
    modeEl.textContent = text;
    modeEl.className = 'mode ' + kind;
    live = kind === 'live';
    renderPhaseActions(lastStatus?.feature);
    if (!lastStatus) renderProjectHome();
    else project(lastStatus);
  }

  // ---------------------------------------------------------------- mock bar
  const play = mockbar.querySelector('.play');
  const stop = mockbar.querySelector('.stop');
  const speed = mockbar.querySelector('select.speed');
  const auto = mockbar.querySelector('input.auto');
  play.addEventListener('click', () => onMock?.('play'));
  stop.addEventListener('click', () => onMock?.('stop'));
  speed.addEventListener('change', () => onMock?.('speed', Number(speed.value)));
  auto.addEventListener('change', () => onMock?.('auto', auto.checked));
  function mockState(running) {
    play.disabled = running;
    stop.disabled = !running;
    mockbar.classList.toggle('running', running);
  }
  function showMockbar(show) { mockbar.hidden = !show; }

  return {
    open, close, phase, transcript, ask, answerAsk, approval, decideApproval,
    board, docs: docsUpdate, project, setProjects, tv, report, status, statusOf, cost, mode,
    mockState, showMockbar,
    get live() { return live; },
    get autoAnswer() { return auto.checked; },
    get speed() { return Number(speed.value); },
  };
}

export { STATUS_LABEL };
