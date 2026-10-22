// Cluster–cluster aggregation on the torus (Z/LZ)^2.
//
// Sites are occupied independently with probability p (density); each occupied
// site starts as a singleton cluster and the configuration is a forest on the
// occupied sites. Every cluster with m vertices rings at rate m^(-alpha); when
// it rings it bonds to one neighbouring occupied vertex, merging the two trees:
//   directional — a direction d is chosen uniformly; then an occupied vertex
//                 w ∉ C with w − e_d ∈ C is chosen uniformly and the bond is
//                 (w − e_d, w). If there is none, C translates rigidly by e_d.
//   isotropic   — requires p = 1 (the spanning-forest case). An occupied vertex
//                 w ∉ C adjacent to C is chosen uniformly; if several vertices
//                 of C are adjacent to w, the bond is chosen uniformly among
//                 them. With no neighbour at all (C wraps the torus) the event
//                 is void.
//
// Event times are exact (Gillespie): the total rate is kept in a Fenwick tree
// so selecting a cluster costs O(log N). Clusters are labelled by the site
// index of their first vertex; `clusterAt[site]` holds the label (−1 when
// vacant) and small-to-large relabelling keeps merges cheap.
//
// Every event is recorded in a history so the process can be stepped backwards
// (undo) and forwards again (replay) along the same trajectory; fresh
// randomness is only consumed once the replay reaches the end of the history.

import { Rng } from './rng.js';

/** Lattice directions, indexed 0..3: +x, −x, +y, −y. */
export const DIRS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];
export const DIR_LABELS = ['+x', '−x', '+y', '−y'];
export const OPPOSITE = [1, 0, 3, 2];

/** Fenwick tree over per-slot rates: O(log n) update, total and sampling. */
class RateTree {
  constructor(n) {
    this.n = n;
    this.value = new Float64Array(n);
    this.tree = new Float64Array(n + 1);
    this.top = 1;
    while (this.top * 2 <= n) this.top *= 2;
  }

  set(i, v) {
    const delta = v - this.value[i];
    if (delta === 0) return;
    this.value[i] = v;
    for (let j = i + 1; j <= this.n; j += j & -j) this.tree[j] += delta;
  }

  total() {
    let s = 0;
    for (let j = this.n; j > 0; j -= j & -j) s += this.tree[j];
    return s;
  }

  /** Index i whose cumulative interval contains u ∈ [0, total). */
  sample(u) {
    let pos = 0;
    for (let step = this.top; step > 0; step >>= 1) {
      const next = pos + step;
      if (next <= this.n && this.tree[next] <= u) {
        pos = next;
        u -= this.tree[next];
      }
    }
    if (pos < this.n && this.value[pos] > 0) return pos;
    // Floating-point slack can land us on an empty slot; fall back to the last live one.
    for (let i = this.n - 1; i >= 0; i--) if (this.value[i] > 0) return i;
    return -1;
  }
}

export class Aggregation {
  /**
   * @param {object} p
   * @param {number} p.L           side length of the box
   * @param {number} p.alpha       rate exponent: a cluster of size m rings at rate m^(-alpha)
   * @param {'directional'|'isotropic'} p.sampling   (isotropic forces density 1)
   * @param {number} p.density     occupation probability p
   * @param {string|number} p.seed
   */
  constructor({ L, alpha = 1, sampling = 'directional', density = 0.3, seed = 1 }) {
    if (!Number.isInteger(L) || L < 3) throw new Error('L must be an integer ≥ 3');
    if (sampling !== 'isotropic' && sampling !== 'directional') throw new Error(`unknown sampling rule "${sampling}"`);
    this.L = L;
    this.N = L * L;
    this.alpha = alpha;
    this.sampling = sampling;
    this.density = sampling === 'isotropic' ? 1 : Math.min(1, Math.max(0, density));
    this.rng = new Rng(seed);

    this.t = 0;
    this.merges = 0;
    this.moves = 0;
    this.voidEvents = 0;

    this.clusterAt = new Int32Array(this.N).fill(-1); // cluster label per site, −1 when vacant
    this.bonds = new Uint8Array(this.N); // bit d set ⇔ bond from the site to its neighbour in direction d
    this.size = new Int32Array(this.N); // valid at cluster labels
    this.members = new Array(this.N).fill(null); // site list, valid at cluster labels
    this.rates = new RateTree(this.N);
    this.occupied = 0;
    for (let v = 0; v < this.N; v++) {
      if (this.density < 1 && this.rng.uniform() >= this.density) continue;
      this.clusterAt[v] = v;
      this.members[v] = [v];
      this.size[v] = 1;
      this.rates.set(v, 1);
      this.occupied++;
    }
    this.clusterCount = this.occupied;

    this.pendingWait = null; // waiting time already drawn for the next fresh event
    this.history = []; // every event fired so far, in order
    this.cursor = 0; // events in history[0, cursor) are currently applied
    this.stamp = new Int32Array(this.N); // scratch marks for neighbour enumeration / BFS
    this.stampId = 0;
    this.scratchBonds = new Uint8Array(this.N);
    this.bfsPrev = new Int32Array(this.N);
    this.bfsQueue = new Int32Array(this.N);
  }

