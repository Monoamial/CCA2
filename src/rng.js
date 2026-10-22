// Small deterministic PRNG (mulberry32) so every run is reproducible from a seed.

export class Rng {
  constructor(seed) {
    this.state = hashSeed(seed);
  }

  /** Uniform in [0, 1). */
  uniform() {
    this.state = (this.state + 0x6d2b79f5) | 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Uniform integer in {0, …, n-1}. */
  int(n) {
    return Math.floor(this.uniform() * n);
  }

  /** Exponential waiting time with the given rate. */
  exponential(rate) {
    return -Math.log(1 - this.uniform()) / rate;
  }
}

/** FNV-1a hash of the seed's string form, so seeds may be numbers or text. */
function hashSeed(seed) {
  const str = String(seed);
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
