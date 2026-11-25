/**
 * Side-panel features after the manual cut editor:
 *   - Auto-orient (milestone 3)
 *   - Auto-segment, its results and decision log (milestone 3)
 *   - Slice + G-code + collision check, download (milestones 4-6)
 *   - Toolpath preview with a layer slider, and the machine animation (milestone 6)
 *
 * app.js creates this with initPipeline(app) and calls the returned hooks:
 *   renderScene()  - extra 3D content (toolpaths, markers)
 *   renderPanel()  - refresh this module's panel text
 *   invalidate()   - forget the sliced plan (cuts/settings changed)
 *   isAnimating()  - true while the machine animation runs
 */

import { autoSegment } from '../core/autoSegment.js';
import { checkPlan } from '../core/checks.js';
import { HotendModel } from '../core/collision.js';
import { generateGcode } from '../core/gcode.js';
import { machineToPart, tableRotation, toolDirectionInPart } from '../core/kinematics.js';
import { chooseOrientation } from '../core/orientation.js';
import { sliceAll, toPartFrame } from '../core/slicer.js';
import { identity, matMul } from '../core/vec.js';

const PLA_DENSITY = 1.24; // g/cm^3, for the weight estimate

/**
 * @param {object} app shared things from app.js:
 *   { state, viewer, $, toast, renderAll, recompute, segmentColor, download, fmt }
 */
