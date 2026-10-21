import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { BlenderControls } from './controls.js';

// ------------------------------------------------------------------ 定数
const BASE_URL = location.pathname.replace(/\/?$/, '/');
const IS_MOBILE = matchMedia('(pointer: coarse)').matches;
const FIELD_MAX = IS_MOBILE ? 1024 : 2048;  // 高さ・法線マップの解像度（長辺）
const GRID_MAX = IS_MOBILE ? 256 : 512;     // メッシュ分割数（長辺）
const COLOR_MAX = IS_MOBILE ? 2048 : 4096;  // カラーテクスチャ（長辺）

const DEFAULT_LAYER = {
  base: { max_height_mm: 1.0 },
  texture: { max_height_mm: 0.2 },
  varnish: { max_height_mm: 0 },
  color: {},
};
const LAYER_LABEL = { base: 'Base', texture: 'Texture', color: 'Color', varnish: 'Varnish' };

const $ = (id) => document.getElementById(id);

// ------------------------------------------------------------------ 状態
const state = {
  config: {},
  title: '',
  imgs: {},
  isModelMode: false,
  modelBaseScaleZ: 1,
  W: 0, H: 0,           // フィールド解像度
  widthMm: 300, heightMm: 200,
  fields: {},           // base / texture / varnish : Float32Array(0..1)
  hField: null,         // 合成高さ Float32Array (mm)
  maxHeight: 0,
  exag: 1,
  normalExag: 1,
  textureOn: true,
  shadowOn: true,
  aoOn: true,
  varnishOn: true,
  mode: 'color',
};

// ------------------------------------------------------------------ 画像ユーティリティ
function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('画像の読み込みに失敗しました: ' + url));
    img.src = url;
  });
}

function fitSize(w, h, max) {
  const s = Math.min(1, max / Math.max(w, h));
  return [Math.max(1, Math.round(w * s)), Math.max(1, Math.round(h * s))];
}

function drawToCanvas(img, w, h, bg) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  if (bg) { ctx.fillStyle = bg; ctx.fillRect(0, 0, w, h); }
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, w, h);
  return c;
}

/** 画像 → 0..1 の高さ値（白 = 高い。透明部分は 0） */
function toField(img, w, h, opt = {}) {
  const c = drawToCanvas(img, w, h);
  const d = c.getContext('2d').getImageData(0, 0, w, h).data;
  const out = new Float32Array(w * h);
  const whiteHigh = opt.whiteIsHigh !== false;
  const invert = !!opt.invert !== !whiteHigh;
  const gamma = opt.gamma || 1;
  for (let i = 0, j = 0; i < out.length; i++, j += 4) {
    let v = (0.2126 * d[j] + 0.7152 * d[j + 1] + 0.0722 * d[j + 2]) / 255;
    if (invert) v = 1 - v;
    if (gamma !== 1) v = Math.pow(v, gamma);
    out[i] = v * (d[j + 3] / 255);
  }
  return out;
}

function colorTexture(img, maxTex) {
  const [w, h] = fitSize(img.naturalWidth, img.naturalHeight, maxTex);
  const tex = new THREE.CanvasTexture(drawToCanvas(img, w, h, '#ffffff'));
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return tex;
}

/** Float32 フィールド → グレースケール DataTexture（上下反転して格納） */
function grayTexture(field, w, h, scale = 1) {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const row = (h - 1 - y) * w;
    for (let x = 0; x < w; x++) {
      const v = Math.max(0, Math.min(255, Math.round(field[y * w + x] * scale * 255)));
      const o = (row + x) * 4;
      data[o] = data[o + 1] = data[o + 2] = v; data[o + 3] = 255;
    }
  }
  return dataTex(data, w, h);
}

function dataTex(data, w, h) {
  const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat);
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = renderer ? renderer.capabilities.getMaxAnisotropy() : 4;
  tex.needsUpdate = true;
  return tex;
}

