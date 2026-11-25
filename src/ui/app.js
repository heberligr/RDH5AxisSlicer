/**
 * The app: holds the state, wires up the side panel, and redraws the view.
 *
 * Flow: the user changes something (a button, slider, file) -> we update
 * `state` -> call cutsChanged() / renderAll(). renderAll() redraws the 3D
 * scene (renderScene) and refreshes the panel text (renderPanel). All real
 * work (cutting, IK, collisions) happens in ../core, which knows nothing
 * about the page.
 */

import { Viewer } from './viewer.js';
import { initPipeline } from './pipeline.js';
import { parseSettingsYaml } from '../core/settings.js';
import { initGeometry } from '../core/geometry.js';
import { parseMachineYaml } from '../core/config.js';
import { DEMO_MODELS } from '../core/demoModels.js';
import { meshInfo } from '../core/meshIO.js';
import { Project } from '../core/project.js';
import { Cut, applyCuts, tiltDeg } from '../core/segments.js';
import { overhangArea, overhangMask } from '../core/overhang.js';
import { IKError, inverseKinematics, partToMachine, tableRotation, toCommanded } from '../core/kinematics.js';
import { HotendModel, ObstacleSet, checkCollision, makeObstacle, tableMeshForMachine } from '../core/collision.js';
import { anglesOf, directionFromAngles } from '../core/transforms.js';
import { dot, normalize } from '../core/vec.js';

const $ = (id) => document.getElementById(id);

/** One colour per segment (r, g, b in 0..1); cycles if there are more segments. */
const SEGMENT_COLORS = [
  [0.78, 0.8, 0.85], // root: light grey
  [0.27, 0.6, 0.95],
  [0.33, 0.78, 0.45],
  [0.96, 0.72, 0.2],
  [0.7, 0.45, 0.92],
  [0.25, 0.8, 0.78],
  [0.95, 0.5, 0.65],
  [0.62, 0.55, 0.36],
];
const segmentColor = (id) => SEGMENT_COLORS[id % SEGMENT_COLORS.length];
const cssColor = (c) => `rgb(${c.map((x) => Math.round(x * 255)).join(',')})`;

// Example projects (made by tools/make-examples.mjs with Auto-segment).
const EXAMPLES = [
  { label: 'T-shape (3 segments)', file: 'examples/t_shape.json' },
  { label: 'Cube with arm (2 segments)', file: 'examples/cube_with_arm.json' },
  { label: 'Plain cube (no cuts needed)', file: 'examples/cube.json' },
];

const fmt = (x, d = 2) => (Math.abs(x) < 0.5 * 10 ** -d ? 0 : x).toFixed(d);

// --------------------------------------------------------------------- //
// State
// --------------------------------------------------------------------- //
const state = {
  machine: null,
  machineLabel: 'repo default (config/machine.yaml)',
  project: new Project(),
  part: null,          // TriMesh of the whole part (part frame)
  seg: null,           // result of applyCuts()
  selectedCut: -1,
  liveUpdate: true,
  dirty: false,        // cuts edited but not applied (live update off)
  showOverhangs: true,
  picked: null,        // { segmentId, faceIndex, point, normal, isOverhang }
  editTilt: 90,        // slider values for the selected cut's normal
  editAz: 0,
  tool: { show: false, tilt: 0, az: 0, tip: [0, 0, 10], machineView: false, segment: null },
  tableObstacle: null, // sampled table, built the first time the hotend test needs it
  defaultSettings: null, // config/settings.yaml, used for new projects
  autoResult: null,    // last Auto-segment result (log, remaining overhangs)
  plan: null,          // last Slice result (toolpaths, G-code, collision report)
};
let viewer;
let pipeline; // auto-segment / slice / preview panel (pipeline.js)

// --------------------------------------------------------------------- //
// Small UI helpers
// --------------------------------------------------------------------- //
let toastTimer = null;
function toast(message, isError = false) {
  const el = $('toast');
  el.textContent = message;
  el.classList.toggle('error', isError);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, isError ? 8000 : 4000);
}

/** Set an input's value, unless the user is typing in it right now. */
function setValue(el, value) {
  if (document.activeElement !== el) el.value = value;
}