  // --- lattice helpers ------------------------------------------------------

  index(x, y) {
    const L = this.L;
    return (((y % L) + L) % L) * L + (((x % L) + L) % L);
  }

  coords(v) {
    const x = v % this.L;
    return [x, (v - x) / this.L];
  }

  neighbor(v, d) {
    const L = this.L;
    const x = v % L;
    const y = (v - x) / L;
    return ((y + DIRS[d][1] + L) % L) * L + ((x + DIRS[d][0] + L) % L);
  }

  hasBond(v, d) {
    return (this.bonds[v] & (1 << d)) !== 0;
  }

  // --- clusters ---------------------------------------------------------------

  /** Label of the cluster occupying site v, or −1 when vacant. */
  find(v) {
    return this.clusterAt[v];
  }

  componentSize(v) {
    const root = this.clusterAt[v];
    return root === -1 ? 0 : this.size[root];
  }

  largestComponent() {
    let best = 0;
    for (let v = 0; v < this.N; v++) if (this.members[v] !== null && this.size[v] > best) best = this.size[v];
    return best;
  }

  /** Nothing left to merge (a lone cluster would only keep translating). */
  isDone() {
    return this.clusterCount <= 1;
  }

  // --- dynamics ---------------------------------------------------------------

  rateOf(m) {
    return Math.pow(m, -this.alpha);
  }

  /** Time of the next event (drawn once and remembered until the event fires). */
  nextEventTime() {
    if (this.cursor < this.history.length) return this.history[this.cursor].t;
    if (this.isDone()) return Infinity;
    if (this.pendingWait === null) this.pendingWait = this.rng.exponential(this.rates.total());
    return this.t + this.pendingWait;
  }

  /**
   * Fire the next event: replay it from the history if we have stepped back,
   * otherwise draw a fresh one. Returns the event, or null when done.
   */
  step() {
    if (this.cursor === this.history.length) {
      if (this.isDone()) return null;
      this.history.push(this.drawEvent());
    }
    const event = this.history[this.cursor++];
    this.apply(event);
    return event;
  }

  /** Revert the most recent applied event. Returns it, or null at the start. */
  undo() {
    if (this.cursor === 0) return null;
    const event = this.history[--this.cursor];
    this.revert(event);
    return event;
  }

  /** The most recently applied event, or null. */
  lastEvent() {
    return this.cursor === 0 ? null : this.history[this.cursor - 1];
  }

  /** Fire every event with time ≤ T. */
  runUntil(T) {
    while (this.nextEventTime() <= T) this.step();
  }

  /** Run until done, or until maxEvents more events have fired. */
  runToEnd(maxEvents = Infinity) {
    for (let i = 0; i < maxEvents && !this.isDone(); i++) this.step();
  }

  runToStart() {
    while (this.cursor > 0) this.undo();
  }

  /** Draw a fresh event from the current state (consumes randomness; does not apply it). */
  drawEvent() {
    const tBefore = this.t;
    const t = this.nextEventTime();
    this.pendingWait = null;
    const selected = this.rates.sample(this.rng.uniform() * this.rates.total());
    const base = { tBefore, t, selected, root: selected, sizeSelected: this.size[selected] };

    if (this.sampling === 'isotropic') {
      const bond = this.pickIsotropic(selected);
      return bond === null ? { type: 'void', ...base } : this.mergeEvent(base, bond);
    }
    const d = this.rng.int(4);
    const bond = this.pickDirectional(selected, d);
    if (bond !== null) return this.mergeEvent(base, bond);
    return { type: 'move', d, ...base };
  }

  mergeEvent(base, { v, w, d }) {
    const target = this.clusterAt[w];
    return { type: 'merge', ...base, target, sizeTarget: this.size[target], v, w, d, absorbed: -1 };
  }

  /** Occupied neighbour of the cluster in direction d, uniform; null if there is none. */
  pickDirectional(root, d) {
    const candidates = [];
    for (const v of this.members[root]) {
      const r = this.clusterAt[this.neighbor(v, d)];
      if (r !== root && r !== -1) candidates.push(v);
    }
    if (candidates.length === 0) return null;
    const v = candidates[this.rng.int(candidates.length)];
    return { v, w: this.neighbor(v, d), d };
  }

