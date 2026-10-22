// Map-style colouring of clusters: each cluster keeps one palette colour, and
// when two clusters merge the result is recoloured only if its colour collides
// with a neighbouring cluster. Borders are drawn separately, so an occasional
// collision is harmless.

export const PALETTE = [
  '#d64550', '#e8871e', '#e9c46a', '#8ab17d', '#2a9d8f', '#4c9be8',
  '#7a6ff0', '#c76bb3', '#a0714f', '#6fc3df', '#b5c959', '#f28cb1',
];

export const PALETTE_RGB = PALETTE.map((hex) => [
  parseInt(hex.slice(1, 3), 16),
  parseInt(hex.slice(3, 5), 16),
  parseInt(hex.slice(5, 7), 16),
]);

export class ClusterColors {
  constructor(model) {
    this.model = model;
    this.index = new Uint8Array(model.N); // palette index, valid at cluster roots
    for (let v = 0; v < model.N; v++) this.index[v] = scramble(v) % PALETTE.length;
    this.counts = new Int32Array(PALETTE.length);
  }

  /** Palette index of the cluster with the given root. */
  of(root) {
    return this.index[root];
  }

  hex(root) {
    return PALETTE[this.index[root]];
  }

  /**
   * Called after a merge event; keeps the surviving colour unless it now
   * clashes. Returns the survivor's previous palette index so the merge can be
   * undone with undoMerge().
   */
  onMerge(event) {
    const { model, counts, index } = this;
    const root = event.root;
    const previous = index[root];
    counts.fill(0);
    for (const v of model.members[root]) {
      for (let d = 0; d < 4; d++) {
        const r = model.find(model.neighbor(v, d));
        if (r !== root && r !== -1) counts[index[r]]++;
      }
    }
    if (counts[index[root]] === 0) return previous;
    if (counts[index[event.absorbed]] === 0) {
      index[root] = index[event.absorbed];
      return previous;
    }
    let best = 0;
    for (let k = 1; k < counts.length; k++) if (counts[k] < counts[best]) best = k;
    index[root] = best;
    return previous;
  }

  /** Restore the survivor's colour after the model reverted the merge (the absorbed cluster kept its own). */
  undoMerge(event, previous) {
    this.index[event.root] = previous;
  }
}

function scramble(v) {
  let h = Math.imul(v + 1, 0x9e3779b1);
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  return h >>> 0;
}