/** Fill a <ul> with lines; each line is a string or [string, cssClass]. */
function fillList(ul, lines) {
  ul.replaceChildren(...lines.map((line) => {
    const li = document.createElement('li');
    const [text, cls] = Array.isArray(line) ? line : [line, ''];
    li.textContent = text;
    if (cls) li.className = cls;
    return li;
  }));
}

function download(filename, text, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const currentCut = () => state.project.cuts[state.selectedCut] ?? null;
const currentReport = () => state.seg?.cutReports[state.selectedCut] ?? null;

// --------------------------------------------------------------------- //
// Machine
// --------------------------------------------------------------------- //
async function loadDefaultMachine() {
  const res = await fetch('config/machine.yaml', { cache: 'no-cache' });
  if (!res.ok) throw new Error(`Could not load config/machine.yaml (${res.status})`);
  return parseMachineYaml(await res.text());
}

function setMachine(machine, label) {
  state.machine = machine;
  state.machineLabel = label;
  state.tableObstacle = null;
  pipeline?.invalidate();
  viewer.setTable(tableMeshForMachine(machine), machine.kinematics.pivot);
  if (state.part) recompute();
  else renderAll();
}

// --------------------------------------------------------------------- //
// Loading models and projects
// --------------------------------------------------------------------- //
function openProject(project) {
  const part = project.loadPart(state.machine); // throws on a bad model
  state.project = project;
  state.part = part;
  state.selectedCut = project.cuts.length - 1;
  state.picked = null;
  state.tool.segment = null;
  state.autoResult = null;
  const { min, max } = part.bounds();
  state.tool.tip = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, max[2]];
  syncAnglesFromCut();
  $('placeOnBed').checked = project.placeOnBed;
  $('overhangAngle').value = project.overhangAngleDeg;
  recompute();
  viewer.frame(part.bounds());
}

function tryOpen(makeProject, what) {
  try {
    openProject(makeProject());
    toast(`Opened ${what}`);
  } catch (err) {
    console.error(err);
    toast(`Could not open ${what}: ${err.message}`, true);
  }
}

async function openFile(file) {
  if (file.name.toLowerCase().endsWith('.json')) {
    const text = await file.text();
    tryOpen(() => Project.parse(text), file.name);
  } else {
    const buffer = await file.arrayBuffer();
    tryOpen(() => new Project({
      stlName: file.name,
      stlBuffer: buffer,
      placeOnBed: $('placeOnBed').checked,
      settings: state.project.settings,
    }), file.name);
  }
}

async function openExample(path) {
  const res = await fetch(path, { cache: 'no-cache' });
  if (!res.ok) return toast(`Could not load ${path}`, true);
  const text = await res.text();
  tryOpen(() => Project.parse(text), path.split('/').pop());
}

// --------------------------------------------------------------------- //
// Cuts
// --------------------------------------------------------------------- //
function recompute() {
  pipeline?.invalidate(); // any sliced toolpaths are now out of date
  if (state.part) {
    try {
      state.seg = applyCuts(state.part, state.project.cuts, state.machine);
    } catch (err) {
      console.error(err);
      toast(`Cutting failed: ${err.message}`, true);
    }
  } else {
    state.seg = null;
  }
  state.dirty = false;
  renderAll();
}

// While a slider is being dragged, many changes arrive per frame. Re-cut at
// most once per animation frame.
let recomputeQueued = false;
function scheduleRecompute() {
  if (recomputeQueued) return;
  recomputeQueued = true;
  requestAnimationFrame(() => {
    recomputeQueued = false;
    recompute();
  });
}

/** Call after editing cuts: re-cut now (live update) or later (Apply button). */
function cutsChanged() {
  if (state.liveUpdate) scheduleRecompute();
  else {
    state.dirty = true;
    renderAll(); // still move the plane preview
  }
}

function syncAnglesFromCut() {
  const cut = currentCut();
  if (!cut) return;
  const { tilt, azimuth } = anglesOf(cut.normal);
  state.editTilt = tilt;
  if (tilt > 1e-6) state.editAz = azimuth; // azimuth means nothing for a vertical normal
}

function selectCut(i) {
  state.selectedCut = i;
  syncAnglesFromCut();
  renderAll();
}