/** 画像からリアルタイムに法線マップを生成（エッジの微細な凹凸とハイライトを強調） */
function createNormalMapFromImage(img, bumpScale = 2.0) {
  try {
    const nw = img.naturalWidth || img.videoWidth || img.width;
    const nh = img.naturalHeight || img.videoHeight || img.height;
    if (!nw || !nh) return null;
    const [w, h] = fitSize(nw, nh, 1024);
    const canvas = drawToCanvas(img, w, h);
    const ctx = canvas.getContext('2d');
    const imgData = ctx.getImageData(0, 0, w, h);
    const d = imgData.data;
    const gray = new Float32Array(w * h);
    for (let i = 0, j = 0; i < gray.length; i++, j += 4) {
      gray[i] = (0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2]) / 255;
    }
    const normalData = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) {
      const yu = Math.max(0, y - 1), yd = Math.min(h - 1, y + 1);
      const row = (h - 1 - y) * w;
      for (let x = 0; x < w; x++) {
        const xl = Math.max(0, x - 1), xr = Math.min(w - 1, x + 1);
        const gx = (gray[y * w + xr] - gray[y * w + xl]) * bumpScale;
        const gy = (gray[yd * w + x] - gray[yu * w + x]) * bumpScale;
        let nx = -gx, ny = gy, nz = 1.0;
        const inv = 1 / Math.hypot(nx, ny, nz);
        const o = (row + x) * 4;
        normalData[o] = Math.round((nx * inv * 0.5 + 0.5) * 255);
        normalData[o + 1] = Math.round((ny * inv * 0.5 + 0.5) * 255);
        normalData[o + 2] = Math.round((nz * inv * 0.5 + 0.5) * 255);
        normalData[o + 3] = 255;
      }
    }
    return dataTex(normalData, w, h);
  } catch (e) {
    console.warn('法線マップ生成スキップ:', e);
    return null;
  }
}

// ------------------------------------------------------------------ Three.js 初期化
const wrap = $('canvasWrap');
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.toneMapping = THREE.NeutralToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
wrap.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color('#f2f2f2');
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.65;

const persp = new THREE.PerspectiveCamera(35, 1, 0.1, 10000);
const ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, -10000, 10000);
const controls = new BlenderControls(persp, ortho, renderer.domElement);

// メインライト（影を投影する指向性ライト）
const light = new THREE.DirectionalLight(0xffffff, 1.8);
light.castShadow = true;
light.shadow.mapSize.width = 2048;
light.shadow.mapSize.height = 2048;
light.shadow.camera.near = 10;
light.shadow.camera.far = 3000;
light.shadow.bias = -0.00015;
light.shadow.normalBias = 0.04;
scene.add(light, light.target);

// 補助ライト（反対側からの淡い光で暗部を持ち上げる）
const fillLight = new THREE.DirectionalLight(0xedf1f8, 0.45);
scene.add(fillLight);

// リムライト（エッジの光沢を際立たせる）
const rimLight = new THREE.DirectionalLight(0xffffff, 0.35);
scene.add(rimLight);

const hemi = new THREE.HemisphereLight(0xffffff, 0xd0d4dc, 0.28);
scene.add(hemi);

const group = new THREE.Group();
scene.add(group);

let reliefMesh, skirtMesh, boardMesh, material, heightMaterial, skirtMaterial;
let geo, skirtGeo, normalTex, heightTex, varnishTex;
const textures = {};

// ------------------------------------------------------------------ ポストプロセッシング (GTAO)
let composer = null;
let renderPass = null;
let gtaoPass = null;
let outputPass = null;

try {
  composer = new EffectComposer(renderer);
  renderPass = new RenderPass(scene, controls.camera);
  composer.addPass(renderPass);

  const initW = wrap.clientWidth || window.innerWidth;
  const initH = wrap.clientHeight || window.innerHeight;
  gtaoPass = new GTAOPass(scene, controls.camera, initW, initH);
  gtaoPass.output = GTAOPass.OUTPUT.Default;
  gtaoPass.blendIntensity = 1.35;
  gtaoPass.radius = 14;
  gtaoPass.distanceFallOff = 1.0;
  composer.addPass(gtaoPass);

  outputPass = new OutputPass();
  composer.addPass(outputPass);
} catch (err) {
  console.warn('Postprocessing could not be initialized:', err);
  composer = null;
}

let needsRender = true;
const requestRender = () => { needsRender = true; };
controls.addEventListener('change', () => { updateLight(); requestRender(); });
controls.addEventListener('frame', () => frameAll());
controls.addEventListener('projection', () => {
  $('orthoLabel').textContent = controls.isOrtho ? 'Ortho' : 'Persp';
  $('orthoBtn').classList.toggle('is-active', controls.isOrtho);
  if (renderPass) renderPass.camera = controls.camera;
  if (gtaoPass) gtaoPass.camera = controls.camera;
  requestRender();
});

function resize() {
  const w = wrap.clientWidth, h = wrap.clientHeight;
  renderer.setSize(w, h, false);
  if (composer) {
    composer.setSize(w, h);
    if (gtaoPass) gtaoPass.setSize(w, h);
  }
  persp.aspect = w / Math.max(1, h);
  controls.update();
  requestRender();
}
new ResizeObserver(resize).observe(wrap);

function renderScene() {
  if (state.aoOn && composer) {
    composer.render();
  } else {
    renderer.render(scene, controls.camera);
  }
}

