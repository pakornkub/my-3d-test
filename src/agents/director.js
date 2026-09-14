// director.js -- turns the event stream into stage directions.
//
// The scene never decides *what* happened; the driver (mock today, server later) tells it
// through events, and this class decides who walks where, what their bubble says and what
// the panel shows. It knows nothing about three.js so it can be unit-tested with a fake
// crew: everything physical goes through `crew`, `bubbles`, `panel` and `places`.

import { validate, frontier } from './events.js';
import { ROLE, HOME_SEAT, MEETING_SEATS, WORK_SPOT, STATUS_LABEL } from './team.js';

const SHORT = (s, n = 64) => (s && s.length > n ? s.slice(0, n - 1) + '…' : s ?? '');

export class Director {
  /**
   * @param crew    { members: [{id,label,obj,ctl,home}], ... } -- the real Crew or a fake
   * @param bubbles { say(member, text, opts), clear(member) }
   * @param panel   see panel.js; every method optional
   * @param places  { approach(name, from) -> {x,z}|null, highlight(name) }
   * @param heights id -> metres, for bubble placement
   */
  constructor({ crew, bubbles, panel = {}, places, heights = {}, onStatus = () => {} }) {
    this.crew = crew;
    this.bubbles = bubbles;
    this.panel = panel;
    this.places = places;
    this.heights = heights;
    this.onStatus = onStatus;
    this.status = {};          // id -> { state, ticket }
    this.phase = 'onboard';
    this.tickets = [];
    this.pendingAsks = new Map();   // askId -> agent id, so answers can clear the right person
    this.log = [];
    this.budget = undefined;        // daily-budget-usd from the connection snapshot; undefined when unknown
    for (const m of crew.members) this.#set(m.id, 'idle');
  }

  #sessions = new Map();   // session key (session ?? agent) -> { agent, usd }, this UTC day
  #costDay = null;         // UTC day (ms / 86_400_000) of the current bucket

  /** Every agent id that has spent money today, summed across its sessions -- roster or not. */
  breakdown() {
    const out = {};
    for (const { agent, usd } of this.#sessions.values()) out[agent] = (out[agent] ?? 0) + usd;
    return out;
  }

  /** Member cost: the sum of the latest running totals of `id`'s sessions this UTC day. */
  memberCost(id) {
    return this.breakdown()[id];
  }

  /** Team cost: the sum of the latest running totals of every session today, roster or not. */
  teamCost() {
    return Object.values(this.breakdown()).reduce((a, b) => a + b, 0);
  }

  /** The daily-budget-usd from the connection snapshot; republishes the team figure right away. */
  setBudget(usd) {
    this.budget = usd;
    this.#publishCost();
  }

  #publishCost() {
    this.panel.cost?.({ team: this.teamCost(), budget: this.budget, breakdown: this.breakdown() });
  }

  // ---------------------------------------------------------------- helpers
  member(id) { return this.crew.members.find((m) => m.id === id) ?? null; }

