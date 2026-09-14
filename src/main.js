// main.js -- wire the office, the crew and the UI together.

import * as THREE from 'three';
import { CharacterPack, matchScene } from './characters.js';
import { createViewer, ROOM } from './scene.js';
import { NavGrid } from './nav.js';
import { Crew } from './crew.js';
import { hotspotFor, SKIP, SEAT_OF } from './hotspots.js';
import { createUI } from './ui.js';
import { Bubbles } from './agents/bubbles.js';
import { Director } from './agents/director.js';
import { createPanel } from './agents/panel.js';
import { MockDriver, demoScript } from './agents/mock.js';
import { make } from './agents/events.js';

// '/' during dev, '/my-3d-test/' on GitHub Pages -- vite substitutes this at build time
const BASE = import.meta.env.BASE_URL;

// Who is in the room, and where they start. `fallback` keeps the crew full while only some
// models exist: a missing id spawns the fallback, tinted so the clones do not read as a bug.
// Roles and desks live in agents/team.js, keyed by these same ids.
const CREW = [
  { id: 'eng_m1',  label: 'วิศวกร A',  at: [2.2, -2.6], faceY: Math.PI * 0.75 },
  { id: 'eng_f1',  label: 'วิศวกร B',  at: [4.9, -1.5], faceY: Math.PI * 0.5 },
  { id: 'manager', label: 'ผู้จัดการ', at: [8.4, -6.1], faceY: Math.PI },
  { id: 'eng_m2',  label: 'วิศวกร C',  at: [6.6, -2.8], faceY: 0,
    fallback: 'eng_m1', tint: 0xcfdcea },
  { id: 'eng_f2',  label: 'วิศวกร D',  at: [1.9, -6.3], faceY: -Math.PI * 0.5,
    fallback: 'eng_f1', tint: 0xead9cf },
  { id: 'eng_m3',  label: 'วิศวกร E',  at: [4.3, -6.8], faceY: Math.PI * 0.5,
    fallback: 'eng_m1', tint: 0xd7e5d1 },
];
const LABEL = Object.fromEntries(CREW.map((c) => [c.id, c.label]));

// 0.10 m cells (100 x 80 = 8000) cost about a millisecond to bake and keep the whole floor
// as one connected region -- at 0.20 m the quantisation error walls off the manager's
// alcove, whose tightest legal standing spot has only 0.30 m of clearance.
const CELL = 0.1;
const BODY_RADIUS = 0.25;      // how wide the chibi is when squeezing past a desk

const host = document.getElementById('viewport');
const viewer = createViewer(host);
const ui = createUI({
  onCamera: (mode) => viewer.setMode(mode),
  onReset: () => viewer.reset(),
  onAction: (id, name, spot) => runAction(id, name, spot),
  onSelect: (i) => crew.selectIndex(i),
});

let pack, crew, marker, officeRoot, bubbles, director, panel, mock;
const events = [];              // every event the scene has received, for replay / debugging
const pickables = [];
const crewPickables = [];
const seatNames = new Set();

init().catch((e) => { console.error(e); ui.failed(e.message ?? e); });