function loop() {
  requestAnimationFrame(loop);
  if (!needsRender) return;
  needsRender = false;
  renderScene();
}

// ------------------------------------------------------------------ 高さ計算
function layerCfg(name) {
  const c = (state.config.layers && state.config.layers[name]) || {};
  const merged = { ...DEFAULT_LAYER[name], ...c };
  if (c.max_height_mm == null && c.height_per_pass_mm != null && c.passes != null) {
    merged.max_height_mm = c.height_per_pass_mm * c.passes;
  }
  return merged;
}

function composeHeight() {
  const n = state.W * state.H;
  const out = state.hField || new Float32Array(n);
  out.fill(0);
  const add = (name) => {
    const f = state.fields[name];
    const mm = Number(layerCfg(name).max_height_mm) || 0;
    if (!f || !mm) return;
    for (let i = 0; i < n; i++) out[i] += f[i] * mm;
  };
  add('base');
  if (state.textureOn) add('texture');
  add('varnish');
  let max = 0;
  for (let i = 0; i < n; i++) if (out[i] > max) max = out[i];
  state.hField = out;
  state.maxHeight = max;
}

function sampleHeight(px, py) {
  const { W, H, hField: f } = state;
  const x0 = Math.floor(px), y0 = Math.floor(py);
  const x1 = Math.min(x0 + 1, W - 1), y1 = Math.min(y0 + 1, H - 1);
  const tx = px - x0, ty = py - y0;
  const a = f[y0 * W + x0], b = f[y0 * W + x1], c = f[y1 * W + x0], d = f[y1 * W + x1];
  return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
}

/** 法線マップ（接空間 = オブジェクト空間。頂点法線は全て +Z） */
function buildNormalMap(exag) {
  const { W, H, hField: f } = state;
  const pxX = state.widthMm / W, pxY = state.heightMm / H;
  const data = normalTex ? normalTex.image.data : new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) {
    const yu = Math.max(0, y - 1), yd = Math.min(H - 1, y + 1);
    const row = (H - 1 - y) * W;
    for (let x = 0; x < W; x++) {
      const xl = Math.max(0, x - 1), xr = Math.min(W - 1, x + 1);
      const gx = (f[y * W + xr] - f[y * W + xl]) / ((xr - xl) * pxX) * exag;
      const gy = (f[yd * W + x] - f[yu * W + x]) / ((yd - yu) * pxY) * exag; // 画像下方向
      let nx = -gx, ny = gy, nz = 1;
      const inv = 1 / Math.hypot(nx, ny, nz);
      const o = (row + x) * 4;
      data[o] = (nx * inv * 0.5 + 0.5) * 255;
      data[o + 1] = (ny * inv * 0.5 + 0.5) * 255;
      data[o + 2] = (nz * inv * 0.5 + 0.5) * 255;
      data[o + 3] = 255;
    }
  }
  if (!normalTex) normalTex = dataTex(data, W, H);
  else normalTex.needsUpdate = true;
  state.normalExag = exag;
  if (material) {
    material.normalScale.set(1, 1);
    material.clearcoatNormalScale.set(1, 1);
  }
}

function buildGeometry() {
  const aspect = state.widthMm / state.heightMm;
  const sx = aspect >= 1 ? GRID_MAX : Math.max(2, Math.round(GRID_MAX * aspect));
  const sy = aspect >= 1 ? Math.max(2, Math.round(GRID_MAX / aspect)) : GRID_MAX;
  geo = new THREE.PlaneGeometry(state.widthMm, state.heightMm, sx, sy);
  geo.userData = { sx, sy };

  // 側面（縁の立ち上がり）
  const loop = [];
  for (let x = 0; x <= sx; x++) loop.push(x);
  for (let y = 1; y <= sy; y++) loop.push(y * (sx + 1) + sx);
  for (let x = sx - 1; x >= 0; x--) loop.push(sy * (sx + 1) + x);
  for (let y = sy - 1; y >= 1; y--) loop.push(y * (sx + 1));
  loop.push(0);
  skirtGeo = new THREE.BufferGeometry();
  skirtGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array((loop.length - 1) * 18), 3));
  skirtGeo.userData = { loop };
}