// --------------------------------------------------------------------- //
// Rendering the 3D scene
// --------------------------------------------------------------------- //
function renderScene() {
  const { machine, seg } = state;
  const threshold = state.project.overhangAngleDeg;

  viewer.setSegments((seg?.segments ?? []).map((s) => ({
    id: s.id,
    mesh: s.mesh,
    color: segmentColor(s.id),
    overhang: state.showOverhangs ? overhangMask(s.mesh, s.direction, threshold) : null,
  })));

  const cut = currentCut();
  const showingToolpaths = Boolean(state.plan?.showToolpaths); // the plane would hide the layers
  if (cut && state.part && !showingToolpaths) {
    const e = state.part.extents();
    const report = currentReport();
    viewer.setCutPlane({
      point: cut.point,
      normal: cut.normal,
      size: 1.2 * Math.hypot(...e),
      ok: !state.dirty && (report ? report.applied : true),
    });
  } else viewer.setCutPlane(null);

  viewer.setPicked(state.picked && !state.tool.machineView ? state.picked.point : null);

  pipeline.renderScene();
  if (pipeline.isAnimating()) return; // the animation drives the hotend and table itself

  // Hotend + machine view
  const t = state.tool;
  const dir = directionFromAngles(t.tilt, t.az);
  let pose = null;
  try {
    pose = inverseKinematics(dir, machine);
  } catch (err) {
    if (!(err instanceof IKError)) throw err;
  }
  if (t.show) {
    const model = new HotendModel(machine.hotend);
    const hit = checkCollision(model, t.tip, dir, toolObstacles()).hit;
    viewer.setHotend({ mesh: model.toMesh(t.tip, dir), hit });
  } else viewer.setHotend(null);
  viewer.setMachineTransform(t.machineView && pose ? tableRotation(pose.a, pose.c) : null, machine.kinematics.pivot);
  viewer.pickEnabled = !t.machineView;
}

/** Obstacles for the hotend test: the table + segments printed before the tested one. */
// Sampling meshes into points is the slow part, so reuse the result until
// the segments (state.seg) or the set of obstacle segments change.
let obstacleCache = { seg: null, ids: '', set: null };
function toolObstacles() {
  const spacing = state.machine.collision.sample_spacing;
  if (!state.tableObstacle) state.tableObstacle = makeObstacle(tableMeshForMachine(state.machine), 'table', spacing);
  const ids = obstacleSegmentIds();
  if (obstacleCache.seg !== state.seg || obstacleCache.ids !== ids.join(',') || obstacleCache.set.obstacles[0] !== state.tableObstacle) {
    const obstacles = [state.tableObstacle, ...ids.map((id) => makeObstacle(state.seg.segments[id].mesh, `segment ${id}`, spacing))];
    obstacleCache = { seg: state.seg, ids: ids.join(','), set: new ObstacleSet(spacing, obstacles) };
  }
  return obstacleCache.set;
}

function obstacleSegmentIds() {
  const seg = state.seg;
  if (!seg) return [];
  const target = state.tool.segment;
  if (target === null || !seg.order.includes(target)) return seg.segments.map((s) => s.id);
  return seg.order.slice(0, seg.order.indexOf(target)); // only what is printed before it
}

