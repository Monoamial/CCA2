// Slim compute UI: parameters in; time series (with optional log axes and a
// power-law fit) and the A–B distance distribution out.

const $ = (id) => document.getElementById(id);

const ui = {
  form: $('form'),
  run: $('run'),
  cancel: $('cancel'),
  progress: $('progress'),
  progressText: $('progress-text'),
  results: $('results'),
  summary: $('summary'),
  series: $('series'),
  logX: $('log-x'),
  logY: $('log-y'),
  fit: $('fit'),
  fitFrom: $('fit-from'),
  fitTo: $('fit-to'),
  fitText: $('fit-text'),
  chart: $('chart'),
  histogram: $('histogram'),
  distanceText: $('distance-text'),
  scanLogX: $('scan-log-x'),
  scanLogY: $('scan-log-y'),
  scanFit: $('scan-fit'),
  scanText: $('scan-text'),
  scanChart: $('scan-chart'),
  csv: $('csv'),
};

const SERIES = {
  size: { label: 'E[cluster size at A]', get: (r) => r.size },
  pConnected: { label: 'P(A and B connected)', get: (r) => r.pConnected },
  pOccupied: { label: 'P(A occupied)', get: (r) => r.pOccupied, needsVacancies: true },
};

const ACCENT = '#2a9d8f';
const FIT = '#d64550';

let worker = null;
let result = null;
let params = null;

// --- parameters & worker ---------------------------------------------------------

function readParams() {
  const f = ui.form.elements;
  const num = (name) => Number(f[name].value);
  return {
    L: Math.max(3, Math.round(num('L'))),
    alpha: num('alpha'),
    sampling: f.sampling.value,
    density: f.sampling.value === 'isotropic' ? 1 : Math.min(1, Math.max(0, num('density'))),
    shots: Math.max(1, Math.round(num('shots'))),
    seed: f.seed.value.trim() || '1',
    samples: Math.max(2, Math.round(num('samples'))),
    logSpaced: f.spacing.value === 'log',
    pointA: [Math.round(num('ax')), Math.round(num('ay'))],
    pointB: [Math.round(num('bx')), Math.round(num('by'))],
  };
}

function start() {
  params = readParams();
  stop();
  worker = new Worker('src/compute-worker.js', { type: 'module' });
  worker.onmessage = (e) => {
    const msg = e.data;
    if (msg.type === 'progress') {
      ui.progress.value = msg.shot / msg.shots;
      ui.progressText.textContent = `${msg.shot} / ${msg.shots} shots`;
    } else if (msg.type === 'result') {
      result = msg;
      stop();
      showResult();
    }
  };
  worker.onerror = (e) => {
    stop();
    ui.progressText.textContent = `error: ${e.message}`;
  };
  worker.postMessage({ type: 'run', params });
  ui.run.disabled = true;
  ui.cancel.disabled = false;
  ui.progress.value = 0;
  ui.progressText.textContent = 'pilot run to pick the time horizon…';
}

function stop() {
  if (worker) worker.terminate();
  worker = null;
  ui.run.disabled = false;
  ui.cancel.disabled = true;
}

// --- results ---------------------------------------------------------------------

function showResult() {
  const { L, alpha, sampling, density, shots, pointA, pointB } = params;
  ui.results.hidden = false;
  ui.progressText.textContent = `done — ${shots} shots`;
  ui.summary.textContent =
    `p = ${density} · ${sampling} · L = ${L} · α = ${alpha} · ${shots} shots · ` +
    `A (${pointA}) → B (${pointB}) · tmax ${fmt(result.tMax)}`;
  for (const option of ui.series.options) option.hidden = !!SERIES[option.value].needsVacancies && density >= 1;
  if (ui.series.selectedOptions[0].hidden) ui.series.value = 'size';

  // Default fit window: the time grid where the mean is strictly between its extremes.
  const positive = result.series.filter((r) => r.t > 0);
  ui.fitFrom.value = fmt(positive[0].t);
  ui.fitTo.value = fmt(positive[positive.length - 1].t);
  ui.logX.checked = params.logSpaced;
  ui.logY.checked = params.logSpaced;

  drawChart();
  drawHistogram();
  drawScan();
}

