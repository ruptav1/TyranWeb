'use strict';
// The outline of a shape in a small picture (its opacity a[0..1], w x h) as an SVG path, to be drawn
// sharp at any size: marching squares at half opacity, each closed outline simplified
// (Ramer-Douglas-Peucker, `eps` pixels) so that its straight edges and corners come out straight,
// edges within `snap` degrees of level or upright made exactly so; specks under `speck` px² dropped.
// (Used for the NIKKE logo behind her, see nikke.js.)
function trace(a, w, h, { eps = 0.35, speck = 1, snap = 14 } = {}) {
  // (a border of nothing, so that every outline closes)
  const W = w + 2;
  const H = h + 2;
  const v = new Float32Array(W * H);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) v[(y + 1) * W + x + 1] = a[y * w + x];
  const at = (x, y) => v[y * W + x];
  const iso = 0.5;
  const lerp = (p, q) => (iso - p) / (q - p);
  const points = new Map(); // edge key -> [x, y]
  const ends = new Map(); // edge key -> [segment ids]
  const segs = [];
  const edge = (x, y, side) => {
    // T, B: on the row; L, R: on the column
    const key = side === 'T' ? `h${x},${y}` : side === 'B' ? `h${x},${y + 1}` : side === 'L' ? `v${x},${y}` : `v${x + 1},${y}`;
    if (!points.has(key)) {
      const [tl, tr, br, bl] = [at(x, y), at(x + 1, y), at(x + 1, y + 1), at(x, y + 1)];
      points.set(key, side === 'T' ? [x + lerp(tl, tr), y] : side === 'B' ? [x + lerp(bl, br), y + 1] : side === 'L' ? [x, y + lerp(tl, bl)] : [x + 1, y + lerp(tr, br)]);
    }
    return key;
  };
  const add = (x, y, s1, s2) => {
    const k = [edge(x, y, s1), edge(x, y, s2)];
    const id = segs.push(k) - 1;
    for (const e of k) ends.has(e) ? ends.get(e).push(id) : ends.set(e, [id]);
  };
  const CASES = { 1: ['LB'], 2: ['BR'], 3: ['LR'], 4: ['TR'], 6: ['TB'], 7: ['TL'], 8: ['TL'], 9: ['TB'], 11: ['TR'], 12: ['LR'], 13: ['RB'], 14: ['LB'] };
  for (let y = 0; y < H - 1; y++) {
    for (let x = 0; x < W - 1; x++) {
      const [tl, tr, br, bl] = [at(x, y), at(x + 1, y), at(x + 1, y + 1), at(x, y + 1)];
      const c = (tl > iso ? 8 : 0) | (tr > iso ? 4 : 0) | (br > iso ? 2 : 0) | (bl > iso ? 1 : 0);
      if (!c || c === 15) continue;
      const mid = (tl + tr + br + bl) / 4 > iso;
      const pairs = c === 5 ? (mid ? ['TL', 'BR'] : ['TR', 'LB']) : c === 10 ? (mid ? ['TR', 'LB'] : ['TL', 'BR']) : CASES[c];
      for (const p of pairs) add(x, y, p[0], p[1]);
    }
  }
  // the segments joined into closed outlines
  const used = new Uint8Array(segs.length);
  const loops = [];
  for (let s = 0; s < segs.length; s++) {
    if (used[s]) continue;
    const loop = [];
    let id = s;
    let from = segs[s][0];
    while (!used[id]) {
      used[id] = 1;
      const to = segs[id][0] === from ? segs[id][1] : segs[id][0];
      loop.push(points.get(from));
      const next = ends.get(to).find((n) => !used[n]);
      from = to;
      if (next === undefined) break;
      id = next;
    }
    if (loop.length > 2) loops.push(loop);
  }
  const area = (p) => Math.abs(p.reduce((n, q, i) => n + q[0] * p[(i + 1) % p.length][1] - p[(i + 1) % p.length][0] * q[1], 0)) / 2;
  const off = (p, a1, b1) => {
    const [dx, dy] = [b1[0] - a1[0], b1[1] - a1[1]];
    const len = Math.hypot(dx, dy);
    return len ? Math.abs(dx * (a1[1] - p[1]) - dy * (a1[0] - p[0])) / len : Math.hypot(p[0] - a1[0], p[1] - a1[1]);
  };
  function rdp(p, i, j, keep) {
    let far = -1;
    let most = eps;
    for (let k = i + 1; k < j; k++) {
      const d = off(p[k], p[i], p[j]);
      if (d > most) [most, far] = [d, k];
    }
    if (far < 0) return;
    keep[far] = 1;
    rdp(p, i, far, keep);
    rdp(p, far, j, keep);
  }
  let d = '';
  for (const p of loops) {
    if (area(p) < speck) continue;
    // (split where it is farthest from its first point, both halves simplified)
    let far = 0;
    for (let k = 1; k < p.length; k++) if (Math.hypot(p[k][0] - p[0][0], p[k][1] - p[0][1]) > Math.hypot(p[far][0] - p[0][0], p[far][1] - p[0][1])) far = k;
    const ring = [...p, p[0]];
    const keep = new Uint8Array(ring.length);
    keep[0] = keep[far] = keep[ring.length - 1] = 1;
    rdp(ring, 0, far, keep);
    rdp(ring, far, ring.length - 1, keep);
    const q = ring.filter((_, k) => keep[k]).slice(0, -1);
    if (q.length < 3) continue;
    // (level and upright edges made exactly so, each corner where two of them meet)
    if (snap) {
      const n = q.length;
      const kind = q.map((p, k) => {
        const r = q[(k + 1) % n];
        const ang = (Math.atan2(Math.abs(r[1] - p[1]), Math.abs(r[0] - p[0])) * 180) / Math.PI;
        return ang < snap ? { h: (p[1] + r[1]) / 2 } : ang > 90 - snap ? { v: (p[0] + r[0]) / 2 } : {};
      });
      for (let k = 0; k < n; k++) {
        const [a1, b1] = [kind[(k + n - 1) % n], kind[k]]; // (the edges into and out of q[k])
        const x = b1.v ?? a1.v;
        const y = b1.h ?? a1.h;
        q[k] = [x ?? q[k][0], y ?? q[k][1]];
      }
    }
    d += 'M' + q.map(([x, y]) => `${(x - 1).toFixed(2)} ${(y - 1).toFixed(2)}`).join('L') + 'Z';
  }
  return d;
}
module.exports = { trace };