// --------------------------------------------------------------------- //
// Rendering the side panel
// --------------------------------------------------------------------- //
function renderPanel() {
  const { project, part, seg, machine } = state;

  // ---- Model ----
  fillList($('modelInfo'), part ? meshInfo(part, project.modelLabel).map((l) => (l.startsWith('WARNING') ? [l, 'bad'] : l))
    : [['No model loaded.', 'muted']]);

  // ---- Cuts ----
  $('cutsNeedModel').hidden = Boolean(part);
  $('cutsBody').hidden = !part;
  $('overhangAngleOut').textContent = `${project.overhangAngleDeg}°`;
  $('cutApply').hidden = !state.dirty;
  renderCutList();
  renderCutEditor();

  // ---- Segments ----
  renderSegments();

  // ---- Hotend / IK ----
  const t = state.tool;
  $('toolShow').checked = t.show;
  $('machineView').checked = t.machineView;
  setValue($('toolTilt'), t.tilt);
  setValue($('toolAz'), t.az);
  $('toolTiltOut').textContent = `${fmt(t.tilt, 0)}°`;
  $('toolAzOut').textContent = `${fmt(t.az, 0)}°`;
  ['toolTx', 'toolTy', 'toolTz'].forEach((id, k) => setValue($(id), fmt(t.tip[k])));
  $('toolAim').disabled = !currentCut();
  $('toolAll').hidden = t.segment === null;
  $('toolScope').textContent = t.segment === null ? 'Checking against the table and all segments.'
    : `Checking against the table and segments printed before segment ${t.segment}.`;
  const dir = directionFromAngles(t.tilt, t.az);
  const status = [];
  try {
    const pose = inverseKinematics(dir, machine);
    const cmd = toCommanded(pose, machine);
    const k = machine.kinematics;
    status.push(`IK: ${k.a_axis.letter}=${fmt(cmd.a)}  ${k.c_axis.letter}=${fmt(cmd.c)} (commanded)`);
    if (t.machineView) status.push(`Tip in machine XYZ: [${partToMachine(t.tip, pose, k.pivot).map((x) => fmt(x)).join(', ')}]`);
  } catch (err) {
    if (!(err instanceof IKError)) throw err;
    status.push([`IK: unreachable - ${err.message}`, 'bad']);
  }
  if (t.show) {
    const res = checkCollision(new HotendModel(machine.hotend), t.tip, dir, toolObstacles());
    status.push(res.hit ? [`COLLISION with ${res.obstacleName} (${res.numPoints} sample points)`, 'bad'] : ['No collision', 'good']);
  }
  fillList($('toolStatus'), status);

  pipeline.renderPanel();

  // ---- Machine ----
  const k = machine.kinematics;
  fillList($('machineInfo'), [
    `${machine.name} (${machine.firmware})`,
    `Loaded from: ${state.machineLabel}`,
    `Pivot: [${k.pivot.join(', ')}]`,
    `${k.a_axis.letter}: ${k.a_axis.min_deg}° to ${k.a_axis.max_deg}° · ${k.c_axis.letter}: ${k.c_axis.continuous ? 'continuous' : `${k.c_axis.min_deg}° to ${k.c_axis.max_deg}°`}`,
    `Hotend: ${machine.hotend.cone_half_angle_deg}° cone, ${machine.hotend.cylinder_radius} mm radius block`,
  ]);
}

function renderCutList() {
  const list = $('cutList');
  list.replaceChildren(...state.project.cuts.map((cut, i) => {
    const li = document.createElement('li');
    li.className = i === state.selectedCut ? 'selected' : '';
    const report = state.seg?.cutReports[i];
    const n = cut.normal.map((x) => fmt(x)).join(', ');
    li.innerHTML = `<span></span><span class="tag"></span><span class="skipped"></span>`;
    li.children[0].textContent = `Cut ${i + 1}${cut.name ? ` · ${cut.name}` : ''}`;
    li.children[1].textContent = `${cut.local ? 'local · ' : ''}n = (${n})`;
    li.children[2].textContent = report && !report.applied ? 'skipped' : '';
    li.addEventListener('click', () => selectCut(i));
    return li;
  }));
}

