// bubbles.js -- speech bubbles floating above heads.
//
// DOM labels via CSS2DRenderer rather than sprite textures: Thai text stays crisp at any
// zoom, wraps like normal text, and the stylesheet owns the look. One CSS2DObject per
// person, parented to the character so it follows walks and sits for free.

import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';

export class Bubbles {
  constructor(host) {
    this.host = host;
    this.renderer = new CSS2DRenderer();
    const el = this.renderer.domElement;
    el.id = 'bubbles';
    el.style.position = 'absolute';
    el.style.top = '0';
    el.style.left = '0';
    el.style.pointerEvents = 'none';
    host.appendChild(el);
    this.entries = new Map();   // member.id -> { obj, root, text, ttl }
    this.resize();
    addEventListener('resize', () => this.resize());
  }

  resize() {
    this.renderer.setSize(this.host.clientWidth || innerWidth, this.host.clientHeight || innerHeight);
  }

  /** Lazily attach a label to a crew member. */
  #entry(member, height = 1.4) {
    let e = this.entries.get(member.id);
    if (e) return e;
    const root = document.createElement('div');
    root.className = 'bubble';
    root.innerHTML = '<span class="who"></span><span class="txt"></span>';
    root.querySelector('.who').textContent = member.label;
    const obj = new CSS2DObject(root);
    obj.position.set(0, height + 0.22, 0);
    obj.center.set(0.5, 1);       // anchor at the bubble's bottom-centre
    member.obj.add(obj);
    e = { obj, root, ttl: 0, kind: '' };
    this.entries.set(member.id, e);
    root.hidden = true;
    return e;
  }

  /**
   * kind: say | working | waiting | done | error | thinking
   * ttl in seconds; 0 keeps it until replaced or cleared.
   */
  say(member, text, { kind = 'say', ttl = 6, height } = {}) {
    const e = this.#entry(member, height);
    e.root.querySelector('.txt').textContent = text;
    e.root.className = 'bubble ' + kind;
    e.root.hidden = false;
    e.kind = kind;
    e.ttl = ttl;
    // restart the pop-in animation
    e.root.style.animation = 'none';
    void e.root.offsetWidth;
    e.root.style.animation = '';
  }

  clear(member) {
    const e = this.entries.get(member.id);
    if (e) { e.root.hidden = true; e.ttl = 0; }
  }

  update(dt) {
    for (const e of this.entries.values()) {
      if (e.root.hidden || e.ttl <= 0) continue;
      e.ttl -= dt;
      if (e.ttl <= 0) e.root.hidden = true;
    }
  }

  render(scene, camera) { this.renderer.render(scene, camera); }
}
