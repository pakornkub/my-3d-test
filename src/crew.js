// crew.js -- everyone in the office, and who you are currently giving orders to.
//
// One CharacterController per person was already the shape of character.js; this adds the
// three things that only matter once there is more than one of them:
//   * a selection, so a click has an unambiguous subject
//   * seat claims, so two people cannot walk into the same chair
//   * a separation pass, because the A* grid is static and knows nothing about bodies

import * as THREE from 'three';
import { CharacterController } from './character.js';

const PERSONAL_SPACE = 0.30;      // metres, radius -- two idle chibis stop at 0.6 m apart

export class Crew {
  constructor({ pack, nav, scene }) {
    this.pack = pack;
    this.nav = nav;
    this.scene = scene;
    this.members = [];
    this.selected = null;
    this.onChange = () => {};
    this.ring = makeSelectionRing();
    this.scene.add(this.ring);
  }

  /**
   * @param spec { id, label, at:[x,z], faceY, fallback, tint }
   * `fallback` lets the crew stay full while only some models exist: a missing id spawns
   * the fallback model, flagged as a placeholder so the UI can say so.
   */
  add(spec) {
    const id = this.pack.info(spec.id) ? spec.id : spec.fallback;
    const info = id && this.pack.info(id);
    if (!info) {
      console.warn('[crew] no model for', spec.id, '(and no usable fallback)');
      return null;
    }
    const [x, z] = this.#freeSpot(spec.at);
    const obj = this.pack.spawn(id, { at: [x, z], faceY: spec.faceY ?? 0 });
    obj.name = spec.id;
    this.scene.add(obj);

    const placeholder = id !== spec.id;
    if (placeholder && spec.tint) tint(obj, spec.tint);

    const member = {
      id: spec.id,
      label: spec.label ?? spec.id,
      model: id,
      placeholder,
      obj,
      ctl: new CharacterController(obj, {
        nav: this.nav,
        seats: this.pack.seats,
        sitHipY: info.sit_hip_y ?? 0.46,
        onState: () => this.onChange(),
      }),
    };
    obj.userData.member = member;
    this.members.push(member);
    this.onChange();
    return member;
  }