function renderCutEditor() {
  const cut = currentCut();
  $('cutEditor').hidden = !cut;
  if (!cut) return;
  const i = state.selectedCut;
  $('cutEditorTitle').textContent = `Editing cut ${i + 1}`;
  $('cutUp').disabled = i === 0;
  $('cutDown').disabled = i === state.project.cuts.length - 1;
  ['cutPx', 'cutPy', 'cutPz'].forEach((id, k) => setValue($(id), fmt(cut.point[k])));
  setValue($('cutSlide'), fmt(dot(cut.normal, cut.point)));
  setValue($('cutTilt'), state.editTilt);
  setValue($('cutAz'), state.editAz);
  $('cutTiltOut').textContent = `${fmt(state.editTilt, 1)}°`;
  $('cutAzOut').textContent = `${fmt(state.editAz, 1)}°`;
  ['cutNx', 'cutNy', 'cutNz'].forEach((id, k) => setValue($(id), fmt(cut.normal[k], 3)));
  $('cutLocal').checked = cut.local;

  // Picked face
  const pk = state.picked;
  $('pickButtons').hidden = !pk;
  $('pickText').textContent = pk
    ? `Picked: segment ${pk.segmentId}, face ${pk.faceIndex}${pk.isOverhang ? ' (overhang)' : ''}`
    : 'Tip: click a face in the view to pick it, then snap the plane to it.';

  // Pieces (local cuts)
  const report = currentReport();
  const pieces = report?.pieceCentroids ?? [];
  $('pieceBox').hidden = !(cut.local && pieces.length);
  $('pieceAuto').checked = cut.components === null;
  $('pieceList').replaceChildren(...pieces.map((c, k) => {
    const label = document.createElement('label');
    label.className = 'check';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = report.chosenPieces.includes(k);
    box.addEventListener('change', () => {
      const chosen = new Set(report.chosenPieces);
      if (box.checked) chosen.add(k);
      else chosen.delete(k);
      cut.components = [...chosen].sort((a, b) => a - b);
      cutsChanged();
    });
    label.append(box, ` piece ${k}: ${(report.pieceVolumes[k] / 1000).toFixed(2)} cm³ at (${c.map((x) => fmt(x, 0)).join(', ')})`);
    return label;
  }));

  const msg = $('cutReport');
  msg.textContent = state.dirty ? 'Not applied yet - press Apply cuts.' : (report?.message ?? '');
  msg.className = `small ${report && !report.applied ? 'bad' : 'muted'}`;
}

function renderSegments() {
  const box = $('segmentsBody');
  const seg = state.seg;
  if (!seg) {
    box.textContent = 'No model loaded.';
    box.className = 'muted';
    return;
  }
  box.className = '';
  const k = state.machine.kinematics;
  const intro = document.createElement('div');
  intro.className = 'muted small';
  intro.textContent = `${seg.segments.length} segment(s), in print order:`;
  const ul = document.createElement('ul');
  ul.className = 'seg-list';
  seg.order.forEach((id, step) => {
    const s = seg.segments[id];
    let ac;
    try {
      const cmd = toCommanded(inverseKinematics(s.direction, state.machine), state.machine);
      ac = `${k.a_axis.letter}${fmt(cmd.a, 1)} ${k.c_axis.letter}${fmt(cmd.c, 1)}`;
    } catch {
      ac = 'unreachable';
    }
    const rests = s.cutIndex === null ? 'the bed' : s.supports.length ? `segment ${s.supports.join(', ')}` : 'nothing!';
    const area = overhangArea(s.mesh, s.direction, state.project.overhangAngleDeg);
    const li = document.createElement('li');
    li.innerHTML = `<span class="swatch"></span><div><div></div><div class="detail"></div></div>`;
    li.querySelector('.swatch').style.background = cssColor(segmentColor(id));
    li.querySelector('div > div').textContent = `${step + 1}. Segment ${id} on ${rests}`;
    li.querySelector('.detail').textContent = `tilt ${fmt(tiltDeg(s.direction), 0)}° · ${ac} · overhang ${fmt(area, 0)} mm²`;
    ul.append(li);
  });
  const status = document.createElement('div');
  if (seg.warnings.length) {
    status.className = 'warnings';
    status.innerHTML = '<ul class="warnings"></ul>';
    fillList(status.firstChild, seg.warnings);
  } else {
    status.className = 'good small';
    status.textContent = '✓ Cuts form a valid print order.';
  }
  box.replaceChildren(intro, ul, status);
}

function renderAll() {
  if (!state.machine) return;
  renderScene();
  renderPanel();
}

// --------------------------------------------------------------------- //
// Picking faces
// --------------------------------------------------------------------- //
function onPick({ segmentId, faceIndex, point }) {
  const s = state.seg?.segments[segmentId];
  if (!s) return;
  state.picked = {
    segmentId,
    faceIndex,
    point,
    normal: s.mesh.faceNormal(faceIndex),
    isOverhang: overhangMask(s.mesh, s.direction, state.project.overhangAngleDeg)[faceIndex],
  };
  if (!currentCut()) toast('Face picked. Add a cut, then use the snap buttons to place it.');
  renderAll();
}