/** Least-squares line through (log x, log y): y ≈ C x^β. Points are {x, v: {mean, se}}. */
function powerLawFit(points) {
  const usable = points.filter((p) => p.x > 0 && p.v.mean > 0);
  if (usable.length < 2) return null;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const p of usable) {
    const x = Math.log(p.x);
    const y = Math.log(p.v.mean);
    sx += x; sy += y; sxx += x * x; sxy += x * y;
  }
  const n = usable.length;
  const denom = n * sxx - sx * sx;
  if (denom === 0) return null;
  const beta = (n * sxy - sx * sy) / denom;
  const logC = (sy - beta * sx) / n;
  let ssRes = 0, ssTot = 0;
  const yBar = sy / n;
  for (const p of usable) {
    const y = Math.log(p.v.mean);
    ssRes += (y - logC - beta * Math.log(p.x)) ** 2;
    ssTot += (y - yBar) ** 2;
  }
  return { beta, C: Math.exp(logC), r2: ssTot > 0 ? 1 - ssRes / ssTot : 1, n, xMin: usable[0].x };
}

function fitStats(el, enabled, fit, variable) {
  if (!enabled) setStats(el, []);
  else if (!fit) setStats(el, [['fit', `needs ≥ 2 points with ${variable} > 0`]]);
  else setStats(el, [['β', fit.beta.toFixed(3)], ['C', fmt(fit.C)], ['R²', fit.r2.toFixed(3)], ['points', fit.n]]);
}

function drawChart() {
  const series = SERIES[ui.series.value];
  const fitFrom = Number(ui.fitFrom.value);
  const fitTo = Number(ui.fitTo.value);
  const pts = result.series.map((r) => ({ x: r.t, v: series.get(r) }));
  const fit = ui.fit.checked ? powerLawFit(pts.filter((p) => p.x >= fitFrom && p.x <= fitTo)) : null;
  fitStats(ui.fitText, ui.fit.checked, fit, 't');
  plotSeries(ui.chart, pts, {
    logX: ui.logX.checked,
    logY: ui.logY.checked,
    fit,
    title: `${series.label}${ui.logX.checked ? ' · log t' : ''}${ui.logY.checked ? ' · log y' : ''}`,
    markers: false,
  });
}

function drawScan() {
  const pts = result.scan.map((r) => ({ x: r.n, v: r.dist }));
  const fit = ui.scanFit.checked ? powerLawFit(pts) : null;
  if (pts.length === 0) setStats(ui.scanText, [['data', 'no pair (0, 0)–(n, 0) ever connected']]);
  else fitStats(ui.scanText, ui.scanFit.checked, fit, 'n');
  plotSeries(ui.scanChart, pts, {
    logX: ui.scanLogX.checked,
    logY: ui.scanLogY.checked,
    fit,
    title: `mean graph distance (0, 0) → (n, 0)${ui.scanLogX.checked ? ' · log n' : ''}${ui.scanLogY.checked ? ' · log D' : ''}`,
    markers: true,
  });
}

/**
 * Mean ± standard error against x, with optional log axes and a power-law
 * fit. Points are {x, v: {mean, se}}; markers draws a dot per point.
 */