async function init() {
  ui.progress('กำลังโหลดฉาก…');
  pack = await CharacterPack.load(BASE);

  const office = await pack.loadOffice(BASE + 'ube_office.glb');
  officeRoot = office;
  matchScene(office, { stripMaps: false, envIntensity: 0.25 });
  viewer.scene.add(office);
  office.traverse((n) => { if (n.isMesh && !SKIP.has(n.name)) pickables.push(n); });
  // the floor is not a hotspot but it IS the walk target, so it stays pickable
  const floor = office.getObjectByName('Floor');
  if (floor && !pickables.includes(floor)) pickables.push(floor);
  for (const s of pack.seats.keys()) seatNames.add(s);

  const nav = new NavGrid(
    { minX: ROOM.minX, maxX: ROOM.maxX, minZ: ROOM.minZ, maxZ: ROOM.maxZ },
    CELL,
    (x, z) => !!pack.blocked(x, z, BODY_RADIUS),
  );
  console.info('[nav] %d x %d cells, %d blocked', nav.cols, nav.rows, nav.blockedCount);
  const repaired = nav.repairApproaches(pack.seats);
  const broken = repaired.filter((r) => r.src !== 'seats.json');
  if (broken.length) {
    console.warn('[seats] %d approach points were unusable and got re-derived:', broken.length);
    console.table(broken);
  }

  ui.progress('กำลังวางทีมงาน…');
  crew = new Crew({ pack, nav, scene: viewer.scene });
  crew.onChange = () => ui.renderRoster(crew.members, crew.selected, (id) => director?.status[id]);
  for (const spec of CREW) {
    const m = crew.add(spec);
    if (!m) continue;
    m.home = spec.at;
    m.obj.traverse((n) => { if (n.isMesh || n.isSkinnedMesh) crewPickables.push(n); });
  }
  if (!crew.members.length) throw new Error('ไม่มีตัวละครใน characters.json เลย');
  console.info('[crew] %d in the room: %s', crew.members.length,
    crew.members.map((m) => m.label + (m.placeholder ? ' (placeholder)' : '')).join(', '));

  marker = makeMarker();
  viewer.scene.add(marker);

  // ---- the agent office: bubbles + panel + director, driven by the mock until a server exists
  bubbles = new Bubbles(host);
  const heights = Object.fromEntries(crew.members.map((m) => [m.model, pack.info(m.model)?.height_m ?? 1.4]));
  panel = createPanel({
    labels: LABEL,
    onCommand: (text) => driver.send(make('command', { text })),
    onFlowAnswer: (askId, a) => { director.answered(askId); driver.send(make('flow.answer', { askId, ...a })); },
    onAnswer: (askId, allow) => { director.answered(askId); driver.send(make('answer', { askId, allow })); },
    onMock: (op, v) => {
      if (op === 'play') mock.start(demoScript());
      if (op === 'stop') mock.stop();
      if (op === 'speed') mock.speed = v;
      if (op === 'auto') mock.auto = v;
    },
  });
  director = new Director({
    crew, bubbles, panel, heights,
    places: { approach: approachPointFor, highlight },
    onStatus: () => crew.onChange(),
  });
  const receive = (e) => { events.push(e); director.handle(e); };
  mock = new MockDriver({
    emit: receive,
    speed: panel.speed,
    auto: panel.autoAnswer,
    onState: (running) => panel.mockState(running),
  });
  // when the mock answers itself, mirror that in the panel so the transcript stays honest
  mock.onAnswered = (askEv, r) => {
    director.answered(askEv.askId);
    if (!r.auto) return;
    if (askEv.type === 'flow.ask') panel.answerAsk(askEv.askId, { auto: true });
    else panel.decideApproval(askEv.askId, r.allow, true);
  };
  const driver = mock;            // bridge.js (phase 1) will take this seat when a server answers
  panel.mode('โหมดสาธิต', 'mock');
  panel.showMockbar(true);
  panel.transcript({ agent: 'manager', kind: 'say',
    text: 'ยังไม่ได้ต่อ server: กด "เล่นตัวอย่าง" เพื่อดูทีมทำงานครบ flow หรือพิมพ์ไอเดียเพื่อเริ่มสาธิตด้วยข้อความของคุณ' });

  host.addEventListener('pointerdown', onPointerDown);
  host.addEventListener('contextmenu', (e) => e.preventDefault());
  addEventListener('keydown', onKey);

  let last = performance.now();
  frame();
  function frame() {
    requestAnimationFrame(frame);
    const now = performance.now();
    const dt = Math.min((now - last) / 1000, 0.05);   // clamp: a backgrounded tab returns seconds
    last = now;
    viewer.controls.update();
    crew.update(dt);
    pack.update(dt);
    bubbles.update(dt);
    if (marker.visible) {
      marker.userData.life -= dt;
      marker.material.opacity = Math.max(0, marker.userData.life) * 1.4;
      marker.scale.setScalar(1 + (1 - Math.max(0, marker.userData.life)) * 0.5);
      if (marker.userData.life <= 0) marker.visible = false;
    }
    viewer.render();
    bubbles.render(viewer.scene, viewer.camera);
  }

  // Handy from the devtools console: __ube.crew.sendTo(5, -2).
  // `step` advances the simulation by hand -- embedded preview panes often park
  // requestAnimationFrame, and this makes the app testable there anyway.
  window.__ube = {
    viewer, pack, crew, nav, office, pickables, director, panel, mock, events, bubbles,
    step(n = 60, dt = 1 / 60) {
      for (let i = 0; i < n; i++) { crew.update(dt); pack.update(dt); bubbles.update(dt); }
      viewer.render();
      bubbles.render(viewer.scene, viewer.camera);
    },
    /** Feed one event straight into the Director, e.g. __ube.emit('agent.say', { agent: 'eng_m1', text: 'hi' }). */
    emit(type, fields) { receive(make(type, fields)); },
    screenOf(name) {
      const o = viewer.scene.getObjectByName(name);
      if (!o) return null;
      const p = new THREE.Box3().setFromObject(o).getCenter(new THREE.Vector3());
      p.project(viewer.camera);
      const r = viewer.renderer.domElement.getBoundingClientRect();
      return { x: Math.round((p.x * 0.5 + 0.5) * r.width), y: Math.round((-p.y * 0.5 + 0.5) * r.height) };
    },
  };

  crew.onChange();
  ui.ready();
  ui.say('กดปุ่ม "ทีม" มุมขวาบน แล้ว "เล่นตัวอย่าง" เพื่อดูทีมทำงาน');
}

