# Cluster–cluster aggregation on the torus

Two static pages, no build step:

- `index.html` — interactive visualisation.
- `compute.html` — slim multi-shot Monte Carlo (runs in a Web Worker).

The code uses ES modules, so serve the folder over HTTP rather than opening
the files directly, e.g. `python3 -m http.server` in this directory.

## Model

The box `{0,…,L−1}²` with periodic boundary conditions. Sites are occupied
independently with probability `p`; each occupied site starts as a singleton
cluster, and the configuration is a forest on the occupied sites. Each cluster
with `m` vertices rings at rate `m^(−α)` and bonds to one neighbouring occupied
vertex, merging the two trees:

- *directional* — a direction `d` is uniform over the four lattice directions,
  then `w` is uniform over the occupied vertices in `{v + e_d : v ∈ C} \ C` and
  the bond is `(w − e_d, w)`. If there is no such vertex, `C` translates
  rigidly by one step in direction `d` instead.
- *isotropic* — the spanning-forest case, `p = 1`. `w` is uniform over the
  vertices adjacent to `C`; if `w` touches `C` along several edges, the bond is
  uniform among them. (If `C` has no neighbour at all, which needs `C` to wrap
  the torus, the event is void.)

Event times are exact (Gillespie): the total rate is maintained in a Fenwick
tree, so choosing the ringing cluster is `O(log N)`. Clusters are labelled by
the site index of their first vertex, with small-to-large relabelling on
merges; translations cost `O(m)`. Graph distances are BFS along the bonds of
the (unique) tree path. The run ends when a single cluster remains.

## Layout

| file | role |
| --- | --- |
| `src/rng.js` | seeded PRNG (mulberry32) |
| `src/model.js` | the model: lattice, cluster labelling, rates, sampling rules, translation, history, distance |
| `src/colors.js` | map-style cluster colouring (recolour on clash only) |
| `src/render.js` | canvas drawing: solid map, skeletons, hover, A–B path |
| `src/app.js` | interactive UI |
| `src/compute.js`, `src/compute-worker.js` | slim compute UI and its worker |

## Interactive page

- `L`, `α`, density `p`, sampling rule and seed; changing any of them resets
  the run. Choosing isotropic sampling sets `p = 1`.
- Play / pause (space), step back (←), step forward (→), skip to end; speed in
  events per second. Every event is kept in a history, so stepping back reverts
  a merge exactly and stepping forward again replays the same trajectory (fresh
  randomness is only used past the end of the history).
- The most recent event is highlighted — the new bond, or the outline of the
  cluster that just translated with an arrow — and described in the "Last
  event" readout.
- Solid map or bond-skeleton view. Hovering a cluster dims the map and shows
  the skeletons, with the hovered cluster's skeleton highlighted.
- Click the lattice (or type coordinates) to place A and B; the panel shows the
  size of each cluster (0 at a vacant site) and the graph distance (`null` if
  not connected), and the tree path is drawn.

## Compute page

Model parameters, number of shots, a time grid (linear or logarithmic; the
horizon is the time at which a pilot shot reaches a single cluster) and two
sites A, B. Outputs:

- time series (mean ± standard error over shots) of the cluster size at A (0
  when vacant), P(A and B connected) and, for `p < 1`, P(A occupied), with
  toggles for log axes and a least-squares power-law fit `C·t^β` over a chosen
  time window;
- the distribution over shots of the graph distance between A and B at the
  first moment they are connected (for `p = 1` the tree path never changes
  afterwards), together with the fraction of shots that connect before the
  horizon and the mean contact time;
- the mean first-contact graph distance between (0, 0) and (n, 0) against the
  separation n = 1 … ⌊L/2⌋, with a power-law fit `C·n^β`;
- CSV download of all three.