  pickIsotropic(root) {
    const id = ++this.stampId;
    const neighbours = [];
    for (const v of this.members[root]) {
      for (let d = 0; d < 4; d++) {
        const w = this.neighbor(v, d);
        const r = this.clusterAt[w];
        if (this.stamp[w] !== id && r !== root && r !== -1) {
          this.stamp[w] = id;
          neighbours.push(w);
        }
      }
    }
    if (neighbours.length === 0) return null;
    const w = neighbours[this.rng.int(neighbours.length)];

    const into = []; // directions from w that lead into the cluster
    for (let d = 0; d < 4; d++) if (this.clusterAt[this.neighbor(w, d)] === root) into.push(d);
    const dw = into[this.rng.int(into.length)];
    return { v: this.neighbor(w, dw), w, d: OPPOSITE[dw] };
  }

  apply(event) {
    this.t = event.t;
    switch (event.type) {
      case 'merge': this.merge(event); break;
      case 'move': this.translate(event.root, event.d); this.moves++; break;
      default: this.voidEvents++;
    }
  }

  revert(event) {
    this.t = event.tBefore;
    switch (event.type) {
      case 'merge': this.unmerge(event); break;
      case 'move': this.translate(event.root, OPPOSITE[event.d]); this.moves--; break;
      default: this.voidEvents--;
    }
  }

  /** Add the bond v–w (w in direction d from v) and merge the two clusters; records root/absorbed. */
  merge(event) {
    const { v, w, d } = event;
    this.bonds[v] |= 1 << d;
    this.bonds[w] |= 1 << OPPOSITE[d];

    let big = event.selected;
    let small = event.target;
    if (this.size[small] > this.size[big]) [big, small] = [small, big];
    const dst = this.members[big];
    const src = this.members[small];
    for (let i = 0; i < src.length; i++) {
      this.clusterAt[src[i]] = big;
      dst.push(src[i]);
    }
    this.members[small] = null;
    this.size[big] += this.size[small];
    this.rates.set(small, 0);
    this.rates.set(big, this.rateOf(this.size[big]));
    this.clusterCount--;
    this.merges++;
    event.root = big;
    event.absorbed = small;
  }

  unmerge(event) {
    const { v, w, d, root: big, absorbed: small } = event;
    this.bonds[v] &= ~(1 << d);
    this.bonds[w] &= ~(1 << OPPOSITE[d]);

    // The absorbed vertices were appended to the survivor's list, so they are exactly its tail.
    const n = this.size[small];
    const dst = this.members[big];
    const src = dst.splice(dst.length - n, n);
    for (let i = 0; i < n; i++) this.clusterAt[src[i]] = small;
    this.members[small] = src;
    this.size[big] -= n;
    this.rates.set(small, this.rateOf(n));
    this.rates.set(big, this.rateOf(this.size[big]));
    this.clusterCount++;
    this.merges--;
  }

  /** Rigidly translate a cluster by one lattice step; bonds are direction bits, so they move unchanged. */
  translate(root, d) {
    const list = this.members[root];
    const saved = this.scratchBonds;
    for (let i = 0; i < list.length; i++) {
      saved[i] = this.bonds[list[i]];
      this.bonds[list[i]] = 0;
      this.clusterAt[list[i]] = -1;
    }
    for (let i = 0; i < list.length; i++) {
      const target = this.neighbor(list[i], d);
      list[i] = target;
      this.clusterAt[target] = root;
      this.bonds[target] = saved[i];
    }
  }

  // --- queries ------------------------------------------------------------------

  /**
   * Graph distance between sites a and b in the current configuration, with
   * the unique path. Null when either is vacant or they lie in different clusters.
   */
  distance(a, b) {
    const root = this.clusterAt[a];
    if (root === -1 || root !== this.clusterAt[b]) return null;
    const id = ++this.stampId;
    const { stamp, bfsPrev: prev, bfsQueue: queue, bonds } = this;
    let head = 0;
    let tail = 0;
    queue[tail++] = a;
    stamp[a] = id;
    prev[a] = -1;
    while (head < tail) {
      const u = queue[head++];
      if (u === b) break;
      for (let d = 0; d < 4; d++) {
        if (!(bonds[u] & (1 << d))) continue;
        const w = this.neighbor(u, d);
        if (stamp[w] === id) continue;
        stamp[w] = id;
        prev[w] = u;
        queue[tail++] = w;
      }
    }
    const path = [];
    for (let u = b; u !== -1; u = prev[u]) path.push(u);
    path.reverse();
    return { dist: path.length - 1, path };
  }
}
