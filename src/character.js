// character.js -- walk / turn / sit state machine for one character.
//
// Facing convention: the GLB faces -Z at rotation.y = 0, which is exactly what
// seats.json stores in `rotation_y_rad`. So the heading for a direction (dx, dz) is
// atan2(-dx, -dz), and a seat's stored angle can be used verbatim.

import * as THREE from 'three';
import { play, findClip } from './characters.js';

const TAU = Math.PI * 2;
const shortestAngle = (from, to) => ((((to - from) % TAU) + TAU + Math.PI) % TAU) - Math.PI;
export const headingFor = (dx, dz) => Math.atan2(-dx, -dz);

export class CharacterController {
  /**
   * @param obj   the spawned THREE.Object3D (origin between the feet)
   * @param opts  { nav, seats, sitHipY, speed, turnSpeed, onState }
   */
  constructor(obj, { nav, seats, sitHipY = 0.46, speed = 1.15, turnSpeed = 7.0, onState } = {}) {
    this.obj = obj;
    this.nav = nav;
    this.seats = seats;
    this.sitHipY = sitHipY;
    this.speed = speed;
    this.turnSpeed = turnSpeed;
    this.onState = onState ?? (() => {});

    this.state = 'idle';
    this.path = [];
    this.leg = 0;
    this.heading = obj.rotation.y;
    this.pending = null;                 // queued destination while standing up
    this.seat = null;                    // seat record we are sitting on / heading to
    this.t = 0;                          // timer inside a timed state
    this.from = new THREE.Vector3();
    this.to = new THREE.Vector3();

    this.has = {
      idle: !!findClip(obj, /^idle$/i),
      walk: !!findClip(obj, /^walk$/i),
      sit: !!findClip(obj, /^sit$/i),
      sitIdle: !!findClip(obj, /^sitidle$/i),
    };
    this.sitDuration = this.#durationOf(/^sit$/i) || 1.2;
    this.#enter('idle');
  }

  #durationOf(re) {
    const clip = findClip(this.obj, re);
    return clip ? clip.duration : 0;
  }

  #enter(state) {
    this.state = state;
    this.t = 0;
    if (state === 'idle' && this.has.idle) play(this.obj, 'Idle', { fade: 0.25 });
    if (state === 'walk' && this.has.walk) play(this.obj, 'Walk', { fade: 0.18 });
    if (state === 'seated' && this.has.sitIdle) play(this.obj, 'SitIdle', { fade: 0.3 });
    this.onState(state);
  }

  get busy() { return this.state !== 'idle' && this.state !== 'seated'; }
  get seated() { return this.state === 'seated'; }

  /** Walk to a floor point. Cancels whatever was happening, standing up first if needed. */
  walkTo(x, z) {
    const dest = { x, z, seat: null };
    if (this.state === 'seated') { this.pending = dest; this.#standUp(); return true; }
    return this.#startWalk(dest);
  }

  /** Walk to a chair's approach spot, turn to face it, then sit. */
  goToSeat(name) {
    const s = this.seats.get(name);
    if (!s) return false;
    const a = s.three.approach;
    const dest = { x: a[0], z: a[2], seat: s };
    if (this.state === 'seated') {
      if (this.seat === s) return false;      // already on it
      this.pending = dest;
      this.#standUp();
      return true;
    }
    return this.#startWalk(dest);
  }

  #startWalk(dest) {
    const here = { x: this.obj.position.x, z: this.obj.position.z };
    const path = this.nav.findPath(here, { x: dest.x, z: dest.z });
    if (!path || path.length < 2) {
      // already there, or unreachable: still honour a seat request
      if (dest.seat) { this.seat = dest.seat; this.#enter('faceSeat'); return true; }
      return false;
    }
    this.path = path;
    this.leg = 1;
    this.seat = dest.seat;
    this.#aimAtLeg();
    this.#enter(Math.abs(shortestAngle(this.obj.rotation.y, this.heading)) > 0.45 ? 'turn' : 'walk');
    return true;
  }

  #aimAtLeg() {
    const p = this.path[this.leg];
    const dx = p.x - this.obj.position.x;
    const dz = p.z - this.obj.position.z;
    if (Math.hypot(dx, dz) > 1e-4) this.heading = headingFor(dx, dz);
  }

  #standUp() {
    if (!this.seat) { this.#enter('idle'); return; }
    const a = this.seat.three.approach;
    this.from.copy(this.obj.position);
    this.to.set(a[0], 0, a[2]);
    if (this.has.sit) {
      const act = play(this.obj, 'Sit', { loop: false, fade: 0.15 });
      if (act) { act.timeScale = -1; act.time = this.sitDuration; act.paused = false; }
    }
    this.#enter('standUp');
  }

  #sitDown() {
    const s = this.seat.three;
    this.from.copy(this.obj.position);
    this.to.set(s.seat[0], Math.max(0, s.seat[1] - this.sitHipY), s.seat[2]);
    if (this.has.sit) {
      const act = play(this.obj, 'Sit', { loop: false, fade: 0.2 });
      if (act) { act.timeScale = 1; act.time = 0; }
    }
    this.#enter('sitDown');
  }

  update(dt) {
    const o = this.obj;
    // yaw always eases toward the current heading, whatever the state
    const turn = shortestAngle(o.rotation.y, this.heading);
    const step = Math.sign(turn) * Math.min(Math.abs(turn), this.turnSpeed * dt);
    o.rotation.y += step;
    const aimed = Math.abs(turn) < 0.06;

    switch (this.state) {
      case 'turn':
        if (aimed) this.#enter('walk');
        break;

      case 'walk': {
        const p = this.path[this.leg];
        const dx = p.x - o.position.x;
        const dz = p.z - o.position.z;
        const dist = Math.hypot(dx, dz);
        const move = this.speed * dt;
        if (dist <= move) {
          o.position.x = p.x;
          o.position.z = p.z;
          this.leg++;
          if (this.leg >= this.path.length) {
            if (this.seat) {
              this.heading = this.seat.three.rotation_y_rad ?? 0;
              this.#enter('faceSeat');
            } else {
              this.#enter('idle');
            }
          } else {
            this.#aimAtLeg();
          }
        } else {
          o.position.x += (dx / dist) * move;
          o.position.z += (dz / dist) * move;
          this.#aimAtLeg();
        }
        break;
      }

      case 'faceSeat':
        if (aimed) this.#sitDown();
        break;

      case 'sitDown': {
        this.t += dt;
        const k = Math.min(1, this.t / this.sitDuration);
        o.position.lerpVectors(this.from, this.to, k * k * (3 - 2 * k));
        if (k >= 1) this.#enter('seated');
        break;
      }

      case 'standUp': {
        this.t += dt;
        const k = Math.min(1, this.t / this.sitDuration);
        o.position.lerpVectors(this.from, this.to, k * k * (3 - 2 * k));
        if (k >= 1) {
          this.seat = null;
          const next = this.pending;
          this.pending = null;
          this.#enter('idle');
          if (next) this.#startWalk(next);
        }
        break;
      }
    }
  }
}
