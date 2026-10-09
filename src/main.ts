import './style.css';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VRM, VRMLoaderPlugin, VRMUtils, VRMHumanBoneName } from '@pixiv/three-vrm';
import { FaceLandmarker, PoseLandmarker, FilesetResolver, type FaceLandmarkerResult, type Landmark, type NormalizedLandmark } from '@mediapipe/tasks-vision';
import { CHARACTERS, HAIRSTYLES, HAIR_COLORS, OUTFITS, BASE_URLS, charById, type Config } from './characters';
import { AvatarDresser } from './avatar';
import { ArmRig } from './arms';

// MediaPipe's wasm prints harmless INFO lines through console.error. Keep the console clean.
const origError = console.error.bind(console);
console.error = (...args: unknown[]) => {
  if (typeof args[0] === 'string' && /^(INFO|W\d{4}|I\d{4})/.test(args[0])) return;
  origError(...args);
};

const STORAGE_KEY = 'vtuber.custom.v1';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const canvas = $<HTMLCanvasElement>('scene');
const statusEl = $('status');
const startBtn = $<HTMLButtonElement>('startBtn');
const errorEl = $('error');
const hero = $('hero');
const video = $<HTMLVideoElement>('video');
const previewWrap = $('previewWrap');
const previewBtn = $<HTMLButtonElement>('previewBtn');
const trackBadge = $('trackBadge');
const modelName = $('modelName');
const toast = $('toast');

const setStatus = (t: string) => (statusEl.textContent = t);
let toastTimer = 0;
function showToast(t: string) {
  toast.textContent = t;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (toast.hidden = true), 3200);
}

// ---------- three.js scene ----------
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(24, window.innerWidth / window.innerHeight, 0.05, 50);
camera.position.set(0, 1.35, 1.6);
const lookTarget = new THREE.Vector3(0, 1.3, 0);

const key = new THREE.DirectionalLight(0xffffff, Math.PI * 0.9);
key.position.set(0.6, 1.6, 1.4);
scene.add(key);
const rim = new THREE.DirectionalLight(0x9fe8ff, Math.PI * 0.35);
rim.position.set(-1, 1.5, -1);
scene.add(rim);
scene.add(new THREE.AmbientLight(0xffffff, 0.6));

function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  // Portrait screens get a wider field of view so the head and shoulders still fit.
  camera.fov = w / h < 0.8 ? 34 : 24;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

// ---------- VRM loading ----------
const loader = new GLTFLoader();
loader.register((parser) => new VRMLoaderPlugin(parser));
let vrm: VRM | null = null;
let isVRM0 = false;
let restPose: Record<string, THREE.Euler> = {};

let dresser: AvatarDresser | null = null;
let arms: ArmRig | null = null;
let loadedUrl = '';
let isCustomModel = false;

async function loadVRM(url: string, label: string, custom = false) {
  setStatus('Loading avatar…');
  const gltf = await loader.loadAsync(url, (e) => {
    if (e.total) setStatus(`Loading avatar… ${Math.round((e.loaded / e.total) * 100)}%`);
  });
  const next = gltf.userData.vrm as VRM | undefined;
  if (!next) throw new Error('This file is not a VRM model.');
  VRMUtils.removeUnnecessaryVertices(gltf.scene);
  VRMUtils.combineSkeletons(gltf.scene);
  VRMUtils.rotateVRM0(next);
  next.scene.traverse((o) => (o.frustumCulled = false));

  if (vrm) {
    dresser?.dispose();
    scene.remove(vrm.scene);
    VRMUtils.deepDispose(vrm.scene);
  }
  vrm = next;
  isVRM0 = next.meta.metaVersion === '0';
  scene.add(next.scene);
  if (next.lookAt) next.lookAt.autoUpdate = false;

  // A relaxed idle pose instead of the T-pose (angles in VRM 1.0 space, facing +Z).
  restPose = {
    leftUpperArm: new THREE.Euler(0.15, 0, -1.2),
    rightUpperArm: new THREE.Euler(0.15, 0, 1.2),
    leftLowerArm: new THREE.Euler(0, -0.25, -0.12),
    rightLowerArm: new THREE.Euler(0, 0.25, 0.12),
    leftHand: new THREE.Euler(0, 0, -0.1),
    rightHand: new THREE.Euler(0, 0, 0.1),
  };
  const restLocal: Record<string, THREE.Quaternion> = {};
  for (const [name, e] of Object.entries(restPose))
    restLocal[name] = new THREE.Quaternion().setFromEuler(new THREE.Euler(isVRM0 ? -e.x : e.x, e.y, isVRM0 ? -e.z : e.z, 'YXZ'));
  // Measure the rest pose before anything moves.
  arms = new ArmRig(next, restLocal);
  dresser = custom ? null : new AvatarDresser(next);
  loadedUrl = url;
  isCustomModel = custom;
  frameCamera();
  modelName.textContent = label;
  setStatus(cameraOn ? 'Tracking' : 'Ready');
}

