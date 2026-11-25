/**
 * Projects: which model + the list of cuts, saved as a JSON file.
 *
 * Because this is a web app, a project can't point at a file on your disk.
 * Instead an uploaded STL is stored INSIDE the project file (as base64 text),
 * so one .json file is everything needed to reopen the work. Demo parts are
 * stored by name.
 *
 * Example:
 *   {
 *     "app": "RDH5AxisSlicer", "version": 2,
 *     "model": { "demo": "T-shape" },          // or { "stl_name": "x.stl", "stl_base64": "..." }
 *     "place_on_bed": true,
 *     "overhang_angle_deg": 50,
 *     "cuts": [ { "name": "", "point": [5,0,34], "normal": [1,0,0], "local": false, "components": null } ]
 *   }
 */

import { DEMO_MODELS } from './demoModels.js';
import { arrayBufferToBase64, base64ToArrayBuffer, parseSTL, placeOnBed } from './meshIO.js';
import { Cut } from './segments.js';

export const PROJECT_VERSION = 2;

export class Project {
  constructor({ demoName = null, stlName = null, stlBuffer = null, placeOnBed = true, overhangAngleDeg = 50, cuts = [] } = {}) {
    this.demoName = demoName;   // name in DEMO_MODELS, or null
    this.stlName = stlName;     // original file name of an uploaded STL
    this.stlBuffer = stlBuffer; // raw STL bytes (ArrayBuffer)
    this.placeOnBed = placeOnBed;
    this.overhangAngleDeg = overhangAngleDeg;
    this.cuts = cuts;
  }

  /** Human-readable name of the model. */
  get modelLabel() {
    return this.demoName ? `demo: ${this.demoName}` : (this.stlName ?? 'no model');
  }

  /** Build (or parse) the part this project refers to, placed per settings. */
  loadPart(machine) {
    let mesh;
    if (this.demoName) {
      if (!(this.demoName in DEMO_MODELS)) throw new Error(`Unknown demo model '${this.demoName}'`);
      mesh = DEMO_MODELS[this.demoName]();
    } else if (this.stlBuffer) {
      mesh = parseSTL(this.stlBuffer);
    } else {
      throw new Error('Project has no model');
    }
    return this.placeOnBed ? placeOnBed(mesh, machine) : mesh;
  }

  /** JSON text for saving. */
  serialize() {
    const model = this.demoName
      ? { demo: this.demoName }
      : { stl_name: this.stlName, stl_base64: arrayBufferToBase64(this.stlBuffer) };
    return JSON.stringify(
      {
        app: 'RDH5AxisSlicer',
        version: PROJECT_VERSION,
        model,
        place_on_bed: this.placeOnBed,
        overhang_angle_deg: this.overhangAngleDeg,
        cuts: this.cuts.map((c) => c.toJSON()),
      },
      null,
      2,
    );
  }

  /** Read a project from JSON text. */
  static parse(text) {
    const data = JSON.parse(text);
    if ((data.version ?? 1) > PROJECT_VERSION) throw new Error('This project was saved by a newer version of the slicer');
    const model = data.model ?? {};
    if (!model.demo && !model.stl_base64) throw new Error('Project file has no model in it');
    return new Project({
      demoName: model.demo ?? null,
      stlName: model.stl_name ?? null,
      stlBuffer: model.stl_base64 ? base64ToArrayBuffer(model.stl_base64) : null,
      placeOnBed: data.place_on_bed ?? true,
      overhangAngleDeg: Number(data.overhang_angle_deg ?? 50),
      cuts: (data.cuts ?? []).map(Cut.fromJSON),
    });
  }
}
