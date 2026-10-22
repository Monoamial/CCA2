// Interactive visualisation: wires the model, colouring and renderer to the UI.

import { Aggregation, DIR_LABELS } from './model.js';
import { ClusterColors } from './colors.js';
import { Renderer } from './render.js';

const $ = (id) => document.getElementById(id);

const ui = {
  density: $('density'),
  densityRange: $('density-range'),
  L: $('L'),
  LRange: $('L-range'),
  alpha: $('alpha'),
  alphaRange: $('alpha-range'),
  sampling: document.querySelectorAll('input[name="sampling"]'),
  seed: $('seed'),
  randomSeed: $('random-seed'),
  reset: $('reset'),
  play: $('play'),
  back: $('back'),
  step: $('step'),
  skip: $('skip'),
  speed: $('speed'),
  speedValue: $('speed-value'),
  view: document.querySelectorAll('input[name="view"]'),
  ax: $('ax'), ay: $('ay'), bx: $('bx'), by: $('by'),
  clearPoints: $('clear-points'),
  canvas: $('lattice'),
  readTime: $('read-time'),
  readMerges: $('read-merges'),
  readClusters: $('read-clusters'),
  readLargest: $('read-largest'),
  readOccupied: $('read-occupied'),
  readMoves: $('read-moves'),
  readHover: $('read-hover'),
  readLast: $('read-last'),
  readSizeA: $('read-size-a'),
  readSizeB: $('read-size-b'),
  readDistance: $('read-distance'),
  status: $('status'),
};

const state = {
  model: null,
  colors: null,
  renderer: new Renderer(ui.canvas),
  mode: 'paused', // 'paused' | 'playing' | 'skipping'
  budget: 0, // fractional events owed to the playback clock
  colorHistory: [], // survivor's previous palette index per applied merge, for undo
  lastDensity: Number($('density').value),
  viewMode: 'solid',
  hoverRoot: null,
  points: [null, null], // particle ids of A and B (they ride along when their cluster translates)
  nextPoint: 0,
  dirty: true,
  lastFrame: 0,
};

// --- parameters ----------------------------------------------------------------

function readParams() {
  const L = clampInt(ui.L.value, 4, 300);
  const alpha = Number(ui.alpha.value) || 0;
  const sampling = [...ui.sampling].find((r) => r.checked).value;
  const seed = ui.seed.value.trim() || '1';
  // Isotropic sampling forces p = 1; remember the directional density so switching back restores it.
  let density = Math.min(1, Math.max(0, Number(ui.density.value) || 0));
  if (sampling === 'isotropic') density = 1;
  else if (ui.density.disabled) density = state.lastDensity;
  state.lastDensity = sampling === 'isotropic' ? state.lastDensity : density;
  return { L, alpha, sampling, density, seed };
}

function clampInt(value, lo, hi) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}

function speedPerSecond() {
  return Math.pow(10, Number(ui.speed.value));
}

function resetModel() {
  const params = readParams();
  state.model = new Aggregation(params);
  ui.L.value = params.L;
  ui.LRange.value = params.L;
  ui.density.value = state.model.density; // isotropic sampling forces p = 1
  ui.densityRange.value = state.model.density;
  ui.density.disabled = ui.densityRange.disabled = params.sampling === 'isotropic';
  state.colors = new ClusterColors(state.model);
  state.renderer.resize(params.L);
  state.hoverRoot = null;
  state.budget = 0;
  state.colorHistory = [];
  state.points = state.points.map((id) => (id !== null && id < state.model.N && state.model.siteOf[id] !== -1 ? id : null));
  syncPointInputs(true);
  syncPointInputs();
  setMode('paused');
  state.dirty = true;
}

// --- playback ------------------------------------------------------------------

function setMode(mode) {
  state.mode = mode;
  ui.play.textContent = mode === 'playing' ? 'Pause' : 'Play';
  ui.status.textContent = { paused: 'paused', playing: 'running', skipping: 'skipping to end…' }[mode];
  if (mode === 'paused' && state.model.isDone()) ui.status.textContent = 'all clusters merged';
}

/** Fire the next event (replayed from history or freshly drawn). */
function doStep() {
  const event = state.model.step();
  if (!event) return false;
  if (event.type === 'merge') state.colorHistory.push(state.colors.onMerge(event));
  state.dirty = true;
  return true;
}

