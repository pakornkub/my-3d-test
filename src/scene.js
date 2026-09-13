// scene.js -- renderer, lighting and the two cameras.
//
// The Iso preset reproduces iso_office_lib.camera_lights() one-for-one, so the browser view
// is the same framing as renders/ube_iso_office_final.png. Free mode is a narrow-FOV
// perspective camera on the same orbit target, so switching does not jump.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export const ROOM = { minX: 0, maxX: 10, minZ: -8, maxZ: 0, height: 3 };
const TARGET = new THREE.Vector3(5.3, 1.0, -4.0);
const ISO_DIR = new THREE.Vector3(12, 10.5, 12);
const ISO_WIDTH = 14.6;

export function createViewer(host) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;   // PCFSoft was removed in r186
  renderer.toneMapping = THREE.AgXToneMapping ?? THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  host.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xf1f2f3);

  // ---- lights: the Blender setup was a sun + soft fill + bright white world ----
  const sun = new THREE.DirectionalLight(0xfff6ea, 2.2);
  sun.position.set(9, 12, 10);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const d = 9;
  const sc = sun.shadow.camera;
  sc.left = -d; sc.right = d; sc.top = d; sc.bottom = -d; sc.near = 1; sc.far = 40;
  sc.updateProjectionMatrix();                 // without this the frustum stays at the default
  sun.shadow.bias = -0.0006;
  sun.shadow.normalBias = 0.02;
  sun.target.position.copy(TARGET);
  scene.add(sun, sun.target);
  scene.add(new THREE.HemisphereLight(0xffffff, 0xb8bcc4, 1.2));
  const fill = new THREE.DirectionalLight(0xe8f0ff, 0.45);
  fill.position.set(-6, 5, -8);
  scene.add(fill);

  // ---- cameras ----
  const ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 120);
  const persp = new THREE.PerspectiveCamera(35, 1, 0.1, 200);
  let mode = 'iso';
  let camera = ortho;

  let controls = null;
  function bindControls() {
    const target = controls ? controls.target.clone() : TARGET.clone();
    if (controls) controls.dispose();
    controls = new OrbitControls(camera, renderer.domElement);
    controls.target.copy(target);
    controls.enableDamping = true;
    controls.dampingFactor = 0.075;
    controls.minPolarAngle = 0.15;
    controls.maxPolarAngle = 1.45;             // never dip below the floor
    controls.minDistance = 4;
    controls.maxDistance = 40;
    controls.screenSpacePanning = false;
    controls.mouseButtons = {
      LEFT: null,                              // left click is for interacting, not orbiting
      MIDDLE: THREE.MOUSE.DOLLY,
      RIGHT: THREE.MOUSE.ROTATE,
    };
    controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
    controls.addEventListener('change', clampPan);
    controls.update();
  }

  // keep the orbit target inside the room so the view cannot be flown away
  const tmp = new THREE.Vector3();
  function clampPan() {
    const t = controls.target;
    tmp.copy(t);
    t.x = THREE.MathUtils.clamp(t.x, ROOM.minX - 1, ROOM.maxX + 1);
    t.z = THREE.MathUtils.clamp(t.z, ROOM.minZ - 1, ROOM.maxZ + 1);
    t.y = THREE.MathUtils.clamp(t.y, 0, ROOM.height);
    if (!tmp.equals(t)) camera.position.add(tmp.sub(t).negate());
  }

  function resize() {
    const w = host.clientWidth || innerWidth;
    const h = host.clientHeight || innerHeight;
    const aspect = w / h;
    renderer.setSize(w, h);
    persp.aspect = aspect;
    persp.updateProjectionMatrix();
    ortho.left = -ISO_WIDTH / 2;
    ortho.right = ISO_WIDTH / 2;
    ortho.top = ISO_WIDTH / aspect / 2;
    ortho.bottom = -ISO_WIDTH / aspect / 2;
    ortho.updateProjectionMatrix();
  }

  function setMode(next) {
    if (next === mode) return mode;
    const from = camera;
    const target = controls.target.clone();
    const offset = from.position.clone().sub(target);
    mode = next;
    camera = next === 'iso' ? ortho : persp;
    // keep the same viewing direction; pick a distance that frames the room in either lens
    const dir = offset.clone().normalize();
    const dist = next === 'iso' ? 20 : THREE.MathUtils.clamp(offset.length(), 10, 22);
    camera.position.copy(target).add(dir.multiplyScalar(dist));
    camera.lookAt(target);
    bindControls();
    return mode;
  }

  function reset() {
    controls.target.copy(TARGET);
    // .copy() returns the position itself -- cloning here would move the clone, not the camera
    camera.position.copy(TARGET).add(camera === ortho ? ISO_DIR : ISO_DIR.clone().setLength(19));
    camera.zoom = 1;
    camera.updateProjectionMatrix();
    camera.lookAt(TARGET);
    camera.updateMatrixWorld();
    controls.update();
  }

  // ---- pointer picking ----
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  function pick(event, objects) {
    const rect = renderer.domElement.getBoundingClientRect();
    ndc.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    ndc.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(ndc, camera);
    return raycaster.intersectObjects(objects, true);
  }

  ortho.position.copy(TARGET).add(ISO_DIR);
  persp.position.copy(TARGET).add(ISO_DIR);
  ortho.lookAt(TARGET);
  persp.lookAt(TARGET);
  bindControls();
  resize();
  addEventListener('resize', resize);

  return {
    scene, renderer, sun,
    get camera() { return camera; },
    get controls() { return controls; },
    get mode() { return mode; },
    setMode, reset, resize, pick,
    render: () => renderer.render(scene, camera),
  };
}
