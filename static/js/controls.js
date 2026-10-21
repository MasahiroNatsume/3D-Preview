// Blender 風カメラ操作
//
//  マウス
//    中ボタンドラッグ           : 回転（ターンテーブル）
//    Shift + 中ボタンドラッグ   : 平行移動
//    Ctrl  + 中ボタンドラッグ   : ズーム
//    ホイール                   : ズーム
//    左ドラッグ / 右ドラッグ    : 回転 / 平行移動（Blender に慣れていない方向け）
//  トラックパッド
//    2本指スライド              : 回転
//    Shift + 2本指スライド      : 平行移動
//    Ctrl + 2本指 / ピンチ      : ズーム
//  タッチ
//    1本指 : 回転 / 2本指 : ピンチでズーム・ドラッグで平行移動
//  キーボード（テンキー / 数字キー）
//    1 正面, 3 右, 7 上（Ctrl で反対側）, 5 透視/平行投影, 2 4 6 8 15°回転, . / Home 全体表示
import * as THREE from 'three';

const TAU = Math.PI * 2;
const STEP = Math.PI / 12; // 15°

export class BlenderControls extends EventTarget {
  constructor(perspCamera, orthoCamera, dom) {
    super();
    this.persp = perspCamera;
    this.ortho = orthoCamera;
    this.dom = dom;

    this.target = new THREE.Vector3();
    this.distance = 500;
    this.yaw = 0;    // Y 軸まわり
    this.elev = 0;   // 仰角（上から見下ろすと +）
    this.minDistance = 1;
    this.maxDistance = 1e5;

    this.isOrtho = false;
    this.autoPerspective = true; // Blender の Auto Perspective と同様
    this._autoOrtho = false;

    this.rotateSpeed = 0.006;  // rad / px
    this.wheelMode = 'auto';   // 'auto' | 'mouse' | 'trackpad'
    this.home = null;

    this._pointers = new Map();
    this._drag = null;
    this._anim = null;
    this._lastTrackpadTime = 0;
    this._gestureScale = 1;

    this._bind();
    this.update();
  }

  get camera() { return this.isOrtho ? this.ortho : this.persp; }

  // ------------------------------------------------------------- 基本操作
  orbit(dx, dy) {
    this._cancelAnim();
    if (this._autoOrtho && this.autoPerspective) { this.setOrtho(false); this._autoOrtho = false; }
    const flip = Math.cos(this.elev) < 0 ? -1 : 1; // 逆さま時も直感的な方向に
    this.yaw -= dx * this.rotateSpeed * flip;
    this.elev += dy * this.rotateSpeed;
    this.update();
  }

  pan(dx, dy) {
    this._cancelAnim();
    const h = this.dom.clientHeight || 1;
    const worldPerPx = (2 * this.distance * Math.tan(THREE.MathUtils.degToRad(this.persp.fov) / 2)) / h;
    const q = this._quat();
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
    this.target.addScaledVector(right, -dx * worldPerPx);
    this.target.addScaledVector(up, dy * worldPerPx);
    this.update();
  }

  zoom(factor) {
    this._cancelAnim();
    this.distance = THREE.MathUtils.clamp(this.distance * factor, this.minDistance, this.maxDistance);
    this.update();
  }

  setOrtho(v) {
    this.isOrtho = v;
    this.update();
    this.dispatchEvent(new Event('projection'));
  }

  toggleOrtho() { this._autoOrtho = false; this.setOrtho(!this.isOrtho); }

  // 視点プリセット（アニメーション付き）
  setView({ yaw = this.yaw, elev = this.elev, distance = this.distance, target = this.target, ortho } = {}, duration = 280) {
    this._cancelAnim();
    const from = { yaw: this.yaw, elev: this.elev, distance: this.distance, target: this.target.clone() };
    // 最短経路で回す
    let dYaw = ((yaw - from.yaw) % TAU + TAU + Math.PI) % TAU - Math.PI;
    let dElev = ((elev - from.elev) % TAU + TAU + Math.PI) % TAU - Math.PI;
    const to = { target: target.clone() };
    if (ortho !== undefined && ortho !== this.isOrtho) this.setOrtho(ortho);
    const t0 = performance.now();
    const step = (now) => {
      const t = Math.min(1, (now - t0) / duration);
      const e = 1 - Math.pow(1 - t, 3);
      this.yaw = from.yaw + dYaw * e;
      this.elev = from.elev + dElev * e;
      this.distance = from.distance + (distance - from.distance) * e;
      this.target.lerpVectors(from.target, to.target, e);
      this.update();
      if (t < 1) this._anim = requestAnimationFrame(step);
      else this._anim = null;
    };
    if (duration <= 0) step(t0 + 1); else this._anim = requestAnimationFrame(step);
  }

  axisView(yaw, elev) {
    const ortho = this.autoPerspective ? true : this.isOrtho;
    this._autoOrtho = this.autoPerspective;
    this.setView({ yaw, elev, ortho });
  }

