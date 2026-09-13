// main.js -- wire the office, the character and the UI together.

import * as THREE from 'three';
import { CharacterPack, matchScene } from './characters.js';
import { createViewer, ROOM } from './scene.js';
import { NavGrid } from './nav.js';
import { CharacterController } from './character.js';
import { hotspotFor, SKIP, SEAT_OF } from './hotspots.js';
import { createUI } from './ui.js';

const CHARACTER = 'eng_m1';
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
});

let pack, controller, marker, officeRoot;
const pickables = [];
const seatNames = new Set();

init().catch((e) => { console.error(e); ui.failed(e.message ?? e); });

async function init() {
  ui.progress('กำลังโหลดฉากและตัวละคร…');
  pack = await CharacterPack.load('/');

  const office = await pack.loadOffice("/ube_office.glb");
  officeRoot = office;
  matchScene(office, { stripMaps: false, envIntensity: 0.25 });
  viewer.scene.add(office);
  office.traverse((n) => { if (n.isMesh && !SKIP.has(n.name)) pickables.push(n); });
  // the floor is not a hotspot but it IS the walk target, so it stays pickable
  const floor = office.getObjectByName('Floor');
  if (floor && !pickables.includes(floor)) pickables.push(floor);
  for (const s of pack.seats.keys()) seatNames.add(s);

  ui.progress('กำลังวางตัวละคร…');
  const info = pack.info(CHARACTER);
  if (!info) throw new Error('ไม่พบตัวละคร ' + CHARACTER + ' ใน characters.json');
  const hero = pack.spawn(CHARACTER, { at: [2.2, -2.6], faceY: Math.PI * 0.75 });
  viewer.scene.add(hero);

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
  console.info('[character] clips:', (hero.userData.clips ?? []).map((c) => c.name).join(', ') || 'none');

  controller = new CharacterController(hero, {
    nav,
    seats: pack.seats,
    sitHipY: info.sit_hip_y ?? 0.46,
  });

  marker = makeMarker();
  viewer.scene.add(marker);

  host.addEventListener('pointerdown', onPointerDown);
  host.addEventListener('contextmenu', (e) => e.preventDefault());

  let last = performance.now();
  frame();
  function frame() {
    requestAnimationFrame(frame);
    const now = performance.now();
    const dt = Math.min((now - last) / 1000, 0.05);   // clamp: a backgrounded tab returns seconds
    last = now;
    viewer.controls.update();
    controller.update(dt);
    pack.update(dt);
    if (marker.visible) {
      marker.userData.life -= dt;
      marker.material.opacity = Math.max(0, marker.userData.life) * 1.4;
      marker.scale.setScalar(1 + (1 - Math.max(0, marker.userData.life)) * 0.5);
      if (marker.userData.life <= 0) marker.visible = false;
    }
    viewer.render();
  }

  // Handy from the devtools console: __ube.controller.walkTo(5, -2).
  // `step` advances the simulation by hand -- embedded preview panes often park
  // requestAnimationFrame, and this makes the app testable there anyway.
  window.__ube = {
    viewer, pack, controller, nav, hero, office, pickables,
    step(n = 60, dt = 1 / 60) {
      for (let i = 0; i < n; i++) { controller.update(dt); pack.update(dt); }
      viewer.render();
    },
    screenOf(name) {
      const o = viewer.scene.getObjectByName(name);
      if (!o) return null;
      const p = new THREE.Box3().setFromObject(o).getCenter(new THREE.Vector3());
      p.project(viewer.camera);
      const r = viewer.renderer.domElement.getBoundingClientRect();
      return { x: Math.round((p.x * 0.5 + 0.5) * r.width), y: Math.round((-p.y * 0.5 + 0.5) * r.height) };
    },
  };

  ui.ready();
  ui.say('คลิกพื้นเพื่อให้เดิน หรือคลิกเก้าอี้เพื่อไปนั่ง');
}

// ---------------------------------------------------------------- picking
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

  const hits = viewer.pick(event, pickables);
  if (!hits.length) { ui.hideCard(); return; }
  const hit = hits[0];
  const name = topName(hit.object);

  if (name === 'Floor' || name === 'Rug') {
    walkTo(hit.point.x, hit.point.z);
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
  if (controller.nav.isBlocked(x, z)) {
    ui.say('ตรงนั้นเดินไปไม่ได้');
    return;
  }
  controller.walkTo(x, z);
  showMarker(x, z);
}

function sitOn(seatName) {
  const s = pack.seats.get(seatName);
  if (!s) return;
  const spot = hotspotFor(seatName);
  if (spot) ui.showCard(seatName, spot);
  controller.goToSeat(seatName);
  showMarker(s.three.approach[0], s.three.approach[2]);
  ui.say('กำลังเดินไป' + (spot?.label ?? seatName));
}

function runAction(id, name, spot) {
  if (id === 'sit') { sitOn(name); return; }
  if (id.startsWith('sit:')) { sitOn(id.slice(4)); return; }
  if (id === 'sit-manager') { sitOn('ManagerChair'); return; }
  if (id === 'goto' || id === 'walk-here' || id === 'drink' || id === 'print' ||
      id === 'throw' || id === 'browse' || id === 'water' || id === 'read' ||
      id === 'admire' || id === 'notices') {
    const seatName = SEAT_OF[name];
    if (seatName) { sitOn(seatName); return; }
    const near = approachPointFor(name);
    if (near) { walkTo(near.x, near.z); ui.say('กำลังเดินไป' + (spot?.label ?? name)); return; }
  }
  ui.say('ยังไม่ได้ผูก action "' + id + '" — เพิ่มทีหลังได้ที่ src/hotspots.js');
  console.info('[action]', { id, object: name });
}

/** Nearest free floor point just outside an object's footprint. */
const _box = new THREE.Box3();
const _c = new THREE.Vector3();
function approachPointFor(name) {
  const obj = viewer.scene.getObjectByName(name);
  if (!obj) return null;
  _box.setFromObject(obj);
  _box.getCenter(_c);
  const from = controller.obj.position;
  for (let r = 0.55; r <= 2.2; r += 0.25) {
    for (let a = 0; a < 12; a++) {
      const ang = (a / 12) * Math.PI * 2 + Math.atan2(from.x - _c.x, from.z - _c.z);
      const x = _c.x + Math.sin(ang) * (r + (_box.max.x - _box.min.x) / 2);
      const z = _c.z + Math.cos(ang) * (r + (_box.max.z - _box.min.z) / 2);
      if (x < ROOM.minX || x > ROOM.maxX || z < ROOM.minZ || z > ROOM.maxZ) continue;
      if (!controller.nav.isBlocked(x, z)) return { x, z };
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