function updateGeometry() {
  if (state.isModelMode && modelRoot) {
    modelRoot.scale.z = state.modelBaseScaleZ * Math.max(0.00001, state.exag);
    modelRoot.updateMatrixWorld(true);
    requestRender();
    return;
  }
  const { sx, sy } = geo.userData;
  const pos = geo.attributes.position;
  const ex = state.exag;
  for (let iy = 0; iy <= sy; iy++) {
    const py = (iy / sy) * (state.H - 1);
    for (let ix = 0; ix <= sx; ix++) {
      const px = (ix / sx) * (state.W - 1);
      pos.setZ(iy * (sx + 1) + ix, sampleHeight(px, py) * ex);
    }
  }
  pos.needsUpdate = true;
  geo.computeBoundingBox();
  geo.computeBoundingSphere();

  const { loop } = skirtGeo.userData;
  const sp = skirtGeo.attributes.position.array;
  let o = 0;
  const P = pos.array;
  for (let i = 0; i < loop.length - 1; i++) {
    const a = loop[i] * 3, b = loop[i + 1] * 3;
    const ax = P[a], ay = P[a + 1], az = P[a + 2];
    const bx = P[b], by = P[b + 1], bz = P[b + 2];
    // a_top, a_bot, b_bot / a_top, b_bot, b_top
    sp.set([ax, ay, az, ax, ay, 0, bx, by, 0, ax, ay, az, bx, by, 0, bx, by, bz], o);
    o += 18;
  }
  skirtGeo.attributes.position.needsUpdate = true;
  skirtGeo.computeVertexNormals();
  skirtGeo.computeBoundingSphere();
  requestRender();
}

// ------------------------------------------------------------------ マテリアル
const modelOriginalMaterials = new Map();
const clayMaterial = new THREE.MeshPhysicalMaterial({
  color: 0xf5f5f7,
  roughness: 0.32,
  metalness: 0.0,
  clearcoat: 0.45,
  clearcoatRoughness: 0.12,
  reflectivity: 0.5,
});

function applyMode() {
  const m = state.mode;
  if (state.isModelMode && modelRoot) {
    modelRoot.traverse((child) => {
      if (child.isMesh) {
        if (!modelOriginalMaterials.has(child)) {
          modelOriginalMaterials.set(child, child.material);
        }
        if (m === 'clay' || m === 'height') {
          const orig = modelOriginalMaterials.get(child);
          if (orig && orig.normalMap) {
            clayMaterial.normalMap = orig.normalMap;
            clayMaterial.clearcoatNormalMap = orig.clearcoatNormalMap;
            clayMaterial.needsUpdate = true;
          }
          child.material = clayMaterial;
        } else {
          child.material = modelOriginalMaterials.get(child);
        }
      }
    });
  } else if (reliefMesh) {
    if (m === 'height') {
      reliefMesh.material = heightMaterial;
    } else {
      reliefMesh.material = material;
      if (m === 'color') {
        material.map = textures.color || textures.original || null;
        material.color.set('#ffffff');
      } else if (m === 'original') {
        material.map = textures.original || textures.color || null;
        material.color.set('#ffffff');
      } else {
        material.map = null;
        material.color.set('#f5f5f7');
      }
      material.needsUpdate = true;
    }
  }
  document.querySelectorAll('#displayMode button').forEach((b) => b.classList.toggle('is-active', b.dataset.mode === m));
  requestRender();
}

function applyVarnish(on) {
  state.varnishOn = on;
  if (state.isModelMode && modelRoot) {
    modelRoot.traverse((child) => {
      if (child.isMesh && child.material && child.material.isMeshPhysicalMaterial) {
        child.material.clearcoat = on ? 1.0 : 0.0;
        child.material.roughness = on ? 0.28 : 0.58;
        child.material.needsUpdate = true;
      }
    });
  } else if (material) {
    material.clearcoat = on ? 1.0 : 0.0;
    material.roughness = on ? 0.30 : 0.62;
    material.needsUpdate = true;
  }
  requestRender();
}

// ------------------------------------------------------------------ ライト
function updateLight() {
  const center = controls.target || new THREE.Vector3(0, 0, 0);
  const R = Math.max(state.widthMm, state.heightMm || 1) * 2.2;
  if ($('lightFollow').checked) {
    const cam = controls.camera;
    const q = cam.quaternion;
    const dir = new THREE.Vector3(-0.35, 0.45, 1).normalize().applyQuaternion(q);
    light.position.copy(center).addScaledVector(dir, R);
    light.target.position.copy(center);
  } else {
    const az = THREE.MathUtils.degToRad(+$('lightAz').value);
    const el = THREE.MathUtils.degToRad(+$('lightEl').value);
    light.position.set(
      center.x + Math.sin(az) * Math.cos(el) * R,
      center.y + Math.cos(az) * Math.cos(el) * R,
      center.z + Math.sin(el) * R
    );
    light.target.position.copy(center);
  }
  light.intensity = +$('lightInt').value;
  light.castShadow = state.shadowOn;

  // 補助光・リム光の同期
  fillLight.position.set(-light.position.x * 0.7, -light.position.y * 0.7, R * 0.5);
  fillLight.target.position.copy(center);
  rimLight.position.set(light.position.y * 0.6, -light.position.x * 0.6, R * 0.7);
  rimLight.target.position.copy(center);

  // シャドウカメラの範囲をシーンサイズに合わせて更新
  const maxDim = Math.max(state.widthMm, state.heightMm, 150) * 0.85;
  light.shadow.camera.left = -maxDim;
  light.shadow.camera.right = maxDim;
  light.shadow.camera.top = maxDim;
  light.shadow.camera.bottom = -maxDim;
  light.shadow.camera.updateProjectionMatrix();
}