  frame(box, { yaw, elev } = {}, duration = 280) {
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const fov = THREE.MathUtils.degToRad(this.persp.fov);
    const aspect = this.persp.aspect || 1;
    const fitH = (size.y / 2) / Math.tan(fov / 2);
    const fitW = (size.x / 2) / (Math.tan(fov / 2) * aspect);
    const distance = Math.max(fitH, fitW) * 1.15 + size.z;
    this.minDistance = Math.max(size.x, size.y) * 0.02;
    this.maxDistance = Math.max(size.x, size.y) * 20;
    const view = { target: center, distance, yaw: yaw ?? this.yaw, elev: elev ?? this.elev };
    this.setView(view, duration);
    return view;
  }

  goHome() {
    if (!this.home) return;
    this._autoOrtho = false;
    this.setView({ ...this.home, ortho: false });
  }

  // ------------------------------------------------------------- 更新
  _quat() {
    return new THREE.Quaternion().setFromEuler(new THREE.Euler(-this.elev, this.yaw, 0, 'YXZ'));
  }

  update() {
    const q = this._quat();
    const offset = new THREE.Vector3(0, 0, this.distance).applyQuaternion(q);
    for (const cam of [this.persp, this.ortho]) {
      cam.position.copy(this.target).add(offset);
      cam.quaternion.copy(q);
    }
    // 平行投影の画角を透視投影と揃える
    const h = this.distance * Math.tan(THREE.MathUtils.degToRad(this.persp.fov) / 2);
    const aspect = this.persp.aspect || 1;
    Object.assign(this.ortho, { left: -h * aspect, right: h * aspect, top: h, bottom: -h });
    const far = Math.max(this.distance * 10, 1000);
    this.persp.near = Math.max(this.distance / 1000, 0.01);
    this.persp.far = far;
    this.ortho.near = -far;
    this.ortho.far = far;
    this.persp.updateProjectionMatrix();
    this.ortho.updateProjectionMatrix();
    this.persp.updateMatrixWorld();
    this.ortho.updateMatrixWorld();
    this.dispatchEvent(new Event('change'));
  }

  _cancelAnim() {
    if (this._anim) { cancelAnimationFrame(this._anim); this._anim = null; }
  }

  // ------------------------------------------------------------- 入力
  _bind() {
    const el = this.dom;
    el.style.touchAction = 'none';
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    el.addEventListener('pointerdown', (e) => this._onPointerDown(e));
    el.addEventListener('pointermove', (e) => this._onPointerMove(e));
    el.addEventListener('pointerup', (e) => this._onPointerUp(e));
    el.addEventListener('pointercancel', (e) => this._onPointerUp(e));
    el.addEventListener('wheel', (e) => this._onWheel(e), { passive: false });
    // 中クリックでの自動スクロールを抑止
    el.addEventListener('mousedown', (e) => { if (e.button === 1) e.preventDefault(); });
    el.addEventListener('auxclick', (e) => e.preventDefault());
    // Safari のピンチ
    el.addEventListener('gesturestart', (e) => { e.preventDefault(); this._gestureScale = 1; });
    el.addEventListener('gesturechange', (e) => {
      e.preventDefault();
      const s = e.scale / this._gestureScale;
      this._gestureScale = e.scale;
      if (s > 0) this.zoom(1 / s);
    });
    el.addEventListener('gestureend', (e) => e.preventDefault());
    window.addEventListener('keydown', (e) => this._onKey(e));
  }