/** Revert the most recent event. */
function doUndo() {
  const event = state.model.undo();
  if (!event) return false;
  if (event.type === 'merge') state.colors.undoMerge(event, state.colorHistory.pop());
  state.dirty = true;
  return true;
}

function frame(now) {
  const dt = Math.min((now - state.lastFrame) / 1000, 0.1);
  state.lastFrame = now;
  const model = state.model;

  if (state.mode === 'playing') {
    const speed = speedPerSecond();
    state.budget = Math.min(state.budget + speed * dt, Math.max(1, speed));
    // Deadlines use performance.now(): inside an iframe the rAF timestamp can sit on another clock.
    const deadline = performance.now() + 10;
    while (state.budget >= 1 && !model.isDone() && performance.now() < deadline) {
      doStep();
      state.budget -= 1;
    }
    if (model.isDone()) setMode('paused');
  } else if (state.mode === 'skipping') {
    const deadline = performance.now() + 14;
    while (!model.isDone() && performance.now() < deadline) doStep();
    if (model.isDone()) setMode('paused');
  }

  if (state.dirty) {
    render();
    state.dirty = false;
  }
  requestAnimationFrame(frame);
}

// --- rendering & readouts -------------------------------------------------------

function render() {
  const { model, colors } = state;
  const sites = pointSites();
  const connection = sites[0] !== null && sites[1] !== null ? model.distance(sites[0], sites[1]) : null;
  state.renderer.draw(model, colors, {
    mode: state.viewMode,
    hoverRoot: state.hoverRoot,
    points: sites,
    path: connection ? connection.path : null,
    lastEvent: model.lastEvent(),
  });
  updateReadouts(connection);
}

function updateReadouts(connection) {
  const { model } = state;
  const points = pointSites();
  syncPointInputs();
  ui.readTime.textContent = model.t.toFixed(3);
  ui.readMerges.textContent = `${model.merges} / ${Math.max(0, model.occupied - 1)}`;
  ui.readClusters.textContent = model.clusterCount;
  ui.readLargest.textContent = model.largestComponent();
  ui.readOccupied.textContent = `${model.occupied} / ${model.N}`;
  ui.readMoves.textContent = model.sampling === 'directional' ? model.moves : '—';
  ui.readHover.textContent = state.hoverRoot === null ? '—' : `${model.size[state.hoverRoot]} vertices`;
  ui.readLast.textContent = describeEvent(model, model.lastEvent());
  ui.readSizeA.textContent = points[0] === null ? '—' : model.componentSize(points[0]);
  ui.readSizeB.textContent = points[1] === null ? '—' : model.componentSize(points[1]);
  if (points[0] === null || points[1] === null) ui.readDistance.textContent = '—';
  else ui.readDistance.textContent = connection ? connection.dist : 'null';
  if (model.isDone() && state.mode === 'paused') ui.status.textContent = 'all clusters merged';
}

function describeEvent(model, event) {
  if (!event) return '—';
  const cluster = (size) => `${size}-cluster`;
  if (event.type === 'void') return `${cluster(event.sizeSelected)} rang, no neighbour in that direction`;
  if (event.type === 'move') return `${cluster(event.sizeSelected)} translated ${DIR_LABELS[event.d]}`;
  const [vx, vy] = model.coords(event.v);
  const [wx, wy] = model.coords(event.w);
  return `${cluster(event.sizeSelected)} bonded (${vx}, ${vy})–(${wx}, ${wy}) to ${cluster(event.sizeTarget)}`;
}

// --- points ------------------------------------------------------------------------
// A and B mark particles, not sites: the marker follows the vertex it was placed on.

/** Current sites of the marked particles (null when unset). */
function pointSites() {
  return state.points.map((id) => (id === null ? null : state.model.siteOf[id]));
}

/** Mark the particle at site v (ignored when v is vacant). */
function setPoint(i, v) {
  const id = state.model.particleAt[v];
  if (id === -1) return false;
  state.points[i] = id;
  syncPointInputs();
  state.dirty = true;
  return true;
}

/**
 * Keep the coordinate inputs showing where the marked particles are now. An
 * unset point leaves its inputs alone (so half-typed coordinates survive)
 * unless `clearUnset` is given.
 */