function frameCamera() {
  if (!vrm) return;
  vrm.scene.updateMatrixWorld(true);
  const head = vrm.humanoid.getNormalizedBoneNode('head');
  const p = new THREE.Vector3();
  if (head) head.getWorldPosition(p);
  else p.set(0, 1.35, 0);
  lookTarget.set(0, p.y - 0.2, 0);
  camera.position.set(0, p.y - 0.05, 2.3);
  camera.lookAt(lookTarget);
}

// Set a normalized bone rotation given in VRM 1.0 space. VRM 0.x bones need X and Z flipped.
const tmpEuler = new THREE.Euler();
function setBone(name: VRMHumanBoneName | string, x: number, y: number, z: number) {
  const node = vrm?.humanoid.getNormalizedBoneNode(name as VRMHumanBoneName);
  if (!node) return;
  const r = restPose[name];
  const rx = x + (r?.x ?? 0), ry = y + (r?.y ?? 0), rz = z + (r?.z ?? 0);
  tmpEuler.set(isVRM0 ? -rx : rx, ry, isVRM0 ? -rz : rz, 'YXZ');
  node.quaternion.setFromEuler(tmpEuler);
}

// ---------- Face tracking state ----------
const state = {
  yaw: 0, pitch: 0, roll: 0, x: 0,
  aa: 0, ih: 0, ou: 0, ee: 0, oh: 0,
  blinkL: 0, blinkR: 0,
  lookX: 0, lookY: 0,
  happy: 0,
};
const target = { ...state };
let landmarker: FaceLandmarker | null = null;
let poseLandmarker: PoseLandmarker | null = null;
let poseRuns = 0;
// Test hook: synthetic pose landmarks for automated checks.
let fakePose: { world: Landmark[]; image: NormalizedLandmark[] } | null = null;
let poseFrame = 0;
let cameraOn = false;
let lastVideoTime = -1;
let lastFaceAt = 0;

function resetTarget() {
  for (const k of Object.keys(target) as (keyof typeof target)[]) target[k] = 0;
}

const headMat = new THREE.Matrix4();
const headQuat = new THREE.Quaternion();
const headEuler = new THREE.Euler();
const v3 = new THREE.Vector3();
const s3 = new THREE.Vector3();

function bs(result: FaceLandmarkerResult) {
  const out: Record<string, number> = {};
  const cats = result.faceBlendshapes?.[0]?.categories ?? [];
  for (const c of cats) out[c.categoryName] = c.score;
  return out;
}
const clamp = (v: number, a = 0, b = 1) => Math.min(b, Math.max(a, v));