function plotSeries(canvas, allPts, { logX, logY, fit, title, markers }) {
  const pts = allPts.filter((p) => (!logX || p.x > 0) && (!logY || p.v.mean > 0));
  const plot = setupCanvas(canvas);
  if (pts.length === 0) return;
  const { ctx, W, H, dpr } = plot;
  const fx = logX ? Math.log10 : (x) => x;
  const fy = logY ? Math.log10 : (y) => y;
  const xs = pts.map((p) => fx(p.x));
  const xMin = Math.min(...xs);
  const xMax = Math.max(...xs);
  const yLo = pts.map((p) => fy(logY ? Math.max(p.v.mean - p.v.se, p.v.mean / 2) : Math.max(0, p.v.mean - p.v.se)));
  const yHi = pts.map((p) => fy(p.v.mean + p.v.se));
  const yMin = logY ? Math.min(...yLo) : 0;
  const yMax = Math.max(...yHi, yMin + 1e-9);
  const pad = { l: 64 * dpr, r: 16 * dpr, t: 22 * dpr, b: 36 * dpr };
  const sx = (x) => pad.l + ((x - xMin) / (xMax - xMin || 1)) * (W - pad.l - pad.r);
  const sy = (y) => H - pad.b - ((y - yMin) / (yMax - yMin || 1)) * (H - pad.t - pad.b);

  drawAxes(plot, pad, {
    xTicks: ticks(xMin, xMax, 5).map((x) => [sx(x), fmt(logX ? 10 ** x : x)]),
    yTicks: ticks(yMin, yMax, 5).map((y) => [sy(y), fmt(logY ? 10 ** y : y)]),
    title,
  });

  // ±1 s.e. band, then the mean
  ctx.fillStyle = 'rgba(42, 157, 143, 0.18)';
  ctx.beginPath();
  pts.forEach((p, i) => ctx[i ? 'lineTo' : 'moveTo'](sx(xs[i]), sy(yHi[i])));
  for (let i = pts.length - 1; i >= 0; i--) ctx.lineTo(sx(xs[i]), sy(yLo[i]));
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = ACCENT;
  ctx.lineWidth = 1.6 * dpr;
  ctx.beginPath();
  pts.forEach((p, i) => ctx[i ? 'lineTo' : 'moveTo'](sx(xs[i]), sy(fy(p.v.mean))));
  ctx.stroke();
  if (markers) {
    ctx.fillStyle = ACCENT;
    for (let i = 0; i < pts.length; i++) {
      ctx.beginPath();
      ctx.arc(sx(xs[i]), sy(fy(pts[i].v.mean)), 3 * dpr, 0, 2 * Math.PI);
      ctx.fill();
    }
  }

  if (fit) {
    ctx.strokeStyle = FIT;
    ctx.lineWidth = 1.4 * dpr;
    ctx.setLineDash([6 * dpr, 4 * dpr]);
    ctx.beginPath();
    const xLo = pts[0].x > 0 ? pts[0].x : fit.xMin;
    const xHi = pts[pts.length - 1].x;
    const steps = 80;
    let started = false;
    for (let i = 0; i <= steps; i++) {
      const x = logX ? xLo * Math.pow(xHi / xLo, i / steps) : xLo + ((xHi - xLo) * i) / steps;
      const py = sy(fy(fit.C * Math.pow(x, fit.beta)));
      if (py < pad.t - 2 * dpr) continue;
      ctx[started ? 'lineTo' : 'moveTo'](sx(fx(x)), py);
      started = true;
    }
    ctx.stroke();
    ctx.setLineDash([]);
  }
}

