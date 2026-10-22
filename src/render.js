// Canvas rendering of the forest: solid "political map" view, bond-skeleton
// view, hover highlighting and the A–B path.

import { DIRS, OPPOSITE } from './model.js';
import { PALETTE, PALETTE_RGB } from './colors.js';

const BG = '#15161a';
const BORDER = 'rgba(0, 0, 0, 0.55)';
const DIM = 'rgba(22, 23, 28, 0.8)';
const SKELETON = '#ffffff';
const SKELETON_FAINT = 'rgba(255, 255, 255, 0.32)';
// The A–B path is drawn as a dark casing with a white core, so it reads on every palette colour.
const PATH_CASING = 'rgba(20, 20, 24, 0.85)';
const PATH_CORE = '#ffffff';
const POINT_A = '#ff5c8a';
const POINT_B = '#3ddc97';
const GLOW = 'rgba(255, 255, 255, 0.35)';
const GLOW_EDGE = '#ff3d9a';
const GLOW_CORE = '#ffffff';

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.layer = document.createElement('canvas'); // L×L pixels, one per cell
    this.layerCtx = this.layer.getContext('2d');
    this.L = 0;
    this.cell = 1;
  }

  /** Size the canvas so that L cells fill the available width with whole device pixels. */
  resize(L) {
    const dpr = window.devicePixelRatio || 1;
    const available = this.canvas.parentElement.clientWidth || 600;
    this.L = L;
    this.cell = Math.max(2, Math.floor((available * dpr) / L));
    const px = this.cell * L;
    this.canvas.width = px;
    this.canvas.height = px;
    this.canvas.style.width = `${px / dpr}px`;
    this.canvas.style.height = `${px / dpr}px`;
    this.layer.width = L;
    this.layer.height = L;
    this.image = this.layerCtx.createImageData(L, L);
    this.dpr = dpr; // all drawing happens in device pixels
  }

  /** Lattice cell under a mouse event, or null when outside. */
  cellAt(event) {
    const rect = this.canvas.getBoundingClientRect();
    const x = Math.floor(((event.clientX - rect.left) / rect.width) * this.L);
    const y = Math.floor(((event.clientY - rect.top) / rect.height) * this.L);
    if (x < 0 || y < 0 || x >= this.L || y >= this.L) return null;
    return [x, y];
  }

  /**
   * @param {object} view
   * @param {'solid'|'skeleton'} view.mode
   * @param {number|null} view.hoverRoot
   * @param {Array<number|null>} view.points  lattice indices of A and B
   * @param {number[]|null} view.path         A→B path, when connected
   * @param {object|null} view.lastEvent      most recent applied event (its bond is highlighted)
   */
  draw(model, colors, view) {
    const { ctx, canvas } = this;
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    if (view.mode === 'solid') this.drawSolid(model, colors, view.hoverRoot);
    else this.drawSkeleton(model, colors, view.hoverRoot);

    if (view.path) this.drawPath(model, view.path);
    if (view.lastEvent && view.lastEvent.type === 'merge') this.drawLastBond(model, view.lastEvent);
    if (view.lastEvent && view.lastEvent.type === 'move') this.drawMovedCluster(model, view.lastEvent);
    if (view.points[0] !== null) this.drawMarker(model, view.points[0], 'A', POINT_A);
    if (view.points[1] !== null) this.drawMarker(model, view.points[1], 'B', POINT_B);
  }

  drawSolid(model, colors, hoverRoot) {
    const { ctx } = this;
    this.fillCells(model, colors, null, 1);
    this.strokePath(this.borderPath(model, null, 0), BORDER, this.dpr);
    if (hoverRoot === null) return;

    ctx.fillStyle = DIM;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    this.strokePath(this.bondPath(model, null), SKELETON_FAINT, this.bondWidth());

    const [r, g, b] = PALETTE_RGB[colors.of(hoverRoot)];
    this.fillCells(model, colors, hoverRoot, 0.28);
    this.strokePath(this.borderPath(model, hoverRoot, 0), `rgb(${r}, ${g}, ${b})`, 1.5 * this.dpr);
    this.strokePath(this.bondPath(model, hoverRoot), SKELETON, this.bondWidth());
    this.fillPath(this.dotPath(model, hoverRoot), SKELETON);
  }

  drawSkeleton(model, colors, hoverRoot) {
    const inset = Math.max(0.5, this.cell * 0.08);
    const paths = this.coloredBorderPaths(model, colors, inset);
    for (let k = 0; k < paths.length; k++) {
      const [r, g, b] = PALETTE_RGB[k];
      this.strokePath(paths[k], `rgba(${r}, ${g}, ${b}, 0.5)`, this.dpr);
    }
    this.strokePath(this.bondPath(model, null), SKELETON, this.bondWidth());
    this.fillPath(this.dotPath(model, null), SKELETON);
    if (hoverRoot === null) return;

    this.fillCells(model, colors, hoverRoot, 0.3);
    this.strokePath(this.bondPath(model, hoverRoot), colors.hex(hoverRoot), this.bondWidth() * 1.4);
  }

  // --- primitives --------------------------------------------------------------

  bondWidth() {
    return Math.max(1, this.cell * 0.18);
  }

  strokePath(path, style, width) {
    const { ctx } = this;
    ctx.strokeStyle = style;
    ctx.lineWidth = width;
    ctx.lineCap = 'round';
    ctx.stroke(path);
  }

  fillPath(path, style) {
    this.ctx.fillStyle = style;
    this.ctx.fill(path);
  }

  /** Fill every cell (or only one cluster's cells) with its cluster colour at the given opacity. */
  fillCells(model, colors, onlyRoot, alpha) {
    const data = this.image.data;
    const a = Math.round(alpha * 255);
    for (let v = 0; v < model.N; v++) {
      const root = model.find(v);
      const o = v * 4;
      if (root === -1 || (onlyRoot !== null && root !== onlyRoot)) {
        data[o + 3] = 0;
        continue;
      }
      const [r, g, b] = PALETTE_RGB[colors.of(root)];
      data[o] = r;
      data[o + 1] = g;
      data[o + 2] = b;
      data[o + 3] = a;
    }
    this.layerCtx.putImageData(this.image, 0, 0);
    this.ctx.imageSmoothingEnabled = false;
    this.ctx.drawImage(this.layer, 0, 0, this.canvas.width, this.canvas.height);
  }

  /** Visit each cell side of an occupied cell that faces a different cluster or a vacant cell. */
  eachBoundarySide(model, onlyRoot, fn) {
    const L = model.L;
    for (let v = 0; v < model.N; v++) {
      const root = model.find(v);
      if (root === -1 || (onlyRoot !== null && root !== onlyRoot)) continue;
      const x = v % L;
      const y = (v - x) / L;
      for (let d = 0; d < 4; d++) {
        if (model.find(model.neighbor(v, d)) !== root) fn(x, y, d, root);
      }
    }
  }

  addSide(path, x, y, d, inset) {
    const c = this.cell;
    const x0 = x * c + inset;
    const y0 = y * c + inset;
    const x1 = (x + 1) * c - inset;
    const y1 = (y + 1) * c - inset;
    switch (d) {
      case 0: path.moveTo(x1, y0); path.lineTo(x1, y1); break;
      case 1: path.moveTo(x0, y0); path.lineTo(x0, y1); break;
      case 2: path.moveTo(x0, y1); path.lineTo(x1, y1); break;
      default: path.moveTo(x0, y0); path.lineTo(x1, y0);
    }
  }

  borderPath(model, onlyRoot, inset) {
    const path = new Path2D();
    this.eachBoundarySide(model, onlyRoot, (x, y, d) => this.addSide(path, x, y, d, inset));
    return path;
  }

  coloredBorderPaths(model, colors, inset) {
    const paths = PALETTE.map(() => new Path2D());
    this.eachBoundarySide(model, null, (x, y, d, root) => this.addSide(paths[colors.of(root)], x, y, d, inset));
    return paths;
  }

  /** Each bond as two half-segments from the cell centres, so bonds across the periodic seam draw correctly. */
  bondPath(model, onlyRoot) {
    const path = new Path2D();
    const c = this.cell;
    const h = c / 2;
    for (let v = 0; v < model.N; v++) {
      if (!model.bonds[v]) continue;
      if (onlyRoot !== null && model.find(v) !== onlyRoot) continue;
      const [x, y] = model.coords(v);
      const cx = x * c + h;
      const cy = y * c + h;
      for (let d = 0; d < 4; d++) {
        if (!model.hasBond(v, d)) continue;
        path.moveTo(cx, cy);
        path.lineTo(cx + DIRS[d][0] * h, cy + DIRS[d][1] * h);
      }
    }
    return path;
  }

  dotPath(model, onlyRoot) {
    const path = new Path2D();
    const c = this.cell;
    const r = Math.max(1, c * 0.14);
    for (let v = 0; v < model.N; v++) {
      const root = model.find(v);
      if (root === -1 || (onlyRoot !== null && root !== onlyRoot)) continue;
      const [x, y] = model.coords(v);
      path.rect(x * c + c / 2 - r, y * c + c / 2 - r, 2 * r, 2 * r);
    }
    return path;
  }

  drawPath(model, cells) {
    const path = new Path2D();
    const c = this.cell;
    const h = c / 2;
    for (let i = 0; i + 1 < cells.length; i++) {
      const d = directionBetween(model, cells[i], cells[i + 1]);
      const [x0, y0] = model.coords(cells[i]);
      const [x1, y1] = model.coords(cells[i + 1]);
      path.moveTo(x0 * c + h, y0 * c + h);
      path.lineTo(x0 * c + h + DIRS[d][0] * h, y0 * c + h + DIRS[d][1] * h);
      path.moveTo(x1 * c + h, y1 * c + h);
      path.lineTo(x1 * c + h + DIRS[OPPOSITE[d]][0] * h, y1 * c + h + DIRS[OPPOSITE[d]][1] * h);
    }
    const core = Math.max(1.5 * this.dpr, this.cell * 0.28);
    this.strokePath(path, PATH_CASING, core + 3 * this.dpr);
    this.strokePath(path, PATH_CORE, core);
  }

  /** The bond formed by the most recent event: a glowing segment with rings at both endpoints. */
  drawLastBond(model, event) {
    const c = this.cell;
    const h = c / 2;
    const dpr = this.dpr;
    const [x, y] = model.coords(event.v);
    const [x1, y1] = model.coords(event.w);
    const ends = [
      [x * c + h, y * c + h, DIRS[event.d]],
      [x1 * c + h, y1 * c + h, DIRS[OPPOSITE[event.d]]],
    ];
    // The bond may cross the periodic seam, so draw it as two half-segments from each centre.
    const bond = new Path2D();
    for (const [cx, cy, dir] of ends) {
      bond.moveTo(cx, cy);
      bond.lineTo(cx + dir[0] * c, cy + dir[1] * c);
    }
    const core = Math.max(2 * dpr, c * 0.3);
    this.strokePath(bond, GLOW, core + 10 * dpr);
    this.strokePath(bond, GLOW_EDGE, core + 4 * dpr);
    this.strokePath(bond, GLOW_CORE, core);

    const rings = new Path2D();
    const r = Math.max(5 * dpr, c * 0.6);
    for (const [cx, cy] of ends) {
      rings.moveTo(cx + r, cy);
      rings.arc(cx, cy, r, 0, 2 * Math.PI);
    }
    this.strokePath(rings, GLOW, 6 * dpr);
    this.strokePath(rings, GLOW_EDGE, 2.5 * dpr);
    this.strokePath(rings, GLOW_CORE, 1 * dpr);
  }

  /** Glowing outline of the cluster that just translated, with an arrow showing the direction. */
  drawMovedCluster(model, event) {
    const dpr = this.dpr;
    const outline = this.borderPath(model, event.root, 0);
    this.strokePath(outline, GLOW, 8 * dpr);
    this.strokePath(outline, GLOW_EDGE, 3 * dpr);
    this.strokePath(outline, GLOW_CORE, 1 * dpr);

    // arrow at the cluster's centroid (unwrapped relative to its first vertex)
    const c = this.cell;
    const L = model.L;
    const members = model.members[event.root];
    const [x0, y0] = model.coords(members[0]);
    let sx = 0;
    let sy = 0;
    for (const v of members) {
      const [x, y] = model.coords(v);
      sx += x0 + wrapDelta(x - x0, L);
      sy += y0 + wrapDelta(y - y0, L);
    }
    const cx = ((((sx / members.length) % L) + L) % L) * c + c / 2;
    const cy = ((((sy / members.length) % L) + L) % L) * c + c / 2;
    const [dx, dy] = DIRS[event.d];
    const len = Math.max(14 * dpr, c * 1.2);
    const head = len * 0.4;
    const arrow = new Path2D();
    arrow.moveTo(cx - dx * len / 2, cy - dy * len / 2);
    arrow.lineTo(cx + dx * len / 2, cy + dy * len / 2);
    arrow.moveTo(cx + dx * len / 2 - dx * head - dy * head * 0.7, cy + dy * len / 2 - dy * head - dx * head * 0.7);
    arrow.lineTo(cx + dx * len / 2, cy + dy * len / 2);
    arrow.lineTo(cx + dx * len / 2 - dx * head + dy * head * 0.7, cy + dy * len / 2 - dy * head + dx * head * 0.7);
    this.strokePath(arrow, BG, 6 * dpr);
    this.strokePath(arrow, GLOW_CORE, 2.5 * dpr);
  }

  drawMarker(model, v, label, color) {
    const { ctx, cell } = this;
    const [x, y] = model.coords(v);
    const cx = x * cell + cell / 2;
    const cy = y * cell + cell / 2;
    const r = Math.max(cell * 0.55, 7 * this.dpr);
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, 2 * Math.PI);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.lineWidth = 1.5 * this.dpr;
    ctx.strokeStyle = BG;
    ctx.stroke();
    ctx.fillStyle = BG;
    ctx.font = `700 ${Math.round(r * 1.2)}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, cx, cy + r * 0.05);
  }
}

/** Signed offset folded into (−L/2, L/2]. */
function wrapDelta(delta, L) {
  if (delta > L / 2) return delta - L;
  if (delta <= -L / 2) return delta + L;
  return delta;
}

/** Direction d such that neighbor(a, d) === b. */
function directionBetween(model, a, b) {
  for (let d = 0; d < 4; d++) if (model.neighbor(a, d) === b) return d;
  throw new Error('cells are not adjacent');
}