function applyResult(result: FaceLandmarkerResult) {
  const lm = result.faceLandmarks?.[0];
  const mat = result.facialTransformationMatrixes?.[0];
  if (!lm || !mat) return false;
  lastFaceAt = performance.now();

  // Head rotation. MediaPipe gives a camera space matrix (x right, y up, z toward camera).
  headMat.fromArray(mat.data);
  headMat.decompose(v3, headQuat, s3);
  headEuler.setFromQuaternion(headQuat, 'YXZ');
  // Mirror like a selfie: keep pitch, flip yaw and roll.
  target.pitch = clamp(headEuler.x, -0.9, 0.9);
  target.yaw = clamp(-headEuler.y, -1.1, 1.1);
  target.roll = clamp(-headEuler.z, -0.8, 0.8);
  target.x = clamp(-(v3.x / 20), -1, 1);

  const b = bs(result);
  const jaw = clamp((b.jawOpen ?? 0) * 1.6 - 0.04);
  const funnel = clamp((b.mouthFunnel ?? 0) * 1.4);
  const pucker = clamp((b.mouthPucker ?? 0) * 1.2);
  const smile = clamp((((b.mouthSmileLeft ?? 0) + (b.mouthSmileRight ?? 0)) / 2) * 1.3);
  const stretch = clamp(((b.mouthStretchLeft ?? 0) + (b.mouthStretchRight ?? 0)) / 2 * 2);
  target.oh = clamp(funnel * (0.5 + jaw));
  target.ou = clamp(pucker * (1 - jaw * 0.6) * 0.9);
  target.aa = clamp(jaw * (1 - funnel * 0.6) * (1 - pucker * 0.5));
  target.ee = clamp((stretch * 0.6 + smile * 0.3) * (jaw > 0.08 ? 1 : 0.4));
  target.ih = clamp(smile * 0.35 * (1 - jaw));
  target.happy = clamp(smile * 0.5 - 0.05);

  // Blinks. Amount comes from blendshapes, the side (for winks) from eye openness in the image.
  const bl = b.eyeBlinkLeft ?? 0, br = b.eyeBlinkRight ?? 0;
  const amt = (v: number) => clamp((v - 0.25) / 0.45);
  const avg = amt((bl + br) / 2);
  const open = (top: number, bot: number, a: number, c: number) =>
    Math.hypot(lm[top].x - lm[bot].x, lm[top].y - lm[bot].y) / (Math.hypot(lm[a].x - lm[c].x, lm[a].y - lm[c].y) + 1e-6);
  const openImgLeft = open(159, 145, 33, 133); // the eye that is on the left of the raw camera image
  const openImgRight = open(386, 374, 362, 263);
  if (Math.abs(bl - br) > 0.35) {
    const hi = amt(Math.max(bl, br)), lo = amt(Math.min(bl, br));
    // Mirrored view: the raw image's left eye shows on the right of the screen, which is the avatar's left eye.
    if (openImgLeft < openImgRight) { target.blinkL = hi; target.blinkR = lo; }
    else { target.blinkL = lo; target.blinkR = hi; }
  } else {
    target.blinkL = target.blinkR = avg;
  }

  // Gaze. Horizontal from iris position between the eye corners (unambiguous in image space).
  const irisRatio = (iris: number, a: number, c: number) => {
    const x0 = Math.min(lm[a].x, lm[c].x), x1 = Math.max(lm[a].x, lm[c].x);
    return (lm[iris].x - x0) / (x1 - x0 + 1e-6) - 0.5;
  };
  if (lm.length > 473) {
    const r = (irisRatio(468, 33, 133) + irisRatio(473, 362, 263)) / 2;
    target.lookX = clamp(-r * 4, -1, 1);
  }
  const up = ((b.eyeLookUpLeft ?? 0) + (b.eyeLookUpRight ?? 0)) / 2;
  const down = ((b.eyeLookDownLeft ?? 0) + (b.eyeLookDownRight ?? 0)) / 2;
  target.lookY = clamp((up - down) * 1.6, -1, 1);
  return true;
}

// ---------- Camera + MediaPipe ----------
async function ensureLandmarker() {
  if (landmarker) return landmarker;
  setStatus('Loading face tracker…');
  const fileset = await FilesetResolver.forVisionTasks('/mediapipe/wasm');
  const opts = (delegate: 'GPU' | 'CPU') => ({
    baseOptions: { modelAssetPath: '/mediapipe/face_landmarker.task', delegate },
    runningMode: 'VIDEO' as const,
    numFaces: 1,
    outputFaceBlendshapes: true,
    outputFacialTransformationMatrixes: true,
  });
  try {
    landmarker = await FaceLandmarker.createFromOptions(fileset, opts('GPU'));
  } catch {
    landmarker = await FaceLandmarker.createFromOptions(fileset, opts('CPU'));
  }
  // Arm tracking: the lite pose model, run at a lower rate than the face.
  setStatus('Loading arm tracker…');
  const poseOpts = (delegate: 'GPU' | 'CPU') => ({
    baseOptions: { modelAssetPath: '/mediapipe/pose_landmarker_lite.task', delegate },
    runningMode: 'VIDEO' as const,
    numPoses: 1,
    minPoseDetectionConfidence: 0.5,
    minTrackingConfidence: 0.5,
  });
  try {
    poseLandmarker = await PoseLandmarker.createFromOptions(fileset, poseOpts('GPU'));
  } catch {
    try { poseLandmarker = await PoseLandmarker.createFromOptions(fileset, poseOpts('CPU')); }
    catch (err) { console.warn('Arm tracking unavailable', err); }
  }
  return landmarker;
}