// --------------------------------------------------------------------- //
// Event wiring
// --------------------------------------------------------------------- //
function wireEvents() {
  // ---- Model ----
  $('stlInput').addEventListener('change', (e) => { if (e.target.files[0]) openFile(e.target.files[0]); e.target.value = ''; });
  $('demoLoad').addEventListener('click', () => {
    const name = $('demoSelect').value;
    tryOpen(() => new Project({ demoName: name, placeOnBed: $('placeOnBed').checked, settings: state.project.settings }), `demo: ${name}`);
  });
  const view = $('view');
  view.addEventListener('dragover', (e) => e.preventDefault());
  view.addEventListener('drop', (e) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file) openFile(file);
  });

  // ---- Project ----
  $('projectSave').addEventListener('click', () => {
    if (!state.part) return toast('Nothing to save - load a model first.', true);
    const base = (state.project.demoName ?? state.project.stlName ?? 'project').replace(/\.stl$/i, '').replace(/[^\w-]+/g, '_');
    download(`${base}.json`, state.project.serialize());
  });
  $('projectInput').addEventListener('change', (e) => { if (e.target.files[0]) openFile(e.target.files[0]); e.target.value = ''; });
  $('exampleLoad').addEventListener('click', () => openExample($('exampleSelect').value));

  // ---- Overhangs ----
  $('showOverhangs').addEventListener('change', (e) => { state.showOverhangs = e.target.checked; renderAll(); });
  $('overhangAngle').addEventListener('input', (e) => { state.project.overhangAngleDeg = Number(e.target.value); renderAll(); });

  // ---- Cut list ----
  $('cutAdd').addEventListener('click', () => {
    if (!state.part) return;
    const { min, max } = state.part.bounds();
    state.project.cuts.push(new Cut(min.map((x, k) => (x + max[k]) / 2), [1, 0, 0]));
    selectCut(state.project.cuts.length - 1);
    cutsChanged();
  });
  $('liveUpdate').addEventListener('change', (e) => { state.liveUpdate = e.target.checked; if (state.liveUpdate && state.dirty) recompute(); });
  $('cutApply').addEventListener('click', recompute);
  const move = (step) => {
    const i = state.selectedCut, j = i + step, cuts = state.project.cuts;
    if (j < 0 || j >= cuts.length) return;
    [cuts[i], cuts[j]] = [cuts[j], cuts[i]];
    state.selectedCut = j;
    cutsChanged();
  };
  $('cutUp').addEventListener('click', () => move(-1));
  $('cutDown').addEventListener('click', () => move(+1));
  $('cutDelete').addEventListener('click', () => {
    state.project.cuts.splice(state.selectedCut, 1);
    state.selectedCut = Math.min(state.selectedCut, state.project.cuts.length - 1);
    syncAnglesFromCut();
    cutsChanged();
  });

  // ---- Cut editor ----
  const onCut = (fn) => () => { const cut = currentCut(); if (cut) { fn(cut); cutsChanged(); } };
  ['cutPx', 'cutPy', 'cutPz'].forEach((id, k) => $(id).addEventListener('change', onCut((cut) => {
    const v = Number($(id).value);
    if (Number.isFinite(v)) cut.point[k] = v;
  })));
  $('cutSlide').addEventListener('input', onCut((cut) => {
    const v = Number($('cutSlide').value);
    if (!Number.isFinite(v)) return;
    const delta = v - dot(cut.normal, cut.point);
    cut.point = cut.point.map((x, k) => x + delta * cut.normal[k]);
  }));
  const onAngles = onCut((cut) => {
    state.editTilt = Number($('cutTilt').value);
    state.editAz = Number($('cutAz').value);
    cut.normal = directionFromAngles(state.editTilt, state.editAz);
  });
  $('cutTilt').addEventListener('input', onAngles);
  $('cutAz').addEventListener('input', onAngles);
  ['cutNx', 'cutNy', 'cutNz'].forEach((id) => $(id).addEventListener('change', onCut((cut) => {
    const n = ['cutNx', 'cutNy', 'cutNz'].map((i) => Number($(i).value));
    if (n.every(Number.isFinite) && Math.hypot(...n) > 1e-9) {
      cut.normal = normalize(n);
      syncAnglesFromCut();
    }
  })));
  $('cutFlip').addEventListener('click', onCut((cut) => { cut.normal = cut.normal.map((x) => -x); syncAnglesFromCut(); }));
  $('snapNormal').addEventListener('click', onCut((cut) => { cut.normal = [...state.picked.normal]; syncAnglesFromCut(); }));
  $('snapPoint').addEventListener('click', onCut((cut) => { cut.point = [...state.picked.point]; }));
  $('snapBoth').addEventListener('click', onCut((cut) => {
    cut.normal = [...state.picked.normal];
    cut.point = [...state.picked.point];
    syncAnglesFromCut();
  }));
  $('cutLocal').addEventListener('change', onCut((cut) => { cut.local = $('cutLocal').checked; }));
  $('pieceAuto').addEventListener('change', onCut((cut) => {
    cut.components = $('pieceAuto').checked ? null : [...(currentReport()?.chosenPieces ?? [])];
  }));

  // ---- Hotend / IK test ----
  const t = state.tool;
  $('toolShow').addEventListener('change', (e) => { t.show = e.target.checked; renderAll(); });
  $('toolTilt').addEventListener('input', (e) => { t.tilt = Number(e.target.value); renderAll(); });
  $('toolAz').addEventListener('input', (e) => { t.az = Number(e.target.value); renderAll(); });
  ['toolTx', 'toolTy', 'toolTz'].forEach((id, k) => $(id).addEventListener('change', () => {
    const v = Number($(id).value);
    if (Number.isFinite(v)) { t.tip[k] = v; renderAll(); }
  }));
  $('machineView').addEventListener('change', (e) => { t.machineView = e.target.checked; renderAll(); });
  $('toolAim').addEventListener('click', () => {
    // Nozzle on the cut point, pointing along the cut normal, checked only
    // against what is printed before that cut's segment.
    const cut = currentCut();
    if (!cut) return;
    const { tilt, azimuth } = anglesOf(cut.normal);
    Object.assign(t, { tilt, az: azimuth, tip: [...cut.point], show: true, segment: currentReport()?.newSegment ?? null });
    renderAll();
  });
  $('toolAll').addEventListener('click', () => { t.segment = null; renderAll(); });

  // ---- Machine ----
  $('machineInput').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      setMachine(parseMachineYaml(await file.text()), file.name);
      toast(`Machine loaded from ${file.name}`);
    } catch (err) {
      toast(`Bad machine file: ${err.message}`, true);
    }
  });
  $('machineReset').addEventListener('click', async () => {
    try {
      setMachine(await loadDefaultMachine(), 'repo default (config/machine.yaml)');
      toast('Using the repo default machine');
    } catch (err) {
      toast(err.message, true);
    }
  });
}

