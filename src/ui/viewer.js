/**
 * The 3D view, built on three.js.
 *
 * Everything that lives in the PART frame (table, segments, cut plane,
 * hotend, picked point) goes into one group, `partGroup`. For the "machine
 * view" we simply give that group the table rotation (A/C about the pivot):
 * the whole scene tilts exactly as the real table would.
 *
 * The rest of the app never touches three.js objects directly; it calls the
 * set...() methods below with plain data (TriMesh, arrays).
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const TABLE_COLOR = 0x5c6370;
const PLANE_OK = 0x3b82f6;
const PLANE_BAD = 0xf59e0b;
const TOOL_OK = 0x22c55e;
const TOOL_HIT = 0xef4444;
const PIVOT_COLOR = 0xf59e0b;

/** TriMesh -> non-indexed three.js geometry, so each face can have its own colour. */
function toGeometry(mesh, faceColors = null) {
  const F = mesh.numFaces;
  const pos = new Float32Array(F * 9);
  const col = faceColors ? new Float32Array(F * 9) : null;
  for (let f = 0; f < F; f++) {
    const tri = mesh.triangle(f);
    for (let v = 0; v < 3; v++)
      for (let k = 0; k < 3; k++) {
        pos[f * 9 + v * 3 + k] = tri[v][k];
        if (col) col[f * 9 + v * 3 + k] = faceColors[f * 3 + k];
      }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  if (col) g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.computeVertexNormals(); // flat: every face has its own 3 vertices
  return g;
}

/** Remove an object from its parent and free its GPU memory. */
function dispose(obj) {
  if (!obj) return;
  obj.parent?.remove(obj);
  obj.traverse((o) => {
    o.geometry?.dispose();
    if (o.material) [].concat(o.material).forEach((m) => m.dispose());
  });
}

export class Viewer {
  /**
   * @param {HTMLElement} container element the canvas fills
   * @param {object} opts
   * @param {(pick: {segmentId:number, faceIndex:number, point:number[]}) => void} opts.onPick
   */
  constructor(container, { onPick }) {
    this.container = container;
    this.onPick = onPick;
    this.pickEnabled = true;

    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.prepend(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(40, 1, 0.5, 5000);
    this.camera.up.set(0, 0, 1); // Z is up, like the printer
    this.camera.position.set(140, -180, 130);
    this.scene.add(this.camera);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.target.set(0, 0, 15);

    // Soft light from everywhere + a light that moves with the camera, so
    // the side you're looking at is always lit.
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x8890a0, 1.6));
    const headlight = new THREE.DirectionalLight(0xffffff, 1.6);
    headlight.position.set(0.3, 0.5, 1);
    this.camera.add(headlight);

    this.partGroup = new THREE.Group();
    this.partGroup.matrixAutoUpdate = false;
    this.scene.add(this.partGroup);
    this.objects = {}; // name -> three.js object currently shown
    this.segmentMeshes = [];

    this._setupPicking();
    this.applyTheme();
    new ResizeObserver(() => this.resize()).observe(container);
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => this.applyTheme());
    this.resize();
    this.renderer.setAnimationLoop(() => {
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
    });
  }

  applyTheme() {
    const bg = getComputedStyle(document.documentElement).getPropertyValue('--view-bg').trim() || '#e9ecf1';
    this.scene.background = new THREE.Color(bg);
  }

  resize() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    if (w === 0 || h === 0) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /** Replace the object stored under `name` (null just removes it). */
  _set(name, obj) {
    dispose(this.objects[name]);
    delete this.objects[name];
    if (obj) {
      this.objects[name] = obj;
      this.partGroup.add(obj);
    }
  }

  // ------------------------------------------------------------------ //
  // Scene content
  // ------------------------------------------------------------------ //

  /** Table mesh + a marker at the pivot point. */
  setTable(tableMesh, pivot) {
    const group = new THREE.Group();
    group.add(new THREE.Mesh(toGeometry(tableMesh),
      new THREE.MeshStandardMaterial({ color: TABLE_COLOR, roughness: 0.9, flatShading: true })));
    const marker = new THREE.Mesh(new THREE.SphereGeometry(1.5, 16, 12),
      new THREE.MeshBasicMaterial({ color: PIVOT_COLOR }));
    marker.position.set(...pivot);
    group.add(marker);
    const axes = new THREE.AxesHelper(25);
    axes.position.set(pivot[0], pivot[1], pivot[2] + 0.05);
    group.add(axes);
    this._set('table', group);
  }

  /**
   * Show the segments.
   * @param {{id:number, mesh:any, color:number[], overhang:boolean[]|null}[]} segments
   *   color is [r,g,b] in 0..1; faces where overhang[f] is true are drawn red.
   */
  setSegments(segments, overhangColor = [0.9, 0.2, 0.22]) {
    const group = new THREE.Group();
    this.segmentMeshes = [];
    for (const s of segments) {
      const colors = new Float32Array(s.mesh.numFaces * 3);
      for (let f = 0; f < s.mesh.numFaces; f++) {
        const c = s.overhang && s.overhang[f] ? overhangColor : s.color;
        colors.set(c, f * 3);
      }
      const mesh = new THREE.Mesh(toGeometry(s.mesh, colors),
        new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.65, metalness: 0.0, flatShading: true }));
      mesh.userData.segmentId = s.id;
      this.segmentMeshes.push(mesh);
      group.add(mesh);
      // Dark outline on sharp edges so flat faces are easy to read.
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(mesh.geometry, 25),
        new THREE.LineBasicMaterial({ color: 0x1d2330, transparent: true, opacity: 0.35 }));
      group.add(edges);
    }
    this._set('segments', group);
  }

  /** Square showing the selected cut plane, plus an arrow along its normal. */
  setCutPlane(plane) {
    if (!plane) return this._set('cutPlane', null);
    const { point, normal, size, ok } = plane;
    const color = ok ? PLANE_OK : PLANE_BAD;
    const group = new THREE.Group();
    group.add(new THREE.Mesh(new THREE.PlaneGeometry(size, size),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.18, side: THREE.DoubleSide, depthWrite: false })));
    const h = size / 2;
    const border = new THREE.BufferGeometry().setFromPoints(
      [[-h, -h], [h, -h], [h, h], [-h, h], [-h, -h]].map(([x, y]) => new THREE.Vector3(x, y, 0)));
    group.add(new THREE.Line(border, new THREE.LineBasicMaterial({ color })));
    group.add(new THREE.ArrowHelper(new THREE.Vector3(0, 0, 1), new THREE.Vector3(), size * 0.45, color, size * 0.08, size * 0.04));
    group.position.set(...point);
    group.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3(...normal));
    this._set('cutPlane', group);
  }

  /** Semi-transparent hotend model; red when it collides. */
  setHotend(tool) {
    if (!tool) return this._set('hotend', null);
    this._set('hotend', new THREE.Mesh(toGeometry(tool.mesh),
      new THREE.MeshStandardMaterial({ color: tool.hit ? TOOL_HIT : TOOL_OK, transparent: true, opacity: 0.45, depthWrite: false })));
  }

  /** Small yellow ball at the last picked point. */
  setPicked(point) {
    if (!point) return this._set('picked', null);
    const ball = new THREE.Mesh(new THREE.SphereGeometry(1.2, 16, 12), new THREE.MeshBasicMaterial({ color: 0xfacc15 }));
    ball.position.set(...point);
    this._set('picked', ball);
  }

  /**
   * Machine view: tilt everything by the table rotation R (3x3) about the
   * pivot, i.e. machine = R (p - pivot) + pivot. Pass null for the part view.
   */
  setMachineTransform(R, pivot) {
    const m = new THREE.Matrix4();
    if (R) {
      const rot = new THREE.Matrix4().set(
        R[0][0], R[0][1], R[0][2], 0,
        R[1][0], R[1][1], R[1][2], 0,
        R[2][0], R[2][1], R[2][2], 0,
        0, 0, 0, 1);
      m.makeTranslation(...pivot).multiply(rot).multiply(new THREE.Matrix4().makeTranslation(-pivot[0], -pivot[1], -pivot[2]));
    }
    this.partGroup.matrix.copy(m);
    this.partGroup.matrixWorldNeedsUpdate = true;
  }

  /** Point the camera at a bounding box. */
  frame(bounds) {
    const center = new THREE.Vector3(...bounds.min).add(new THREE.Vector3(...bounds.max)).multiplyScalar(0.5);
    const size = new THREE.Vector3(...bounds.max).sub(new THREE.Vector3(...bounds.min)).length();
    const dist = Math.max(60, size * 1.8);
    const dir = new THREE.Vector3(0.6, -0.75, 0.3).normalize(); // low enough to see undersides
    this.camera.position.copy(center).addScaledVector(dir, dist);
    this.controls.target.copy(center);
    this.controls.update();
  }

  // ------------------------------------------------------------------ //
  // Picking: a click (not a drag) on a segment reports the face under it.
  // ------------------------------------------------------------------ //
  _setupPicking() {
    const el = this.renderer.domElement;
    const raycaster = new THREE.Raycaster();
    let down = null;
    el.addEventListener('pointerdown', (e) => { down = [e.clientX, e.clientY]; });
    el.addEventListener('pointerup', (e) => {
      if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 4) return; // it was a drag
      down = null;
      if (!this.pickEnabled || this.segmentMeshes.length === 0) return;
      const rect = el.getBoundingClientRect();
      const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
      raycaster.setFromCamera(ndc, this.camera);
      const hit = raycaster.intersectObjects(this.segmentMeshes, false)[0];
      if (hit) this.onPick({ segmentId: hit.object.userData.segmentId, faceIndex: hit.faceIndex, point: hit.point.toArray() });
    });
  }
}