function cameraErrorMessage(err: unknown): string {
  const name = (err as { name?: string })?.name ?? '';
  if (!window.isSecureContext) return 'The camera only works over HTTPS. Open the https:// version of this page.';
  if (!navigator.mediaDevices?.getUserMedia) return 'This browser does not support camera access. Try Chrome, Edge, Safari or Firefox.';
  if (name === 'NotAllowedError' || name === 'SecurityError')
    return 'Camera access was blocked. Click the camera icon in the address bar (or your browser settings), allow the camera for this site, and press Start camera again.';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'No camera was found. Plug one in or check that no other app is using it.';
  if (name === 'NotReadableError') return 'The camera is busy. Close other apps or tabs that use it (Zoom, Meet, OBS) and try again.';
  return `Could not start the camera or face tracker: ${(err as Error)?.message ?? err}`;
}

async function startCamera() {
  errorEl.hidden = true;
  startBtn.disabled = true;
  startBtn.textContent = 'Starting…';
  try {
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) throw new Error('insecure');
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30 } },
      audio: false,
    });
    video.srcObject = stream;
    await video.play();
    await ensureLandmarker();
    cameraOn = true;
    hero.hidden = true;
    previewWrap.hidden = false;
    previewBtn.disabled = false;
    previewBtn.classList.add('on');
    setStatus('Tracking');
  } catch (err) {
    errorEl.textContent = cameraErrorMessage(err);
    errorEl.hidden = false;
    startBtn.disabled = false;
    startBtn.textContent = 'Try again';
    setStatus('Camera off');
  }
}

function track(now: number) {
  if (!cameraOn || !landmarker || video.readyState < 2) return;
  if (video.currentTime === lastVideoTime) return;
  lastVideoTime = video.currentTime;
  const result = landmarker.detectForVideo(video, now);
  const found = applyResult(result);
  if (poseLandmarker && arms && poseFrame++ % 2 === 0) {
    const pose = poseLandmarker.detectForVideo(video, now + 0.5);
    poseRuns++;
    arms.setPose(pose.worldLandmarks?.[0], pose.landmarks?.[0], now);
  }
  trackBadge.textContent = found ? 'Face found' : 'No face';
  trackBadge.classList.toggle('ok', found);
}

// ---------- Animation loop ----------
const clock = new THREE.Timer();
let idleBlinkAt = 2;
let idleBlink = 0;
let frames = 0;

function animate() {
  requestAnimationFrame(animate);
  clock.update();
  const dt = Math.min(clock.getDelta(), 0.1);
  const t = clock.getElapsed();
  const now = performance.now();
  track(now);
  frames++;

  const tracking = cameraOn && now - lastFaceAt < 600;
  if (!tracking) {
    resetTarget();
    // Idle life: gentle head drift and automatic blinks.
    target.yaw = Math.sin(t * 0.5) * 0.12;
    target.pitch = Math.sin(t * 0.37) * 0.05;
    target.roll = Math.sin(t * 0.29) * 0.04;
    target.lookX = Math.sin(t * 0.6) * 0.3;
    if (t > idleBlinkAt) {
      idleBlink = 1;
      idleBlinkAt = t + 2.5 + Math.random() * 3;
    }
    idleBlink = Math.max(0, idleBlink - dt * 7);
    target.blinkL = target.blinkR = idleBlink > 0.5 ? 1 : idleBlink * 2;
  }

  // Smooth everything so it does not jitter. Blinks and mouth react faster than the head.
  const k = (rate: number) => 1 - Math.exp(-rate * dt);
  for (const key of Object.keys(state) as (keyof typeof state)[]) {
    const fast = key.startsWith('blink') ? 30 : ['aa', 'ih', 'ou', 'ee', 'oh'].includes(key) ? 22 : 12;
    state[key] += (target[key] - state[key]) * k(fast);
  }

  if (vrm) {
    const s = state;
    setBone('neck', s.pitch * 0.35, s.yaw * 0.35, s.roll * 0.35);
    setBone('head', s.pitch * 0.55, s.yaw * 0.55, s.roll * 0.55);
    const breathe = Math.sin(t * 1.6) * 0.012;
    setBone('chest', breathe + s.pitch * 0.08, s.yaw * 0.12, s.roll * 0.1);
    setBone('spine', -breathe * 0.5, s.yaw * 0.06, s.x * 0.06 + s.roll * 0.05);
    setBone('hips', 0, 0, 0);
    if (fakePose) arms?.setPose(fakePose.world, fakePose.image, now);
    arms?.update(dt, now);
    dresser?.update(t);

    const em = vrm.expressionManager;
    if (em) {
      em.setValue('aa', s.aa);
      em.setValue('ih', s.ih);
      em.setValue('ou', s.ou);
      em.setValue('ee', s.ee);
      em.setValue('oh', s.oh);
      em.setValue('blinkLeft', s.blinkL);
      em.setValue('blinkRight', s.blinkR);
      em.setValue('relaxed', s.happy * 0.4);
    }
    if (vrm.lookAt) {
      vrm.lookAt.yaw = s.lookX * 14;
      vrm.lookAt.pitch = s.lookY * 10;
    }
    vrm.update(dt);
  }
  renderer.render(scene, camera);
}