// --------------------------------------------------------------------- //
// Start-up
// --------------------------------------------------------------------- //
async function main() {
  viewer = new Viewer($('view'), { onPick });
  pipeline = initPipeline({ state, viewer, $, toast, renderAll, recompute, segmentColor, download, fmt, fillList });
  $('demoSelect').replaceChildren(...Object.keys(DEMO_MODELS).map((n) => new Option(n, n)));
  $('demoSelect').value = 'T-shape';
  $('exampleSelect').replaceChildren(...EXAMPLES.map((e) => new Option(e.label, e.file)));
  wireEvents();

  try {
    const [machine, settingsText] = await Promise.all([
      loadDefaultMachine(),
      fetch('config/settings.yaml', { cache: 'no-cache' }).then((r) => r.text()),
      initGeometry(),
    ]);
    state.defaultSettings = parseSettingsYaml(settingsText);
    state.project = new Project({ settings: state.defaultSettings });
    setMachine(machine, state.machineLabel);
  } catch (err) {
    console.error(err);
    $('loadingText').textContent = `Could not start: ${err.message}`;
    return;
  }
  $('loading').hidden = true;
  // Open with a finished example so the first thing you see is the idea.
  await openExample(EXAMPLES[0].file);
  document.body.dataset.ready = 'true'; // used by the automated browser test
  // Handy for poking around in the browser console (F12): slicer.state, slicer.viewer
  window.slicer = { state, viewer, renderAll, recompute, pipeline };
}

main();
