import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { MTLLoader } from 'three/addons/loaders/MTLLoader.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { BlenderControls } from './controls.js';

// ------------------------------------------------------------------ 定数
const BASE_URL = location.pathname.replace(/\/?$/, '/');
const IS_MOBILE = matchMedia('(pointer: coarse)').matches;
const QUALITY_KEY = 'yamate-preview-quality';
const PREVIEW_QUALITY = (() => {
  try { return localStorage.getItem(QUALITY_KEY) === 'high' ? 'high' : 'low'; }
  catch { return 'low'; }
})();
const QUALITY_LIMITS = {
  low: {
    fieldMax: IS_MOBILE ? 1024 : 2048,
    gridMax: IS_MOBILE ? 512 : 1024,
    colorMax: IS_MOBILE ? 2048 : 4096,
  },
  high: {
    fieldMax: IS_MOBILE ? 2048 : 2304,
    gridMax: IS_MOBILE ? 768 : 2304,
    colorMax: IS_MOBILE ? 2048 : 2304,
  },
};
const { fieldMax: FIELD_MAX, gridMax: GRID_MAX, colorMax: COLOR_MAX } = QUALITY_LIMITS[PREVIEW_QUALITY];

const DEFAULT_LAYER = {
  heightmap: { max_height_mm: 3.0 },
  base: { max_height_mm: 1.5 },
  texture: { max_height_mm: 0.25 },
  varnish: { max_height_mm: 0 },
  color: {},
};
const LAYER_LABEL = { heightmap: 'Heightmap', base: 'Base', texture: 'Texture', color: 'Color', varnish: 'Varnish' };

const $ = (id) => document.getElementById(id);

// ------------------------------------------------------------------ 状態
const state = {
  config: {},
  title: '',
  previewQuality: PREVIEW_QUALITY,
  imgs: {},
  isModelMode: false,
  modelBaseScaleZ: 1,
  W: 0, H: 0,           // フィールド解像度
  widthMm: 300, heightMm: 200,
  fields: {},           // base / texture / varnish / heightmap : Float32Array(0..1)
  rawHField: null,      // 理想の線形合成高さ Float32Array (mm)
  hField: null,         // 現在表示中の高さ Float32Array (mm)
  maxHeight: 0,
  exag: 1,
  normalExag: 1,
  textureOn: true,
  shadowOn: true,
  aoOn: true,
  realPrintSim: false,   // 実機シミュレーション（初期値OFF：BR-T本来の高精度立体形状を表示）
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
renderer.toneMappingExposure = 0.92;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
wrap.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color('#f2f2f2');
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.38;

const persp = new THREE.PerspectiveCamera(35, 1, 0.1, 10000);
const ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, -10000, 10000);
const controls = new BlenderControls(persp, ortho, renderer.domElement);

// メインライト（影を投影する指向性ライト）
const light = new THREE.DirectionalLight(0xffffff, 1.15);
light.castShadow = true;
light.shadow.mapSize.width = 2048;
light.shadow.mapSize.height = 2048;
light.shadow.camera.near = 10;
light.shadow.camera.far = 3000;
light.shadow.bias = -0.00015;
light.shadow.normalBias = 0.04;
scene.add(light, light.target);

// 補助ライト（暗部のつぶれ・青み転びを防ぐ自然な温かみのある光）
const fillLight = new THREE.DirectionalLight(0xfff8f0, 0.30);
scene.add(fillLight);

const hemi = new THREE.HemisphereLight(0xffffff, 0xf2ede4, 0.35);
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

function inkHeightGamma() {
  const curve = state.config.ink_height_curve || {};
  const gamma = Number(curve.gamma);
  return Number.isFinite(gamma) && gamma > 0 ? gamma : 1.737;
}

/**
 * UV厚盛り印刷の実機物理挙動シミュレーション（ヤマテ技術仕様書準拠）
 * 1. 非線形な沈降・盛り下がり（濃度50%→実測30%高さ、γ ≈ 1.737）
 * 2. 液体インクの表面張力とレベリングによるエッジのR曲面・ダレ（R ≈ 0.3mm）
 * 3. 厚盛り部の硬化収縮（大面積ベタの微小引き締まり）
 */