// ---------- UI wiring ----------
startBtn.addEventListener('click', startCamera);
previewBtn.addEventListener('click', () => {
  previewWrap.hidden = !previewWrap.hidden;
  previewBtn.classList.toggle('on', !previewWrap.hidden);
});

const backgrounds = ['bg-dusk', 'bg-sunset', 'bg-sky', 'bg-ink'];
let bgIndex = 0;
const greenBtn = $<HTMLButtonElement>('greenBtn');
function setBg(cls: string) {
  document.body.classList.remove(...backgrounds, 'bg-green');
  document.body.classList.add(cls);
  greenBtn.classList.toggle('on', cls === 'bg-green');
}
$('bgBtn').addEventListener('click', () => {
  bgIndex = (bgIndex + 1) % backgrounds.length;
  setBg(backgrounds[bgIndex]);
});
greenBtn.addEventListener('click', () => setBg(document.body.classList.contains('bg-green') ? backgrounds[bgIndex] : 'bg-green'));

function toggleUI() {
  document.body.classList.toggle('ui-hidden');
  if (document.body.classList.contains('ui-hidden')) showToast('Interface hidden. Press H or tap the screen twice to bring it back.');
}
$('hideBtn').addEventListener('click', toggleUI);
window.addEventListener('keydown', (e) => {
  if (e.key === 'h' || e.key === 'H') toggleUI();
});
canvas.addEventListener('dblclick', () => document.body.classList.contains('ui-hidden') && toggleUI());

const resetBtn = $<HTMLButtonElement>('resetBtn');
let objectUrl: string | null = null;
async function loadFile(file: File) {
  if (!file.name.toLowerCase().endsWith('.vrm')) {
    showToast('Please choose a .vrm file (export it from VRoid Studio as VRM).');
    return;
  }
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = URL.createObjectURL(file);
  try {
    await loadVRM(objectUrl, file.name.replace(/\.vrm$/i, ''), true);
    resetBtn.hidden = false;
    renderPanel();
    showToast(`Loaded ${file.name}. It stays on your device.`);
  } catch (err) {
    showToast(`Could not load that model: ${(err as Error).message}`);
    setStatus('Ready');
  }
}
$<HTMLInputElement>('fileInput').addEventListener('change', (e) => {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (f) loadFile(f);
  (e.target as HTMLInputElement).value = '';
});
resetBtn.addEventListener('click', async () => {
  resetBtn.hidden = true;
  loadedUrl = '';
  await applyConfig(config);
});

const drop = $('drop');
let dragDepth = 0;
window.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; drop.hidden = false; });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; drop.hidden = true; } });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  drop.hidden = true;
  const f = e.dataTransfer?.files?.[0];
  if (f) loadFile(f);
});