export function initPipeline(app) {
  const { state, viewer, $, toast, fmt } = app;
  let busy = false;
  let anim = null; // { timeline, start, frame } while the animation plays

  // ------------------------------------------------------------------ //
  // Settings inputs: <input data-setting="section.key">
  // ------------------------------------------------------------------ //
  const settingInputs = [...document.querySelectorAll('[data-setting]')];
  for (const input of settingInputs) {
    input.addEventListener('change', () => {
      const [section, key] = input.dataset.setting.split('.');
      const v = Number(input.value);
      if (!Number.isFinite(v)) return;
      state.project.settings[section][key] = v;
      if (section === 'slicing' || section === 'collision_check') invalidate();
      app.renderAll();
    });
  }

  function invalidate() {
    stopAnimation();
    state.plan = null;
  }

  async function runExclusive(progressEl, fn) {
    if (busy) return toast('Busy - wait for the current job to finish.', true);
    busy = true;
    document.body.classList.add('busy');
    try {
      await fn((msg) => { $(progressEl).textContent = msg; });
    } catch (err) {
      console.error(err);
      toast(err.message, true);
    } finally {
      busy = false;
      document.body.classList.remove('busy');
      $(progressEl).textContent = '';
      app.renderAll();
    }
  }

  // ------------------------------------------------------------------ //
  // Auto-orient
  // ------------------------------------------------------------------ //
  function confirmDropCuts(what) {
    const n = state.project.cuts.length;
    return n === 0 || window.confirm(`${what} will remove the ${n} existing cut${n > 1 ? 's' : ''}. Continue?`);
  }

  function reloadPart() {
    state.part = state.project.loadPart(state.machine);
    state.project.cuts = [];
    state.selectedCut = -1;
    state.picked = null;
    state.autoResult = null;
    app.recompute();
    viewer.frame(state.part.bounds());
  }

  $('orientAuto').addEventListener('click', () => {
    if (!state.part || !confirmDropCuts('Changing the orientation')) return;
    const r = chooseOrientation(state.part, state.project.settings);
    if (r.overhang >= r.current.overhang - 0.5) return toast(`Already the best orientation found (overhang ${fmt(r.current.overhang, 0)} mm²).`);
    state.project.baseRotation = matMul(r.rotation, state.project.baseRotation ?? identity());
    reloadPart();
    toast(`Re-oriented: overhang ${fmt(r.current.overhang, 0)} → ${fmt(r.overhang, 0)} mm², bed contact ${fmt(r.contact, 0)} mm². Use "Reset orientation" to undo.`);
  });

  $('orientReset').addEventListener('click', () => {
    if (!state.part || !state.project.baseRotation || !confirmDropCuts('Resetting the orientation')) return;
    state.project.baseRotation = null;
    reloadPart();
  });

  // ------------------------------------------------------------------ //
  // Auto-segment
  // ------------------------------------------------------------------ //
  $('autoRun').addEventListener('click', () => {
    if (!state.part) return toast('Load a model first.', true);
    if (!confirmDropCuts('Auto-segment')) return;
    runExclusive('autoProgress', async (progress) => {
      const result = await autoSegment(state.part, state.machine, state.project.settings, { onProgress: progress });
      state.project.cuts = result.cuts;
      state.selectedCut = result.cuts.length - 1;
      state.autoResult = result;
      app.recompute();
      toast(result.cuts.length ? `Auto-segment proposed ${result.cuts.length} cut(s) - check them in the Cuts list.` : 'No cuts needed.');
    });
  });

  function logText(result) {
    const lines = [];
    result.log.forEach((e, i) => {
      lines.push(`Region ${i + 1}: ${fmt(e.region.area, 0)} mm² in segment ${e.segment}, centre (${e.region.centroid.map((x) => fmt(x, 1)).join(', ')})`);
      lines.push(`  ${e.candidatesTried} directions tried, ${e.collisionChecked ?? 0} collision-checked`);
      for (const [why, n] of Object.entries(e.rejectedBeforeScoring ?? {})) lines.push(`  rejected ${n}x: ${why}`);
      lines.push('  best candidates (score = left-over overhang + weights × parent overhang & tilt):');
      for (const b of e.best.slice(0, 8)) {
        const verdict = b.collision === null ? 'OK' : b.collision === 'not checked' ? 'not checked' : `hits ${b.collision}`;
        lines.push(`    ${b.direction} tilt ${fmt(b.tilt, 0)}°  score ${fmt(b.score, 1)}  (left ${fmt(b.remaining, 0)}, parent +${fmt(b.createdInParent, 0)})  ${verdict}`);
      }
      lines.push(`  → ${e.decision}`, '');
    });
    if (!result.log.length) lines.push('No overhang regions above the minimum area - nothing to do.');
    return lines.join('\n');
  }

  // ------------------------------------------------------------------ //
  // Slice + G-code + collision check
  // ------------------------------------------------------------------ //
  $('sliceRun').addEventListener('click', () => {
    if (!state.seg) return toast('Load a model first.', true);
    if (!state.seg.valid) return toast('Fix the warnings in the Segments panel before slicing.', true);
    stopAnimation();
    runExclusive('sliceProgress', async (progress) => {
      const seg = state.seg;
      const settings = state.project.settings;
      const sliced = await sliceAll(seg, state.machine, settings, progress);
      let gcode = null, gcodeError = null;
      progress('Writing G-code…');
      await new Promise((r) => setTimeout(r, 0));
      try {
        gcode = generateGcode(sliced, state.machine, settings);
      } catch (err) {
        gcodeError = err.message;
      }
      const check = await checkPlan({ segmentation: seg, sliced }, state.machine, settings, progress);
      const preview = buildToolpaths(sliced);
      state.plan = { seg, sliced, gcode, gcodeError, check, ...preview, step: preview.steps.length - 1, showToolpaths: true };
      viewer.setToolpaths(preview);
      toast(check.ok && gcode ? 'Sliced - no collisions found.' : 'Sliced - see the problems listed under Slice & export.', !(check.ok && gcode));
    });
  });

  $('gcodeDownload').addEventListener('click', () => {
    const plan = state.plan;
    if (!plan?.gcode) return;
    if (!plan.check.ok && !window.confirm(`The collision check found ${plan.check.issues.length} problem(s). Download anyway?`)) return;
    const base = (state.project.demoName ?? state.project.stlName ?? 'part').replace(/\.stl$/i, '').replace(/[^\w-]+/g, '_');
    app.download(`${base}.gcode`, plan.gcode.text, 'text/plain');
  });

  /** All extrusion lines (part frame) in print order, one "step" per layer. */
  function buildToolpaths(sliced) {
    let count = 0;
    for (const sl of sliced) for (const L of sl.layers) for (const p of L.paths) count += 2 * (p.points.length - 1);
    const positions = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    const stepEnds = [], steps = [];
    let v = 0;
    sliced.forEach((sl, k) => {
      const base = app.segmentColor(sl.segmentId);
      const wall = base.map((c) => c * 0.62);
      for (const L of sl.layers) {
        let last = null;
        for (const p of L.paths) {
          const pts = p.points.map(([x, y]) => toPartFrame(sl, x, y, L.z));
          const col = p.closed ? wall : base;
          for (let i = 1; i < pts.length; i++)
            for (const q of [pts[i - 1], pts[i]]) {
              positions.set(q, v * 3);
              colors.set(col, v * 3);
              v++;
            }
          last = pts[pts.length - 1];
        }
        stepEnds.push(v);
        steps.push({ order: k, segmentId: sl.segmentId, layer: L.index, nLayers: sl.layers.length, last });
      }
    });
    return { positions, colors, stepEnds, steps };
  }

  // ------------------------------------------------------------------ //
  // Preview controls
  // ------------------------------------------------------------------ //
  $('showToolpaths').addEventListener('change', (e) => {
    if (state.plan) state.plan.showToolpaths = e.target.checked;
    app.renderAll();
  });
  $('stepSlider').addEventListener('input', (e) => {
    if (!state.plan) return;
    stopAnimation();
    state.plan.step = Number(e.target.value);
    state.plan.showToolpaths = true;
    app.renderAll();
  });

  function showStep(segmentId, layer) {
    const plan = state.plan;
    const i = plan.steps.findIndex((s) => s.segmentId === segmentId && s.layer === (layer ?? 0));
    if (i >= 0) plan.step = i;
    plan.showToolpaths = true;
    app.renderAll();
  }

  // ------------------------------------------------------------------ //
  // Machine animation: the table turns between segments, layers appear.
  // ------------------------------------------------------------------ //
  $('animPlay').addEventListener('click', () => (anim ? stopAnimation() : startAnimation()));

  function startAnimation() {
    const plan = state.plan;
    if (!plan) return;
    const timeline = [];
    let prev = { a: 0, c: 0 }, step = 0;
    for (const sl of plan.sliced) {
      const first = step, last = step + sl.layers.length - 1;
      const descend = plan.gcode?.path.find((p) => p.type === 'descend' && p.segmentId === sl.segmentId)?.machine;
      timeline.push({ kind: 'rotate', from: prev, to: sl.pose, dur: 1.4, first, descend });
      timeline.push({ kind: 'print', pose: sl.pose, dur: Math.min(5, Math.max(2, sl.layers.length * 0.025)), first, last });
      prev = sl.pose;
      step = last + 1;
    }
    anim = { timeline, start: performance.now(), total: timeline.reduce((s, p) => s + p.dur, 0) };
    $('animPlay').textContent = '■ Stop animation';
    plan.showToolpaths = true;
    viewer.setGhost(true);
    animFrame();
  }

  function stopAnimation() {
    if (!anim) return;
    cancelAnimationFrame(anim.frame);
    anim = null;
    $('animPlay').textContent = '▶ Play machine animation';
    app.renderAll();
  }

  function animFrame() {
    const t = (performance.now() - anim.start) / 1000;
    if (t >= anim.total) {
      state.plan.step = state.plan.steps.length - 1;
      return stopAnimation();
    }
    let acc = 0, phase = anim.timeline[0];
    for (const p of anim.timeline) {
      if (t < acc + p.dur) { phase = p; break; }
      acc += p.dur;
    }
    const f = (t - acc) / phase.dur;
    const pivot = state.machine.kinematics.pivot;
    const model = new HotendModel(state.machine.hotend);
    let pose, tip, step;
    if (phase.kind === 'rotate') {
      const e = f < 0.5 ? 2 * f * f : 1 - 2 * (1 - f) ** 2; // ease in/out
      pose = { a: phase.from.a + (phase.to.a - phase.from.a) * e, c: phase.from.c + (phase.to.c - phase.from.c) * e };
      step = phase.first - 1;
      // Nozzle waits above where the next segment starts (machine frame).
      const m = phase.descend ?? [0, 0, state.machine.motion.safe_z];
      tip = machineToPart(m, pose, pivot);
    } else {
      pose = phase.pose;
      step = Math.min(phase.last, phase.first + Math.floor(f * (phase.last - phase.first + 1)));
      tip = state.plan.steps[step].last;
    }
    viewer.setMachineTransform(tableRotation(pose.a, pose.c), pivot);
    viewer.setToolpathStep(step);
    viewer.setHotend({ mesh: model.toMesh(tip, toolDirectionInPart(pose)), hit: false });
    state.plan.step = Math.max(0, step);
    renderStepLabel();
    anim.frame = requestAnimationFrame(animFrame);
  }

  // ------------------------------------------------------------------ //
  // Rendering hooks
  // ------------------------------------------------------------------ //
  function renderScene() {
    const plan = state.plan;
    if (!plan) {
      viewer.setToolpaths(null);
      viewer.setMarkers('issues', null);
    } else {
      viewer.setGhost(plan.showToolpaths);
      viewer.setToolpathStep(plan.showToolpaths ? plan.step : -1);
      viewer.setMarkers('issues', plan.check.issues.map((i) => i.point).filter(Boolean));
    }
    viewer.setMarkers('remaining', (state.autoResult?.remaining ?? []).map((r) => r.centroid), 0xf59e0b, 1.3);
  }

  function renderStepLabel() {
    const plan = state.plan;
    const s = plan?.steps[plan.step];
    $('stepOut').textContent = s ? `${plan.step + 1}` : '';
    $('stepLabel').textContent = s ? `Print step ${plan.step + 1}/${plan.steps.length}: segment ${s.segmentId}, layer ${s.layer + 1} of ${s.nLayers}` : '';
  }

  function renderPanel() {
    const settings = state.project.settings;
    for (const input of settingInputs) {
      const [section, key] = input.dataset.setting.split('.');
      if (document.activeElement !== input) input.value = settings[section][key];
    }
    $('autoRun').disabled = !state.part;
    $('sliceRun').disabled = !state.part;
    $('orientReset').disabled = !state.project.baseRotation;

    // Auto-segment results
    const r = state.autoResult;
    const results = [];
    if (r) {
      results.push([`${r.cuts.length} cut(s) proposed from ${r.log.length} overhang region(s).`, r.cuts.length ? 'good' : '']);
      for (const rem of r.remaining)
        results.push([`Segment ${rem.segmentId}: ${fmt(rem.area, 0)} mm² at (${rem.centroid.map((x) => fmt(x, 0)).join(', ')}) - ${rem.message}`, 'bad']);
      if (!r.remaining.length && r.log.length) results.push(['No overhang regions left above the minimum area.', 'good']);
    }
    app.fillList($('autoResults'), results);
    $('autoLogBox').hidden = !r;
    if (r) $('autoLog').textContent = logText(r);

    // Slice results
    const plan = state.plan;
    $('previewBox').hidden = !plan;
    $('gcodeDownload').disabled = !plan?.gcode;
    const stats = [];
    const issueBox = $('issueBox');
    issueBox.replaceChildren();
    if (!plan) {
      stats.push(['Not sliced yet.', 'muted']);
    } else {
      if (plan.gcode) {
        const st = plan.gcode.stats;
        const grams = (st.filamentMm * Math.PI * (settings.slicing.filament_diameter / 2) ** 2 * PLA_DENSITY) / 1000;
        stats.push(`${st.segments} segment(s), ${st.layers} layers, ${st.rotations} table rotation(s)`);
        stats.push(`Filament ${fmt(st.filamentMm / 1000, 2)} m (≈ ${fmt(grams, 1)} g PLA), about ${Math.round(st.timeS / 60)} min`);
        stats.push(`${st.lines.toLocaleString()} lines of G-code`);
      } else {
        stats.push([`G-code not written: ${plan.gcodeError}`, 'bad']);
      }
      stats.push(plan.check.ok
        ? [`✓ No collisions (${plan.check.checkedPoints.toLocaleString()} hotend positions checked)`, 'good']
        : [`${plan.check.issues.length} collision problem(s):`, 'bad']);
      for (const issue of plan.check.issues) {
        const row = document.createElement('div');
        row.className = 'issue';
        const btn = Object.assign(document.createElement('button'), { className: 'btn small', textContent: 'Show' });
        btn.addEventListener('click', () => showStep(issue.segmentId, issue.layer));
        const text = document.createElement('span');
        text.textContent = issue.message;
        row.append(btn, text);
        issueBox.append(row);
      }
      const slider = $('stepSlider');
      slider.max = String(plan.steps.length - 1);
      if (document.activeElement !== slider) slider.value = String(plan.step);
      $('showToolpaths').checked = plan.showToolpaths;
      renderStepLabel();
    }
    app.fillList($('sliceStats'), stats);
  }

  return { renderScene, renderPanel, invalidate, isAnimating: () => Boolean(anim) };
}