function drawHistogram() {
  const { histogram, stats, median, connectedShots: n, contactTime } = result.distance;
  const [ax, ay] = params.pointA;
  const [bx, by] = params.pointB;
  const L = params.L;
  const torusDist = Math.min(mod(ax - bx, L), mod(bx - ax, L)) + Math.min(mod(ay - by, L), mod(by - ay, L));
  const plot = setupCanvas(ui.histogram);
  if (n === 0) {
    setStats(ui.distanceText, [['connected', `0 / ${params.shots} shots`], ['ℓ¹(A, B)', torusDist]]);
    return;
  }

  // Prune the domain to the bulk of the mass; the tail is reported as a number.
  const cutoff = Math.max(quantile(histogram, n, 0.9), Math.min(histogram.length - 1, torusDist + 2));
  let tail = 0;
  for (let d = cutoff + 1; d < histogram.length; d++) tail += histogram[d];
  const chips = [
    ['connected', `${n} / ${params.shots} shots`],
    ['mean', `${fmt(stats.mean)} ± ${fmt(stats.se)}`],
    ['median', median],
    ['ℓ¹(A, B)', torusDist],
    ['contact time', `${fmt(contactTime.mean)} ± ${fmt(contactTime.se)}`],
  ];
  if (tail > 0) chips.push([`beyond ${cutoff}`, `${(100 * tail / n).toFixed(1)}%`]);
  setStats(ui.distanceText, chips);

  const bins = cutoff + 1;
  const probs = histogram.slice(0, bins).map((c) => c / n);
  const curve = smoothDensity(histogram, n, cutoff);
  const pMax = Math.max(...probs, ...curve.map((p) => p.y)) || 1;

  const { ctx, W, H, dpr } = plot;
  const pad = { l: 64 * dpr, r: 16 * dpr, t: 22 * dpr, b: 36 * dpr };
  const bw = (W - pad.l - pad.r) / bins;
  const sx = (d) => pad.l + (d + 0.5) * bw; // centre of integer bin d
  const sy = (p) => H - pad.b - (p / pMax) * (H - pad.t - pad.b);

  const xStep = niceStep(bins / 8);
  const xTicks = [];
  for (let d = 0; d < bins; d += xStep) xTicks.push([sx(d), String(d)]);
  drawAxes(plot, pad, {
    xTicks,
    yTicks: ticks(0, pMax, 4).map((p) => [sy(p), fmt(p)]),
    title: 'Graph distance A–B at first connection · fraction of connecting shots',
  });

  ctx.fillStyle = 'rgba(42, 157, 143, 0.28)';
  for (let d = 0; d < bins; d++) {
    const top = sy(probs[d]);
    ctx.fillRect(pad.l + d * bw + 0.5 * dpr, top, Math.max(1, bw - 1 * dpr), H - pad.b - top);
  }
  ctx.strokeStyle = ACCENT;
  ctx.lineWidth = 2 * dpr;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  curve.forEach((p, i) => ctx[i ? 'lineTo' : 'moveTo'](sx(p.x), sy(p.y)));
  ctx.stroke();

  const mx = sx(stats.mean);
  ctx.strokeStyle = FIT;
  ctx.lineWidth = 1.2 * dpr;
  ctx.setLineDash([4 * dpr, 4 * dpr]);
  ctx.beginPath();
  ctx.moveTo(mx, pad.t);
  ctx.lineTo(mx, H - pad.b);
  ctx.stroke();
  ctx.setLineDash([]);
}

/**
 * Gaussian kernel density estimate of the integer-valued distance, evaluated on
 * a fine grid over [0, cutoff] and scaled to the bars: the lattice is
 * bipartite, so when A and B have fixed parity only every other distance can
 * occur and the envelope is scaled by that spacing to match the bar heights.
 * Bandwidth: a robust spread (from the pruned bulk, so the tail does not
 * inflate it) shrunk with n, floored so the envelope bridges the parity gaps.
 */
function smoothDensity(histogram, n, cutoff) {
  let spacing = 0;
  let first = -1;
  histogram.forEach((c, d) => {
    if (!c) return;
    if (first === -1) first = d;
    else spacing = gcd(spacing, d - first);
  });
  spacing = spacing || 1;

  let bulk = 0;
  let sum = 0;
  let sumSq = 0;
  for (let d = 0; d <= cutoff; d++) { bulk += histogram[d]; sum += histogram[d] * d; sumSq += histogram[d] * d * d; }
  const mean = sum / bulk;
  const sd = Math.sqrt(Math.max(0, sumSq / bulk - mean * mean));
  const iqr = quantile(histogram, bulk, 0.75) - quantile(histogram, bulk, 0.25);
  const spread = Math.min(sd, iqr / 1.34) || sd || spacing;
  const h = Math.max(0.75 * spacing, 0.6 * spread * Math.pow(n, -1 / 3));

  const points = [];
  const steps = 240;
  for (let i = 0; i <= steps; i++) {
    const x = (cutoff * i) / steps;
    let y = 0;
    for (let d = 0; d < histogram.length; d++) {
      if (!histogram[d]) continue;
      const z = (x - d) / h;
      if (Math.abs(z) > 5) continue;
      y += histogram[d] * Math.exp(-0.5 * z * z);
    }
    points.push({ x, y: (spacing * y) / (n * h * Math.sqrt(2 * Math.PI)) });
  }
  return points;
}

function gcd(a, b) {
  while (b) [a, b] = [b, a % b];
  return a;
}

/** Render label/value pairs as a compact stat strip. */
function setStats(el, pairs) {
  el.replaceChildren(...pairs.map(([label, value]) => {
    const chip = document.createElement('span');
    chip.className = 'stat';
    const k = document.createElement('span');
    k.className = 'stat-label';
    k.textContent = label;
    const v = document.createElement('span');
    v.className = 'stat-value';
    v.textContent = String(value);
    chip.append(k, v);
    return chip;
  }));
}