// ------------------------------------------------------------------ カメラ
function sceneBox() {
  const box = new THREE.Box3();
  if (modelRoot) {
    box.expandByObject(modelRoot);
  } else if (reliefMesh) {
    box.expandByObject(reliefMesh);
  }
  if (boardMesh && boardMesh.visible) box.expandByObject(boardMesh);
  if (box.isEmpty()) box.set(new THREE.Vector3(-150, -100, -3), new THREE.Vector3(150, 100, 3));
  return box;
}

function frameAll() { controls.frame(sceneBox()); }

const HOME = { yaw: -0.42, elev: 0.32 };

function handleView(v) {
  if (v === 'home') controls.goHome();
  else if (v === 'front') controls.axisView(0, 0);
  else if (v === 'right') controls.axisView(Math.PI / 2, 0);
  else if (v === 'top') controls.axisView(0, Math.PI / 2);
  else if (v === 'frame') frameAll();
  else if (v === 'ortho') controls.toggleOrtho();
}

// ------------------------------------------------------------------ UI
function setProgress(p, text) {
  $('loadingBar').style.width = `${Math.round(p * 100)}%`;
  if (text) $('loadingText').textContent = text;
}

function fmt(n, d = 2) { return (Math.round(n * 10 ** d) / 10 ** d).toFixed(d); }

function updateHeightNote() {
  const parts = ['base', 'texture', 'varnish']
    .filter((k) => state.fields[k] && (k !== 'texture' || state.textureOn))
    .map((k) => `${LAYER_LABEL[k]} ${fmt(+layerCfg(k).max_height_mm || 0)}mm`);
  $('heightNote').textContent = `最大高さ 約 ${fmt(state.maxHeight)} mm` + (parts.length ? `（${parts.join(' + ')}）` : '');
}

function buildSpec() {
  const cfg = state.config;
  const rows = [];
  rows.push(`<tr><th>サイズ</th><td colspan="4">${fmt(state.widthMm, 0)} × ${fmt(state.heightMm, 0)} mm</td></tr>`);
  const layerRows = ['base', 'texture', 'color', 'varnish'].filter((k) => cfg.layers && cfg.layers[k]);
  if (layerRows.length) {
    rows.push('<tr class="spec-head"><th>層</th><td>インク</td><td>濃度</td><td>積層</td><td>高さ</td></tr>');
    for (const k of layerRows) {
      const l = layerCfg(k);
      const esc = (s) => String(s ?? '–').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
      rows.push(`<tr><th>${LAYER_LABEL[k]}</th><td>${esc(l.ink)}</td><td>${l.density_percent != null ? esc(l.density_percent) + '%' : '–'}</td><td>${l.passes != null ? esc(l.passes) + '回' : '–'}</td><td>${l.max_height_mm ? fmt(+l.max_height_mm) + 'mm' : '–'}</td></tr>`);
    }
  }
  if (cfg.note) rows.push(`<tr><td colspan="5" class="spec-note">${String(cfg.note).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))}</td></tr>`);
  $('specTable').innerHTML = rows.join('');
  $('specSec').hidden = false;
}