  #set(id, state, ticket = null) {
    this.status[id] = { state, ticket };
    this.panel.status?.(id, state, ticket);
    this.onStatus(id, state, ticket);
  }

  #say(member, text, opts = {}) {
    if (!member) return;
    this.bubbles.say(member, text, { height: this.heights[member.model ?? member.id], ...opts });
  }

  #goHomeSeat(member) {
    const seat = HOME_SEAT[member.id];
    if (seat) this.crew.sendToSeat(seat, member);
  }

  #goTo(member, objectName) {
    if (!member) return;
    const p = this.places.approach(objectName, member.obj.position);
    if (p) this.crew.sendTo(p.x, p.z, member);
  }

  #goIdle(member) {
    if (!member) return;
    const h = member.home;
    if (h) this.crew.sendTo(h[0], h[1], member);
  }

  // ---------------------------------------------------------------- entry
  handle(ev) {
    const errs = validate(ev);
    if (errs.length) {
      console.warn('[director] dropped malformed event', ev?.type, errs);
      return false;
    }
    this.log.push(ev);
    const fn = this[`on_${ev.type.replace('.', '_')}`];
    if (fn) fn.call(this, ev);
    else console.info('[director] no handler for', ev.type);
    return true;
  }

  // ---------------------------------------------------------------- flow
  on_flow_phase(ev) {
    this.phase = ev.phase;
    this.panel.phase?.(ev.phase, ev);
    const mgr = this.member('manager');
    switch (ev.phase) {
      case 'grill':
        // the interview happens at the meeting table: manager sits, faces the human
        if (mgr) { this.crew.sendToSeat(MEETING_SEATS[0], mgr); this.#set('manager', 'meeting'); }
        this.#say(mgr, 'มาคุยกันที่โต๊ะประชุมครับ', { kind: 'say', ttl: 5 });
        break;
      case 'spec':
        if (mgr) { this.#goHomeSeat(mgr); this.#set('manager', 'working'); }
        this.#say(mgr, 'กำลังเขียนสเปกจากที่คุยกัน', { kind: 'working', ttl: 0 });
        break;
      case 'tickets':
        if (mgr) { this.#goTo(mgr, 'NoticeBoard'); this.#set('manager', 'working'); }
        this.#say(mgr, 'แตกงานเป็น ticket ที่บอร์ด', { kind: 'working', ttl: 0 });
        this.places.highlight?.('NoticeBoard');
        break;
      case 'implement':
        if (mgr) { this.#goHomeSeat(mgr); this.#set('manager', 'idle'); this.bubbles.clear(mgr); }
        break;
      case 'done':
        for (const m of this.crew.members) {
          if (m.id === 'manager') { this.#goHomeSeat(m); this.#set('manager', 'idle'); continue; }
          this.#goIdle(m);
          this.#set(m.id, 'idle');
          this.bubbles.clear(m);
        }
        break;
      default:
        break;
    }
  }

  on_flow_ask(ev) {
    const mgr = this.member('manager');
    this.#set('manager', 'grilling');
    this.pendingAsks.set(ev.askId, 'manager');
    this.#say(mgr, SHORT(ev.text, 90), { kind: 'waiting', ttl: 0 });
    this.panel.ask?.(ev);
  }

  /** The scene answered (or the human did through the panel): clear the waiting look. */
  answered(askId) {
    const id = this.pendingAsks.get(askId);
    if (!id) return;
    this.pendingAsks.delete(askId);
    const m = this.member(id);
    if (id === 'manager') {
      this.#set(id, this.phase === 'grill' ? 'meeting' : 'working');
      this.#say(m, 'รับทราบครับ', { kind: 'say', ttl: 3 });
    } else if (m) {
      this.#set(id, 'working', this.status[id]?.ticket);
      this.#goHomeSeat(m);
      this.#say(m, 'ได้รับคำตอบแล้ว ทำต่อ', { kind: 'working', ttl: 4 });
    }
  }

  on_board_update(ev) {
    this.tickets = ev.tickets;
    this.panel.board?.(ev.tickets, frontier(ev.tickets));
  }

  on_docs_update(ev) {
    this.panel.docs?.(ev);
    const mgr = this.member('manager');
    const kind = ev.kind ?? (ev.path.includes('adr') ? 'ADR' : ev.path.split('/').pop());
    this.#say(mgr, 'บันทึก ' + kind, { kind: 'working', ttl: 4 });
    this.places.highlight?.('Bookshelf');
  }

  on_project_status(ev) { this.panel.project?.(ev); }

  // ---------------------------------------------------------------- agents
  on_agent_start(ev) {
    const m = this.member(ev.agent);
    if (!m) return;
    const role = ROLE[ev.agent];
    const mode = ev.mode ?? (role === 'review' ? 'review' : role === 'qa' ? 'verify' : 'implement');
    if (mode === 'verify') {
      this.#goTo(m, WORK_SPOT.qa);
      this.#set(ev.agent, 'verifying', ev.ticket);
      this.places.highlight?.('TV');
    } else if (mode === 'research') {
      this.#goTo(m, WORK_SPOT.research);
      this.#set(ev.agent, 'researching', ev.ticket);
    } else {
      this.#goHomeSeat(m);
      this.#set(ev.agent, mode === 'review' ? 'reviewing' : 'working', ev.ticket);
    }
    this.#say(m, `ใบ ${ev.ticket}: ${SHORT(ev.brief, 70)}`, { kind: 'working', ttl: 0 });
    this.panel.transcript?.({ agent: ev.agent, kind: 'start', text: `รับใบ ${ev.ticket}: ${ev.brief}` });
  }

  on_agent_tool(ev) {
    const m = this.member(ev.agent);
    this.#say(m, `${ev.tool}: ${SHORT(ev.summary, 60)}`, { kind: 'working', ttl: 0 });
    this.panel.transcript?.({ agent: ev.agent, kind: 'tool', text: `${ev.tool} · ${ev.summary}` });
  }

  on_agent_say(ev) {
    const m = this.member(ev.agent);
    this.#say(m, SHORT(ev.text, 110), { kind: 'say', ttl: 8 });
    this.panel.transcript?.({ agent: ev.agent, kind: 'say', text: ev.text });
  }

  on_agent_ask(ev) {
    const m = this.member(ev.agent);
    if (!m) return;
    // stand up next to the desk: a person on their feet reads as "needs you"
    const seat = HOME_SEAT[ev.agent];
    const s = seat && this.crew.pack?.seats?.get(seat);
    if (s) this.crew.sendTo(s.three.approach[0], s.three.approach[2], m);
    this.pendingAsks.set(ev.askId, ev.agent);
    this.#set(ev.agent, 'waiting', this.status[ev.agent]?.ticket);
    this.#say(m, `ขออนุมัติ: ${ev.tool} ${SHORT(ev.summary, 50)}`, { kind: 'waiting', ttl: 0 });
    this.panel.approval?.(ev);
  }

  on_agent_done(ev) {
    const m = this.member(ev.agent);
    if (!m) return;
    const ok = ev.result === 'done';
    this.#set(ev.agent, ok ? 'done' : 'error', ev.ticket);
    if (ok) this.#goTo(m, 'ManagerDesk');       // walk over and report
    this.#say(m, SHORT(ev.summary, 90), { kind: ok ? 'done' : 'error', ttl: ok ? 10 : 0 });
    this.panel.transcript?.({ agent: ev.agent, kind: ok ? 'done' : 'error',
      text: `ใบ ${ev.ticket} ${ok ? 'เสร็จ' : ev.result}: ${ev.summary}` });
  }

  on_agent_stalled(ev) {
    const m = this.member(ev.agent);
    this.#set(ev.agent, 'stalled', ev.ticket);
    this.#say(m, `ค้างมา ${ev.minutes} นาที ไม่มีความคืบหน้า`, { kind: 'waiting', ttl: 0 });
    this.panel.transcript?.({ agent: ev.agent, kind: 'warn', text: `ใบ ${ev.ticket} ค้าง ${ev.minutes} นาที` });
  }

  on_agent_retry(ev) {
    const m = this.member(ev.agent);
    if (!m) return;
    this.#goHomeSeat(m);
    this.#set(ev.agent, 'working', ev.ticket);
    this.#say(m, `รอบที่ ${ev.attempt}: ${SHORT(ev.note, 60)}`, { kind: 'working', ttl: 0 });
    this.panel.transcript?.({ agent: ev.agent, kind: 'warn', text: `เริ่มใบ ${ev.ticket} ใหม่ (รอบ ${ev.attempt}): ${ev.note}` });
  }

  on_ticket_escalated(ev) {
    const mgr = this.member('manager');
    const owner = this.tickets.find((t) => t.id === ev.ticket)?.assignee;
    const m = owner && this.member(owner);
    if (m) { this.#goIdle(m); this.#set(owner, 'idle'); this.bubbles.clear(m); }
    this.#say(mgr, `ใบ ${ev.ticket} ต้องให้คุณดู: ${SHORT(ev.reason, 60)}`, { kind: 'error', ttl: 0 });
    this.panel.transcript?.({ agent: 'manager', kind: 'error', text: `ใบ ${ev.ticket} ส่งต่อให้คน: ${ev.reason}` });
  }

  on_review_result(ev) {
    const m = this.member(ev.agent);
    const n = (ev.standards ?? []).length;
    const pass = ev.verdict === 'pass';
    this.#set(ev.agent, pass ? 'done' : 'error', ev.ticket);
    this.#say(m, `Standards ${n} ข้อ · Spec ${ev.spec?.length ? ev.spec.length + ' ข้อ' : 'ครบ'} → ${pass ? 'ผ่าน' : 'ส่งกลับ'}`,
      { kind: pass ? 'done' : 'error', ttl: 10 });
    this.panel.transcript?.({ agent: ev.agent, kind: pass ? 'done' : 'error',
      text: `รีวิวใบ ${ev.ticket}: ${pass ? 'ผ่าน' : 'ไม่ผ่าน'}`
        + (n ? ' · Standards: ' + ev.standards.join('; ') : '')
        + (ev.spec?.length ? ' · Spec: ' + ev.spec.join('; ') : '') });
    if (!pass && ev.assignee) {
      const imp = this.member(ev.assignee);
      if (imp) { this.#goHomeSeat(imp); this.#set(ev.assignee, 'working', ev.ticket); }
      this.#say(imp, 'รีวิวไม่ผ่าน กลับไปแก้', { kind: 'error', ttl: 6 });
    }
  }

  on_verify_result(ev) {
    const m = this.member(ev.agent);
    const total = ev.criteria.length;
    const ok = ev.criteria.filter((c) => c.pass).length;
    const pass = ev.verdict === 'pass';
    this.#set(ev.agent, pass ? 'done' : 'error', ev.ticket);
    this.#say(m, `เช็คของจริง ${ok}/${total} ข้อ → ${pass ? 'ผ่าน' : 'ส่งกลับ'}`, { kind: pass ? 'done' : 'error', ttl: 10 });
    this.panel.tv?.({ title: `ตรวจรับใบ ${ev.ticket}`, criteria: ev.criteria, verdict: ev.verdict });
    this.panel.transcript?.({ agent: ev.agent, kind: pass ? 'done' : 'error',
      text: `ตรวจรับใบ ${ev.ticket}: ${ok}/${total} ข้อ` });
    if (!pass && ev.assignee) {
      const imp = this.member(ev.assignee);
      if (imp) { this.#goHomeSeat(imp); this.#set(ev.assignee, 'working', ev.ticket); }
      this.#say(imp, 'QA ส่งกลับ มี repro ให้แล้ว', { kind: 'error', ttl: 6 });
    }
  }

  on_gate_result(ev) {
    const m = this.member(ev.agent);
    this.#say(m, `${ev.gate}: ${ev.pass ? 'ผ่าน' : 'ไม่ผ่าน'} (server รันเอง)`, { kind: ev.pass ? 'done' : 'error', ttl: 5 });
    this.panel.transcript?.({ agent: ev.agent, kind: ev.pass ? 'gate' : 'error',
      text: `gate ${ev.gate} ${ev.pass ? 'ผ่าน' : 'ไม่ผ่าน'}: ${ev.output}` });
  }

  on_ticket_closed(ev) {
    const t = this.tickets.find((x) => x.id === ev.ticket);
    for (const id of new Set([t?.assignee, ev.assignee].filter(Boolean))) {
      const m = this.member(id);
      if (m) { this.#goIdle(m); this.#set(id, 'idle'); this.bubbles.clear(m); }
    }
    // reviewer and QA go idle too once the ticket is really closed
    for (const id of Object.keys(ROLE)) {
      if ((ROLE[id] === 'review' || ROLE[id] === 'qa') && this.status[id]?.ticket === ev.ticket) {
        const m = this.member(id);
        if (m) { this.#goIdle(m); this.#set(id, 'idle'); this.bubbles.clear(m); }
      }
    }
    const mgr = this.member('manager');
    this.#say(mgr, `ปิดใบ ${ev.ticket} แล้ว`, { kind: 'done', ttl: 5 });
    this.panel.report?.({ level: 1, ticket: ev.ticket, markdown: ev.report });
  }

  on_feature_report(ev) {
    const mgr = this.member('manager');
    this.#goTo(mgr, 'TV');
    this.#set('manager', 'working');
    this.#say(mgr, `รายงานปิดงาน ${ev.feature}`, { kind: 'done', ttl: 0 });
    this.gather({ except: ['manager'] });
    this.places.highlight?.('TV');
    this.panel.report?.({ level: 2, feature: ev.feature, markdown: ev.report });
    this.panel.tv?.({ title: `รายงานปิดงาน: ${ev.feature}`, markdown: ev.report, merge: { branch: `feature/${ev.feature}`, mainBranch: ev.mainBranch ?? 'main' } });
  }

  on_session_cost(ev) {
    const day = Math.floor(ev.t / 86_400_000);
    if (this.#costDay !== null && day !== this.#costDay) this.#sessions.clear();
    this.#costDay = day;
    this.#sessions.set(ev.session ?? ev.agent, { agent: ev.agent, usd: ev.usd });
    this.#publishCost();
    this.onStatus();
  }

  on_ci_status(ev) {
    this.panel.transcript?.({ agent: 'manager', kind: ev.state === 'success' ? 'done' : 'warn', text: `CI ${ev.state}: ${ev.pr}` });
  }

  on_error(ev) {
    const m = ev.agent ? this.member(ev.agent) : this.member('manager');
    if (ev.agent) this.#set(ev.agent, 'error', this.status[ev.agent]?.ticket);
    this.#say(m, SHORT(ev.message, 90), { kind: 'error', ttl: 0 });
    this.panel.transcript?.({ agent: ev.agent ?? 'manager', kind: 'error', text: ev.message });
  }

  // ---------------------------------------------------------------- scene-initiated
  /** Everyone to the meeting table: the first four get chairs, the rest stand nearby. */
  gather({ except = [] } = {}) {
    let i = 0;
    for (const m of this.crew.members) {
      if (except.includes(m.id)) continue;
      const seat = MEETING_SEATS[i++];
      if (seat) this.crew.sendToSeat(seat, m);
      else this.#goTo(m, 'MeetingTable');
      if (this.status[m.id]?.state === 'idle') this.#set(m.id, 'meeting');
    }
  }

  /** One person walks to the manager's desk (the `report` hotspot action). */
  reportTo(member) { this.#goTo(member, 'ManagerDesk'); }

  labelFor(id) { return STATUS_LABEL[this.status[id]?.state ?? 'idle']; }
}