  /** Spawn points are hand-written, so nudge them out of the furniture if one is wrong. */
  #freeSpot([x, z]) {
    if (!this.nav.isBlocked(x, z)) return [x, z];
    const { c, r } = this.nav.cellAt(x, z);
    const free = this.nav.nearestFree(c, r, 12);
    if (!free) return [x, z];
    const p = this.nav.centre(free.c, free.r);
    return [p.x, p.z];
  }

  // ---------------------------------------------------------------- selection
  select(member) {
    this.selected = member ?? null;
    this.onChange();
    return this.selected;
  }

  selectIndex(i) { return this.select(this.members[i] ?? null); }

  /** Walk a raycast hit back up to the person it belongs to, if any. */
  memberOf(object3d) {
    for (let n = object3d; n; n = n.parent) if (n.userData?.member) return n.userData.member;
    return null;
  }

  /** Explicit selection wins; otherwise the nearest person who is not already busy. */
  #subject(target) {
    if (this.selected) return this.selected;
    const idle = this.members.filter((m) => !m.ctl.busy);
    const pool = idle.length ? idle : this.members;
    if (!pool.length) return null;
    if (!target) return pool[0];
    return pool.reduce((best, m) => {
      const d = (m.obj.position.x - target.x) ** 2 + (m.obj.position.z - target.z) ** 2;
      return !best || d < best.d ? { m, d } : best;
    }, null).m;
  }

  // ---------------------------------------------------------------- commands
  sendTo(x, z, member = null) {
    const m = member ?? this.#subject({ x, z });
    if (!m) return null;
    m.ctl.walkTo(x, z);
    this.onChange();
    return m;
  }

  /** @returns { member } on success, or { blockedBy } when someone already has that seat. */
  sendToSeat(seatName, member = null) {
    const seat = this.pack.seats.get(seatName);
    if (!seat) return {};
    this.#syncClaims();
    const holder = this.claims.get(seatName);
    const target = { x: seat.three.approach[0], z: seat.three.approach[2] };
    const m = member ?? this.#subject(target);
    if (!m) return {};
    if (holder && holder !== m) return { blockedBy: holder };
    m.ctl.goToSeat(seatName);
    this.onChange();
    return { member: m };
  }

  /** A seat counts as taken from the moment someone sets off towards it. */
  #syncClaims() {
    this.claims = new Map();
    for (const m of this.members) {
      const s = m.ctl.seat;
      if (s) this.claims.set(s.name, m);
    }
  }

  seatHolder(seatName) {
    this.#syncClaims();
    return this.claims.get(seatName) ?? null;
  }

  // ---------------------------------------------------------------- frame
  update(dt) {
    for (const m of this.members) m.ctl.update(dt);
    this.#separate();
    const sel = this.selected;
    this.ring.visible = !!sel;
    if (sel) {
      this.ring.position.set(sel.obj.position.x, sel.obj.position.y + 0.015, sel.obj.position.z);
      this.ring.rotation.z += dt * 0.6;
    }
  }

  /**
   * Push overlapping people apart after they have moved. Cheaper and steadier than making
   * the pathfinder dynamic, and at five bodies in a 10x8 m room it is all that is needed.
   * Seated people are anchors: they never get shoved off their chair.
   */
  #separate() {
    const min = PERSONAL_SPACE * 2;
    for (let i = 0; i < this.members.length; i++) {
      for (let j = i + 1; j < this.members.length; j++) {
        const a = this.members[i], b = this.members[j];
        const ax = a.obj.position, bx = b.obj.position;
        const dx = bx.x - ax.x, dz = bx.z - ax.z;
        const d = Math.hypot(dx, dz);
        if (d >= min || d < 1e-5) continue;
        const aFixed = a.ctl.seated || a.ctl.state === 'sitDown';
        const bFixed = b.ctl.seated || b.ctl.state === 'sitDown';
        if (aFixed && bFixed) continue;
        const overlap = min - d;
        const ux = dx / d, uz = dz / d;
        const share = aFixed || bFixed ? overlap : overlap / 2;
        if (!aFixed) this.#nudge(a, -ux * share, -uz * share);
        if (!bFixed) this.#nudge(b, ux * share, uz * share);
      }
    }
  }

  #nudge(m, dx, dz) {
    const p = m.obj.position;
    const nx = p.x + dx, nz = p.z + dz;
    if (this.nav.isBlocked(nx, nz)) return;     // never let a shove push someone into a desk
    p.x = nx;
    p.z = nz;
  }
}

// ---------------------------------------------------------------- bits
function makeSelectionRing() {
  const g = new THREE.RingGeometry(0.24, 0.30, 40, 1, 0, Math.PI * 1.55);
  const m = new THREE.MeshBasicMaterial({
    color: 0x00ADEA, transparent: true, opacity: 0.85,
    depthWrite: false, side: THREE.DoubleSide,
  });
  const ring = new THREE.Mesh(g, m);
  ring.rotation.x = -Math.PI / 2;
  ring.renderOrder = 2;
  ring.visible = false;
  return ring;
}

/**
 * Placeholder crew members are all the same model, which reads as a bug. A light multiply
 * on the base colour tells them apart without editing the source asset; it disappears on
 * its own once every id has a real model.
 */
function tint(root, hex) {
  root.traverse((n) => {
    if (!n.isMesh && !n.isSkinnedMesh) return;
    const mats = Array.isArray(n.material) ? n.material : [n.material];
    n.material = mats.map((m) => {
      const c = m.clone();
      c.color = new THREE.Color(hex);
      return c;
    });
    if (!Array.isArray(n.material)) n.material = n.material[0];
    if (n.material.length === 1) n.material = n.material[0];
  });
}