function bindUI() {
  document.querySelectorAll('.view-bar button').forEach((b) => b.addEventListener('click', () => handleView(b.dataset.view)));
  document.querySelectorAll('#displayMode button').forEach((b) => b.addEventListener('click', () => {
    state.mode = b.dataset.mode; applyMode();
  }));
  $('varnishToggle').addEventListener('change', (e) => applyVarnish(e.target.checked));
  $('shadowToggle')?.addEventListener('change', (e) => {
    state.shadowOn = e.target.checked;
    updateLight();
    requestRender();
  });
  $('aoToggle')?.addEventListener('change', (e) => {
    state.aoOn = e.target.checked;
    requestRender();
  });
  $('textureToggle').addEventListener('change', (e) => {
    state.textureOn = e.target.checked;
    composeHeight(); buildNormalMap(state.exag); refreshHeightTex(); updateGeometry(); updateHeightNote();
  });
  $('boardToggle').addEventListener('change', (e) => { boardMesh.visible = e.target.checked; requestRender(); });

  const exag = $('exag');
  const setExag = (val) => {
    state.exag = THREE.MathUtils.clamp(Math.round(val * 100) / 100, 0, 2);
    exag.value = state.exag;
    exagLabel();
    if (!state.isModelMode && material) {
      const s = state.exag / (state.normalExag || 1);
      material.normalScale.set(s, s);
      material.clearcoatNormalScale.set(s, s);
    }
    updateGeometry();
  };
  const exagLabel = () => {
    if (state.exag <= 0.005) $('exagOut').textContent = '×0.00（平坦）';
    else if (Math.abs(state.exag - 1.0) < 0.005) $('exagOut').textContent = '×1.00（実寸）';
    else $('exagOut').textContent = `×${fmt(state.exag, 2)}`;
  };
  exag.addEventListener('input', () => setExag(+exag.value));
  exag.addEventListener('change', () => {
    if (!state.isModelMode) buildNormalMap(state.exag);
    requestRender();
  });
  $('exagMinus')?.addEventListener('click', () => {
    setExag(state.exag - 0.05);
    if (!state.isModelMode) buildNormalMap(state.exag);
  });
  $('exagPlus')?.addEventListener('click', () => {
    setExag(state.exag + 0.05);
    if (!state.isModelMode) buildNormalMap(state.exag);
  });
  exagLabel();

  const lightLabels = () => {
    $('lightAzOut').textContent = `${$('lightAz').value}°`;
    $('lightElOut').textContent = `${$('lightEl').value}°`;
    $('lightIntOut').textContent = fmt(+$('lightInt').value, 2);
    const follow = $('lightFollow').checked;
    $('lightAz').disabled = follow; $('lightEl').disabled = follow;
  };
  ['lightAz', 'lightEl', 'lightInt', 'lightFollow'].forEach((id) => $(id).addEventListener('input', () => { lightLabels(); updateLight(); requestRender(); }));
  lightLabels();

  document.querySelectorAll('#bgMode button').forEach((b) => b.addEventListener('click', () => {
    const dark = b.dataset.bg === 'dark';
    scene.background.set(dark ? '#1b1b1b' : '#f2f2f2');
    document.body.classList.toggle('is-dark', dark);
    document.querySelectorAll('#bgMode button').forEach((x) => x.classList.toggle('is-active', x === b));
    requestRender();
  }));

  $('wheelMode').addEventListener('change', (e) => { controls.wheelMode = e.target.value; });

  $('shotBtn').addEventListener('click', () => {
    renderScene();
    renderer.domElement.toBlob((blob) => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${(state.title || 'preview').replace(/[\\/:*?"<>|]/g, '_')}.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    }, 'image/png');
  });

  $('panelToggle').addEventListener('click', () => document.body.classList.toggle('panel-open'));
  if (IS_MOBILE || innerWidth < 900) $('help').open = false;
}

function refreshHeightTex() {
  const scale = state.maxHeight > 0 ? 1 / state.maxHeight : 1;
  const old = heightTex;
  heightTex = grayTexture(state.hField, state.W, state.H, scale);
  if (heightMaterial) { heightMaterial.map = heightTex; heightMaterial.needsUpdate = true; }
  old?.dispose();
}

// ------------------------------------------------------------------ 3Dモデルモード
let modelRoot = null;

async function setupModelMode(modelUrl, manifest) {
  state.isModelMode = true;
  setProgress(0.3, '3Dモデルデータを読み込んでいます…');

  let root;
  if (modelUrl.endsWith('.glb') || modelUrl.endsWith('.gltf')) {
    const loader = new GLTFLoader();
    const gltf = await new Promise((res, rej) => loader.load(BASE_URL + modelUrl, res, undefined, rej));
    root = gltf.scene || gltf.scenes[0];
  } else if (modelUrl.endsWith('.obj')) {
    const loader = new OBJLoader();
    root = await new Promise((res, rej) => loader.load(BASE_URL + modelUrl, res, undefined, rej));
  } else {
    throw new Error('未対応の3Dモデル形式です: ' + modelUrl);
  }

  modelRoot = root;
  group.add(modelRoot);

  setProgress(0.65, 'オブジェクトの配置とスケールを調整しています…');
  await new Promise((r) => setTimeout(r, 20));

  // 向き補正：最も薄い軸を厚み方向（Z軸）にする
  let box = new THREE.Box3().setFromObject(modelRoot);
  let size = box.getSize(new THREE.Vector3());
  if (size.y < size.z && size.y < size.x) {
    modelRoot.rotation.x = Math.PI / 2;
    modelRoot.updateMatrixWorld(true);
    box = new THREE.Box3().setFromObject(modelRoot);
    size = box.getSize(new THREE.Vector3());
  }

  // 寸法
  const targetW = Number(state.config.size_mm?.width) || (size.x <= 10 ? 300 : size.x);
  const scaleXY = targetW / (size.x || 1);
  const targetH = Number(state.config.size_mm?.height) || (size.y * scaleXY);

  state.widthMm = targetW;
  state.heightMm = targetH;
  // Z軸の基本スケール
  const baseScaleZ = size.x <= 10 ? scaleXY : 1;
  modelRoot.scale.set(scaleXY, scaleXY, baseScaleZ);
  state.modelBaseScaleZ = baseScaleZ;
  modelRoot.updateMatrixWorld(true);

  // メッシュの法線再計算、シャドウ、厚盛りPhysicalMaterialへのアップグレード
  modelRoot.traverse((child) => {
    if (child.isMesh) {
      child.castShadow = true;
      child.receiveShadow = true;
      if (child.geometry) {
        child.geometry.computeVertexNormals();
      }
      const orig = child.material;
      if (orig) {
        let normalMap = null;
        if (orig.map && orig.map.image) {
          if (orig.map.image.complete || orig.map.image.width) {
            normalMap = createNormalMapFromImage(orig.map.image, 2.5);
          } else {
            orig.map.image.addEventListener('load', () => {
              const nm = createNormalMapFromImage(orig.map.image, 2.5);
              if (nm) {
                upgraded.normalMap = nm;
                upgraded.clearcoatNormalMap = nm;
                upgraded.needsUpdate = true;
                requestRender();
              }
            });
          }
        }
        const upgraded = new THREE.MeshPhysicalMaterial({
          map: orig.map || null,
          color: orig.color ? orig.color.clone() : new THREE.Color(0xffffff),
          roughness: 0.28,             // UV印刷インクのしっとりしたツヤ
          metalness: 0.0,
          normalMap: normalMap,
          normalScale: new THREE.Vector2(0.9, 0.9),
          clearcoat: 1.0,              // 表面のクリアニス層
          clearcoatRoughness: 0.06,    // ニス層のシャープなツヤ
          clearcoatNormalMap: normalMap,
          ior: 1.52,                   // UV印刷インクの屈折率
          specularIntensity: 1.0,
        });
        modelOriginalMaterials.set(child, upgraded);
        child.material = upgraded;
      }
    }
  });

  // 再計算して底面を Z=0、中心(X,Y)を (0,0) に配置
  box = new THREE.Box3().setFromObject(modelRoot);
  const center = box.getCenter(new THREE.Vector3());
  modelRoot.position.x -= center.x;
  modelRoot.position.y -= center.y;
  modelRoot.position.z -= box.min.z;
  modelRoot.updateMatrixWorld(true);

  box = new THREE.Box3().setFromObject(modelRoot);
  state.maxHeight = box.max.z - box.min.z;

  // 基材板の配置（影を受け止める）
  const board = state.config.board || {};
  const t = +board.thickness_mm || 3;
  boardMesh = new THREE.Mesh(
    new THREE.BoxGeometry(state.widthMm * 1.02, state.heightMm * 1.02, t),
    new THREE.MeshStandardMaterial({
      color: board.color || '#fafafa',
      roughness: 0.85,
      polygonOffset: true,
      polygonOffsetFactor: 2,
      polygonOffsetUnits: 2,
    }),
  );
  boardMesh.receiveShadow = true;
  boardMesh.position.z = -t / 2 - 0.02;
  group.add(boardMesh);

  // UI調整
  $('textureToggle').closest('label').style.display = 'none';
  document.querySelector('[data-mode="original"]').style.display = 'none';
  document.querySelector('[data-mode="height"]').style.display = 'none';

  $('heightNote').textContent = `厚み 約 ${fmt(state.maxHeight)} mm`;
  applyMode();
  buildSpec();
  bindUI();
  updateLight();

  resize();
  controls.home = controls.frame(sceneBox(), HOME, 0);
  loop();
  setProgress(1, '');
  $('loading').classList.add('is-done');
}

// ------------------------------------------------------------------ メイン
async function main() {
  setProgress(0.03, '設定を読み込んでいます…');
  const res = await fetch(BASE_URL + 'manifest.json', { cache: 'no-store' });
  if (!res.ok) throw new Error('プレビューが見つかりません');
  const manifest = await res.json();
  if (manifest.config) {
    try { state.config = await (await fetch(BASE_URL + manifest.config, { cache: 'no-store' })).json(); }
    catch { state.config = {}; }
  }
  state.title = state.config.title || manifest.title || '';
  if (state.title) { $('projectTitle').textContent = state.title; document.title = `${state.title} | 3D Preview`; }

  // 3Dモデルファイルが存在する場合は3Dモデルモードで起動
  if (manifest.model) {
    return await setupModelMode(manifest.model, manifest);
  }

  const names = Object.keys(manifest.files);
  if (!names.length) throw new Error('プレビュー対象のデータ（画像または3Dモデル）がありません');
  let done = 0;
  await Promise.all(names.map(async (k) => {
    state.imgs[k] = await loadImage(BASE_URL + manifest.files[k]);
    done++;
    setProgress(0.05 + 0.55 * (done / names.length), `画像を読み込んでいます… (${done}/${names.length})`);
  }));

  // 寸法
  const ref = state.imgs.base || state.imgs.color || state.imgs.original || state.imgs.texture || state.imgs.varnish;
  const imgAspect = ref.naturalWidth / ref.naturalHeight;
  const size = state.config.size_mm || {};
  state.widthMm = +size.width || (size.height ? +size.height * imgAspect : 300);
  state.heightMm = +size.height || state.widthMm / imgAspect;
  const [W, H] = fitSize(ref.naturalWidth, ref.naturalHeight, FIELD_MAX);
  state.W = W; state.H = H;

  setProgress(0.65, '立体形状を計算しています…');
  await new Promise((r) => setTimeout(r, 20));
  const whiteIsHigh = state.config.white_is_high !== false;
  for (const k of ['base', 'texture', 'varnish']) {
    if (state.imgs[k]) state.fields[k] = toField(state.imgs[k], W, H, { whiteIsHigh, ...layerCfg(k) });
  }
  if (!state.fields.texture) {
    $('textureToggle').disabled = true;
    $('textureToggle').closest('label').classList.add('is-disabled');
  }
  composeHeight();

  setProgress(0.78, '法線マップを生成しています…');
  await new Promise((r) => setTimeout(r, 20));
  buildNormalMap(1);
  refreshHeightTex();

  // テクスチャ
  const maxTex = Math.min(COLOR_MAX, renderer.capabilities.maxTextureSize);
  if (state.imgs.color) textures.color = colorTexture(state.imgs.color, maxTex);
  if (state.imgs.original) textures.original = colorTexture(state.imgs.original, maxTex);
  if (state.fields.varnish) varnishTex = grayTexture(state.fields.varnish, W, H);
  if (!textures.original) document.querySelector('[data-mode="original"]').disabled = true;
  if (!varnishTex) { $('varnishToggle').disabled = true; $('varnishToggle').closest('label').classList.add('is-disabled'); }

  setProgress(0.9, 'メッシュを構築しています…');
  await new Promise((r) => setTimeout(r, 20));

  material = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    roughness: 0.30,
    metalness: 0,
    normalMap: normalTex,
    clearcoat: varnishTex ? 1 : 0,
    clearcoatMap: varnishTex || null,
    clearcoatRoughness: 0.06,
    clearcoatNormalMap: normalTex,
    specularIntensity: 1.0,
    ior: 1.52,
  });
  heightMaterial = new THREE.MeshBasicMaterial({ map: heightTex, toneMapped: false });
  skirtMaterial = new THREE.MeshStandardMaterial({ color: 0xf3f3f3, roughness: 0.7, side: THREE.DoubleSide });

  buildGeometry();
  reliefMesh = new THREE.Mesh(geo, material);
  reliefMesh.castShadow = true;
  reliefMesh.receiveShadow = true;
  skirtMesh = new THREE.Mesh(skirtGeo, skirtMaterial);
  skirtMesh.castShadow = true;
  skirtMesh.receiveShadow = true;
  const board = state.config.board || {};
  const t = +board.thickness_mm || 3;
  boardMesh = new THREE.Mesh(
    new THREE.BoxGeometry(state.widthMm, state.heightMm, t),
    new THREE.MeshStandardMaterial({ color: board.color || '#fafafa', roughness: 0.85, polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 2 }),
  );
  boardMesh.receiveShadow = true;
  boardMesh.position.z = -t / 2 - 0.02;
  group.add(reliefMesh, skirtMesh, boardMesh);
  updateGeometry();
  applyMode();
  updateHeightNote();
  buildSpec();
  bindUI();
  updateLight();

  resize();
  controls.home = controls.frame(sceneBox(), HOME, 0);
  loop();
  setProgress(1, '');
  $('loading').classList.add('is-done');
}

main().catch((err) => {
  console.error(err);
  $('loading').classList.add('is-error');
  $('loadingText').textContent = (err && (err.stack || err.message)) || '読み込みに失敗しました';
});