function simulateRealPrintHeight(rawField, W, H, maxMm) {
  const n = W * H;
  const sim = new Float32Array(n);
  if (maxMm <= 0.0001) return sim;

  // 1. ヤマテ実測非線形カーブ（50%濃度で実測30%高さに沈降する盛り下がり特性）
  const gamma = inkHeightGamma();
  for (let i = 0; i < n; i++) {
    const v = rawField[i] / maxMm;
    if (v > 0) {
      sim[i] = Math.pow(Math.min(1, Math.max(0, v)), gamma) * maxMm;
    }
  }

  // 2. インクのダレ・エッジのR付け（急激な崖を丸める表面張力フィルター）
  const pxMm = state.widthMm / W;
  const rad = Math.max(1, Math.min(6, Math.round(0.3 / pxMm)));
  const temp = new Float32Array(n);

  for (let y = 0; y < H; y++) {
    const row = y * W;
    for (let x = 0; x < W; x++) {
      let sum = 0, weight = 0;
      for (let dx = -rad; dx <= rad; dx++) {
        const nx = Math.min(W - 1, Math.max(0, x + dx));
        const w = 1 - Math.abs(dx) / (rad + 1);
        sum += sim[row + nx] * w;
        weight += w;
      }
      temp[row + x] = sum / weight;
    }
  }

  for (let x = 0; x < W; x++) {
    for (let y = 0; y < H; y++) {
      let sum = 0, weight = 0;
      for (let dy = -rad; dy <= rad; dy++) {
        const ny = Math.min(H - 1, Math.max(0, y + dy));
        const w = 1 - Math.abs(dy) / (rad + 1);
        sum += temp[ny * W + x] * w;
        weight += w;
      }
      const orig = sim[y * W + x];
      const blurred = sum / weight;
      // エッジの曲面化（R付け）と硬化収縮
      sim[y * W + x] = (orig * 0.45 + blurred * 0.55) * 0.985;
    }
  }

  return sim;
}

function composeHeight() {
  const n = state.W * state.H;
  if (!state.rawHField || state.rawHField.length !== n) {
    state.rawHField = new Float32Array(n);
  }
  const raw = state.rawHField;
  raw.fill(0);

  const add = (name) => {
    const f = state.fields[name];
    let mm = Number(layerCfg(name).max_height_mm) || 0;
    if (name === 'heightmap') {
      const cfgMax = Number(state.config.max_height_mm);
      if (cfgMax) {
        mm = cfgMax;
      } else if (!state.config.layers?.heightmap) {
        mm = 3.0;
      }
    }
    if (!f || !mm) return;
    for (let i = 0; i < n; i++) raw[i] += f[i] * mm;
  };

  if (state.fields.heightmap) {
    add('heightmap');
  } else {
    add('base');
    if (state.textureOn) add('texture');
    add('varnish');
  }

  let rawMax = 0;
  for (let i = 0; i < n; i++) if (raw[i] > rawMax) rawMax = raw[i];

  if (state.realPrintSim) {
    state.hField = simulateRealPrintHeight(raw, state.W, state.H, rawMax);
  } else {
    state.hField = raw.slice();
  }

  let max = 0;
  for (let i = 0; i < n; i++) if (state.hField[i] > max) max = state.hField[i];
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
  const targetGrid = Math.min(Math.max(state.W, state.H), GRID_MAX);
  const sx = aspect >= 1 ? targetGrid : Math.max(2, Math.round(targetGrid * aspect));
  const sy = aspect >= 1 ? Math.max(2, Math.round(targetGrid / aspect)) : targetGrid;
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
    // スケール変更後も底面が常に Z=0（基材板の上面）にピッタリ密着するように位置を補正
    const currentBox = new THREE.Box3().setFromObject(modelRoot);
    modelRoot.position.z -= currentBox.min.z;
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
  geo.computeVertexNormals();
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
  roughness: 0.55,
  metalness: 0.0,
  clearcoat: 0.05,
  clearcoatRoughness: 0.35,
  reflectivity: 0.3,
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
          if (child.userData?.isVarnish) {
            // ニス層は半透明の光沢層を維持し、下地クレイ形状の上のニス配置を確認できるようにする
            child.material = modelOriginalMaterials.get(child);
          } else {
            const orig = modelOriginalMaterials.get(child);
            if (orig && orig.normalMap) {
              clayMaterial.normalMap = orig.normalMap;
              clayMaterial.clearcoatNormalMap = orig.clearcoatNormalMap;
              clayMaterial.needsUpdate = true;
            }
            child.material = clayMaterial;
          }
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
        child.material.clearcoat = on ? 0.04 : 0.0;
        child.material.clearcoatRoughness = 0.35;
        child.material.roughness = on ? 0.58 : 0.72;
        child.material.needsUpdate = true;
      }
    });
  } else if (material) {
    material.clearcoat = on ? 0.04 : 0.0;
    material.clearcoatRoughness = 0.35;
    material.roughness = on ? 0.58 : 0.72;
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
  // 白飛びしないようライト強度のベースを適正化
  light.intensity = +$('lightInt').value * 0.75;
  light.castShadow = state.shadowOn;

  // 補助光の同期
  fillLight.position.set(-light.position.x * 0.6, -light.position.y * 0.6, R * 0.5);
  fillLight.target.position.copy(center);

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
  const simTag = state.realPrintSim ? '【実機補正後】' : '【入力ハイトマップ値】';
  if (state.isModelMode) {
    $('heightNote').textContent = `厚み 約 ${fmt(state.maxHeight)} mm ${simTag}`;
    return;
  }
  if (state.fields.heightmap) {
    $('heightNote').textContent = `最大高さ 約 ${fmt(state.maxHeight)} mm（Heightmap ${fmt(+layerCfg('heightmap').max_height_mm || 0)}mm） ${simTag}`;
    return;
  }
  const parts = ['base', 'texture', 'varnish']
    .filter((k) => state.fields[k] && (k !== 'texture' || state.textureOn))
    .map((k) => `${LAYER_LABEL[k]} ${fmt(+layerCfg(k).max_height_mm || 0)}mm`);
  $('heightNote').textContent = `最大高さ 約 ${fmt(state.maxHeight)} mm` + (parts.length ? `（${parts.join(' + ')}）` : '') + ` ${simTag}`;
}