// ---------------------------------------------------------------- input
function onKey(e) {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  if (e.key === 'Escape') { crew.select(null); ui.hideCard(); return; }
  const n = Number(e.key);
  if (Number.isInteger(n) && n >= 1 && n <= crew.members.length) {
    const m = crew.selectIndex(n - 1);
    if (m) ui.say('เลือก ' + m.label);
  }
}

let downAt = null;
function onPointerDown(event) {
  if (event.button !== 0) return;
  downAt = { x: event.clientX, y: event.clientY };
  host.addEventListener('pointerup', onPointerUp, { once: true });
}

function onPointerUp(event) {
  if (!downAt) return;
  const moved = Math.hypot(event.clientX - downAt.x, event.clientY - downAt.y);
  downAt = null;
  if (moved > 5) return;                       // that was a drag, not a click

  // people first: clicking a person always means "select them", never "walk to the floor
  // behind them"
  const onPerson = viewer.pick(event, crewPickables);
  if (onPerson.length) {
    const m = crew.memberOf(onPerson[0].object);
    if (m) {
      const now = crew.select(crew.selected === m ? null : m);
      ui.say(now ? 'เลือก ' + m.label : 'ยกเลิกการเลือก');
      return;
    }
  }

  const hits = viewer.pick(event, pickables);
  if (!hits.length) { ui.hideCard(); return; }
  const name = topName(hits[0].object);

  if (name === 'Floor' || name === 'Rug') {
    walkTo(hits[0].point.x, hits[0].point.z);
    ui.hideCard();
    return;
  }
  if (seatNames.has(name)) { sitOn(name); return; }

  const spot = hotspotFor(name);
  if (spot) ui.showCard(name, spot);
  else ui.hideCard();
}

/**
 * The 63 office nodes are flat children of the loaded glTF scene, so climb until the parent
 * IS that scene. Climbing to "the top" instead would return the glTF scene's own name.
 */
function topName(obj) {
  let n = obj;
  while (n && n.parent && n.parent !== officeRoot) n = n.parent;
  return n ? n.name : '';
}

// ---------------------------------------------------------------- actions
function walkTo(x, z) {
  if (crew.nav.isBlocked(x, z)) { ui.say('ตรงนั้นเดินไปไม่ได้'); return; }
  const m = crew.sendTo(x, z);
  if (m) { showMarker(x, z); ui.say(m.label + ' กำลังเดินไป'); }
}

function sitOn(seatName) {
  const s = pack.seats.get(seatName);
  if (!s) return;
  const spot = hotspotFor(seatName);
  if (spot) ui.showCard(seatName, spot);
  const { member, blockedBy } = crew.sendToSeat(seatName);
  if (blockedBy) { ui.say(blockedBy.label + ' จองที่นั่งนี้ไว้แล้ว'); return; }
  if (!member) return;
  showMarker(s.three.approach[0], s.three.approach[2]);
  ui.say(member.label + ' กำลังไป' + (spot?.label ?? seatName));
}

