// Multi-shot Monte Carlo of the aggregation model, run off the main thread.
//
// Per shot the process is driven event by event. The time series are sampled
// on a fixed grid up to a horizon tMax (the time at which a pilot shot reaches
// a single cluster); the shot then keeps running until it reaches a single
// cluster itself, so that first-contact quantities are not cut off by the
// horizon. We record:
//   - on the time grid: cluster size at A, whether A and B are connected,
//     whether A is occupied;
//   - the graph distance between A and B at the first moment they become
//     connected (for p = 1 the tree path never changes afterwards);
//   - the same first-contact distance between (0, 0) and (n, 0) for every
//     n = 1 … ⌊L/2⌋, to see how distance grows with separation.

import { Aggregation } from './model.js';

const EVENT_CAP = 20_000_000; // safety cap per shot

self.onmessage = (e) => {
  if (e.data.type === 'run') run(e.data.params);
};

function run(p) {
  const base = { L: p.L, alpha: p.alpha, sampling: p.sampling, density: p.density };
  const pointA = indexOf(p.L, p.pointA);
  const pointB = indexOf(p.L, p.pointB);
  const nMax = Math.floor(p.L / 2);
  const scanSites = [];
  for (let n = 0; n <= nMax; n++) scanSites.push(indexOf(p.L, [n, 0]));

  const pilot = new Aggregation({ ...base, seed: `${p.seed}:pilot` });
  pilot.runToEnd(EVENT_CAP);
  const tMax = pilot.t > 0 ? pilot.t : 1;
  const grid = makeGrid(tMax, p.samples, p.logSpaced);
  const K = grid.length;

  const size = new Float64Array(K);
  const size2 = new Float64Array(K);
  const connected = new Float64Array(K);
  const occupiedA = new Float64Array(K);
  const distances = []; // A–B first-contact distance, one per shot that connects before tMax
  const contactTimes = [];
  const scanSum = new Float64Array(nMax + 1);
  const scanSum2 = new Float64Array(nMax + 1);
  const scanCount = new Int32Array(nMax + 1);

  let lastReport = 0;
  for (let shot = 0; shot < p.shots; shot++) {
    const model = new Aggregation({ ...base, seed: `${p.seed}:${shot}` });
    let contact = null;
    const scanDist = new Int32Array(nMax + 1).fill(-1);
    let unresolved = nMax;

    const checkContacts = () => {
      if (contact === null) {
        const r = model.find(pointA);
        if (r !== -1 && r === model.find(pointB)) contact = { t: model.t, dist: model.distance(pointA, pointB).dist };
      }
      if (unresolved === 0) return;
      const r0 = model.find(scanSites[0]);
      if (r0 === -1) return;
      for (let n = 1; n <= nMax; n++) {
        if (scanDist[n] !== -1 || model.find(scanSites[n]) !== r0) continue;
        scanDist[n] = model.distance(scanSites[0], scanSites[n]).dist;
        unresolved--;
      }
    };

    checkContacts();
    for (let k = 0; k < K; k++) {
      while (model.nextEventTime() <= grid[k]) {
        model.step();
        checkContacts();
      }
      const s = model.componentSize(pointA);
      size[k] += s;
      size2[k] += s * s;
      if (s > 0) occupiedA[k] += 1;
      if (s > 0 && model.find(pointA) === model.find(pointB)) connected[k] += 1;
    }
    // Finish the shot so first contacts are not truncated by the horizon.
    for (let i = 0; i < EVENT_CAP && !model.isDone() && (contact === null || unresolved > 0); i++) {
      model.step();
      checkContacts();
    }
    if (contact !== null) {
      distances.push(contact.dist);
      contactTimes.push(contact.t);
    }
    for (let n = 1; n <= nMax; n++) {
      if (scanDist[n] === -1) continue;
      scanSum[n] += scanDist[n];
      scanSum2[n] += scanDist[n] * scanDist[n];
      scanCount[n]++;
    }

    const now = performance.now();
    if (now - lastReport > 100 || shot === p.shots - 1) {
      lastReport = now;
      self.postMessage({ type: 'progress', shot: shot + 1, shots: p.shots });
    }
  }

  const shots = p.shots;
  const series = [];
  for (let k = 0; k < K; k++) {
    series.push({
      t: grid[k],
      size: meanSe(size[k], size2[k], shots),
      pConnected: meanSe(connected[k], connected[k], shots),
      pOccupied: meanSe(occupiedA[k], occupiedA[k], shots),
    });
  }

  const maxDist = distances.reduce((m, d) => Math.max(m, d), 0);
  const histogram = new Array(maxDist + 1).fill(0);
  let dSum = 0;
  let dSum2 = 0;
  for (const d of distances) {
    histogram[d]++;
    dSum += d;
    dSum2 += d * d;
  }
  const m = distances.length;
  let tSum = 0;
  let tSum2 = 0;
  for (const t of contactTimes) { tSum += t; tSum2 += t * t; }

  const scan = [];
  for (let n = 1; n <= nMax; n++) {
    if (scanCount[n] === 0) continue;
    scan.push({ n, count: scanCount[n], dist: meanSe(scanSum[n], scanSum2[n], scanCount[n]) });
  }

  self.postMessage({
    type: 'result',
    tMax,
    series,
    distance: {
      histogram,
      connectedShots: m,
      stats: m > 0 ? meanSe(dSum, dSum2, m) : null,
      median: m > 0 ? quantile(histogram, m, 0.5) : null,
      contactTime: m > 0 ? meanSe(tSum, tSum2, m) : null,
    },
    scan,
  });
}

function indexOf(L, [x, y]) {
  return (((y % L) + L) % L) * L + (((x % L) + L) % L);
}

function makeGrid(tMax, samples, logSpaced) {
  const grid = [];
  if (logSpaced) {
    const tMin = tMax * 1e-3;
    for (let k = 0; k < samples; k++) grid.push(tMin * Math.pow(tMax / tMin, k / (samples - 1)));
  } else {
    for (let k = 0; k < samples; k++) grid.push((tMax * k) / (samples - 1));
  }
  return grid;
}

function meanSe(sum, sumSq, n) {
  const mean = sum / n;
  const variance = n > 1 ? Math.max(0, (sumSq - n * mean * mean) / (n - 1)) : 0;
  return { mean, se: Math.sqrt(variance / n) };
}

function quantile(histogram, n, q) {
  let cum = 0;
  for (let d = 0; d < histogram.length; d++) {
    cum += histogram[d];
    if (cum >= q * n) return d;
  }
  return histogram.length - 1;
}
