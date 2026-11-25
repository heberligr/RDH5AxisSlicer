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
import { machineToPart, partToMachine, tableRotation, toCommanded, toolDirectionInPart } from '../core/kinematics.js';
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
        let last = null, first = null;
        for (const p of L.paths) {
          const pts = p.points.map(([x, y]) => toPartFrame(sl, x, y, L.z));
          const col = p.closed ? wall : base;
          for (let i = 1; i < pts.length; i++)
            for (const q of [pts[i - 1], pts[i]]) {
              positions.set(q, v * 3);
              colors.set(col, v * 3);
              v++;
            }
          first ??= pts[0];
          last = pts[pts.length - 1];
        }
        stepEnds.push(v);
        steps.push({ order: k, segmentId: sl.segmentId, layer: L.index, nLayers: sl.layers.length, first, last });
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
  // Machine animation: every segment in order. Between segments the nozzle
  // lifts, the machine PAUSES, the table tilts, PAUSES again (locked), the
  // nozzle travels over and comes down, then the layers are printed.
  // ------------------------------------------------------------------ //
  $('animPlay').addEventListener('click', () => (anim ? stopAnimation() : startAnimation()));

  const lerp3 = (a, b, t) => a.map((x, i) => x + (b[i] - x) * t);

  /**
   * A point from print step i: its first or last point. A layer can be empty
   * (e.g. the very top slice of a segment), so look at neighbouring steps of
   * the same segment until one has toolpaths.
   */
  function stepPoint(i, which, from = 0, to = Infinity) {
    const steps = state.plan.steps;
    const dir = which === 'first' ? 1 : -1;
    for (let j = i; j >= from && j <= Math.min(to, steps.length - 1); j += dir) if (steps[j][which]) return steps[j][which];
    for (let j = i; j >= from && j <= Math.min(to, steps.length - 1); j -= dir) if (steps[j][which === 'first' ? 'last' : 'first']) return steps[j][which === 'first' ? 'last' : 'first'];
    return null;
  }
  const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) ** 2);
  const angle = (x) => `${fmt(x, 1)}°`;

  /** Build the list of phases. Each phase knows its duration and what to show. */
  function buildTimeline(plan) {
    const k = state.machine.kinematics;
    const pivot = k.pivot;
    const path = plan.gcode?.path ?? [];
    const toMachine = (sl, partPoint) => partToMachine(partPoint, sl.pose, pivot);
    // "Safe" height for the picture: high enough to clear everything, but not
    // the real safe Z (often far above, which would put the nozzle off screen).
    let top = -Infinity;
    for (const sl of plan.sliced)
      for (const s of plan.seg.segments)
        for (let v = 0; v < s.mesh.numVerts; v += 3) top = Math.max(top, partToMachine(s.mesh.vertex(v), sl.pose, pivot)[2]);
    const safeZ = Math.min(state.machine.motion.safe_z, top + state.machine.hotend.cylinder_start + 15);

    const phases = [];
    let prevPose = { a: 0, c: 0 }, step = 0;
    let nozzle = null; // machine-frame nozzle position
    const total = plan.sliced.length;
    plan.sliced.forEach((sl, n) => {
      const first = step, last = step + sl.layers.length - 1;
      const firstPoint = toMachine(sl, stepPoint(first, 'first', first, last));
      const descend = path.find((p) => p.type === 'descend' && p.segmentId === sl.segmentId)?.machine
        ?? [firstPoint[0], firstPoint[1], firstPoint[2] + 10];
      const cmd = toCommanded(sl.pose, state.machine), prevCmd = toCommanded(prevPose, state.machine);
      const label = `Segment ${sl.segmentId} (${n + 1} of ${total})`;
      const turn = Math.max(Math.abs(sl.pose.a - prevPose.a), Math.abs(sl.pose.c - prevPose.c));
      if (!nozzle) nozzle = [descend[0], descend[1], safeZ];
      const up = [nozzle[0], nozzle[1], safeZ];

      if (n > 0) phases.push({ kind: 'move', pose: prevPose, from: nozzle, to: up, dur: 0.8, step: first - 1,
        caption: `Segment ${plan.sliced[n - 1].segmentId} done - retract and lift the nozzle to safe Z` });
      if (turn > 0.01) {
        phases.push({ kind: 'move', pose: prevPose, from: up, to: up, dur: 1.0, step: first - 1, pause: true,
          caption: `⏸ Pause - next: ${label}. Tilting the table to ${k.a_axis.letter}${angle(cmd.a)} ${k.c_axis.letter}${angle(cmd.c)}` });
        phases.push({ kind: 'rotate', from: prevPose, to: sl.pose, at: up, dur: Math.max(1.6, turn / 40), step: first - 1,
          caption: `↻ Tilting: ${k.a_axis.letter} ${angle(prevCmd.a)} → ${angle(cmd.a)},  ${k.c_axis.letter} ${angle(prevCmd.c)} → ${angle(cmd.c)}` });
        phases.push({ kind: 'move', pose: sl.pose, from: up, to: up, dur: 1.0, step: first - 1, pause: true,
          caption: `⏸ Table locked at ${k.a_axis.letter}${angle(cmd.a)} ${k.c_axis.letter}${angle(cmd.c)} - rotary axes stay still while ${label.toLowerCase()} prints` });
      } else {
        phases.push({ kind: 'move', pose: sl.pose, from: up, to: up, dur: 1.2, step: first - 1, pause: true,
          caption: `⏸ ${label}: table stays at ${k.a_axis.letter}${angle(cmd.a)} ${k.c_axis.letter}${angle(cmd.c)}` });
      }
      const above = [descend[0], descend[1], safeZ];
      phases.push({ kind: 'move', pose: sl.pose, from: up, to: above, dur: 0.6, step: first - 1, caption: `${label}: travel above the start point` });
      phases.push({ kind: 'move', pose: sl.pose, from: above, to: firstPoint, dur: 0.7, step: first - 1, caption: `${label}: lower the nozzle and unretract` });
      phases.push({ kind: 'print', pose: sl.pose, first, last, dur: Math.min(7, Math.max(3, sl.layers.length * 0.03)),
        caption: (layer) => `▶ Printing ${label.toLowerCase()} - layer ${layer} of ${sl.layers.length} (pure X Y Z E moves)` });
      nozzle = toMachine(sl, stepPoint(last, 'last', first, last));
      prevPose = sl.pose;
      step = last + 1;
    });
    phases.push({ kind: 'move', pose: prevPose, from: nozzle, to: [nozzle[0], nozzle[1], safeZ], dur: 2.0, step: step - 1,
      caption: `✓ Done - ${total} segment(s), ${plan.gcode?.stats.rotations ?? total} table position(s)` });
    return phases;
  }

  function startAnimation() {
    const plan = state.plan;
    if (!plan) return;
    const timeline = buildTimeline(plan);
    anim = { timeline, t: 0, last: performance.now(), total: timeline.reduce((s, p) => s + p.dur, 0) };
    $('animPlay').textContent = '■ Stop animation';
    $('animCaption').hidden = false;
    plan.showToolpaths = true;
    viewer.setGhost(true);
    viewer.setTableGhost(true);
    animFrame();
  }

  function stopAnimation() {
    if (!anim) return;
    cancelAnimationFrame(anim.frame);
    anim = null;
    $('animPlay').textContent = '▶ Play machine animation';
    $('animCaption').hidden = true;
    viewer.setTableGhost(false);
    app.renderAll();
  }

  function animFrame() {
    // Advance time by the real time since the last frame x the chosen speed.
    const now = performance.now();
    anim.t += ((now - anim.last) / 1000) * Number($('animSpeed').value);
    anim.last = now;
    if (anim.t >= anim.total) {
      state.plan.step = state.plan.steps.length - 1;
      return stopAnimation();
    }
    let acc = 0, index = 0;
    while (index < anim.timeline.length - 1 && anim.t >= acc + anim.timeline[index].dur) acc += anim.timeline[index++].dur;
    const phase = anim.timeline[index];
    const f = Math.min(1, (anim.t - acc) / phase.dur);
    const pivot = state.machine.kinematics.pivot;

    let pose, tip, step, caption = phase.caption;
    if (phase.kind === 'rotate') {
      const e = easeInOut(f);
      pose = { a: phase.from.a + (phase.to.a - phase.from.a) * e, c: phase.from.c + (phase.to.c - phase.from.c) * e };
      tip = machineToPart(phase.at, pose, pivot); // nozzle waits at safe Z
      step = phase.step;
    } else if (phase.kind === 'move') {
      pose = phase.pose;
      tip = machineToPart(lerp3(phase.from, phase.to, easeInOut(f)), pose, pivot);
      step = phase.step;
    } else {
      pose = phase.pose;
      step = Math.min(phase.last, phase.first + Math.floor(f * (phase.last - phase.first + 1)));
      tip = stepPoint(step, 'last', phase.first, phase.last);
      caption = phase.caption(step - phase.first + 1);
    }
    viewer.setMachineTransform(tableRotation(pose.a, pose.c), pivot);
    viewer.setToolpathStep(step);
    viewer.setHotend({ mesh: new HotendModel(state.machine.hotend).toMesh(tip, toolDirectionInPart(pose)), hit: false });
    $('animCaptionText').textContent = caption;
    $('animCaption').classList.toggle('paused', Boolean(phase.pause));
    $('animProgress').style.width = `${(100 * anim.t) / anim.total}%`;
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