function niceStep(raw) {
  const mag = Math.pow(10, Math.floor(Math.log10(Math.max(raw, 1))));
  for (const m of [1, 2, 5, 10]) if (m * mag >= raw) return m * mag;
  return 10 * mag;
}

function quantile(histogram, n, q) {
  let cum = 0;
  for (let d = 0; d < histogram.length; d++) {
    cum += histogram[d];
    if (cum >= q * n) return d;
  }
  return histogram.length - 1;
}

// --- plotting helpers ---------------------------------------------------------------

function setupCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.clientWidth * dpr;
  const H = canvas.clientHeight * dpr;
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, W, H);
  return { ctx, W, H, dpr };
}

function drawAxes({ ctx, W, H, dpr }, pad, { xTicks, yTicks, title }) {
  ctx.strokeStyle = '#999';
  ctx.lineWidth = dpr;
  ctx.beginPath();
  ctx.moveTo(pad.l, pad.t); ctx.lineTo(pad.l, H - pad.b); ctx.lineTo(W - pad.r, H - pad.b);
  ctx.stroke();
  ctx.fillStyle = '#555';
  ctx.font = `${11 * dpr}px ui-monospace, monospace`;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (const [y, label] of yTicks) ctx.fillText(label, pad.l - 6 * dpr, y);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (const [x, label] of xTicks) ctx.fillText(label, x, H - pad.b + 6 * dpr);
  ctx.textAlign = 'left';
  ctx.fillText(title, pad.l, 4 * dpr);
}

function ticks(lo, hi, count) {
  const out = [];
  for (let i = 0; i <= count; i++) out.push(lo + ((hi - lo) * i) / count);
  return out;
}

function mod(a, L) {
  return ((a % L) + L) % L;
}

function fmt(x) {
  if (Number.isInteger(x)) return String(x);
  const a = Math.abs(x);
  if (a >= 1000) return x.toFixed(0);
  if (a >= 10) return x.toFixed(2);
  if (a >= 0.01) return x.toFixed(3);
  return x.toExponential(2);
}

function toCsv() {
  const lines = [`# ${ui.summary.textContent}`, 't,size_A_mean,size_A_se,p_connected,p_connected_se,p_A_occupied'];
  for (const r of result.series) lines.push([r.t, r.size.mean, r.size.se, r.pConnected.mean, r.pConnected.se, r.pOccupied.mean].join(','));
  lines.push('', `# distance at first connection (${result.distance.connectedShots} connecting shots)`, 'distance,count');
  result.distance.histogram.forEach((c, d) => lines.push(`${d},${c}`));
  lines.push('', '# mean graph distance (0,0)-(n,0) at first connection', 'n,dist_mean,dist_se,shots');
  for (const r of result.scan) lines.push([r.n, r.dist.mean, r.dist.se, r.count].join(','));
  return `${lines.join('\n')}\n`;
}

// --- events -----------------------------------------------------------------------------

ui.form.addEventListener('submit', (e) => {
  e.preventDefault();
  start();
});
/** Isotropic sampling is the spanning-forest case: it forces p = 1. */
function syncDensityControl() {
  const f = ui.form.elements;
  const isotropic = f.sampling.value === 'isotropic';
  if (isotropic) f.density.value = 1;
  f.density.disabled = isotropic;
}
for (const r of ui.form.elements.sampling) r.addEventListener('change', syncDensityControl);
syncDensityControl();
ui.cancel.addEventListener('click', () => {
  stop();
  ui.progressText.textContent = 'cancelled';
});
[ui.series, ui.logX, ui.logY, ui.fit, ui.fitFrom, ui.fitTo].forEach((el) => el.addEventListener('change', drawChart));
[ui.scanLogX, ui.scanLogY, ui.scanFit].forEach((el) => el.addEventListener('change', drawScan));
window.addEventListener('resize', () => {
  if (!result) return;
  drawChart();
  drawHistogram();
  drawScan();
});
ui.csv.addEventListener('click', () => {
  const url = URL.createObjectURL(new Blob([toCsv()], { type: 'text/csv' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `cca_L${params.L}_alpha${params.alpha}_${params.sampling}_${params.shots}shots.csv`;
  a.click();
  URL.revokeObjectURL(url);
});