function runAction(id, name, spot) {
  if (id === 'sit') { sitOn(name); return; }
  if (id.startsWith('sit:')) { sitOn(id.slice(4)); return; }
  if (id === 'sit-manager') { sitOn('ManagerChair'); return; }

  // ---- team actions: the hotspots that used to be toasts now open the agent office
  if (id === 'meet' || id === 'gather') { director.gather(); ui.say('ทุกคนมาที่โต๊ะประชุม'); ui.hideCard(); return; }
  if (id === 'report') {
    const m = crew.selected ?? crew.members[0];
    director.reportTo(m);
    ui.say(m.label + ' ไปรายงานที่โต๊ะผู้จัดการ');
    return;
  }
  if (id === 'present') { panel.open('tv'); return; }
  if (id === 'notices' || id === 'tasks') { panel.open('board'); }
  if (id === 'browse') { panel.open('docs'); }
  if (id === 'post') { panel.open('chat'); return; }

  if (id === 'goto' || id === 'walk-here' || id === 'drink' || id === 'print' ||
      id === 'throw' || id === 'browse' || id === 'water' || id === 'read' ||
      id === 'admire' || id === 'notices' || id === 'tasks') {
    const seatName = SEAT_OF[name];
    if (seatName) { sitOn(seatName); return; }
    const near = approachPointFor(name);
    if (near) { walkTo(near.x, near.z); return; }
  }
  ui.say('ยังไม่ได้ผูก action "' + id + '" — เพิ่มทีหลังได้ที่ src/hotspots.js');
  console.info('[action]', { id, object: name });
}

/** Briefly light an office object up (the bookshelf when a doc lands, the TV when it shows something). */
const glowing = new Map();
function highlight(name, ms = 1400) {
  const obj = officeRoot?.getObjectByName(name);
  if (!obj) return;
  if (glowing.has(name)) clearTimeout(glowing.get(name).timer);
  const mats = [];
  obj.traverse((n) => {
    if (!n.isMesh) return;
    for (const m of Array.isArray(n.material) ? n.material : [n.material]) {
      if (!m?.emissive) continue;
      if (!m.userData.baseEmissive) m.userData.baseEmissive = { c: m.emissive.getHex(), i: m.emissiveIntensity };
      m.emissive.setHex(0x00adea);
      m.emissiveIntensity = 0.55;
      mats.push(m);
    }
  });
  const timer = setTimeout(() => {
    for (const m of mats) { m.emissive.setHex(m.userData.baseEmissive.c); m.emissiveIntensity = m.userData.baseEmissive.i; }
    glowing.delete(name);
  }, ms);
  glowing.set(name, { timer });
}

/** Nearest free floor point just outside an object's footprint, searched from `from`. */
const _box = new THREE.Box3();
const _c = new THREE.Vector3();
function approachPointFor(name, from = null) {
  const obj = officeRoot.getObjectByName(name);
  if (!obj) return null;
  _box.setFromObject(obj);
  _box.getCenter(_c);
  from = from ?? (crew.selected ?? crew.members[0]).obj.position;
  for (let r = 0.55; r <= 2.2; r += 0.25) {
    for (let a = 0; a < 12; a++) {
      const ang = (a / 12) * Math.PI * 2 + Math.atan2(from.x - _c.x, from.z - _c.z);
      const x = _c.x + Math.sin(ang) * (r + (_box.max.x - _box.min.x) / 2);
      const z = _c.z + Math.cos(ang) * (r + (_box.max.z - _box.min.z) / 2);
      if (x < ROOM.minX || x > ROOM.maxX || z < ROOM.minZ || z > ROOM.maxZ) continue;
      if (!crew.nav.isBlocked(x, z)) return { x, z };
    }
  }
  return null;
}

// ---------------------------------------------------------------- click marker
function makeMarker() {
  const g = new THREE.RingGeometry(0.16, 0.22, 32);
  const m = new THREE.MeshBasicMaterial({
    color: 0x00ADEA, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(g, m);
  mesh.rotation.x = -Math.PI / 2;
  mesh.visible = false;
  mesh.userData.life = 0;
  return mesh;
}

function showMarker(x, z) {
  marker.position.set(x, 0.012, z);
  marker.userData.life = 0.7;
  marker.scale.setScalar(1);
  marker.visible = true;
}
