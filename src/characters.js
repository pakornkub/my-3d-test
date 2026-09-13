// characters.js -- load the UBE character pack (Meshy -> tripo_import.py -> rig_character.py
// -> GLB) and place people on the seats from seats.json.
//
// The GLBs are already real-scale, Y-up, origin between the feet, facing -Z, so nothing
// here rescales or recolours. Scene setup lives in scene.js; this file is assets only.
//
//   const pack = await CharacterPack.load('/');
//   scene.add(await pack.loadOffice('/ube_office.glb'));
//   scene.add(pack.spawn('eng_m1', { at: [2.2, -2.6] }));
//   ... per frame: pack.update(dt);

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as skeletonClone } from 'three/addons/utils/SkeletonUtils.js';

const loader = new GLTFLoader();
const loadGLTF = url => new Promise((res, rej) => loader.load(url, res, undefined, rej));
const loadJSON = url => fetch(url).then(r => r.json());

// ---------------------------------------------------------------- pack
export class CharacterPack {
  constructor(base, manifest, seats, obstacles) {
    this.base = base;
    this.manifest = manifest;
    this.seats = new Map((seats?.seats ?? []).map(s => [s.name, s]));
    this.obstacles = obstacles?.obstacles ?? [];
    this.sources = new Map();   // id -> { gltf, animations }
    this.mixers = [];
  }

  /** base is the folder holding ube_office.glb, seats.json and characters/ */
  static async load(base = './export/') {
    const b = base.endsWith('/') ? base : base + '/';
    const [manifest, seats, obstacles] = await Promise.all([
      loadJSON(b + 'characters/characters.json'),
      loadJSON(b + 'seats.json').catch(() => null),
      loadJSON(b + 'obstacles.json').catch(() => null),
    ]);
    const pack = new CharacterPack(b, manifest, seats, obstacles);
    const ids = Object.keys(manifest.characters);
    await Promise.all(ids.map(async id => {
      const info = manifest.characters[id];
      const gltf = await loadGLTF(b + 'characters/' + info.file);
      pack.sources.set(id, { gltf, animations: gltf.animations ?? [] });
    }));
    return pack;
  }

  get ids() { return [...this.sources.keys()]; }
  info(id) { return this.manifest.characters[id]; }

  /**
   * spawn('eng_m1', { seat:'ChairA1' })            -> standing on the approach spot
   * spawn('eng_m1', { seat:'ChairA1', mode:'sit' })-> on the chair, plays a sit clip
   * spawn('eng_m1', { at:[x,z], faceY: 0 })        -> anywhere on the floor
   */
  spawn(id, opts = {}) {
    const src = this.sources.get(id);
    if (!src) throw new Error('unknown character: ' + id);
    const obj = skeletonClone(src.gltf.scene);
    obj.name = id;
    obj.userData.characterId = id;
    matchScene(obj);

    if (src.animations.length) {
      const mixer = new THREE.AnimationMixer(obj);
      obj.userData.mixer = mixer;
      obj.userData.clips = src.animations;
      this.mixers.push(mixer);
    }

    if (opts.seat) this.placeAtSeat(obj, opts.seat, opts.mode ?? 'stand');
    else if (opts.at) {
      obj.position.set(opts.at[0], opts.y ?? 0, opts.at[1]);
      obj.rotation.y = opts.faceY ?? 0;
    }
    if (opts.clip) play(obj, opts.clip);
    return obj;
  }

  /** mode 'stand' uses the chair's approach spot; 'sit' puts them on the chair. */
  placeAtSeat(obj, seatName, mode = 'stand') {
    const s = this.seats.get(seatName);
    if (!s) { console.warn('[characters] no seat', seatName); return obj; }
    const t = s.three;
    const p = mode === 'sit' ? t.seat : t.approach;
    obj.position.set(p[0], 0, p[2]);                 // feet stay on the floor either way
    obj.rotation.y = t.rotation_y_rad ?? 0;
    obj.userData.seat = seatName;
    if (mode === 'sit') {
      const clip = findClip(obj, /sit|chair/i);
      if (clip) play(obj, clip.name);
      else console.warn('[characters] no sit clip on ' + obj.name +
                        ' -- rig it in Tripo or pose it in ube_characters.blend');
    }
    return obj;
  }

  /** true when a point on the floor is inside a piece of furniture or a wall */
  blocked(x, z, radius = 0.25) {
    for (const o of this.obstacles) {
      const { min, max } = o.three;
      if (x > min[0] - radius && x < max[0] + radius &&
          z > min[2] - radius && z < max[2] + radius && min[1] < 1.2) return o.name;
    }
    return null;
  }

  async loadOffice(url) {
    const gltf = await loadGLTF(url);
    gltf.scene.traverse(n => {
      if (n.isMesh) { n.castShadow = true; n.receiveShadow = true; }
    });
    return gltf.scene;
  }

  update(dt) { for (const m of this.mixers) m.update(dt); }
}

// ---------------------------------------------------------------- look
/**
 * Shadows on, and the same matte response as the office's 28 flat materials.
 * `stripMaps` throws away the normal/roughness/metallic maps -- leave it off for the
 * Meshy character, whose maps are part of how it was authored, and turn it on only if
 * a generator hands back something glossier than the room.
 */
export function matchScene(root, opts = {}) {
  const {
    roughness = 0.62, metalness = 0.0, envIntensity = 0.35,
    flat = false, stripMaps = false,
  } = opts;
  root.traverse(n => {
    if (!n.isMesh && !n.isSkinnedMesh) return;
    n.castShadow = true;
    n.receiveShadow = true;
    n.frustumCulled = false;                    // skinned bounds are unreliable
    for (const m of (Array.isArray(n.material) ? n.material : [n.material])) {
      if (!m) continue;
      if (m.metalness !== undefined) m.metalness = metalness;
      m.envMapIntensity = envIntensity;
      if (stripMaps) {
        m.roughness = roughness;
        m.normalMap = null;
        m.roughnessMap = null;
        m.metalnessMap = null;
        m.aoMap = null;
      } else if (!m.roughnessMap && m.roughness !== undefined) {
        m.roughness = roughness;
      }
      m.flatShading = flat;
      if (m.map) m.map.anisotropy = 4;
      m.needsUpdate = true;
    }
  });
  return root;
}

export function findClip(obj, re) {
  return (obj.userData.clips ?? []).find(c => re.test(c.name)) ?? null;
}

export function play(obj, clipName, { loop = true, fade = 0.25 } = {}) {
  const mixer = obj.userData.mixer;
  const clip = (obj.userData.clips ?? []).find(c => c.name === clipName);
  if (!mixer || !clip) return null;
  const action = mixer.clipAction(clip);
  action.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
  action.clampWhenFinished = !loop;
  const prev = obj.userData.action;
  if (prev && prev !== action) prev.fadeOut(fade);
  action.reset().fadeIn(fade).play();
  obj.userData.action = action;
  return action;
}