function syncPointInputs(clearUnset = false) {
  const { model } = state;
  const sites = pointSites();
  const pairs = [[ui.ax, ui.ay, sites[0]], [ui.bx, ui.by, sites[1]]];
  for (const [xi, yi, v] of pairs) {
    if (v === null && !clearUnset) continue;
    if (document.activeElement === xi || document.activeElement === yi) continue;
    const [x, y] = v === null ? ['', ''] : model.coords(v);
    if (String(xi.value) !== String(x)) xi.value = x;
    if (String(yi.value) !== String(y)) yi.value = y;
  }
}

/** Parse typed coordinates: mark the particle currently at that site; vacant or half-typed stays unset. */
function readPointInputs() {
  const parse = (xi, yi) => {
    if (xi.value === '' || yi.value === '') return null;
    const x = clampInt(xi.value, 0, state.model.L - 1);
    const y = clampInt(yi.value, 0, state.model.L - 1);
    xi.value = x;
    yi.value = y;
    const id = state.model.particleAt[state.model.index(x, y)];
    return id === -1 ? null : id;
  };
  state.points = [parse(ui.ax, ui.ay), parse(ui.bx, ui.by)];
  syncPointInputs();
  state.dirty = true;
}

// --- events ------------------------------------------------------------------------

function bindPair(number, range, onChange) {
  number.addEventListener('change', () => { range.value = number.value; onChange(); });
  range.addEventListener('input', () => { number.value = range.value; onChange(); });
}

bindPair(ui.L, ui.LRange, resetModel);
bindPair(ui.alpha, ui.alphaRange, resetModel);
bindPair(ui.density, ui.densityRange, resetModel);
ui.sampling.forEach((r) => r.addEventListener('change', resetModel));
ui.seed.addEventListener('change', resetModel);
ui.randomSeed.addEventListener('click', () => {
  ui.seed.value = String(Math.floor(Math.random() * 1e9));
  resetModel();
});
ui.reset.addEventListener('click', resetModel);

ui.play.addEventListener('click', () => {
  if (state.model.isDone()) return;
  setMode(state.mode === 'playing' ? 'paused' : 'playing');
});
ui.back.addEventListener('click', () => { setMode('paused'); doUndo(); });
ui.step.addEventListener('click', () => { setMode('paused'); doStep(); });
ui.skip.addEventListener('click', () => setMode('skipping'));
ui.speed.addEventListener('input', () => {
  ui.speedValue.textContent = formatSpeed(speedPerSecond());
});

ui.view.forEach((r) => r.addEventListener('change', () => {
  state.viewMode = [...ui.view].find((v) => v.checked).value;
  state.dirty = true;
}));

[ui.ax, ui.ay, ui.bx, ui.by].forEach((el) => el.addEventListener('change', readPointInputs));
ui.clearPoints.addEventListener('click', () => {
  state.points = [null, null];
  state.nextPoint = 0;
  syncPointInputs(true);
  state.dirty = true;
});

ui.canvas.addEventListener('mousemove', (e) => {
  const cell = state.renderer.cellAt(e);
  const found = cell ? state.model.find(state.model.index(cell[0], cell[1])) : -1;
  const root = found === -1 ? null : found;
  if (root !== state.hoverRoot) {
    state.hoverRoot = root;
    state.dirty = true;
  }
});
ui.canvas.addEventListener('mouseleave', () => {
  state.hoverRoot = null;
  state.dirty = true;
});
ui.canvas.addEventListener('click', (e) => {
  const cell = state.renderer.cellAt(e);
  if (!cell) return;
  if (setPoint(state.nextPoint, state.model.index(cell[0], cell[1]))) state.nextPoint = 1 - state.nextPoint;
});

window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  if (e.code === 'Space') { e.preventDefault(); ui.play.click(); }
  if (e.key === 'ArrowRight') ui.step.click();
  if (e.key === 'ArrowLeft') ui.back.click();
});

window.addEventListener('resize', () => {
  state.renderer.resize(state.model.L);
  state.dirty = true;
});

function formatSpeed(s) {
  return `${s >= 100 ? Math.round(s) : s.toFixed(1)} merges / s`;
}

// --- boot ----------------------------------------------------------------------------

ui.speedValue.textContent = formatSpeed(speedPerSecond());
resetModel();
requestAnimationFrame((now) => {
  state.lastFrame = now;
  frame(now);
});