// ---------- Customizer ----------
function loadConfig(): Config {
  try {
    const c = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null') as Config | null;
    if (c && CHARACTERS.some((x) => x.id === c.character)) return c;
  } catch { /* ignore */ }
  const d = CHARACTERS[0];
  return { character: d.id, ...d.defaults };
}
let config: Config = loadConfig();
let applyToken = 0;
const saveConfig = () => { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(config)); } catch { /* private mode */ } };

async function applyConfig(cfg: Config) {
  const token = ++applyToken;
  const ch = charById(cfg.character);
  const url = BASE_URLS[ch.base];
  if (isCustomModel || loadedUrl !== url || !dresser) await loadVRM(url, ch.label);
  if (token !== applyToken || !dresser) return;
  modelName.textContent = ch.label;
  const color = HAIR_COLORS.find((c) => c.id === cfg.hairColor) ?? HAIR_COLORS[0];
  dresser.setHairColor(color.hex);
  await dresser.setHair(cfg.hair);
  if (token !== applyToken) return;
  dresser.setHairColor(color.hex);
  dresser.setSkin(ch.skin);
  dresser.setOutfit(OUTFITS.find((o) => o.id === cfg.outfit) ?? OUTFITS[0]);
  dresser.setParts(ch.parts, ch.partColor);
  renderPanel();
  setStatus(cameraOn ? 'Tracking' : 'Ready');
}

const panel = $('panel');
const customizeBtn = $<HTMLButtonElement>('customizeBtn');
customizeBtn.addEventListener('click', () => {
  panel.hidden = !panel.hidden;
  customizeBtn.classList.toggle('on', !panel.hidden);
});
$('panelClose').addEventListener('click', () => { panel.hidden = true; customizeBtn.classList.remove('on'); });

function option(group: HTMLElement, label: string, active: boolean, onClick: () => void, extra?: (b: HTMLButtonElement) => void) {
  const b = document.createElement('button');
  b.className = 'opt' + (active ? ' on' : '');
  b.textContent = label;
  b.addEventListener('click', onClick);
  extra?.(b);
  group.appendChild(b);
}

function renderPanel() {
  const chars = $('optCharacters'), hairs = $('optHair'), colors = $('optHairColor'), outfits = $('optOutfit');
  for (const el of [chars, hairs, colors, outfits]) el.replaceChildren();
  for (const c of CHARACTERS)
    option(chars, `${c.emoji} ${c.label}`, !isCustomModel && config.character === c.id, () => {
      config = { character: c.id, ...c.defaults };
      choose();
    });
  for (const h of HAIRSTYLES) option(hairs, h.label, config.hair === h.id, () => { config.hair = h.id; choose(); });
  for (const c of HAIR_COLORS)
    option(colors, c.label, config.hairColor === c.id, () => { config.hairColor = c.id; choose(); }, (b) => {
      b.classList.add('swatch');
      b.style.setProperty('--sw', c.hex);
    });
  for (const o of OUTFITS) option(outfits, o.label, config.outfit === o.id, () => { config.outfit = o.id; choose(); });
  $('customNote').hidden = !isCustomModel;
}

function choose() {
  saveConfig();
  renderPanel();
  resetBtn.hidden = true;
  applyConfig(config).catch((err) => showToast(`Could not apply that look: ${(err as Error).message}`));
}

// Debug hooks for automated checks.
(window as unknown as { __vtuber: unknown }).__vtuber = {
  get loaded() { return !!vrm; },
  get frames() { return frames; },
  get tracking() { return cameraOn; },
  get lastFaceAt() { return lastFaceAt; },
  get poseRuns() { return poseRuns; },
  get armsTracked() { return arms?.anyTracked ?? false; },
  get hair() { return dresser?.hairStyle ?? null; },
  apply: (c: Partial<Config>) => {
    const ch = c.character ? charById(c.character) : charById(config.character);
    config = { character: ch.id, ...ch.defaults, ...c };
    renderPanel();
    return applyConfig(config);
  },
  characters: CHARACTERS.map((c) => c.id),
  setFakePose: (p: typeof fakePose) => { fakePose = p; },
  state,
};

renderPanel();
applyConfig(config)
  .then(() => (startBtn.disabled = false))
  .catch((err) => {
    setStatus('Avatar failed to load');
    errorEl.textContent = `Could not load the avatar: ${err.message}`;
    errorEl.hidden = false;
    startBtn.disabled = false;
  });
animate();