function buildSpec() {
  const cfg = state.config;
  const rows = [];
  rows.push(`<tr><th>サイズ</th><td colspan="4">${fmt(state.widthMm, 0)} × ${fmt(state.heightMm, 0)} mm</td></tr>`);
  const layerRows = ['heightmap', 'base', 'texture', 'color', 'varnish'].filter((k) => cfg.layers && cfg.layers[k]);
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
  const qualitySection = $('previewQualitySec');
  if (state.isModelMode) {
    qualitySection.hidden = true;
  } else {
    const { sx, sy } = geo.userData;
    const gridStep = Math.max(state.widthMm / sx, state.heightMm / sy);
    $('qualityNote').textContent = `${state.W} × ${state.H} px / メッシュ間隔 約${fmt(gridStep, 2)}mm`;
    document.querySelectorAll('#previewQuality button').forEach((button) => {
      const active = button.dataset.quality === state.previewQuality;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', String(active));
      button.addEventListener('click', () => {
        if (button.dataset.quality === state.previewQuality) return;
        try { localStorage.setItem(QUALITY_KEY, button.dataset.quality); } catch {}
        location.reload();
      });
    });
  }

  document.querySelectorAll('.view-bar button').forEach((b) => b.addEventListener('click', () => handleView(b.dataset.view)));
  document.querySelectorAll('#displayMode button').forEach((b) => b.addEventListener('click', () => {
    state.mode = b.dataset.mode; applyMode();
  }));
  $('realPrintToggle')?.addEventListener('change', (e) => {
    state.realPrintSim = e.target.checked;
    if (state.isModelMode) {
      applyModelPrintSim(state.realPrintSim);
    } else {
      composeHeight();
      buildNormalMap(state.exag);
      refreshHeightTex();
      updateGeometry();
      updateHeightNote();
    }
  });
  $('varnishToggle')?.addEventListener('change', (e) => applyVarnish(e.target.checked));
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
    // OBJ + MTL（マテリアル定義）のサポート
    const mtlUrl = modelUrl.replace(/\.obj$/i, '.mtl');
    let materials = null;
    try {
      const mtlRes = await fetch(BASE_URL + mtlUrl, { method: 'HEAD' });
      if (mtlRes.ok) {
        const mtlLoader = new MTLLoader();
        const basePath = BASE_URL + modelUrl.substring(0, modelUrl.lastIndexOf('/') + 1);
        mtlLoader.setPath(basePath);
        materials = await new Promise((res, rej) => mtlLoader.load(mtlUrl.split('/').pop(), res, undefined, rej));
        materials.preload();
      }
    } catch (e) {
      console.warn('MTLの読み込みをスキップしました:', e);
    }
    const loader = new OBJLoader();
    if (materials) {
      loader.setMaterials(materials);
    }
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

  // ニス判定ヘルパー：OBJ/GLTFの名前やマテリアルから「ニス」「varnish」「gloss」などを自動識別
  const checkIsVarnish = (mesh, mat) => {
    const meshName = (mesh.name || '').toLowerCase();
    const matName = (mat?.name || '').toLowerCase();
    return (
      meshName.includes('varnish') || meshName.includes('ニス') ||
      meshName.includes('gloss') || meshName.includes('clear') || meshName.includes('coat') ||
      matName.includes('varnish') || matName.includes('ニス') ||
      matName.includes('gloss') || matName.includes('clear') || matName.includes('coat') ||
      Boolean(mat?.transmission > 0) || Boolean(mat?.transparent && mat?.opacity < 0.95)
    );
  };

  // メッシュの法線再計算、シャドウ、厚盛りPhysicalMaterialへのアップグレード
  modelRoot.traverse((child) => {
    if (child.isMesh) {
      if (child.geometry) {
        if (child.geometry.attributes.position) {
          const pos = child.geometry.attributes.position;
          const origZ = new Float32Array(pos.count);
          for (let i = 0; i < pos.count; i++) origZ[i] = pos.getZ(i);
          child.geometry.userData.origZ = origZ;
          child.geometry.computeBoundingBox();
          child.geometry.userData.origBox = child.geometry.boundingBox.clone();
        }
        child.geometry.computeVertexNormals();
        const norm = child.geometry.attributes.normal;
        if (norm) {
          let normalZSum = 0;
          for (let i = 2; i < norm.count * 3; i += 3) {
            normalZSum += norm.array[i];
          }
          // 法線が裏向き（下向き）の場合、法線ベクトルを反転して表面（上向き）にする
          if (normalZSum < 0) {
            for (let i = 0; i < norm.count * 3; i++) {
              norm.array[i] = -norm.array[i];
            }
            norm.needsUpdate = true;
          }
        }
      }

      const orig = child.material;
      if (orig) {
        const isVarnish = checkIsVarnish(child, orig);
        let upgraded;

        if (isVarnish) {
          // ── ニス層（3Dモデル/OBJ側で追加されたニスオブジェクト・マテリアル） ──
          child.userData.isVarnish = true;
          child.castShadow = false; // 透明ニスが印刷面に濃い黒影を落とさないよう設定
          child.receiveShadow = true;

          upgraded = new THREE.MeshPhysicalMaterial({
            color: orig.color ? orig.color.clone() : new THREE.Color(0xffffff),
            roughness: 0.08,             // 非常に滑らかな光沢
            metalness: 0.0,
            clearcoat: 1.0,              // 艶やかなクリアコート
            clearcoatRoughness: 0.04,
            ior: 1.52,                   // UV硬化ニスの屈折率
            specularIntensity: 0.9,      // ニスのツヤ
            transmission: 0.88,          // 下地の色が綺麗に透ける透明度
            transparent: true,
            opacity: 0.90,
            polygonOffset: true,         // 下地メッシュとのチラつき（Z-fighting）防止
            polygonOffsetFactor: -1,
            polygonOffsetUnits: -1,
            depthWrite: false,           // 半透明の描画順序を安定化
            side: THREE.DoubleSide,
          });
        } else {
          // ── 通常の印刷インク層（ニスなしの落ち着いたUVインク質感） ──
          child.userData.isVarnish = false;
          child.castShadow = true;
          child.receiveShadow = true;

          let normalMap = null;
          if (orig.map && orig.map.image) {
            if (orig.map.image.complete || orig.map.image.width) {
              normalMap = createNormalMapFromImage(orig.map.image, 2.0);
            } else {
              orig.map.image.addEventListener('load', () => {
                const nm = createNormalMapFromImage(orig.map.image, 2.0);
                if (nm) {
                  upgraded.normalMap = nm;
                  upgraded.needsUpdate = true;
                  requestRender();
                }
              });
            }
          }
          if (orig.map) {
            orig.map.colorSpace = THREE.SRGBColorSpace;
            orig.map.needsUpdate = true;
          }

          upgraded = new THREE.MeshPhysicalMaterial({
            map: orig.map || null,
            color: orig.color ? orig.color.clone() : new THREE.Color(0xffffff),
            roughness: 0.62,             // 落ち着いたマット〜サテン調のUVインク質感
            metalness: 0.0,
            normalMap: normalMap,
            normalScale: new THREE.Vector2(0.35, 0.35),
            clearcoat: 0.0,              // ニスは3Dモデル側のバーニッシュ層で表現するため、下地には人工クリアコートなし
            clearcoatRoughness: 0.35,
            ior: 1.46,
            specularIntensity: 0.15,     // 控えめで自然な印刷表面の反射（白飛びなし）
            side: THREE.DoubleSide,      // 両面描画
          });
        }

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

  // 基材板の配置（上面を Z=0 に配置し、オブジェクト底面と完全に隙間ゼロで密着）
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
  boardMesh.position.z = -t / 2;
  group.add(boardMesh);

  // ヤマテ実機シミュレーション（初期状態適用）
  if (state.realPrintSim) {
    applyModelPrintSim(true);
  }

  // UI調整
  $('textureToggle').closest('label').style.display = 'none';
  document.querySelector('[data-mode="original"]').style.display = 'none';
  document.querySelector('[data-mode="height"]').style.display = 'none';

  updateHeightNote();
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

function applyModelPrintSim(simOn) {
  if (!state.isModelMode || !modelRoot) return;
  const GAMMA = 1.737;
  modelRoot.traverse((child) => {
    if (child.isMesh && child.geometry && child.geometry.userData.origZ) {
      const pos = child.geometry.attributes.position;
      const origZ = child.geometry.userData.origZ;
      const box = child.geometry.userData.origBox;
      if (!box) return;
      const minZ = box.min.z;
      const rangeZ = Math.max(0.0001, box.max.z - minZ);

      for (let i = 0; i < pos.count; i++) {
        const oz = origZ[i];
        if (simOn) {
          const norm = Math.max(0, Math.min(1, (oz - minZ) / rangeZ));
          // ヤマテ実測非線形盛り下がり特性（50%濃度→30%高さ）
          const sagged = Math.pow(norm, inkHeightGamma());
          pos.setZ(i, minZ + sagged * rangeZ * 0.985);
        } else {
          pos.setZ(i, oz);
        }
      }
      pos.needsUpdate = true;
      child.geometry.computeVertexNormals();
      child.geometry.computeBoundingBox();
      child.geometry.computeBoundingSphere();
    }
  });

  const currentBox = new THREE.Box3().setFromObject(modelRoot);
  modelRoot.position.z -= currentBox.min.z;
  modelRoot.updateMatrixWorld(true);
  const updatedBox = new THREE.Box3().setFromObject(modelRoot);
  state.maxHeight = updatedBox.max.z - updatedBox.min.z;
  updateHeightNote();
  requestRender();
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
  const ref = state.imgs.heightmap || state.imgs.base || state.imgs.color || state.imgs.original || state.imgs.texture || state.imgs.varnish;
  const imgAspect = ref.naturalWidth / ref.naturalHeight;
  const size = state.config.size_mm || {};
  state.widthMm = +size.width || 300;
  state.heightMm = Math.round((state.widthMm / imgAspect) * 10) / 10;
  const [W, H] = fitSize(ref.naturalWidth, ref.naturalHeight, FIELD_MAX);
  state.W = W; state.H = H;

  setProgress(0.65, '立体形状を計算しています…');
  await new Promise((r) => setTimeout(r, 20));
  const whiteIsHigh = state.config.white_is_high !== false;
  for (const k of ['heightmap', 'base', 'texture', 'varnish']) {
    if (state.imgs[k]) state.fields[k] = toField(state.imgs[k], W, H, { whiteIsHigh, ...layerCfg(k) });
  }
  if (!state.fields.texture) {
    $('textureToggle')?.closest('label')?.classList.add('is-disabled');
    if ($('textureToggle')) $('textureToggle').disabled = true;
  }
  if (state.fields.heightmap) {
    $('textureToggle')?.closest('label')?.setAttribute('style', 'display: none;');
  }
  composeHeight();

  setProgress(0.78, '法線マップを生成しています…');
  await new Promise((r) => setTimeout(r, 20));
  buildNormalMap(1);
  refreshHeightTex();

  // テクスチャ
  const maxTex = Math.min(COLOR_MAX, renderer.capabilities.maxTextureSize);
  const colorSrc = state.imgs.color || state.imgs.original || null;
  if (colorSrc) textures.color = colorTexture(colorSrc, maxTex);
  if (state.imgs.original) textures.original = colorTexture(state.imgs.original, maxTex);
  if (state.fields.varnish) varnishTex = grayTexture(state.fields.varnish, W, H);
  if (!textures.original) document.querySelector('[data-mode="original"]')?.setAttribute('disabled', 'true');
  if (!textures.color) {
    document.querySelector('[data-mode="color"]')?.setAttribute('disabled', 'true');
    state.mode = 'clay';
  }
  if (!varnishTex && $('varnishToggle')) { $('varnishToggle').disabled = true; $('varnishToggle').closest('label').classList.add('is-disabled'); }

  setProgress(0.9, 'メッシュを構築しています…');
  await new Promise((r) => setTimeout(r, 20));

  material = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    roughness: 0.58,
    metalness: 0,
    normalMap: normalTex,
    normalScale: new THREE.Vector2(0.85, 0.85),
    clearcoat: varnishTex ? 0.04 : 0,
    clearcoatMap: varnishTex || null,
    clearcoatRoughness: 0.35,
    specularIntensity: 0.15,
    ior: 1.46,
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