  _onPointerDown(e) {
    this.dom.setPointerCapture?.(e.pointerId);
    this._pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, type: e.pointerType });
    if (e.pointerType === 'touch') {
      this._touchStart();
      return;
    }
    let mode = null;
    if (e.button === 1) mode = e.shiftKey ? 'pan' : (e.ctrlKey || e.metaKey) ? 'zoom' : 'orbit';
    else if (e.button === 0) mode = e.shiftKey ? 'pan' : (e.ctrlKey || e.metaKey) ? 'zoom' : 'orbit';
    else if (e.button === 2) mode = 'pan';
    if (mode) {
      e.preventDefault();
      this._drag = { mode, button: e.button, x: e.clientX, y: e.clientY };
      this.dom.classList.add('is-dragging');
    }
  }

  _onPointerMove(e) {
    const p = this._pointers.get(e.pointerId);
    if (!p) return;
    if (e.pointerType === 'touch') {
      p.x = e.clientX; p.y = e.clientY;
      this._touchMove();
      return;
    }
    if (!this._drag) return;
    const dx = e.clientX - this._drag.x;
    const dy = e.clientY - this._drag.y;
    this._drag.x = e.clientX; this._drag.y = e.clientY;
    // ドラッグ中に Shift / Ctrl を押し替えてもモードが切り替わるように
    const mode = this._drag.button === 2 ? 'pan'
      : e.shiftKey ? 'pan' : (e.ctrlKey || e.metaKey) ? 'zoom' : 'orbit';
    if (mode === 'orbit') this.orbit(dx, dy);
    else if (mode === 'pan') this.pan(dx, dy);
    else if (mode === 'zoom') this.zoom(Math.exp(dy * 0.005));
  }

  _onPointerUp(e) {
    this._pointers.delete(e.pointerId);
    if (e.pointerType === 'touch') { this._touchStart(); return; }
    this._drag = null;
    this.dom.classList.remove('is-dragging');
  }

  _touchStart() {
    const pts = [...this._pointers.values()].filter((p) => p.type === 'touch');
    if (pts.length === 1) this._touch = { mode: 'orbit', x: pts[0].x, y: pts[0].y };
    else if (pts.length >= 2) {
      const [a, b] = pts;
      this._touch = { mode: 'pinch', cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, d: Math.hypot(a.x - b.x, a.y - b.y) };
    } else this._touch = null;
  }

  _touchMove() {
    const pts = [...this._pointers.values()].filter((p) => p.type === 'touch');
    const t = this._touch;
    if (!t) return;
    if (t.mode === 'orbit' && pts.length === 1) {
      this.orbit(pts[0].x - t.x, pts[0].y - t.y);
      t.x = pts[0].x; t.y = pts[0].y;
    } else if (t.mode === 'pinch' && pts.length >= 2) {
      const [a, b] = pts;
      const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (t.d > 0 && d > 0) this.zoom(t.d / d);
      this.pan(cx - t.cx, cy - t.cy);
      Object.assign(t, { cx, cy, d });
    }
  }

  _isTrackpad(e) {
    if (this.wheelMode === 'mouse') return false;
    if (this.wheelMode === 'trackpad') return true;
    const now = performance.now();
    let tp;
    if (e.deltaMode !== 0) tp = false;                         // 行/ページ単位 = マウス
    else if (e.ctrlKey) tp = true;                             // ピンチ
    else if (e.deltaX !== 0 && e.deltaY !== 0) tp = true;      // 斜めスクロール = トラックパッド
    else if (typeof e.wheelDeltaY === 'number' && e.wheelDeltaY !== 0) {
      tp = !(Math.abs(e.wheelDeltaY) % 120 === 0 && e.deltaX === 0);
    } else tp = !Number.isInteger(e.deltaY) || Math.abs(e.deltaY) < 40;
    // ジェスチャーの途中で判定がぶれないように少しの間だけ維持
    if (!tp && now - this._lastTrackpadTime < 400 && !(e.deltaMode !== 0)) tp = true;
    if (tp) this._lastTrackpadTime = now;
    return tp;
  }

  _onWheel(e) {
    e.preventDefault();
    let dx = e.deltaX, dy = e.deltaY;
    if (e.deltaMode === 1) { dx *= 16; dy *= 16; }
    else if (e.deltaMode === 2) { dx *= 400; dy *= 400; }

    if (this._isTrackpad(e)) {
      if (e.ctrlKey || e.metaKey) {         // ピンチ / Ctrl + 2本指
        this.zoom(Math.exp(dy * 0.01));
      } else if (e.shiftKey) {              // Shift + 2本指 = 平行移動
        this.pan(-dx, -dy);
      } else {                              // 2本指 = 回転
        this.orbit(-dx, -dy);
      }
    } else {
      // マウスホイール = ズーム（Shift/Ctrl 時に横スクロールへ変換されても対応）
      const d = dy !== 0 ? dy : dx;
      this.zoom(Math.exp(Math.sign(d) * Math.min(Math.abs(d), 200) * 0.0015));
    }
  }

  _onKey(e) {
    const tag = (e.target && e.target.tagName) || '';
    if (/INPUT|TEXTAREA|SELECT/.test(tag) && e.target.type !== 'range' && e.target.type !== 'checkbox' && e.target.type !== 'radio') return;
    const c = e.code;
    const ctrl = e.ctrlKey || e.metaKey;
    const k = (n) => c === `Numpad${n}` || c === `Digit${n}`;
    let handled = true;
    if (k(1)) this.axisView(ctrl ? Math.PI : 0, 0);
    else if (k(3)) this.axisView(ctrl ? -Math.PI / 2 : Math.PI / 2, 0);
    else if (k(7)) this.axisView(this._snapYaw(), ctrl ? -Math.PI / 2 : Math.PI / 2);
    else if (k(5)) this.toggleOrtho();
    else if (k(4)) this.setView({ yaw: this.yaw - STEP }, 150);
    else if (k(6)) this.setView({ yaw: this.yaw + STEP }, 150);
    else if (k(8)) this.setView({ elev: this.elev - STEP }, 150);
    else if (k(2)) this.setView({ elev: this.elev + STEP }, 150);
    else if (c === 'NumpadDecimal' || c === 'Period' || c === 'Home') this.dispatchEvent(new Event('frame'));
    else if (c === 'NumpadAdd' || c === 'Equal') this.zoom(0.85);
    else if (c === 'NumpadSubtract' || c === 'Minus') this.zoom(1 / 0.85);
    else if (k(0)) this.goHome();
    else handled = false;
    if (handled && ctrl) e.preventDefault();
    if (handled && c.startsWith('Numpad')) e.preventDefault();
  }

  _snapYaw() {
    return Math.round(this.yaw / (Math.PI / 2)) * (Math.PI / 2);
  }
}
