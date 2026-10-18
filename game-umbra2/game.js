/* ============================================================================
   UMBRA — a 2.5D co-op shadow platformer (Three.js)
   Complete game.js — replaces the previous file. No other files needed.

   P1 PYRE   (WASD)  walks on lava. His shadow trails from his feet.  SPACE =
                     Shadow Lock (locks the shadow's ANGLE; it still moves with
                     him), E = Solar Burst (unlocks at Gate 5).
   P2 UMBRA  (ARROWS) crosses lava "on Pyre's tail" — inside his locked shadow,
                     or on the Crystal Foothold that forms when a lock expires.
                     RIGHT SHIFT (or / or Numpad 0) = Shadow Dash.
   Shared:   R = restart run · ENTER = start / retry · P or ESC = pause · M = mute

   Loading: this file loads Three.js itself (pinned r160 from jsDelivr, then
   unpkg, then an import map entry "three", then a global THREE). It works when
   index.html loads it with <script type="module"> or with a plain <script>.

   Debug helpers: open the page with ?debug to get window.__umbra.
   ========================================================================== */
(async function UMBRA_BOOT() {
'use strict';

if (window.__UMBRA_BOOTED__) {
  console.warn('[UMBRA] game.js was loaded twice — the second copy is ignored.');
  return;
}
window.__UMBRA_BOOTED__ = true;

//#region LEVEL  ---- pure gameplay geometry (no Three.js, no DOM) -------------

const DEG = Math.PI / 180;

const CFG = {
  // round
  ROUND_TIME: 150,          // seconds on the clock (2:30)
  URGENT_TIME: 25,          // timer turns urgent below this
  GATE_TIME_BONUS: 0,       // seconds added per cleared gate (0 = strict 2:30 run)

  // movement
  PYRE_SPEED: 6.3,
  UMBRA_SPEED: 6.8,
  ACCEL: 15,                // velocity response (higher = snappier)
  PLAYER_RADIUS: 0.42,
  MAX_SEPARATION: 15.5,     // max distance along the arena between the two players
  TETHER_CROSSING: 7.4,     // co-op tether during a lava crossing: Pyre can't outrun Umbra
  ESCORT_SPEED: 2.6,        // Pyre's walking pace while the Shadow Lock holds (escort pace)

  // sun
  SUN_PERIOD: 10,           // seconds for one full back-and-forth sweep
  SUN_MAX_DEG: 72,          // sun azimuth swings between -72° and +72°
  SUN_EASE_K: 0.8,          // fraction of each sweep at constant speed
  SUN_START_PHASE: 9.0,     // phase (s) at run start → sun reaches noon ~3.5 s in

  // tail-escort shadow (always attached to Pyre's feet)
  BRIDGE_LENGTH: 5.6,       // sun shadow length — a character-sized cast shadow
  MIRROR_LENGTH: 5.8,       // mirror light comes in a little lower
  BRIDGE_WIDTH: 1.7,
  ALIGN_TOL: 0.2,           // hysteresis: Umbra may drift this far out and stay ALIGNED
  BRIDGE_Y: 0.07,
  LAND_ENTER: 0.8,          // stone needed under the far end to become ALIGNED
  LAND_STAY: 0.45,          // ... and to stay ALIGNED (hysteresis, no flicker)
  EDGE_TOL: 0.14,           // forgiveness at lava edges (Pyre's footing, bridge ends)
  UMBRA_EDGE_TOL: 0.22,     // Umbra's centre may hang this far over an edge without sinking

  // shadow lock
  LOCK_DURATION: 2.2,       // short freeze → 2-3 chained locks per crossing
  LOCK_COOLDOWN: 1.05,      // starts when the lock ends
  RELEASE_TIME: 0.55,       // frozen → live blend
  LOCK_ASSIST: 0.25,        // SPACE pressed this late still locks the last aligned bridge
  SYNC_REFUND: 0.5,         // Perfect Sync halves the next cooldown

  // crystal foothold (spawns under Umbra the moment a lock expires)
  FOOTHOLD_RADIUS: 2.25,
  FOOTHOLD_TIME: 3.4,       // seconds of safe ground while the shadow is UNSTABLE

  // umbra survival
  FALL_GRACE: 0.35,         // time over unsupported lava before falling
  FALL_TIME: 0.6,
  RESPAWN_TIME: 0.4,
  INVULN_TIME: 1.2,
  LAVA_SLOW: 0.22,          // speed factor while sinking

  // abilities
  DASH_DIST: 2.6,
  DASH_TIME: 0.15,
  DASH_COOLDOWN: 1.5,
  BURST_TIME: 1.6,
  BURST_MULT: 3.2,
  BURST_COOLDOWN: 9,
  BURST_GATE: 4,            // gate index (0-based) where Solar Burst unlocks

  // mirrors
  MIRROR_REACH: 11.0,
  MIRROR_HALF_DEG: 22,
  MIRROR_STEPS_DEG: [-60, -40, -20, 0, 20, 40, 60],
  MIRROR_TURN_RATE: 2.6,    // rad/s
  MIRROR_BLEND_RATE: 6,     // sun ↔ mirror light blend speed

  // vents
  VENT_PERIOD: 3.0,
  VENT_WARN: 0.7,
  VENT_ACTIVE: 0.8,

  // pickups / plates
  SHARD_RADIUS: 0.95,
  PLATE_RADIUS: 0.85,

  // arena
  WALL_INNER: 8.6,
  X_EXT: 10.8,
  Z_BACK: 60,
  Z_FRONT: -63,
  Z_MAX: 58.4,              // players can't walk behind this
  Z_MIN: -60.4,             // ... or past this
};
CFG.WALK_LIMIT = CFG.WALL_INNER - CFG.PLAYER_RADIUS;

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const wrapAngle = (a) => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };
const angleLerp = (a, b, t) => a + wrapAngle(b - a) * t;

// ---------------------------------------------------------------- sun
// s in [-1, 1]: a triangle wave with rounded turnarounds → constant speed
// through the useful middle of each sweep, a short smooth pause at the ends.
function sunNorm(phaseSec) {
  let p = (phaseSec / CFG.SUN_PERIOD) % 1;
  if (p < 0) p += 1;
  const tri = p < 0.5 ? -1 + 4 * p : 3 - 4 * p;
  const k = CFG.SUN_EASE_K, m = (1 + k) / 2, a = Math.abs(tri);
  const y = a <= k ? a : k + (a - k) - ((a - k) * (a - k)) / (2 * (1 - k));
  return (tri < 0 ? -1 : 1) * (y / m);
}
// sun azimuth θ (0 = top of the screen, + = toward screen-right)
function sunAzimuth(phaseSec) { return sunNorm(phaseSec) * CFG.SUN_MAX_DEG * DEG; }
// The shadow points away from the sun: d = (-sin θ, cos θ) → yaw ψ = -θ
function shadowYawFromSun(theta) { return -theta; }

// ---------------------------------------------------------------- polylines
function samplePolyline(fn, x0, x1, n) {
  const pts = [];
  for (let i = 0; i <= n; i++) { const x = x0 + ((x1 - x0) * i) / n; pts.push([x, fn(x)]); }
  return pts;
}
// Offset a left→right polyline. dist(x) > 0 moves toward +z (the near side).
function offsetPolyline(pts, distFn) {
  const out = [], n = pts.length;
  for (let i = 0; i < n; i++) {
    const d = distFn(pts[i][0]);
    if (i === 0 || i === n - 1) {
      const a = pts[i === 0 ? 0 : n - 2], b = pts[i === 0 ? 1 : n - 1];
      const tx = b[0] - a[0], tz = b[1] - a[1], l = Math.hypot(tx, tz) || 1;
      out.push([pts[i][0] - (tz / l) * d, pts[i][1] + (tx / l) * d]);
    } else {
      const a = pts[i - 1], b = pts[i], c = pts[i + 1];
      let t1x = b[0] - a[0], t1z = b[1] - a[1]; const l1 = Math.hypot(t1x, t1z) || 1; t1x /= l1; t1z /= l1;
      let t2x = c[0] - b[0], t2z = c[1] - b[1]; const l2 = Math.hypot(t2x, t2z) || 1; t2x /= l2; t2z /= l2;
      const n1x = -t1z, n1z = t1x, n2x = -t2z, n2z = t2x;
      let mx = n1x + n2x, mz = n1z + n2z; const ml = Math.hypot(mx, mz) || 1; mx /= ml; mz /= ml;
      const k = d / Math.max(0.35, mx * n1x + mz * n1z);
      out.push([b[0] + mx * k, b[1] + mz * k]);
    }
  }
  return out;
}
// Keep the part of a polyline with x in [x0, x1]
function clipPolylineX(pts, x0, x1) {
  const out = [];
  const push = (p) => { const q = out[out.length - 1]; if (!q || Math.hypot(q[0] - p[0], q[1] - p[1]) > 1e-7) out.push(p); };
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1], dx = b[0] - a[0];
    let ta = 0, tb = 1;
    if (Math.abs(dx) < 1e-12) { if (a[0] < x0 || a[0] > x1) continue; }
    else {
      const t0 = (x0 - a[0]) / dx, t1 = (x1 - a[0]) / dx;
      ta = Math.max(ta, Math.min(t0, t1)); tb = Math.min(tb, Math.max(t0, t1));
      if (ta > tb) continue;
    }
    push([a[0] + dx * ta, a[1] + (b[1] - a[1]) * ta]);
    push([a[0] + dx * tb, a[1] + (b[1] - a[1]) * tb]);
  }
  return out;
}
// Chunky island outline (superellipse with a little wobble)
function islandOutline(cx, cz, rx, rz, n, seed) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const c = Math.cos(a), s = Math.sin(a);
    const w = 1 + 0.05 * Math.sin(3 * a + seed) + 0.03 * Math.sin(5 * a + seed * 1.7);
    const ex = 2 / 2.6;
    pts.push([cx + Math.sign(c) * Math.pow(Math.abs(c), ex) * rx * w, cz + Math.sign(s) * Math.pow(Math.abs(s), ex) * rz * w]);
  }
  return pts;
}

// ---------------------------------------------------------------- level
function buildLevel() {
  const X = CFG.X_EXT;
  const rivers = {};
  const makeRiver = (id, spine, nearFn, farFn) => {
    const near = clipPolylineX(offsetPolyline(spine, nearFn), -X, X);
    const far = clipPolylineX(offsetPolyline(spine, farFn), -X, X);
    rivers[id] = { id, near, far };
  };

  // Gate 1 — THE STRAIGHT: a straight channel, 4.6 wide
  makeRiver('R1', [[-16, 46], [16, 46]], () => 2.3, () => -2.3);

  // Gate 2 — THE TILT: a diagonal channel, 6.0 wide (perpendicular)
  makeRiver('R2', [[-16, 26.9 + 0.39815 * 16], [16, 26.9 - 0.39815 * 16]], () => 3.0, () => -3.0);

  // Gate 3 — THE SERPENT: two zigzag channels (4.2 wide) around a 2.8-wide middle path
  const serp = [[-16.2, 5.6], [-10.8, 9.0], [-5.4, 5.6], [0, 9.0], [5.4, 5.6], [10.8, 9.0], [16.2, 5.6]];
  makeRiver('R3a', serp, () => 5.6, () => 1.4);
  makeRiver('R3b', serp, () => -1.4, () => -5.6);

  // Gate 4 — THE BEND: a wide U-bend (8.4). Too wide for a sun shadow — needs the mirror.
  const bend = samplePolyline((x) => -7.5 - 4.0 * Math.cos((Math.PI * x) / 21.6) ** 2, -16, 16, 72);
  makeRiver('R4', bend, () => 4.2, () => -4.2);

  // Gate 5 — THE PULSE: wavy channel with vents; much wider near the right wall
  const pulse = samplePolyline((x) => -27.2 + 0.7 * Math.sin((Math.PI * x) / 7), -16, 16, 72);
  const halfW5 = (x) => 3.2 + 1.2 * smoothstep(3.5, 8.0, x);
  makeRiver('R5', pulse, (x) => halfW5(x), (x) => -halfW5(x));

  // Gate 6 — THE ECLIPSE: a lava lake with an island in the middle
  rivers.R6 = {
    id: 'R6',
    near: samplePolyline((x) => -35.2 + 0.9 * Math.sin((Math.PI * x) / 9 + 0.6), -X, X, 48),
    far: samplePolyline((x) => -49.4 + 0.8 * Math.sin((Math.PI * x) / 8 - 0.4), -X, X, 48),
  };

  const polys = [];
  const addRegion = (id, top, bottom, kind) => {
    const pts = top.map((p) => [p[0], p[1]]).concat(bottom.slice().reverse().map((p) => [p[0], p[1]]));
    polys.push({ id, pts, holes: [], kind });
  };
  const backLine = [[-X, CFG.Z_BACK], [X, CFG.Z_BACK]];
  const frontLine = [[-X, CFG.Z_FRONT], [X, CFG.Z_FRONT]];
  addRegion(0, backLine, rivers.R1.near, 'bank');
  addRegion(1, rivers.R1.far, rivers.R2.near, 'bank');
  addRegion(2, rivers.R2.far, rivers.R3a.near, 'bank');
  addRegion(2.5, rivers.R3a.far, rivers.R3b.near, 'strip');
  addRegion(3, rivers.R3b.far, rivers.R4.near, 'bank');
  addRegion(4, rivers.R4.far, rivers.R5.near, 'bank');
  addRegion(5, rivers.R5.far, rivers.R6.near, 'bank');
  addRegion(6, rivers.R6.far, frontLine, 'bank');
  polys.push({ id: 4.6, pts: islandOutline(6.9, -26.15, 1.0, 1.0, 16, 2.1), holes: [], kind: 'islet' });
  polys.push({ id: 5.5, pts: islandOutline(0, -41.6, 3.1, 2.2, 22, 0.7), holes: [], kind: 'island' });
  polys.push({ id: 5.3, pts: islandOutline(-6.3, -41.6, 0.95, 0.95, 16, 4.2), holes: [], kind: 'islet' });

  for (const p of polys) {
    let minx = Infinity, maxx = -Infinity, minz = Infinity, maxz = -Infinity;
    for (const q of p.pts) { minx = Math.min(minx, q[0]); maxx = Math.max(maxx, q[0]); minz = Math.min(minz, q[1]); maxz = Math.max(maxz, q[1]); }
    p.minx = minx; p.maxx = maxx; p.minz = minz; p.maxz = maxz;
  }

  // solid round obstacles (players collide, bridges are blocked by them)
  const obstacles = [
    { x: 0, z: -20.0, r: 0.75, kind: 'mirror' },
    { x: 0, z: -54.0, r: 0.75, kind: 'mirror' },
    { x: -3.3, z: -58.5, r: 0.85, kind: 'pillar' },
    { x: 3.3, z: -58.5, r: 0.85, kind: 'pillar' },
    { x: -7.5, z: -1.2, r: 0.65, kind: 'rock' },
    { x: 7.6, z: 1.4, r: 0.55, kind: 'rock' },
    { x: -7.7, z: 25.5, r: 0.6, kind: 'rock' },
    { x: -2.9, z: -5.4, r: 0.7, kind: 'spire' },
    { x: 2.9, z: -5.4, r: 0.7, kind: 'spire' },
  ];

  const mirrors = [
    { id: 0, x: 0, z: -20.0, gate: 3, startStep: 0,
      plates: [{ x: -2.6, z: -19.0, dir: -1 }, { x: 2.6, z: -19.0, dir: 1 }, { x: -4.6, z: -2.6, dir: 0 }] },
    { id: 1, x: 0, z: -54.0, gate: 5, startStep: 6,
      plates: [{ x: -2.7, z: -53.2, dir: -1 }, { x: 2.7, z: -53.2, dir: 1 }] },
  ];

  const vents = [
    { x: -4.3, z: -27.2 + 0.7 * Math.sin((Math.PI * -4.3) / 7), r: 1.55, offset: 0.0, gate: 4 },
    { x: 0.0, z: -27.2, r: 1.55, offset: 1.0, gate: 4 },
    { x: 4.3, z: -27.2 + 0.7 * Math.sin((Math.PI * 4.3) / 7), r: 1.55, offset: 2.0, gate: 4 },
    { x: 2.6, z: -31.6, r: 1.1, offset: 0.45, gate: 4 },
    { x: -2.6, z: -37.1, r: 1.3, offset: 0.0, gate: 5 },
    { x: 2.6, z: -37.1, r: 1.3, offset: 1.5, gate: 5 },
  ];

  const shards = [
    { x: 6.4, z: 51.2 },
    { x: 7.3, z: 17.6 },
    { x: -5.4, z: 5.6 },
    { x: -7.3, z: -16.4 },
    { x: 6.9, z: -26.15 },
    { x: -6.3, z: -41.6 },
  ];

  const gates = [
    { name: 'THE STRAIGHT', rivers: ['R1'], clearRegion: 1, checkpoint: { x: 0, z: 40.0 },
      objective: 'Pyre, step into the lava ahead of Umbra. When your shadow falls on her, lock it and walk her across on your tail.' },
    { name: 'THE TILT', rivers: ['R2'], clearRegion: 2, checkpoint: { x: -3.2, z: 21.0 },
      objective: 'The channel runs at an angle. Chain locks: pause on the crystal foothold, re-align, lock again.' },
    { name: 'THE SERPENT', rivers: ['R3a', 'R3b'], clearRegion: 3, checkpoint: { x: 0, z: -1.6 },
      sub: [{ region: 2.5, x: 0, z: 9.0 }],
      objective: 'Two zigzag channels. Escort Umbra to the middle path first, then to the far bank.' },
    { name: 'THE BEND', rivers: ['R4'], clearRegion: 4, checkpoint: { x: -4.6, z: -19.0 },
      objective: 'A wide bend. In the mirror’s light Pyre’s shadow points away from the mirror and stops swinging. Gold plates turn it.' },
    { name: 'THE PULSE', rivers: ['R5'], clearRegion: 5, checkpoint: { x: -3.6, z: -32.9 },
      objective: 'Vents erupt in a rhythm. Escort Umbra between eruptions. Pyre: E speeds up the sun.' },
    { name: 'THE ECLIPSE', rivers: ['R6'], clearRegion: 6, checkpoint: { x: 0, z: -51.4 },
      sub: [{ region: 5.5, x: 0, z: -41.6 }],
      objective: 'Island first, then the far bank. Sun, mirror, locks and dashes — use all of it.' },
  ];

  const exitZone = { x0: -2.5, x1: 2.5, z0: -60.2, z1: -57.0 };
  const start = { pyre: { x: -1.6, z: 55.0 }, umbra: { x: 1.6, z: 55.0 }, checkpoint: { x: 1.6, z: 55.0 } };

  return { rivers, polys, obstacles, mirrors, vents, shards, gates, exitZone, start };
}

const LEVEL = buildLevel();

// ---------------------------------------------------------------- queries
function pointInPoly(px, pz, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i][0], zi = pts[i][1], xj = pts[j][0], zj = pts[j][1];
    if ((zi > pz) !== (zj > pz) && px < ((xj - xi) * (pz - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}
function distToSegment(px, pz, ax, az, bx, bz) {
  const vx = bx - ax, vz = bz - az, l2 = vx * vx + vz * vz;
  let t = l2 > 0 ? ((px - ax) * vx + (pz - az) * vz) / l2 : 0;
  t = clamp(t, 0, 1);
  return Math.hypot(px - (ax + vx * t), pz - (az + vz * t));
}
function distToRing(px, pz, pts) {
  let d = Infinity;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) d = Math.min(d, distToSegment(px, pz, pts[j][0], pts[j][1], pts[i][0], pts[i][1]));
  return d;
}
// The floor polygon under a point (exact), or null over lava
function floorAt(px, pz) {
  for (const p of LEVEL.polys) {
    if (px < p.minx || px > p.maxx || pz < p.minz || pz > p.maxz) continue;
    if (!pointInPoly(px, pz, p.pts)) continue;
    let inHole = false;
    for (const h of p.holes) if (pointInPoly(px, pz, h)) { inHole = true; break; }
    if (!inHole) return p;
  }
  return null;
}
// Same, but forgiving: a point within `tol` of stone counts as stone
function floorNear(px, pz, tol) {
  const exact = floorAt(px, pz);
  if (exact || tol <= 0) return exact;
  let best = null, bestD = tol;
  for (const p of LEVEL.polys) {
    if (px < p.minx - tol || px > p.maxx + tol || pz < p.minz - tol || pz > p.maxz + tol) continue;
    const d = distToRing(px, pz, p.pts);
    if (d <= bestD) { bestD = d; best = p; }
  }
  return best;
}

// ---------------------------------------------------------------- bridge analysis
// The bridge is the rectangle: origin O (Pyre's feet), yaw ψ, length L, width W.
// It is ALIGNED when its centreline leaves Pyre's stone, crosses lava and then
// reaches *different* stone with at least `margin` of stone under it, before
// hitting a wall or an obstacle. Rendering and collision use these same numbers.
const SAFE = 1, LAVA = 2, BLOCK = 3;
const _ts = new Float64Array(512);
const IVMAX = 96;
const _ivT = new Int8Array(IVMAX), _ivA = new Float64Array(IVMAX), _ivB = new Float64Array(IVMAX), _ivR = new Float64Array(IVMAX);

function classifyPoint(px, pz) {
  if (Math.abs(px) > CFG.WALK_LIMIT || pz > CFG.Z_MAX + 0.4 || pz < CFG.Z_MIN - 0.4) return -BLOCK;
  for (const o of LEVEL.obstacles) if (Math.hypot(px - o.x, pz - o.z) < o.r + 0.15) return -BLOCK;
  const f = floorAt(px, pz);
  return f ? f.id : -LAVA;
}

function analyzeBridge(ox, oz, yaw, len, margin, res) {
  res = res || {};
  const dx = Math.sin(yaw), dz = Math.cos(yaw);
  const ex = ox + dx * len, ez = oz + dz * len;
  const minx = Math.min(ox, ex) - 0.05, maxx = Math.max(ox, ex) + 0.05;
  const minz = Math.min(oz, ez) - 0.05, maxz = Math.max(oz, ez) + 0.05;
  let nt = 0;
  _ts[nt++] = 0; _ts[nt++] = len;
  const addEdges = (pts) => {
    for (let i = 0, j = pts.length - 1; i < pts.length && nt < 500; j = i++) {
      const ax = pts[j][0], az = pts[j][1];
      const qx = pts[i][0] - ax, qz = pts[i][1] - az;
      const den = dx * qz - dz * qx;
      if (Math.abs(den) < 1e-12) continue;
      const wx = ax - ox, wz = az - oz;
      const t = (wx * qz - wz * qx) / den;
      const s = (wx * dz - wz * dx) / den;
      if (t > 0 && t < len && s >= 0 && s <= 1) _ts[nt++] = t;
    }
  };
  for (const p of LEVEL.polys) {
    if (p.maxx < minx || p.minx > maxx || p.maxz < minz || p.minz > maxz) continue;
    addEdges(p.pts);
    for (const h of p.holes) addEdges(h);
  }
  for (const o of LEVEL.obstacles) {
    const cx = ox - o.x, cz = oz - o.z, r = o.r + 0.15;
    const b = dx * cx + dz * cz, c = cx * cx + cz * cz - r * r, disc = b * b - c;
    if (disc > 0) {
      const s = Math.sqrt(disc);
      const t1 = -b - s, t2 = -b + s;
      if (t1 > 0 && t1 < len) _ts[nt++] = t1;
      if (t2 > 0 && t2 < len) _ts[nt++] = t2;
    }
  }
  if (Math.abs(dx) > 1e-9) {
    for (const wl of [-CFG.WALK_LIMIT, CFG.WALK_LIMIT]) {
      const t = (wl - ox) / dx;
      if (t > 0 && t < len) _ts[nt++] = t;
    }
  }
  if (Math.abs(dz) > 1e-9) {
    for (const wl of [CFG.Z_MAX + 0.4, CFG.Z_MIN - 0.4]) {
      const t = (wl - oz) / dz;
      if (t > 0 && t < len) _ts[nt++] = t;
    }
  }
  const ts = _ts.subarray(0, nt);
  ts.sort();

  // classify the pieces between breakpoints, merging equal neighbours
  let n = 0;
  for (let i = 0; i < nt - 1 && n < IVMAX; i++) {
    const a = ts[i], b = ts[i + 1];
    if (b - a < 1e-5) continue;
    const m = (a + b) * 0.5;
    const c = classifyPoint(ox + dx * m, oz + dz * m);
    const type = c >= 0 ? SAFE : -c, reg = c >= 0 ? c : -1;
    if (n > 0 && _ivT[n - 1] === type && _ivR[n - 1] === reg) { _ivB[n - 1] = b; continue; }
    _ivT[n] = type; _ivA[n] = a; _ivB[n] = b; _ivR[n] = reg; n++;
  }

  res.valid = false; res.status = 'idle'; res.landDist = -1; res.landRegion = -1; res.startRegion = -1; res.lavaStart = -1;

  // Pyre's footing (forgiving at the very edge)
  const foot = floorNear(ox, oz, CFG.EDGE_TOL);
  if (!foot) { res.status = 'nostone'; return res; }
  const startRegion = foot.id;
  res.startRegion = startRegion;
  let i = 0;
  while (i < n && ((_ivT[i] === SAFE && _ivR[i] === startRegion) || (_ivT[i] === LAVA && _ivB[i] <= CFG.EDGE_TOL))) i++;
  if (i >= n) { res.status = 'idle'; return res; }
  if (_ivT[i] === BLOCK) { res.status = 'blocked'; return res; }
  res.lavaStart = _ivA[i];
  for (; i < n; i++) {
    if (_ivT[i] === BLOCK) { res.status = 'blocked'; return res; }
    if (_ivT[i] === SAFE && _ivR[i] !== startRegion && _ivB[i] - _ivA[i] >= margin) {
      res.valid = true; res.status = 'valid'; res.landDist = _ivA[i]; res.landRegion = _ivR[i];
      return res;
    }
  }
  res.status = 'short';
  return res;
}

// Is point P on the bridge rectangle? Returns along-distance or -1.
function bridgeLocal(px, pz, ox, oz, yaw, len, width, out) {
  const dx = Math.sin(yaw), dz = Math.cos(yaw);
  const vx = px - ox, vz = pz - oz;
  const along = vx * dx + vz * dz;
  const across = vx * dz - vz * dx;
  if (out) { out.along = along; out.across = across; }
  return along >= 0 && along <= len && Math.abs(across) <= width * 0.5;
}

// Tail-escort alignment: does Pyre's shadow (origin O at his feet, yaw ψ) fall
// on Umbra at P? `tol` widens the test (hysteresis for staying ALIGNED).
function shadowCovers(ox, oz, yaw, len, px, pz, tol) {
  const dx = Math.sin(yaw), dz = Math.cos(yaw);
  const vx = px - ox, vz = pz - oz;
  const along = vx * dx + vz * dz;
  const across = vx * dz - vz * dx;
  return along >= 0.25 - tol && along <= len + tol && Math.abs(across) <= CFG.BRIDGE_WIDTH * 0.5 + tol;
}

// ---------------------------------------------------------------- mirrors & vents
// Light from a mirror reaches Pyre if he is inside its beam (a wedge).
function mirrorLight(mirrorX, mirrorZ, beamYaw, px, pz) {
  const vx = px - mirrorX, vz = pz - mirrorZ;
  const d = Math.hypot(vx, vz);
  if (d < 0.9 || d > CFG.MIRROR_REACH) return 0;
  const a = Math.abs(wrapAngle(Math.atan2(vx, vz) - beamYaw));
  const half = CFG.MIRROR_HALF_DEG * DEG;
  if (a > half) return 0;
  return 1;
}
// Vent phase from the run clock: 0 idle, 1 warning, 2 erupting
function ventPhase(vent, runTime) {
  let t = (runTime + vent.offset) % CFG.VENT_PERIOD;
  if (t < 0) t += CFG.VENT_PERIOD;
  if (t < CFG.VENT_WARN) return { phase: 1, k: t / CFG.VENT_WARN };
  if (t < CFG.VENT_WARN + CFG.VENT_ACTIVE) return { phase: 2, k: (t - CFG.VENT_WARN) / CFG.VENT_ACTIVE };
  return { phase: 0, k: 0 };
}

//#endregion LEVEL

// =============================================================================
// BOOT: DOM hooks, HUD fallbacks, Three.js loading
// =============================================================================
if (document.readyState === 'loading') {
  await new Promise((resolve) => document.addEventListener('DOMContentLoaded', resolve, { once: true }));
}

const DEBUG = /[?&]debug\b/.test(location.search) || window.UMBRA_DEBUG === true;

const UI_IDS = ['game', 'shadowState', 'lockState', 'objective', 'hint', 'toast', 'timer', 'shardState',
  'progressFill', 'progressText', 'startOverlay', 'overlayTitle', 'overlayText', 'startButton'];
const ui = {};
for (const id of UI_IDS) ui[id] = document.getElementById(id);

(function injectStyle() {
  if (document.getElementById('umbra-style')) return;
  const st = document.createElement('style');
  st.id = 'umbra-style';
  st.textContent = `
  #umbra-fallback-hud{position:fixed;top:10px;left:10px;z-index:30;display:flex;flex-direction:column;gap:4px;
    font:600 13px/1.35 system-ui,sans-serif;color:#f6ecff;pointer-events:none;text-shadow:0 1px 2px #000;max-width:46vw}
  #umbra-fallback-hud .umbra-row{background:rgba(16,6,26,.74);border:1px solid rgba(150,110,255,.35);border-radius:7px;padding:4px 9px}
  #umbra-fallback-hud .umbra-bar{height:7px;border-radius:4px;background:rgba(255,255,255,.14);overflow:hidden;margin-top:3px}
  #umbra-fallback-hud .umbra-bar>div{height:100%;width:0;background:linear-gradient(90deg,#ff7a2a,#3ff0ff)}
  .umbra-fallback-toast{position:fixed;top:72px;left:50%;transform:translateX(-50%);z-index:35;padding:9px 18px;border-radius:10px;
    background:rgba(12,4,22,.88);border:1px solid #7a5cff;color:#fff;font:800 15px system-ui,sans-serif;pointer-events:none;opacity:0;transition:opacity .2s}
  .umbra-fallback-overlay{position:fixed;inset:0;z-index:40;display:flex;flex-direction:column;align-items:center;justify-content:center;
    text-align:center;background:rgba(8,2,14,.82);color:#f6ecff;font-family:system-ui,sans-serif;padding:20px}
  .umbra-fallback-overlay h1{font-size:54px;letter-spacing:.2em;margin:0 0 10px}
  .umbra-fallback-overlay div{max-width:640px;line-height:1.5}
  .umbra-fallback-overlay button{margin-top:18px;font:800 18px system-ui,sans-serif;padding:10px 28px;border-radius:10px;border:0;background:#ff7a2a;color:#1a0a10;cursor:pointer}
  #umbra-abilities{position:fixed;right:14px;top:50%;transform:translateY(-50%);z-index:25;display:flex;flex-direction:column;gap:8px;
    pointer-events:none;font:700 12px/1 system-ui,sans-serif}
  .umbra-pill{padding:7px 11px;border-radius:999px;background:rgba(14,6,24,.8);border:1px solid rgba(255,255,255,.18);color:#d9ccf2;
    letter-spacing:.05em;transition:opacity .3s,border-color .2s,color .2s;white-space:nowrap;text-align:right}
  .umbra-pill.ready{border-color:#3ff0ff;color:#c6fbff}
  .umbra-pill.burst.ready{border-color:#ffc24a;color:#ffe3a6}
  .umbra-pill.off{opacity:.35}
  .umbra-pill.hidden{display:none}
  @keyframes umbra-pulse{0%,100%{transform:scale(1)}50%{transform:scale(1.12)}}
  .umbra-urgent{animation:umbra-pulse .8s ease-in-out infinite;display:inline-block}
  .umbra-overlay-keys{display:inline-grid;grid-template-columns:auto auto;gap:4px 14px;text-align:left;margin-top:10px;font-size:14px}
  .umbra-overlay-keys b{color:#ffd27a}
  .umbra-overlay-keys .u{color:#7ff6ff}
  `;
  document.head.appendChild(st);
})();

// Create any HUD element that index.html doesn't have, so nothing breaks.
const missingIds = UI_IDS.filter((id) => !ui[id]);
(function createFallbacks() {
  if (!missingIds.length) return;
  console.warn('[UMBRA] index.html is missing these element IDs (created automatically): ' + missingIds.join(', ') +
    '\n[UMBRA] Minimum HTML change if you want them styled your way: add elements with those ids.');
  if (!ui.game) {
    const g = document.createElement('div');
    g.id = 'game';
    g.style.cssText = 'position:fixed;inset:0;z-index:0;';
    document.body.prepend(g);
    ui.game = g;
  }
  const hudIds = ['timer', 'shadowState', 'lockState', 'shardState', 'progressText', 'objective', 'hint'];
  const needHud = hudIds.some((id) => !ui[id]) || !ui.progressFill;
  let hud = null;
  if (needHud) {
    hud = document.createElement('div');
    hud.id = 'umbra-fallback-hud';
    document.body.appendChild(hud);
  }
  const labels = { timer: 'TIME', shadowState: 'SHADOW', lockState: 'LOCK', shardState: 'SUN SHARDS', progressText: '', objective: '', hint: '' };
  for (const id of hudIds) {
    if (ui[id]) continue;
    const row = document.createElement('div');
    row.className = 'umbra-row';
    if (labels[id]) { const l = document.createElement('span'); l.textContent = labels[id] + ' '; l.style.opacity = '0.65'; row.appendChild(l); }
    const v = document.createElement('span');
    v.id = id;
    row.appendChild(v);
    hud.appendChild(row);
    ui[id] = v;
  }
  if (!ui.progressFill) {
    const bar = document.createElement('div');
    bar.className = 'umbra-bar';
    const fill = document.createElement('div');
    fill.id = 'progressFill';
    bar.appendChild(fill);
    (hud || document.body).appendChild(bar);
    ui.progressFill = fill;
  }
  if (!ui.toast) {
    const t = document.createElement('div');
    t.id = 'toast';
    t.className = 'umbra-fallback-toast';
    document.body.appendChild(t);
    ui.toast = t;
  }
  if (!ui.startOverlay) {
    const o = document.createElement('div');
    o.id = 'startOverlay';
    o.className = 'umbra-fallback-overlay';
    document.body.appendChild(o);
    ui.startOverlay = o;
  }
  if (!ui.overlayTitle) { const h = document.createElement('h1'); h.id = 'overlayTitle'; ui.startOverlay.appendChild(h); ui.overlayTitle = h; }
  if (!ui.overlayText) { const d = document.createElement('div'); d.id = 'overlayText'; ui.startOverlay.appendChild(d); ui.overlayText = d; }
  if (!ui.startButton) { const b = document.createElement('button'); b.id = 'startButton'; b.type = 'button'; ui.startOverlay.appendChild(b); ui.startButton = b; }
})();

// Remember the label text of shard/progress elements so we can keep their format
const shardTemplate = (ui.shardState.textContent || '').trim();
function parentLabelHas(el, re) {
  const p = el.parentElement;
  if (!p) return false;
  return re.test((p.textContent || '').replace(el.textContent || '', ''));
}
const shardHasOwnLabel = /shard/i.test(shardTemplate);
const shardParentLabel = parentLabelHas(ui.shardState, /shard/i);

function setOverlayVisible(show) {
  const o = ui.startOverlay;
  if (show) {
    o.classList.remove('hidden');
    o.style.display = '';
    o.removeAttribute('hidden');
    if (getComputedStyle(o).display === 'none') o.style.display = 'flex';
    o.style.pointerEvents = 'auto';
  } else {
    o.classList.add('hidden');
    o.style.display = 'none';
    if (document.activeElement === ui.startButton) ui.startButton.blur();
  }
}
function setOverlay(title, html, button) {
  ui.overlayTitle.textContent = title;
  ui.overlayText.innerHTML = html;
  if (button) { ui.startButton.textContent = button; ui.startButton.style.display = ''; ui.startButton.disabled = false; }
  else { ui.startButton.style.display = 'none'; }
  setOverlayVisible(true);
}
if (ui.startButton.tagName === 'BUTTON' && !ui.startButton.getAttribute('type')) ui.startButton.setAttribute('type', 'button');
setOverlay('UMBRA', 'Loading the volcanic temple…', null);

// ---------------------------------------------------------------- Three.js
const THREE_SOURCES = [
  'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js',
  'https://unpkg.com/three@0.160.0/build/three.module.js',
  'three',
];
function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
}
async function loadThree() {
  for (const src of THREE_SOURCES) {
    try {
      const mod = await withTimeout(import(src), 10000);
      if (mod && mod.WebGLRenderer) return mod;
    } catch (err) {
      console.warn('[UMBRA] could not load Three.js from ' + src + ' — ' + (err && err.message));
    }
  }
  if (window.THREE && window.THREE.WebGLRenderer) return window.THREE;
  throw new Error('Three.js could not be loaded (no internet and no local copy).');
}
let THREE;
try {
  THREE = await loadThree();
} catch (err) {
  setOverlay('UMBRA', 'Three.js could not be loaded. Check your internet connection, or point THREE_SOURCES at a local copy of three.module.js.', null);
  console.error('[UMBRA]', err);
  return;
}
const REV = parseInt(THREE.REVISION, 10) || 160;
const LIGHT_SCALE = REV >= 155 ? Math.PI : 1; // physically-based light units since r155

// =============================================================================
// RENDERER, SCENE, CAMERA
// =============================================================================
const container = ui.game;
let renderer;
try {
  const opts = { antialias: true, powerPreference: 'high-performance' };
  if (container.tagName === 'CANVAS') opts.canvas = container;
  renderer = new THREE.WebGLRenderer(opts);
} catch (err) {
  setOverlay('UMBRA', 'WebGL is not available in this browser, so the game cannot start.', null);
  console.error('[UMBRA]', err);
  return;
}
if (container.tagName === 'CANVAS') {
  // a <canvas id="game"> with no CSS size stays at the browser default 300×150 — make it fill the window
  const r = container.getBoundingClientRect();
  if ((Math.round(r.width) === 300 && Math.round(r.height) === 150) || r.width < 40 || r.height < 40) {
    container.style.cssText += ';position:fixed;inset:0;width:100vw;height:100vh;display:block;z-index:0;';
  }
} else {
  container.appendChild(renderer.domElement);
  renderer.domElement.style.display = 'block';
  renderer.domElement.style.width = '100%';
  renderer.domElement.style.height = '100%';
  const r = container.getBoundingClientRect();
  if (r.height < 40 || r.width < 40) container.style.cssText += ';position:fixed;inset:0;z-index:0;';
}
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
if ('outputColorSpace' in renderer) renderer.outputColorSpace = THREE.SRGBColorSpace;
else if ('outputEncoding' in renderer && THREE.sRGBEncoding !== undefined) renderer.outputEncoding = THREE.sRGBEncoding;
renderer.toneMapping = THREE.NoToneMapping;
renderer.shadowMap.enabled = false;
renderer.setClearColor(0x16070f, 1);

const scene = new THREE.Scene();
const FOG_BASE = new THREE.Color(0x2a0f1c);
const FOG_ECLIPSE = new THREE.Color(0x140818);
scene.fog = new THREE.Fog(FOG_BASE.clone(), 86, 120);

const camera = new THREE.OrthographicCamera(-14, 14, 8, -8, 0.5, 240);
scene.add(camera);
const CAM = {
  elev: 56 * DEG,
  dist: 80,
  baseHalfW: 14.2,
  minHalfH: 7.4,
  halfW: 13.6,
  halfH: 7.65,
  zoom: 1,
  tx: 0,
  tz: 52,
  shake: 0,
  pxPerUnit: 40,
};
function placeCamera(shx = 0, shz = 0) {
  camera.position.set(CAM.tx + shx, Math.sin(CAM.elev) * CAM.dist, CAM.tz + Math.cos(CAM.elev) * CAM.dist + shz);
  camera.lookAt(CAM.tx + shx, 0, CAM.tz + shz);
}
let viewW = 1, viewH = 1;
function applyFrustum() {
  const hw = CAM.halfW * CAM.zoom, hh = CAM.halfH * CAM.zoom;
  camera.left = -hw; camera.right = hw; camera.top = hh; camera.bottom = -hh;
  camera.updateProjectionMatrix();
  CAM.pxPerUnit = (viewH * renderer.getPixelRatio()) / (2 * hh);
}
function resize() {
  let w = 0, h = 0;
  const r = container.getBoundingClientRect();
  w = r.width; h = r.height;
  if (w < 40 || h < 40) { w = window.innerWidth; h = window.innerHeight; }
  viewW = Math.max(1, Math.floor(w)); viewH = Math.max(1, Math.floor(h));
  renderer.setPixelRatio(PERF.cap);
  renderer.setSize(viewW, viewH, false);
  const aspect = viewW / viewH;
  CAM.halfW = CAM.baseHalfW;
  CAM.halfH = CAM.halfW / aspect;
  if (CAM.halfH < CAM.minHalfH) { CAM.halfH = CAM.minHalfH; CAM.halfW = CAM.halfH * aspect; }
  applyFrustum();
  if (typeof onLayoutChanged === 'function') onLayoutChanged();
}

// =============================================================================
// PROCEDURAL TEXTURES
// =============================================================================
function mulberry(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function makeCanvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
function finishTexture(c, repeat) {
  const t = new THREE.CanvasTexture(c);
  if ('colorSpace' in t) t.colorSpace = THREE.SRGBColorSpace;
  else if (THREE.sRGBEncoding !== undefined) t.encoding = THREE.sRGBEncoding;
  if (repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(repeat, repeat); }
  t.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy ? renderer.capabilities.getMaxAnisotropy() : 1);
  t.needsUpdate = true;
  return t;
}
function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y); g.lineTo(x + w - r, y); g.quadraticCurveTo(x + w, y, x + w, y + r);
  g.lineTo(x + w, y + h - r); g.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  g.lineTo(x + r, y + h); g.quadraticCurveTo(x, y + h, x, y + h - r);
  g.lineTo(x, y + r); g.quadraticCurveTo(x, y, x + r, y);
  g.closePath();
}
function stoneTexture(seed, base, spread, grout) {
  // 4×4 big square flagstones; some split in two; faint carved rings on a few
  const S = 512, c = makeCanvas(S, S), g = c.getContext('2d'), R = mulberry(seed);
  g.fillStyle = grout; g.fillRect(0, 0, S, S);
  const T = S / 4;
  const slab = (x, y, w, h) => {
    const k = R();
    const cr = base[0] + (k - 0.5) * spread, cg = base[1] + (k - 0.5) * spread * 0.85, cb = base[2] + (k - 0.5) * spread;
    g.fillStyle = `rgb(${cr | 0},${cg | 0},${cb | 0})`;
    roundRect(g, x + 2.5, y + 2.5, w - 5, h - 5, 5); g.fill();
    const grd = g.createLinearGradient(x, y, x + w, y + h);
    grd.addColorStop(0, 'rgba(255,240,255,0.07)'); grd.addColorStop(1, 'rgba(0,0,0,0.10)');
    g.fillStyle = grd; roundRect(g, x + 2.5, y + 2.5, w - 5, h - 5, 5); g.fill();
  };
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 4; col++) {
      const x = col * T, y = row * T, r = R();
      if (r < 0.22) { slab(x, y, T / 2, T); slab(x + T / 2, y, T / 2, T); }
      else if (r < 0.4) { slab(x, y, T, T / 2); slab(x, y + T / 2, T, T / 2); }
      else slab(x, y, T, T);
      if (R() < 0.18) {
        g.strokeStyle = 'rgba(25,10,30,0.28)'; g.lineWidth = 2.5;
        g.beginPath(); g.arc(x + T / 2, y + T / 2, T * 0.28, 0, Math.PI * 2); g.stroke();
        g.beginPath(); g.arc(x + T / 2, y + T / 2, T * 0.16, 0, Math.PI * 2); g.stroke();
      }
    }
  }
  for (let i = 0; i < 3200; i++) {
    const x = R() * S, y = R() * S, v = R();
    g.fillStyle = v > 0.5 ? `rgba(255,240,255,${0.02 + R() * 0.04})` : `rgba(0,0,0,${0.04 + R() * 0.07})`;
    g.fillRect(x, y, 1 + R() * 2, 1 + R() * 2);
  }
  g.strokeStyle = 'rgba(20,8,24,0.4)'; g.lineWidth = 1.4;
  for (let i = 0; i < 10; i++) {
    let x = R() * S, y = R() * S;
    g.beginPath(); g.moveTo(x, y);
    for (let k = 0; k < 5; k++) { x += (R() - 0.5) * 36; y += (R() - 0.5) * 36; g.lineTo(x, y); }
    g.stroke();
  }
  return c;
}
function rockTexture() {
  const S = 256, c = makeCanvas(S, S), g = c.getContext('2d'), R = mulberry(31);
  g.fillStyle = '#3a2a33'; g.fillRect(0, 0, S, S);
  for (let i = 0; i < 18; i++) {
    const y = R() * S, h = 4 + R() * 16;
    g.fillStyle = `rgba(${40 + R() * 30},${26 + R() * 18},${34 + R() * 22},0.7)`;
    g.fillRect(0, y, S, h);
  }
  for (let i = 0; i < 1500; i++) { g.fillStyle = `rgba(0,0,0,${R() * 0.18})`; g.fillRect(R() * S, R() * S, 2, 2); }
  return c;
}
function glowGradientTexture() {
  // side walls of the stone slabs: v = 1 - (y + depth); bright where the stone meets the lava
  const c = makeCanvas(4, 256), g = c.getContext('2d');
  const grd = g.createLinearGradient(0, 0, 0, 256);
  grd.addColorStop(0.0, '#ff7a1a');
  grd.addColorStop(0.36, '#ff6a12');
  grd.addColorStop(0.52, '#3a0c00');
  grd.addColorStop(0.62, '#000000');
  grd.addColorStop(1.0, '#000000');
  g.fillStyle = grd; g.fillRect(0, 0, 4, 256);
  const t = new THREE.CanvasTexture(c);
  if ('colorSpace' in t) t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = THREE.RepeatWrapping; t.wrapT = THREE.ClampToEdgeWrapping;
  return t;
}
function brickTexture() {
  const S = 256, c = makeCanvas(S, S), g = c.getContext('2d'), R = mulberry(77);
  g.fillStyle = '#1e1420'; g.fillRect(0, 0, S, S);
  const bh = S / 6, bw = S / 3;
  for (let row = 0; row < 6; row++) for (let col = -1; col < 4; col++) {
    const x = col * bw + (row % 2) * bw * 0.5, y = row * bh, k = R();
    g.fillStyle = `rgb(${70 + k * 26 | 0},${52 + k * 18 | 0},${66 + k * 22 | 0})`;
    roundRect(g, x + 3, y + 3, bw - 6, bh - 6, 5); g.fill();
    g.fillStyle = 'rgba(255,230,255,0.07)'; g.fillRect(x + 5, y + 4, bw - 10, 4);
  }
  return c;
}
function radialTexture(stops, size = 128) {
  const c = makeCanvas(size, size), g = c.getContext('2d');
  const grd = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  for (const [o, col] of stops) grd.addColorStop(o, col);
  g.fillStyle = grd; g.fillRect(0, 0, size, size);
  return finishTexture(c);
}
function raysTexture() {
  const S = 256, c = makeCanvas(S, S), g = c.getContext('2d');
  g.translate(S / 2, S / 2);
  for (let i = 0; i < 16; i++) {
    g.rotate((Math.PI * 2) / 16);
    const grd = g.createLinearGradient(0, 0, S / 2, 0);
    grd.addColorStop(0, 'rgba(255,230,160,0.9)'); grd.addColorStop(1, 'rgba(255,180,60,0)');
    g.fillStyle = grd;
    g.beginPath(); g.moveTo(0, -5); g.lineTo(S / 2, (i % 2 ? -1 : -3)); g.lineTo(S / 2, (i % 2 ? 1 : 3)); g.lineTo(0, 5); g.fill();
  }
  return finishTexture(c);
}
function runeCircleTexture(seed) {
  const S = 512, c = makeCanvas(S, S), g = c.getContext('2d'), R = mulberry(seed);
  g.translate(S / 2, S / 2);
  g.strokeStyle = '#ffffff'; g.fillStyle = '#ffffff';
  g.lineWidth = 10; g.beginPath(); g.arc(0, 0, 236, 0, Math.PI * 2); g.stroke();
  g.lineWidth = 4; g.beginPath(); g.arc(0, 0, 212, 0, Math.PI * 2); g.stroke();
  g.lineWidth = 3; g.beginPath(); g.arc(0, 0, 150, 0, Math.PI * 2); g.stroke();
  for (let i = 0; i < 24; i++) {
    g.save(); g.rotate((i / 24) * Math.PI * 2);
    g.translate(0, -182);
    const k = Math.floor(R() * 4);
    g.lineWidth = 4; g.beginPath();
    if (k === 0) { g.moveTo(-8, -10); g.lineTo(0, 10); g.lineTo(8, -10); }
    else if (k === 1) { g.moveTo(-9, 0); g.lineTo(9, 0); g.moveTo(0, -10); g.lineTo(0, 10); }
    else if (k === 2) { g.arc(0, 0, 8, 0, Math.PI * 1.5); }
    else { g.moveTo(-8, -8); g.lineTo(8, 8); g.moveTo(8, -8); g.lineTo(-8, 8); }
    g.stroke(); g.restore();
  }
  for (let i = 0; i < 3; i++) {
    g.save(); g.rotate((i / 3) * Math.PI * 2 + 0.3);
    g.lineWidth = 3; g.beginPath(); g.moveTo(0, -150); g.lineTo(130, 75); g.lineTo(-130, 75); g.closePath(); g.stroke();
    g.restore();
  }
  return finishTexture(c);
}
function arrowPlateTexture(dir) {
  const S = 256, c = makeCanvas(S, S), g = c.getContext('2d');
  g.translate(S / 2, S / 2);
  g.strokeStyle = '#fff'; g.fillStyle = '#fff';
  g.lineWidth = 10; g.beginPath(); g.arc(0, 0, 112, 0, Math.PI * 2); g.stroke();
  g.lineWidth = 4; g.beginPath(); g.arc(0, 0, 92, 0, Math.PI * 2); g.stroke();
  const arrow = (s) => {
    g.save(); g.scale(s, 1);
    g.lineWidth = 12; g.beginPath(); g.arc(0, 0, 58, Math.PI * 1.1, Math.PI * 1.9); g.stroke();
    g.beginPath(); g.moveTo(58 * Math.cos(Math.PI * 1.9) + 18, 58 * Math.sin(Math.PI * 1.9) - 2);
    g.lineTo(58 * Math.cos(Math.PI * 1.9) - 6, 58 * Math.sin(Math.PI * 1.9) - 22);
    g.lineTo(58 * Math.cos(Math.PI * 1.9) - 10, 58 * Math.sin(Math.PI * 1.9) + 14); g.closePath(); g.fill();
    g.restore();
  };
  if (dir === 0) { arrow(1); g.rotate(Math.PI); arrow(1); } else arrow(dir > 0 ? 1 : -1);
  return finishTexture(c);
}
function textTexture(text, opts = {}) {
  const font = opts.font || '900 64px system-ui, sans-serif';
  const c = makeCanvas(opts.w || 256, opts.h || 128), g = c.getContext('2d');
  g.font = font; g.textAlign = 'center'; g.textBaseline = 'middle';
  if (opts.bg) { g.fillStyle = opts.bg; roundRect(g, 6, 6, c.width - 12, c.height - 12, 22); g.fill(); }
  if (opts.stroke) { g.lineWidth = opts.strokeWidth || 10; g.strokeStyle = opts.stroke; g.strokeText(text, c.width / 2, c.height / 2 + 4); }
  g.fillStyle = opts.color || '#fff';
  g.fillText(text, c.width / 2, c.height / 2 + 4);
  return finishTexture(c);
}

const TEX = {
  stone: finishTexture(stoneTexture(11, [96, 82, 98], 18, '#2c2230'), 1 / 9),
  strip: finishTexture(stoneTexture(23, [84, 74, 112], 16, '#211a36'), 1 / 9),
  islet: finishTexture(stoneTexture(41, [70, 56, 68], 14, '#1c1419'), 1 / 6),
  rock: finishTexture(rockTexture(), 1 / 3),
  sideGlow: glowGradientTexture(),
  brick: finishTexture(brickTexture(), 1 / 3),
  glow: radialTexture([[0, 'rgba(255,255,255,1)'], [0.25, 'rgba(255,255,255,0.55)'], [1, 'rgba(255,255,255,0)']]),
  softDot: radialTexture([[0, 'rgba(0,0,0,0.6)'], [0.6, 'rgba(0,0,0,0.3)'], [1, 'rgba(0,0,0,0)']], 64),
  rays: raysTexture(),
  rune: runeCircleTexture(5),
  runeB: runeCircleTexture(9),
  plateL: arrowPlateTexture(-1),
  plateR: arrowPlateTexture(1),
  plateLR: arrowPlateTexture(0),
};
TEX.sideGlow.repeat.set(1, 1);
TEX.brickBox = TEX.brick.clone();
TEX.brickBox.repeat.set(2, 1);
TEX.brickBox.needsUpdate = true;

// =============================================================================
// MATERIALS & SHADERS
// =============================================================================
const MAT = {
  stoneTop: new THREE.MeshLambertMaterial({ map: TEX.stone }),
  stripTop: new THREE.MeshLambertMaterial({ map: TEX.strip }),
  isletTop: new THREE.MeshLambertMaterial({ map: TEX.islet }),
  side: new THREE.MeshLambertMaterial({ map: TEX.rock, emissive: 0xffffff, emissiveMap: TEX.sideGlow }),
  wall: new THREE.MeshLambertMaterial({ map: TEX.brickBox }),
  wallCap: new THREE.MeshLambertMaterial({ color: 0x6a5468, flatShading: true }),
  basalt: new THREE.MeshLambertMaterial({ color: 0x33263a, flatShading: true }),
  basaltDark: new THREE.MeshLambertMaterial({ color: 0x1f1624, flatShading: true }),
  pillar: new THREE.MeshLambertMaterial({ color: 0x75607a, flatShading: true }),
  gold: new THREE.MeshLambertMaterial({ color: 0xffc04a, emissive: 0x5a3000, flatShading: true }),
  bronze: new THREE.MeshLambertMaterial({ color: 0x9a6a3a, emissive: 0x2a1000, flatShading: true }),
  runeCyan: new THREE.MeshBasicMaterial({ color: 0x45eeff }),
  runeViolet: new THREE.MeshBasicMaterial({ color: 0xa070ff }),
  fireCore: new THREE.MeshBasicMaterial({ color: 0xffdc7a }),
  fireOuter: new THREE.MeshBasicMaterial({ color: 0xff6a1a }),
  shadowFake: new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.28, depthWrite: false }),
  blob: new THREE.MeshBasicMaterial({ map: TEX.softDot, transparent: true, depthWrite: false }),
};
MAT.shadowFake.polygonOffset = true; MAT.shadowFake.polygonOffsetFactor = -1; MAT.shadowFake.polygonOffsetUnits = -2;
MAT.blob.polygonOffset = true; MAT.blob.polygonOffsetFactor = -1; MAT.blob.polygonOffsetUnits = -2;

function additive(color, opacity = 1, map = TEX.glow) {
  return new THREE.MeshBasicMaterial({ color, map, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false });
}
function spriteMat(color, opacity = 1, map = TEX.glow, depthTest = true) {
  return new THREE.SpriteMaterial({ color, map, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false, depthTest });
}
const vec3 = (hex) => new THREE.Vector3(((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255);

const NOISE_GLSL = `
float hash21(vec2 p){ p = fract(p*vec2(123.34,456.21)); p += dot(p,p+45.32); return fract(p.x*p.y); }
float vnoise(vec2 p){ vec2 i=floor(p), f=fract(p); vec2 u=f*f*(3.0-2.0*f);
  return mix(mix(hash21(i),hash21(i+vec2(1.0,0.0)),u.x), mix(hash21(i+vec2(0.0,1.0)),hash21(i+vec2(1.0,1.0)),u.x), u.y); }
float fbm(vec2 p){ float v=0.0, a=0.5; for(int i=0;i<4;i++){ v+=a*vnoise(p); p=p*2.03+vec2(1.7,9.2); a*=0.5; } return v; }
`;
const WORLD_VERT = `
varying vec2 vW; varying vec2 vUv;
void main(){ vUv = uv; vec4 w = modelMatrix*vec4(position,1.0); vW = w.xz; gl_Position = projectionMatrix*viewMatrix*w; }`;

function makeLavaMaterial(dim) {
  return new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uDim: { value: dim }, uHeat: { value: 1 } },
    vertexShader: WORLD_VERT,
    fragmentShader: `
      uniform float uTime; uniform float uDim; uniform float uHeat; varying vec2 vW;
      ${NOISE_GLSL}
      void main(){
        vec2 p = vW*0.32;
        float t = uTime*0.11;
        vec2 q = vec2(fbm(p + vec2(t, -t*0.7)), fbm(p + vec2(-t*0.6, t) + 3.1));
        float n = fbm(p*1.25 + q*1.9 + vec2(0.0, t*1.4));
        float crust = smoothstep(0.36, 0.62, n);
        vec3 dark = vec3(0.30, 0.035, 0.02);
        vec3 mid  = vec3(0.96, 0.30, 0.04);
        vec3 hot  = vec3(1.0, 0.84, 0.38);
        vec3 col = mix(dark, mid, crust);
        col = mix(col, hot, smoothstep(0.64, 0.86, n));
        float veins = smoothstep(0.47, 0.5, abs(fract(n*5.0 + t*2.0) - 0.5));
        col += vec3(0.25, 0.08, 0.0) * veins * crust;
        col *= (0.93 + 0.07*sin(uTime*1.6 + vW.x*0.35 + vW.y*0.21)) * uHeat;
        float far = uDim < 0.99 ? mix(0.85, 0.22, smoothstep(10.8, 22.0, abs(vW.x))) : 1.0;
        gl_FragColor = vec4(col*uDim*far, 1.0);
      }`,
  });
}
const lavaMat = makeLavaMaterial(1.0);
const abyssMat = makeLavaMaterial(0.42);

const lavaFallMat = new THREE.ShaderMaterial({
  uniforms: { uTime: { value: 0 } },
  transparent: true,
  depthWrite: false,
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
  fragmentShader: `
    uniform float uTime; varying vec2 vUv;
    ${NOISE_GLSL}
    void main(){
      float n = fbm(vec2(vUv.x*4.0, vUv.y*3.0 + uTime*1.6));
      float edge = smoothstep(0.0, 0.18, vUv.x) * smoothstep(1.0, 0.82, vUv.x);
      vec3 col = mix(vec3(0.75,0.15,0.02), vec3(1.0,0.75,0.3), smoothstep(0.45,0.8,n));
      float a = edge * (0.75 + 0.25*n) * smoothstep(0.0, 0.12, vUv.y);
      gl_FragColor = vec4(col, a);
    }`,
});

const portalMat = new THREE.ShaderMaterial({
  uniforms: { uTime: { value: 0 }, uPower: { value: 0.6 } },
  transparent: true,
  depthWrite: false,
  blending: THREE.AdditiveBlending,
  side: THREE.DoubleSide,
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
  fragmentShader: `
    uniform float uTime; uniform float uPower; varying vec2 vUv;
    ${NOISE_GLSL}
    void main(){
      vec2 c = vUv - vec2(0.5, 0.45);
      float r = length(c*vec2(1.0, 0.85));
      float a = atan(c.y, c.x);
      float swirl = fbm(vec2(a*1.6 + r*6.0 - uTime*1.2, r*4.0 - uTime*0.6));
      float mask = smoothstep(0.52, 0.18, r);
      vec3 col = mix(vec3(0.35,0.15,0.85), vec3(0.25,0.95,1.0), swirl);
      col = mix(col, vec3(1.0,0.85,0.45), smoothstep(0.7, 1.0, swirl) * 0.6);
      gl_FragColor = vec4(col * mask * (0.55 + swirl*0.8) * uPower, mask);
    }`,
});

const fireColumnMat = new THREE.ShaderMaterial({
  uniforms: { uTime: { value: 0 } },
  transparent: true,
  depthWrite: false,
  blending: THREE.AdditiveBlending,
  side: THREE.DoubleSide,
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
  fragmentShader: `
    uniform float uTime; varying vec2 vUv;
    ${NOISE_GLSL}
    void main(){
      float n = fbm(vec2(vUv.x*6.0, vUv.y*2.5 - uTime*3.5));
      float fade = smoothstep(1.0, 0.25, vUv.y);
      vec3 col = mix(vec3(1.0,0.25,0.02), vec3(1.0,0.85,0.4), n);
      gl_FragColor = vec4(col * fade * (0.6 + n), 1.0);
    }`,
});

// ---- the shadow bridge (opaque: never sorted against other transparent things)
const BRIDGE_VERT = `
varying vec2 vUv; varying vec2 vW;
void main(){ vUv = uv; vec4 w = modelMatrix*vec4(position,1.0); vW = w.xz; gl_Position = projectionMatrix*viewMatrix*w; }`;
const bridgeMat = new THREE.ShaderMaterial({
  uniforms: {
    uTime: { value: 0 },
    uFill: { value: vec3(0x2a1838) },
    uEdge: { value: vec3(0xff5a2a) },
    uGlow: { value: 0.3 },
    uFrozen: { value: 0 },
    uDim: { value: 0 },
    uCrack: { value: 0 },
    uL: { value: CFG.BRIDGE_LENGTH },
    uW: { value: CFG.BRIDGE_WIDTH },
    uVent: { value: [new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4()] },
  },
  vertexShader: BRIDGE_VERT,
  fragmentShader: `
    uniform float uTime, uGlow, uFrozen, uDim, uCrack, uL, uW;
    uniform vec3 uFill, uEdge;
    uniform vec4 uVent[4];
    varying vec2 vUv; varying vec2 vW;
    float h(vec2 p){ return fract(sin(dot(p, vec2(12.9898,78.233)))*43758.5453); }
    void main(){
      float across = abs(vUv.x - 0.5) * uW;
      float along = (1.0 - vUv.y) * uL;
      float dEdge = min(uW*0.5 - across, min(along, uL - along));
      float edge = 1.0 - smoothstep(0.07, 0.15, dEdge);
      float inner = exp(-dEdge*3.2);
      float flow = 0.5 + 0.5*sin(along*2.6 - uTime*4.0 + sin(across*7.0)*0.7);
      vec3 col = uFill * (0.72 + 0.28*flow);
      vec2 cell = floor(vW*2.4);
      float facet = h(cell);
      float sparkle = step(0.93, h(cell + floor(uTime*3.0)));
      col += uEdge * uFrozen * (0.16*facet + 0.22*pow(flow, 6.0) + 0.25*sparkle);
      col = mix(col, uEdge, inner*uGlow*0.4);
      col = mix(col, uEdge, edge);
      float crack = step(0.96 - 0.25*uCrack, h(floor(vW*5.0))) * uCrack;
      col = mix(col, vec3(1.0), crack*0.6);
      for (int i = 0; i < 4; i++) {
        vec4 v = uVent[i];
        if (v.z <= 0.0) continue;
        float d = length(vW - v.xy);
        float k = 1.0 - smoothstep(v.z*0.82, v.z, d);
        if (v.w > 0.0) col = mix(col, vec3(1.0,0.32,0.04) * (0.8 + 0.4*sin(uTime*18.0 + d*6.0)), k*v.w);
        else col = mix(col, vec3(1.0,0.55,0.1), k*(-v.w)*(0.35 + 0.25*sin(uTime*9.0)));
      }
      col *= mix(1.0, 0.55, uDim);
      gl_FragColor = vec4(col, 1.0);
    }`,
});
// ---- Pyre's humanoid shadow silhouette: fill (state colours, facets, vents) + rim
const silFillMat = new THREE.ShaderMaterial({
  uniforms: {
    uTime: { value: 0 },
    uFill: bridgeMat.uniforms.uFill, uEdge: bridgeMat.uniforms.uEdge,
    uGlow: bridgeMat.uniforms.uGlow, uFrozen: bridgeMat.uniforms.uFrozen,
    uDim: bridgeMat.uniforms.uDim, uCrack: bridgeMat.uniforms.uCrack,
    uVent: bridgeMat.uniforms.uVent,
    uO: { value: new THREE.Vector2() }, uD: { value: new THREE.Vector2(0, 1) },
  },
  side: THREE.DoubleSide,
  vertexShader: `varying vec2 vW; void main(){ vec4 w = modelMatrix*vec4(position,1.0); vW = w.xz; gl_Position = projectionMatrix*viewMatrix*w; }`,
  fragmentShader: `
    uniform float uTime, uGlow, uFrozen, uDim, uCrack;
    uniform vec3 uFill, uEdge; uniform vec2 uO, uD; uniform vec4 uVent[4];
    varying vec2 vW;
    float h(vec2 p){ return fract(sin(dot(p, vec2(12.9898,78.233)))*43758.5453); }
    void main(){
      vec2 rel = vW - uO;
      float along = dot(rel, uD);
      float across = rel.x*uD.y - rel.y*uD.x;
      float flow = 0.5 + 0.5*sin(along*2.6 - uTime*4.0 + sin(across*7.0)*0.7);
      vec3 col = uFill * (0.72 + 0.28*flow);
      vec2 cell = floor(vW*2.4);
      float facet = h(cell);
      float sparkle = step(0.93, h(cell + floor(uTime*3.0)));
      col += uEdge * uFrozen * (0.16*facet + 0.22*pow(flow, 6.0) + 0.25*sparkle);
      col = mix(col, uEdge, uGlow*0.12);
      float crack = step(0.96 - 0.25*uCrack, h(floor(vW*5.0))) * uCrack;
      col = mix(col, vec3(1.0), crack*0.6);
      for (int i = 0; i < 4; i++) {
        vec4 v = uVent[i];
        if (v.z <= 0.0) continue;
        float d = length(vW - v.xy);
        float k = 1.0 - smoothstep(v.z*0.82, v.z, d);
        if (v.w > 0.0) col = mix(col, vec3(1.0,0.32,0.04) * (0.8 + 0.4*sin(uTime*18.0 + d*6.0)), k*v.w);
        else col = mix(col, vec3(1.0,0.55,0.1), k*(-v.w)*(0.35 + 0.25*sin(uTime*9.0)));
      }
      col *= mix(1.0, 0.55, uDim);
      gl_FragColor = vec4(col, 1.0);
    }`,
});
const silRimMat = new THREE.MeshBasicMaterial({ color: 0xff5a2a, side: THREE.DoubleSide });
const silEyeMat = new THREE.MeshBasicMaterial({ color: 0xfff09a, side: THREE.DoubleSide });
const silEyeGlowMat = new THREE.MeshBasicMaterial({ color: 0xffc35a, map: TEX.glow, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
const silHeelRingMat = new THREE.MeshBasicMaterial({ color: 0xffa040, transparent: true, opacity: 0.7, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });

// ---- crystal foothold: faceted purple-cyan disc + neon countdown ring
const footholdMat = new THREE.ShaderMaterial({
  uniforms: { uTime: { value: 0 }, uLeft: { value: 1 }, uAlpha: { value: 0 }, uR: { value: 2.25 } },
  transparent: true,
  depthWrite: false,
  vertexShader: `varying vec2 vUv; varying vec2 vW; void main(){ vUv = uv; vec4 w = modelMatrix*vec4(position,1.0); vW = w.xz; gl_Position = projectionMatrix*viewMatrix*w; }`,
  fragmentShader: `
    uniform float uTime, uLeft, uAlpha, uR; varying vec2 vUv; varying vec2 vW;
    vec2 h2(vec2 p){ p = vec2(dot(p, vec2(127.1,311.7)), dot(p, vec2(269.5,183.3))); return fract(sin(p)*43758.5453); }
    void main(){
      vec2 c = vUv - 0.5; float r = length(c) * 2.0;
      if (r > 1.0) discard;
      // crystal facets (voronoi on the local disc): F1 cell id + F2-F1 edges
      vec2 q = c * uR * 2.2, iq = floor(q), fq = fract(q);
      float f1 = 9.0, f2 = 9.0; vec2 id = vec2(0.0);
      for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
        vec2 g = vec2(float(x), float(y)); vec2 o = h2(iq + g);
        float d = length(g + o - fq);
        if (d < f1) { f2 = f1; f1 = d; id = iq + g; } else if (d < f2) f2 = d;
      }
      float facet = h2(id).x;
      float edgeLine = 1.0 - smoothstep(0.02, 0.09, f2 - f1);
      vec3 purple = vec3(0.50, 0.24, 1.0), cyan = vec3(0.30, 0.95, 1.0);
      vec3 col = mix(purple, cyan, clamp(0.25 + 0.55*r + 0.35*(facet - 0.5), 0.0, 1.0));
      col *= 0.62 + 0.45*facet;
      col += cyan * edgeLine * 0.65;
      col += vec3(0.85, 0.95, 1.0) * 0.35 * pow(0.5 + 0.5*sin(r*10.0 - uTime*5.0), 10.0);
      float disc = 1.0 - smoothstep(0.80, 0.84, r);
      // neon outer ring: the lit arc shrinks as the safe time runs out
      float ring = smoothstep(0.87, 0.91, r) * (1.0 - smoothstep(0.96, 1.0, r));
      float ang = atan(c.x, c.y) / 6.2831853 + 0.5;
      float on = step(ang, uLeft);
      vec3 ringCol = mix(vec3(1.0, 0.42, 0.25), vec3(0.75, 1.0, 1.0), smoothstep(0.12, 0.45, uLeft));
      float a = disc * 0.8 + ring * (0.2 + 0.8*on);
      vec3 outc = col * disc + ringCol * ring * (0.25 + 1.3*on);
      // dissolve in the last quarter: facets wink out and the disc flickers
      float diss = 1.0 - smoothstep(0.0, 0.28, uLeft);
      if (disc > 0.5 && facet < diss * 0.85) a *= 0.25;
      a *= 1.0 - diss * 0.35 * step(0.5, fract(uTime * 7.0));
      gl_FragColor = vec4(outc, a * uAlpha);
    }`,
});

const previewMat = new THREE.ShaderMaterial({
  uniforms: { uTime: { value: 0 }, uL: { value: CFG.BRIDGE_LENGTH }, uW: { value: CFG.BRIDGE_WIDTH }, uAlpha: { value: 0 }, uColor: { value: vec3(0x8ff8ff) } },
  transparent: true,
  depthWrite: false,
  blending: THREE.AdditiveBlending,
  vertexShader: BRIDGE_VERT,
  fragmentShader: `
    uniform float uTime, uL, uW, uAlpha; uniform vec3 uColor; varying vec2 vUv; varying vec2 vW;
    void main(){
      float across = abs(vUv.x - 0.5) * uW;
      float along = (1.0 - vUv.y) * uL;
      float dEdge = min(uW*0.5 - across, min(along, uL - along));
      float edge = 1.0 - smoothstep(0.03, 0.09, dEdge);
      float dash = step(0.45, fract(along*1.4 - uTime*1.5 + vUv.x*0.0));
      float a = edge * (0.35 + 0.65*dash) * uAlpha;
      gl_FragColor = vec4(uColor * a, a);
    }`,
});
const ringMat = new THREE.ShaderMaterial({
  uniforms: { uProgress: { value: 1 }, uColor: { value: vec3(0xbffcff) }, uAlpha: { value: 1 } },
  transparent: true,
  depthWrite: false,
  blending: THREE.AdditiveBlending,
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
  fragmentShader: `
    uniform float uProgress, uAlpha; uniform vec3 uColor; varying vec2 vUv;
    void main(){
      vec2 c = vUv - 0.5; float r = length(c) * 2.0;
      float ring = smoothstep(0.70, 0.76, r) * (1.0 - smoothstep(0.92, 0.98, r));
      float ang = atan(c.x, c.y) / 6.2831853 + 0.5;
      float on = step(ang, uProgress);
      float track = ring * 0.18;
      float a = (ring * on + track) * uAlpha;
      gl_FragColor = vec4(uColor * a, a);
    }`,
});
const RING_OK = vec3(0xbffcff), RING_LOW = vec3(0xffa040);
const beamMat = new THREE.MeshBasicMaterial({ color: 0xffc35a, map: TEX.glow, transparent: true, opacity: 0.3, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });

// =============================================================================
// WORLD BUILDING
// =============================================================================
const world = new THREE.Group();
scene.add(world);
const rand = mulberry(1337);
const SLAB_DEPTH = 0.62, BEVEL_T = 0.08, BEVEL_S = 0.1;
const LAVA_Y = -0.35;

function buildFloor() {
  for (const poly of LEVEL.polys) {
    const shape = new THREE.Shape();
    shape.moveTo(poly.pts[0][0], -poly.pts[0][1]);
    for (let i = 1; i < poly.pts.length; i++) shape.lineTo(poly.pts[i][0], -poly.pts[i][1]);
    shape.closePath();
    for (const hole of poly.holes) shape.holes.push(new THREE.Path(hole.map((p) => new THREE.Vector2(p[0], -p[1]))));
    const geo = new THREE.ExtrudeGeometry(shape, {
      depth: SLAB_DEPTH, bevelEnabled: true, bevelThickness: BEVEL_T, bevelSize: BEVEL_S, bevelOffset: -BEVEL_S, bevelSegments: 1, curveSegments: 1, steps: 1,
    });
    geo.rotateX(-Math.PI / 2);
    geo.translate(0, -(SLAB_DEPTH + BEVEL_T), 0);
    const top = poly.kind === 'strip' || poly.kind === 'island' ? MAT.stripTop : poly.kind === 'islet' ? MAT.isletTop : MAT.stoneTop;
    const mesh = new THREE.Mesh(geo, [top, MAT.side]);
    world.add(mesh);
  }
  const lava = new THREE.Mesh(new THREE.PlaneGeometry(2 * CFG.X_EXT + 4, CFG.Z_BACK - CFG.Z_FRONT + 6), lavaMat);
  lava.rotation.x = -Math.PI / 2;
  lava.position.set(0, LAVA_Y, (CFG.Z_BACK + CFG.Z_FRONT) / 2);
  world.add(lava);
}

function buildWalls() {
  const len = CFG.Z_BACK - CFG.Z_FRONT;
  const segLen = 4;
  const nSeg = Math.ceil(len / segLen);
  const segGeo = new THREE.BoxGeometry(2.2, 1.75, segLen);
  const capGeo = new THREE.BoxGeometry(2.45, 0.24, segLen);
  const merlonGeo = new THREE.BoxGeometry(0.75, 0.55, 1.1);
  const segs = new THREE.InstancedMesh(segGeo, MAT.wall, nSeg * 2);
  const caps = new THREE.InstancedMesh(capGeo, MAT.wallCap, nSeg * 2);
  const merlons = new THREE.InstancedMesh(merlonGeo, MAT.wallCap, nSeg * 2 * 2);
  const m4 = new THREE.Matrix4();
  let k = 0, km = 0;
  for (const side of [-1, 1]) {
    for (let i = 0; i < nSeg; i++) {
      const z = CFG.Z_FRONT + segLen * (i + 0.5);
      m4.makeTranslation(side * 9.7, 0.175, z); segs.setMatrixAt(k, m4);
      m4.makeTranslation(side * 9.72, 1.17, z); caps.setMatrixAt(k, m4);
      k++;
      for (const dz of [-1, 1]) { m4.makeTranslation(side * 10.35, 1.55, z + dz); merlons.setMatrixAt(km++, m4); }
    }
  }
  world.add(segs, caps, merlons);
  // glowing border strips on the inner faces
  for (const side of [-1, 1]) {
    const strip = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.1, len), side < 0 ? MAT.runeViolet : MAT.runeCyan);
    strip.position.set(side * 8.58, 0.42, (CFG.Z_BACK + CFG.Z_FRONT) / 2);
    world.add(strip);
    const strip2 = strip.clone();
    strip2.position.y = 0.95;
    strip2.scale.y = 0.5;
    world.add(strip2);
  }
  // end walls
  const back = new THREE.Mesh(new THREE.BoxGeometry(2 * CFG.X_EXT + 0.2, 2.2, 1.4), MAT.wall);
  back.position.set(0, 0.4, CFG.Z_BACK - 0.5);
  world.add(back);
  const front = back.clone();
  front.position.set(0, 0.4, CFG.Z_FRONT + 0.9);
  world.add(front);
}

function buildAbyss() {
  const sea = new THREE.Mesh(new THREE.PlaneGeometry(160, 260), abyssMat);
  sea.rotation.x = -Math.PI / 2;
  sea.position.set(0, -7.5, 0);
  world.add(sea);
  // basalt columns outside the walls
  const colGeo = new THREE.CylinderGeometry(1, 1.12, 1, 6);
  const count = 120;
  const cols = new THREE.InstancedMesh(colGeo, MAT.basalt, count);
  const capCols = new THREE.InstancedMesh(colGeo, MAT.basaltDark, count);
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
  for (let i = 0; i < count; i++) {
    const side = i % 2 ? 1 : -1;
    const x = side * (12.6 + Math.pow(rand(), 1.6) * 18);
    const z = CFG.Z_FRONT - 10 + rand() * (CFG.Z_BACK - CFG.Z_FRONT + 20);
    const r = 0.7 + rand() * 1.6;
    const top = -2.6 + rand() * 4.2 - Math.max(0, Math.abs(x) - 18) * 0.25;
    const h = top + 7.6;
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rand() * Math.PI);
    p.set(x, -7.6 + h / 2, z); s.set(r, h, r);
    m4.compose(p, q, s); cols.setMatrixAt(i, m4);
    p.set(x, top + 0.06, z); s.set(r * 0.92, 0.14, r * 0.92);
    m4.compose(p, q, s); capCols.setMatrixAt(i, m4);
  }
  world.add(cols, capCols);
  // tall spires further out
  const spireGeo = new THREE.ConeGeometry(1, 1, 5);
  for (let i = 0; i < 16; i++) {
    const side = i % 2 ? 1 : -1;
    const sp = new THREE.Mesh(spireGeo, MAT.basaltDark);
    const h = 9 + rand() * 9;
    sp.scale.set(1.6 + rand() * 1.5, h, 1.6 + rand() * 1.5);
    sp.position.set(side * (26 + rand() * 10), -7.5 + h / 2, CFG.Z_FRONT + rand() * (CFG.Z_BACK - CFG.Z_FRONT));
    sp.rotation.y = rand() * Math.PI;
    world.add(sp);
  }
  // lava falls pouring off the outer walls
  for (let i = 0; i < 10; i++) {
    const side = i % 2 ? 1 : -1;
    const z = CFG.Z_FRONT + 8 + i * 12.5 + rand() * 4;
    const fall = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 8.6), lavaFallMat);
    fall.position.set(side * 10.86, -3.2, z);
    fall.rotation.y = side * Math.PI / 2;
    world.add(fall);
  }
}

// floating rocks (animated)
const floatingRocks = [];
function buildFloatingRocks() {
  const geo = new THREE.DodecahedronGeometry(1, 0);
  for (let i = 0; i < 14; i++) {
    const side = i % 2 ? 1 : -1;
    const m = new THREE.Mesh(geo, MAT.basalt);
    const s = 0.4 + rand() * 0.9;
    m.scale.set(s, s * 0.8, s);
    m.position.set(side * (13 + rand() * 8), 0.5 + rand() * 3, CFG.Z_FRONT + rand() * (CFG.Z_BACK - CFG.Z_FRONT));
    m.userData = { y0: m.position.y, ph: rand() * 6.28, sp: 0.4 + rand() * 0.5 };
    world.add(m);
    floatingRocks.push(m);
  }
}

// fake planar shadows (rotate with the sun, same direction as Pyre's bridge)
const shadowCasters = [];
const shadowQuadGeo = new THREE.PlaneGeometry(1, 1);
shadowQuadGeo.rotateX(-Math.PI / 2);
shadowQuadGeo.translate(0, 0, 0.5);
function addFakeShadow(x, z, width, height, y = 0.015) {
  const m = new THREE.Mesh(shadowQuadGeo, MAT.shadowFake);
  m.position.set(x, y, z);
  m.renderOrder = 1;
  m.userData = { width, height };
  world.add(m);
  shadowCasters.push(m);
  return m;
}

// rune pillars & braziers on the walls
const runeRings = [];
const flames = [];
function buildDecor() {
  const bodyGeo = new THREE.BoxGeometry(0.8, 2.6, 0.8);
  const capGeo = new THREE.BoxGeometry(1.05, 0.28, 1.05);
  const ringGeo = new THREE.TorusGeometry(0.56, 0.055, 6, 28);
  const crystalGeo = new THREE.OctahedronGeometry(0.22, 0);
  const bowlGeo = new THREE.CylinderGeometry(0.42, 0.26, 0.36, 8);
  const standGeo = new THREE.CylinderGeometry(0.12, 0.2, 0.5, 6);
  const flameGeo = new THREE.ConeGeometry(0.22, 0.7, 6);
  const flameInGeo = new THREE.ConeGeometry(0.12, 0.45, 6);
  let n = 0;
  for (let z = CFG.Z_BACK - 6; z > CFG.Z_FRONT + 3; z -= 10) {
    for (const side of [-1, 1]) {
      const g = new THREE.Group();
      g.position.set(side * 9.75, 1.29, z);
      const body = new THREE.Mesh(bodyGeo, MAT.pillar); body.position.y = 1.3; g.add(body);
      const cap = new THREE.Mesh(capGeo, MAT.wallCap); cap.position.y = 2.72; g.add(cap);
      const cyan = (n + (side > 0 ? 1 : 0)) % 2 === 0;
      const ring = new THREE.Mesh(ringGeo, cyan ? MAT.runeCyan : MAT.runeViolet);
      ring.rotation.x = Math.PI / 2; ring.position.y = 1.6; g.add(ring);
      const crystal = new THREE.Mesh(crystalGeo, cyan ? MAT.runeCyan : MAT.runeViolet); crystal.position.y = 3.25; g.add(crystal);
      const halo = new THREE.Sprite(spriteMat(cyan ? 0x45eeff : 0xa070ff, 0.55)); halo.scale.set(1.3, 1.3, 1); halo.position.y = 3.25; g.add(halo);
      world.add(g);
      runeRings.push({ ring, crystal, ph: rand() * 6.28 });
    }
    n++;
  }
  for (let z = CFG.Z_BACK - 11; z > CFG.Z_FRONT + 3; z -= 10) {
    for (const side of [-1, 1]) {
      const g = new THREE.Group();
      g.position.set(side * 9.7, 1.29, z);
      const stand = new THREE.Mesh(standGeo, MAT.bronze); stand.position.y = 0.25; g.add(stand);
      const bowl = new THREE.Mesh(bowlGeo, MAT.bronze); bowl.position.y = 0.62; g.add(bowl);
      const f1 = new THREE.Mesh(flameGeo, MAT.fireOuter); f1.position.y = 1.05; g.add(f1);
      const f2 = new THREE.Mesh(flameInGeo, MAT.fireCore); f2.position.y = 0.98; g.add(f2);
      const glow = new THREE.Sprite(spriteMat(0xff8a3a, 0.7)); glow.scale.set(2.2, 2.2, 1); glow.position.y = 1.1; g.add(glow);
      world.add(g);
      flames.push({ f1, f2, glow, ph: rand() * 6.28, x: g.position.x, y: g.position.y + 1.2, z });
    }
  }
}

// start dais
function buildStart() {
  const disc = new THREE.Mesh(new THREE.CircleGeometry(3.4, 48), additive(0xffa060, 0.55, TEX.rune));
  disc.rotation.x = -Math.PI / 2; disc.position.set(0, 0.02, 55.0); disc.renderOrder = 1;
  world.add(disc);
  const rim = new THREE.Mesh(new THREE.TorusGeometry(3.5, 0.12, 6, 48), MAT.gold);
  rim.rotation.x = Math.PI / 2; rim.position.set(0, 0.04, 55.0);
  world.add(rim);
  // banners for P1 / P2
  const poleGeo = new THREE.CylinderGeometry(0.07, 0.09, 3.2, 6);
  for (const [x, col, label] of [[-4.6, 0xff6a2a, 'P1'], [4.6, 0x39dcff, 'P2']]) {
    const pole = new THREE.Mesh(poleGeo, MAT.bronze); pole.position.set(x, 1.6, 56.8); world.add(pole);
    const flag = new THREE.Mesh(new THREE.PlaneGeometry(1.3, 1.8), new THREE.MeshLambertMaterial({ color: col, side: THREE.DoubleSide, emissive: col, emissiveIntensity: 0.25 }));
    flag.position.set(x + (x < 0 ? 0.7 : -0.7), 2.3, 56.8); world.add(flag);
    const tag = new THREE.Sprite(new THREE.SpriteMaterial({ map: textTexture(label, { color: '#fff', stroke: '#000', strokeWidth: 8, font: '900 72px system-ui, sans-serif' }), transparent: true, depthWrite: false }));
    tag.scale.set(1.4, 0.7, 1); tag.position.set(x + (x < 0 ? 0.7 : -0.7), 2.35, 56.85); world.add(tag);
    addFakeShadow(x, 56.8, 0.25, 3.2);
  }
}

// checkpoints
const checkpoints = [];
function buildCheckpoints() {
  const spikeGeo = new THREE.OctahedronGeometry(0.28, 0);
  LEVEL.gates.forEach((gate, i) => {
    const g = new THREE.Group();
    g.position.set(gate.checkpoint.x, 0, gate.checkpoint.z);
    const mat = additive(0x9a6aff, 0.35, TEX.runeB);
    const disc = new THREE.Mesh(new THREE.CircleGeometry(1.7, 40), mat);
    disc.rotation.x = -Math.PI / 2; disc.position.y = 0.025; disc.renderOrder = 1; g.add(disc);
    const spikes = [];
    for (const sx of [-2.1, 2.1]) {
      const sp = new THREE.Mesh(spikeGeo, new THREE.MeshLambertMaterial({ color: 0x5a3a8a, emissive: 0x2a1050, flatShading: true }));
      sp.scale.set(1, 2.2, 1); sp.position.set(sx, 0.62, 0); g.add(sp); spikes.push(sp);
    }
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(1.2, 1.6, 7, 20, 1, true), additive(0x45eeff, 0, null));
    beam.position.y = 3.5; g.add(beam);
    world.add(g);
    checkpoints.push({ group: g, disc, mat, spikes, beam, active: false, flash: 0 });
  });
}

// gate numerals on the walls
const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI'];
function buildGateMarkers() {
  LEVEL.gates.forEach((gate, i) => {
    const river = LEVEL.rivers[gate.rivers[0]];
    for (const side of [-1, 1]) {
      const end = side < 0 ? river.near[0] : river.near[river.near.length - 1];
      const tex = textTexture(ROMAN[i], { color: '#ffd27a', stroke: '#3a1400', strokeWidth: 12, font: '900 80px Georgia, serif' });
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
      sp.scale.set(1.8, 0.9, 1);
      sp.position.set(side * 9.75, 2.6, end[1] + 0.6);
      world.add(sp);
    }
  });
}

// exit arch + portal
const exitFx = {};
function buildExit() {
  const z = -58.5;
  const pillarGeo = new THREE.CylinderGeometry(0.8, 0.95, 5.4, 10);
  for (const x of [-3.3, 3.3]) {
    const p = new THREE.Mesh(pillarGeo, MAT.pillar); p.position.set(x, 2.7, z); world.add(p);
    const band = new THREE.Mesh(new THREE.TorusGeometry(0.88, 0.07, 6, 24), MAT.runeCyan); band.rotation.x = Math.PI / 2; band.position.set(x, 3.6, z); world.add(band);
    const band2 = band.clone(); band2.material = MAT.runeViolet; band2.position.y = 1.4; world.add(band2);
    addFakeShadow(x, z, 1.6, 5.4);
  }
  const lintel = new THREE.Mesh(new THREE.BoxGeometry(9.2, 1.1, 1.7), MAT.pillar); lintel.position.set(0, 5.8, z); world.add(lintel);
  const lintelTop = new THREE.Mesh(new THREE.BoxGeometry(10.0, 0.35, 2.0), MAT.wallCap); lintelTop.position.set(0, 6.5, z); world.add(lintelTop);
  const emblem = new THREE.Mesh(new THREE.CircleGeometry(0.55, 24), MAT.fireCore); emblem.position.set(0, 5.8, z + 0.87); world.add(emblem);
  const emblemGlow = new THREE.Sprite(spriteMat(0xffc04a, 0.9)); emblemGlow.scale.set(2.6, 2.6, 1); emblemGlow.position.set(0, 5.8, z + 0.95); world.add(emblemGlow);
  const portal = new THREE.Mesh(new THREE.PlaneGeometry(5.8, 5.0), portalMat); portal.position.set(0, 2.6, z); world.add(portal);
  const step1 = new THREE.Mesh(new THREE.BoxGeometry(7.6, 0.16, 1.4), MAT.wallCap); step1.position.set(0, 0.08, z + 1.3); world.add(step1);
  const exitDisc = new THREE.Mesh(new THREE.CircleGeometry(2.3, 40), additive(0x45eeff, 0.25, TEX.rune));
  exitDisc.rotation.x = -Math.PI / 2; exitDisc.position.set(0, 0.03, -58.4); exitDisc.renderOrder = 1; world.add(exitDisc);
  Object.assign(exitFx, { portal, emblemGlow, exitDisc });
}

// mirrors, beams and plates
const mirrorViews = [];
function buildMirrors() {
  const pedGeo = new THREE.CylinderGeometry(0.75, 0.9, 0.45, 10);
  const colGeo = new THREE.CylinderGeometry(0.16, 0.2, 1.3, 8);
  const faceGeo = new THREE.CircleGeometry(0.82, 28);
  const frameGeo = new THREE.TorusGeometry(0.84, 0.08, 6, 28);
  const half = CFG.MIRROR_HALF_DEG * DEG;
  const wedgeGeo = new THREE.CircleGeometry(CFG.MIRROR_REACH, 40, -Math.PI / 2 - half, half * 2);
  wedgeGeo.rotateX(-Math.PI / 2);
  for (const m of LEVEL.mirrors) {
    const base = new THREE.Group(); base.position.set(m.x, 0, m.z); world.add(base);
    const ped = new THREE.Mesh(pedGeo, MAT.basalt); ped.position.y = 0.22; base.add(ped);
    const col = new THREE.Mesh(colGeo, MAT.gold); col.position.y = 1.05; base.add(col);
    const yaw = new THREE.Group(); base.add(yaw);
    const faceMat = new THREE.MeshBasicMaterial({ color: 0xfff1c0, side: THREE.DoubleSide });
    const face = new THREE.Mesh(faceGeo, faceMat); face.position.set(0, 1.85, 0); face.rotation.x = -0.25; yaw.add(face);
    const frame = new THREE.Mesh(frameGeo, MAT.gold); frame.position.copy(face.position); frame.rotation.x = -0.25; yaw.add(frame);
    const glint = new THREE.Sprite(spriteMat(0xffe7a0, 0.8)); glint.scale.set(2.4, 2.4, 1); glint.position.set(0, 1.85, 0.1); yaw.add(glint);
    const wedgeMat = beamMat.clone();
    const wedge = new THREE.Mesh(wedgeGeo, wedgeMat); wedge.position.y = 0.035; wedge.renderOrder = 2; yaw.add(wedge);
    addFakeShadow(m.x, m.z, 1.2, 2.6);
    // light ray from the mirror to Pyre (shown when he stands in the beam)
    const rayMat = new THREE.MeshBasicMaterial({ color: 0xffd27a, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
    const ray = new THREE.Mesh(shadowQuadGeo, rayMat); ray.position.set(m.x, 0.08, m.z); ray.renderOrder = 4; world.add(ray);
    const plates = m.plates.map((pl) => {
      const tex = pl.dir < 0 ? TEX.plateL : pl.dir > 0 ? TEX.plateR : TEX.plateLR;
      const mat = additive(0xffc04a, 0.55, tex);
      const disc = new THREE.Mesh(new THREE.CircleGeometry(CFG.PLATE_RADIUS, 32), mat);
      disc.rotation.x = -Math.PI / 2; disc.position.set(pl.x, 0.03, pl.z); disc.renderOrder = 2; world.add(disc);
      const rim = new THREE.Mesh(new THREE.TorusGeometry(CFG.PLATE_RADIUS + 0.05, 0.06, 5, 32), MAT.gold);
      rim.rotation.x = Math.PI / 2; rim.position.set(pl.x, 0.04, pl.z); world.add(rim);
      return { disc, mat, rim, flash: 0 };
    });
    mirrorViews.push({ base, yaw, face, faceMat, glint, wedge, wedgeMat, ray, rayMat, plates });
  }
}

// vents
const ventViews = [];
function buildVents() {
  const warnGeo = new THREE.RingGeometry(0.9, 1.0, 48);
  warnGeo.rotateX(-Math.PI / 2);
  for (const v of LEVEL.vents) {
    const onStone = !!floorAt(v.x, v.z);
    const y = onStone ? 0.02 : LAVA_Y + 0.03;
    const g = new THREE.Group(); g.position.set(v.x, y, v.z); world.add(g);
    const crater = new THREE.Mesh(new THREE.TorusGeometry(v.r * 0.78, 0.2, 6, 20), MAT.basaltDark);
    crater.rotation.x = Math.PI / 2; crater.scale.z = 0.6; g.add(crater);
    const core = new THREE.Mesh(new THREE.CircleGeometry(v.r * 0.62, 24), additive(0xff7a20, 0.6));
    core.rotation.x = -Math.PI / 2; core.position.y = 0.02; core.renderOrder = 2; g.add(core);
    const warn = new THREE.Mesh(warnGeo, new THREE.MeshBasicMaterial({ color: 0xff3a1a, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
    warn.position.y = (onStone ? 0.06 : 0.45); warn.renderOrder = 8; g.add(warn);
    const column = new THREE.Mesh(new THREE.CylinderGeometry(v.r * 0.5, v.r * 0.85, 3.4, 16, 1, true), fireColumnMat);
    column.position.y = 1.7; column.scale.y = 0.001; column.visible = false; g.add(column);
    const glow = new THREE.Sprite(spriteMat(0xff6a1a, 0)); glow.scale.set(v.r * 3.2, v.r * 3.2, 1); glow.position.y = 1.0; g.add(glow);
    ventViews.push({ g, core, warn, column, glow, onStone, lastPhase: 0 });
  }
}

// sun shards
const shardViews = [];
function buildShards() {
  const geo = new THREE.OctahedronGeometry(0.34, 0);
  for (const s of LEVEL.shards) {
    const g = new THREE.Group(); g.position.set(s.x, 0, s.z); world.add(g);
    const gem = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color: 0xffd04a, emissive: 0xc07a00, flatShading: true }));
    gem.scale.set(1, 1.45, 1); gem.position.y = 0.95; g.add(gem);
    const halo = new THREE.Sprite(spriteMat(0xffc040, 0.8)); halo.scale.set(1.6, 1.6, 1); halo.position.y = 0.95; g.add(halo);
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.42, 0.5, 32), additive(0xffc040, 0.45, null));
    ring.rotation.x = -Math.PI / 2; ring.position.y = 0.04; ring.renderOrder = 2; g.add(ring);
    const blob = new THREE.Mesh(new THREE.CircleGeometry(0.35, 16), MAT.blob); blob.rotation.x = -Math.PI / 2; blob.position.y = 0.02; g.add(blob);
    shardViews.push({ g, gem, halo, ring, ph: rand() * 6.28 });
  }
}

// boulders and basalt spires (every solid obstacle is drawn at its collision size)
function buildRocks() {
  const boulder = new THREE.DodecahedronGeometry(1, 0);
  const spireGeo = new THREE.CylinderGeometry(0.55, 1, 1, 6);
  for (const o of LEVEL.obstacles) {
    if (o.kind === 'rock') {
      const m = new THREE.Mesh(boulder, MAT.basalt);
      m.scale.set(o.r * 1.05, o.r * 0.85, o.r * 1.05);
      m.position.set(o.x, o.r * 0.55, o.z);
      m.rotation.set(rand() * 3, rand() * 3, rand() * 3);
      world.add(m);
      const m2 = new THREE.Mesh(boulder, MAT.basaltDark);
      m2.scale.setScalar(o.r * 0.5);
      m2.position.set(o.x + o.r * 0.6, o.r * 0.3, o.z + o.r * 0.4);
      world.add(m2);
      addFakeShadow(o.x, o.z, o.r * 1.8, o.r * 1.6);
    } else if (o.kind === 'spire') {
      const h = 2.6;
      const m = new THREE.Mesh(spireGeo, MAT.basalt);
      m.scale.set(o.r, h, o.r);
      m.position.set(o.x, h / 2, o.z);
      m.rotation.y = rand() * Math.PI;
      world.add(m);
      const tip = new THREE.Mesh(new THREE.OctahedronGeometry(0.22, 0), MAT.runeViolet);
      tip.position.set(o.x, h + 0.25, o.z);
      world.add(tip);
      const band = new THREE.Mesh(new THREE.TorusGeometry(o.r * 0.82, 0.04, 5, 20), MAT.runeCyan);
      band.rotation.x = Math.PI / 2; band.position.set(o.x, h * 0.55, o.z);
      world.add(band);
      addFakeShadow(o.x, o.z, o.r * 1.6, h);
    }
  }
}

// lava glow lights (static, one per river)
function buildLavaLights() {
  for (const id of ['R1', 'R2', 'R3a', 'R4', 'R5', 'R6']) {
    const r = LEVEL.rivers[id];
    const mid = r.near[Math.floor(r.near.length / 2)], midF = r.far[Math.floor(r.far.length / 2)];
    const light = new THREE.PointLight(0xff6a24, REV >= 155 ? 26 : 1.4, 16, 2);
    light.position.set(0, 1.4, (mid[1] + midF[1]) / 2);
    world.add(light);
  }
}

buildFloor();
buildWalls();
buildAbyss();
buildFloatingRocks();
buildDecor();
buildStart();
buildCheckpoints();
buildGateMarkers();
buildExit();
buildMirrors();
buildVents();
buildShards();
buildRocks();
buildLavaLights();

// lights
const hemi = new THREE.HemisphereLight(0xffd8b0, 0x4a2038, 0.46 * LIGHT_SCALE);
scene.add(hemi);
const ambient = new THREE.AmbientLight(0x3a2a52, 0.2 * LIGHT_SCALE);
scene.add(ambient);
const sunLight = new THREE.DirectionalLight(0xfff0d4, 0.78 * LIGHT_SCALE);
scene.add(sunLight);
scene.add(sunLight.target);

// =============================================================================
// CHARACTERS (procedural, readable silhouettes)
// =============================================================================
function nameTag(text, color) {
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({
    map: textTexture(text, { color, stroke: '#12060f', strokeWidth: 12, font: '900 74px system-ui, sans-serif' }),
    transparent: true, depthWrite: false, depthTest: false,
  }));
  sp.scale.set(1.15, 0.58, 1);
  sp.renderOrder = 30;
  return sp;
}
function keyHint(text, color) {
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({
    map: textTexture(text, { color, bg: 'rgba(14,6,24,0.82)', font: '800 44px system-ui, sans-serif', w: 480, h: 96 }),
    transparent: true, depthWrite: false, depthTest: false,
  }));
  sp.scale.set(2.6, 0.52, 1);
  sp.renderOrder = 31;
  return sp;
}

function buildPyre() {
  const group = new THREE.Group();
  const body = new THREE.Group();
  group.add(body);
  const robeMat = new THREE.MeshLambertMaterial({ color: 0xd94a1e, emissive: 0x3a0800, flatShading: true });
  const trimMat = new THREE.MeshLambertMaterial({ color: 0xffa838, emissive: 0x6a2600, flatShading: true });
  const darkMat = new THREE.MeshLambertMaterial({ color: 0x2b1714, flatShading: true });
  const skinMat = new THREE.MeshLambertMaterial({ color: 0x3c1f17, emissive: 0x2a0800, flatShading: true });
  const eyeMat = new THREE.MeshBasicMaterial({ color: 0xfff09a });
  const legGeo = new THREE.CylinderGeometry(0.11, 0.13, 0.48, 6); legGeo.translate(0, -0.24, 0);
  const legL = new THREE.Mesh(legGeo, darkMat); legL.position.set(-0.17, 0.5, 0); body.add(legL);
  const legR = new THREE.Mesh(legGeo, darkMat); legR.position.set(0.17, 0.5, 0); body.add(legR);
  const robe = new THREE.Mesh(new THREE.CylinderGeometry(0.36, 0.54, 0.74, 8), robeMat); robe.position.y = 0.72; body.add(robe);
  const hem = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.56, 0.08, 8), trimMat); hem.position.y = 0.37; body.add(hem);
  const belt = new THREE.Mesh(new THREE.CylinderGeometry(0.39, 0.39, 0.1, 8), trimMat); belt.position.y = 1.03; body.add(belt);
  const chest = new THREE.Mesh(new THREE.CylinderGeometry(0.44, 0.37, 0.44, 8), robeMat); chest.position.y = 1.28; body.add(chest);
  const padGeo = new THREE.SphereGeometry(0.2, 8, 6);
  const padL = new THREE.Mesh(padGeo, trimMat); padL.position.set(-0.45, 1.44, 0); padL.scale.set(1, 0.75, 1); body.add(padL);
  const padR = new THREE.Mesh(padGeo, trimMat); padR.position.set(0.45, 1.44, 0); padR.scale.set(1, 0.75, 1); body.add(padR);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.31, 10, 8), skinMat); head.position.y = 1.78; body.add(head);
  const eyeGeo = new THREE.BoxGeometry(0.09, 0.06, 0.04);
  const eyeL = new THREE.Mesh(eyeGeo, eyeMat); eyeL.position.set(-0.11, 1.8, 0.29); body.add(eyeL);
  const eyeR = new THREE.Mesh(eyeGeo, eyeMat); eyeR.position.set(0.11, 1.8, 0.29); body.add(eyeR);
  const armGeo = new THREE.CylinderGeometry(0.09, 0.08, 0.5, 6); armGeo.translate(0, -0.25, 0);
  const fistGeo = new THREE.SphereGeometry(0.11, 6, 5);
  const makeArm = (x) => {
    const pivot = new THREE.Group(); pivot.position.set(x, 1.42, 0);
    const arm = new THREE.Mesh(armGeo, robeMat); pivot.add(arm);
    const fist = new THREE.Mesh(fistGeo, trimMat); fist.position.y = -0.52; pivot.add(fist);
    body.add(pivot);
    return pivot;
  };
  const armL = makeArm(-0.5), armR = makeArm(0.5);
  // fire crown
  const crown = new THREE.Group(); crown.position.y = 2.02; body.add(crown);
  const cone = new THREE.ConeGeometry(0.075, 0.34, 5);
  const coneIn = new THREE.ConeGeometry(0.05, 0.22, 5);
  const crownFlames = [];
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2;
    const f = new THREE.Mesh(cone, MAT.fireOuter); f.position.set(Math.sin(a) * 0.2, 0.08, Math.cos(a) * 0.2); crown.add(f);
    const fi = new THREE.Mesh(coneIn, MAT.fireCore); fi.position.set(Math.sin(a) * 0.2, 0.05, Math.cos(a) * 0.2); crown.add(fi);
    crownFlames.push({ f, fi, ph: i * 0.9 });
  }
  const crownBand = new THREE.Mesh(new THREE.TorusGeometry(0.22, 0.045, 5, 16), MAT.gold); crownBand.rotation.x = Math.PI / 2; crownBand.position.y = -0.06; crown.add(crownBand);
  const glow = new THREE.Sprite(spriteMat(0xff8a2a, 0.75)); glow.scale.set(1.9, 1.9, 1); glow.position.y = 2.1; body.add(glow);
  const blob = new THREE.Mesh(new THREE.CircleGeometry(0.55, 20), MAT.blob); blob.rotation.x = -Math.PI / 2; blob.position.y = 0.02; blob.renderOrder = 1; group.add(blob);
  const tag = nameTag('P1', '#ffb066'); tag.position.y = 2.75; group.add(tag);
  const hint = keyHint('WASD · SPACE', '#ffcf8a'); hint.position.y = 3.35; group.add(hint);
  const lavaRing = new THREE.Mesh(new THREE.RingGeometry(0.45, 0.75, 24), additive(0xffb040, 0, null));
  lavaRing.rotation.x = -Math.PI / 2; lavaRing.position.y = 0.05; lavaRing.renderOrder = 4; group.add(lavaRing);
  const channel = new THREE.Mesh(new THREE.RingGeometry(0.7, 0.82, 32), additive(0x8ff8ff, 0, null));
  channel.rotation.x = -Math.PI / 2; channel.position.y = 0.06; channel.renderOrder = 4; group.add(channel);
  scene.add(group);
  return { group, body, legL, legR, armL, armR, head, crown, crownFlames, glow, blob, tag, hint, lavaRing, channel, robeMat };
}

function buildUmbra() {
  const group = new THREE.Group();
  const body = new THREE.Group();
  group.add(body);
  const cloakMat = new THREE.MeshLambertMaterial({ color: 0x2c1a52, emissive: 0x0c0420, flatShading: true });
  const innerMat = new THREE.MeshLambertMaterial({ color: 0x140a26, flatShading: true });
  const cyanMat = new THREE.MeshBasicMaterial({ color: 0x45eeff });
  const cloak = new THREE.Mesh(new THREE.ConeGeometry(0.52, 1.25, 8, 1), cloakMat); cloak.position.y = 0.72; body.add(cloak);
  const trim = new THREE.Mesh(new THREE.TorusGeometry(0.47, 0.045, 5, 24), cyanMat); trim.rotation.x = Math.PI / 2; trim.position.y = 0.16; body.add(trim);
  const mantle = new THREE.Mesh(new THREE.ConeGeometry(0.46, 0.5, 8, 1, true), cloakMat); mantle.position.y = 1.18; body.add(mantle);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.25, 10, 8), innerMat); head.position.y = 1.36; body.add(head);
  const hood = new THREE.Mesh(new THREE.ConeGeometry(0.32, 0.72, 8), cloakMat); hood.position.set(0, 1.62, -0.05); hood.rotation.x = -0.18; body.add(hood);
  const eyeGeo = new THREE.SphereGeometry(0.05, 6, 4);
  const eyeL = new THREE.Mesh(eyeGeo, cyanMat); eyeL.position.set(-0.09, 1.38, 0.22); body.add(eyeL);
  const eyeR = new THREE.Mesh(eyeGeo, cyanMat); eyeR.position.set(0.09, 1.38, 0.22); body.add(eyeR);
  const scarf = [];
  const scarfGeo = new THREE.BoxGeometry(0.16, 0.05, 0.22);
  for (let i = 0; i < 4; i++) { const s = new THREE.Mesh(scarfGeo, cyanMat); s.position.set(0, 1.18, -0.3 - i * 0.2); body.add(s); scarf.push(s); }
  const wisps = [];
  const wispGeo = new THREE.SphereGeometry(0.07, 6, 4);
  for (let i = 0; i < 3; i++) {
    const w = new THREE.Mesh(wispGeo, i === 1 ? MAT.runeViolet : cyanMat); body.add(w);
    const wg = new THREE.Sprite(spriteMat(i === 1 ? 0xa070ff : 0x45eeff, 0.6)); wg.scale.set(0.45, 0.45, 1); w.add(wg);
    wisps.push({ w, ph: (i / 3) * Math.PI * 2 });
  }
  const glow = new THREE.Sprite(spriteMat(0x45eeff, 0.35)); glow.scale.set(1.6, 1.6, 1); glow.position.y = 1.2; body.add(glow);
  const blob = new THREE.Mesh(new THREE.CircleGeometry(0.48, 20), MAT.blob); blob.rotation.x = -Math.PI / 2; blob.position.y = 0.02; blob.renderOrder = 1; group.add(blob);
  const tag = nameTag('P2', '#7ff6ff'); tag.position.y = 2.35; group.add(tag);
  const hint = keyHint('ARROWS · R-SHIFT', '#9ff8ff'); hint.position.y = 2.95; group.add(hint);
  const danger = new THREE.Mesh(new THREE.RingGeometry(0.42, 0.62, 24), additive(0xff3a1a, 0, null));
  danger.rotation.x = -Math.PI / 2; danger.position.y = 0.09; danger.renderOrder = 4; group.add(danger);
  scene.add(group);
  // Umbra's own small shadow (points away from the sun like everything else)
  const shadow = addFakeShadow(0, 0, 0.7, 1.4, 0.02);
  return { group, body, cloak, head, hood, scarf, wisps, glow, blob, tag, hint, danger, shadow, cloakMat };
}

const pyreView = buildPyre();
const umbraView = buildUmbra();

// =============================================================================
// SUN (drawn in screen space, attached to the camera) + SUN TRACK
// =============================================================================
const sunRig = new THREE.Group();
camera.add(sunRig);
const SUN_DEPTH = 30;
function hudMat(color, opacity, map) {
  return new THREE.MeshBasicMaterial({ color, map: map || null, transparent: true, opacity, depthTest: false, depthWrite: false, blending: map ? THREE.AdditiveBlending : THREE.NormalBlending });
}
const sunHalo = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), hudMat(0xffa63a, 0.75, TEX.glow)); sunHalo.renderOrder = 50;
const sunRays = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), hudMat(0xffd27a, 0.7, TEX.rays)); sunRays.renderOrder = 51;
const sunCore = new THREE.Mesh(new THREE.CircleGeometry(0.5, 40), hudMat(0xffe7a0, 1)); sunCore.renderOrder = 52;
const sunMoon = new THREE.Mesh(new THREE.CircleGeometry(0.5, 40), hudMat(0x1a0716, 1)); sunMoon.renderOrder = 53; sunMoon.visible = false;
const sunCorona = new THREE.Mesh(new THREE.RingGeometry(0.5, 0.62, 48), hudMat(0xfff2c8, 0)); sunCorona.renderOrder = 54;
sunRig.add(sunHalo, sunRays, sunCore, sunMoon, sunCorona);
const TRACK_N = 72;
const trackGeo = new THREE.BufferGeometry();
const trackPos = new Float32Array((TRACK_N + 1) * 2 * 3);
const trackCol = new Float32Array((TRACK_N + 1) * 2 * 3);
const trackIdx = [];
for (let i = 0; i < TRACK_N; i++) { const a = i * 2; trackIdx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
trackGeo.setIndex(trackIdx);
trackGeo.setAttribute('position', new THREE.BufferAttribute(trackPos, 3));
trackGeo.setAttribute('color', new THREE.BufferAttribute(trackCol, 3));
const trackMesh = new THREE.Mesh(trackGeo, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.95, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }));
trackMesh.renderOrder = 49;
trackMesh.frustumCulled = false;
sunRig.add(trackMesh);
const trackValid = new Uint8Array(TRACK_N + 1);

function sunScreen(s, out) {
  const hw = CAM.halfW * CAM.zoom, hh = CAM.halfH * CAM.zoom;
  out.x = 0.8 * hw * s;
  out.y = hh * (0.5 + 0.2 * (1 - s * s));
  return out;
}
const _sp = { x: 0, y: 0 }, _sp2 = { x: 0, y: 0 };
function layoutSunTrack() {
  const k = CAM.zoom * Math.min(CAM.halfH, CAM.halfW / 1.78) / 7.65;   // size from the shorter screen side
  const w = 0.07 * k;
  for (let i = 0; i <= TRACK_N; i++) {
    const s = -1 + (2 * i) / TRACK_N;
    sunScreen(s, _sp);
    sunScreen(Math.min(1, s + 0.01), _sp2);
    let tx = _sp2.x - _sp.x, ty = _sp2.y - _sp.y; const l = Math.hypot(tx, ty) || 1; tx /= l; ty /= l;
    const nx = -ty * w, ny = tx * w;
    trackPos.set([_sp.x + nx, _sp.y + ny, -SUN_DEPTH - 1, _sp.x - nx, _sp.y - ny, -SUN_DEPTH - 1], i * 6);
  }
  trackGeo.attributes.position.needsUpdate = true;
  trackGeo.computeBoundingSphere();
  const r = 0.78 * k;
  sunCore.scale.setScalar(r * 2);
  sunMoon.scale.setScalar(r * 2);
  sunCorona.scale.setScalar(r * 2);
  sunHalo.scale.setScalar(r * 6.5);
  sunRays.scale.setScalar(r * 8);
}
function onLayoutChanged() {
  layoutSunTrack();
}

// =============================================================================
// SHADOW BRIDGE MESHES (one persistent mesh each — never recreated)
// =============================================================================
const bridgeGeo = new THREE.PlaneGeometry(1, 1);
bridgeGeo.rotateX(-Math.PI / 2);
bridgeGeo.translate(0, 0, 0.5);

// Pyre's shadow as a flat humanoid silhouette lying on the ground.
// Local frame: origin = Pyre's feet, +z = along the shadow (away from him), x = across.
// Built for CFG.BRIDGE_LENGTH and stretched along z for other lengths.
function buildShadowSilhouette() {
  const SL = CFG.BRIDGE_LENGTH;
  const root = new THREE.Group();
  root.frustumCulled = false;
  const RIM_Y = 0, FILL_Y = 0.012, EYE_Y = 0.024;
  // shape points are [x, along]; rotateX(+90°) maps shape (x, y) → world (x, 0, y)
  const geoOf = (pts) => {
    const s = new THREE.Shape();
    s.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) s.lineTo(pts[i][0], pts[i][1]);
    const g = new THREE.ShapeGeometry(s);
    g.rotateX(Math.PI / 2);
    return g;
  };
  const ellipse = (cx, ca, rx, ra, n = 20) => {
    const pts = [];
    for (let i = 0; i < n; i++) { const a = (i / n) * Math.PI * 2; pts.push([cx + Math.cos(a) * rx, ca + Math.sin(a) * ra]); }
    return pts;
  };
  // one silhouette part: filled body over a slightly larger rim copy
  const part = (parent, pts, rimSx, rimSz) => {
    const node = new THREE.Group();
    const geo = geoOf(pts);
    const rim = new THREE.Mesh(geo, silRimMat); rim.position.y = RIM_Y; rim.scale.set(rimSx, 1, rimSz);
    const fill = new THREE.Mesh(geo, silFillMat); fill.position.y = FILL_Y;
    rim.renderOrder = 3; fill.renderOrder = 3;
    rim.frustumCulled = false; fill.frustumCulled = false;
    node.add(rim, fill);
    parent.add(node);
    return node;
  };

  // heel anchor pad (always under Pyre's feet)
  part(root, ellipse(0, 0, 0.52, 0.52, 28), 1.16, 1.16);
  const heelRing = new THREE.Mesh(new THREE.RingGeometry(0.58, 0.68, 36), silHeelRingMat);
  heelRing.rotation.x = -Math.PI / 2; heelRing.position.y = EYE_Y; heelRing.renderOrder = 8; root.add(heelRing);

  // legs: pivot at the hip, reaching back toward the feet
  const hipA = 0.24 * SL;
  const legPts = [[-0.15, 0], [0.15, 0], [0.12, -(hipA - 0.28)], [0.17, -(hipA - 0.12)], [0, -(hipA + 0.02)], [-0.17, -(hipA - 0.12)], [-0.12, -(hipA - 0.28)]];
  const makeLeg = (x) => { const pv = new THREE.Group(); pv.position.set(x, 0, hipA); root.add(pv); part(pv, legPts, 1.4, 1.06); return pv; };
  const legL = makeLeg(-0.22), legR = makeLeg(0.22);

  // flared fire-cloak torso with a flame-tongued hem
  const torso = new THREE.Group(); torso.position.set(0, 0, 0.42 * SL); root.add(torso);
  const t0 = 0.42 * SL;
  const hem = [];
  for (let i = 0; i <= 8; i++) {
    const x = -0.82 + (1.64 * i) / 8;
    hem.push([x, (i % 2 === 0 ? 0.17 * SL - (i === 4 ? 0.12 : 0) : 0.235 * SL) - t0]);
  }
  const torsoPts = hem.concat([
    [0.66, 0.34 * SL - t0], [0.42, 0.44 * SL - t0], [0.5, 0.535 * SL - t0], [0.46, 0.6 * SL - t0],
    [0.18, 0.635 * SL - t0], [-0.18, 0.635 * SL - t0], [-0.46, 0.6 * SL - t0], [-0.5, 0.535 * SL - t0],
    [-0.42, 0.44 * SL - t0], [-0.66, 0.34 * SL - t0],
  ]);
  part(torso, torsoPts, 1.09, 1.05);

  // spiky shoulder pauldrons (three spikes each, pointing outward)
  const pauldron = (side) => {
    const pts = [];
    const spikes = [0.26, 0.5, 0.26, 0.58, 0.26, 0.5, 0.26];
    for (let i = 0; i < spikes.length; i++) {
      const a = (-80 + (160 * i) / (spikes.length - 1)) * DEG;
      pts.push([side * Math.cos(a) * spikes[i], Math.sin(a) * spikes[i] * 0.9]);
    }
    for (let i = 1; i < 6; i++) {
      const a = (80 + (200 * i) / 6) * DEG;
      pts.push([side * Math.cos(a) * 0.22, Math.sin(a) * 0.22 * 0.9]);
    }
    const node = new THREE.Group(); node.position.set(side * 0.52, 0, 0.59 * SL); root.add(node);
    part(node, side > 0 ? pts : pts.slice().reverse(), 1.14, 1.14);
    return node;
  };
  pauldron(-1); pauldron(1);

  // arms: pivot at the shoulder, hanging back toward the feet, with fists
  const armLen = 1.3;
  const armPts = [[-0.12, 0], [0.12, 0], [0.09, -armLen + 0.1], [-0.09, -armLen + 0.1]];
  const makeArm = (x) => {
    const pv = new THREE.Group(); pv.position.set(x, 0, 0.585 * SL); root.add(pv);
    part(pv, armPts, 1.45, 1.05);
    part(pv, ellipse(0, -armLen + 0.04, 0.15, 0.17, 14), 1.25, 1.25);
    return pv;
  };
  const armL = makeArm(-0.64), armR = makeArm(0.64);

  // head (stretched a little, like a real cast shadow) with two glowing eyes
  const head = new THREE.Group(); head.position.set(0, 0, 0.76 * SL); root.add(head);
  part(head, ellipse(0, 0, 0.31, 0.44, 22), 1.17, 1.13);
  const eyeGeo = geoOf(ellipse(0, 0, 0.075, 0.055, 12));
  const eyeGlowGeo = new THREE.PlaneGeometry(0.42, 0.42); eyeGlowGeo.rotateX(-Math.PI / 2);
  const eyes = [];
  for (const x of [-0.12, 0.12]) {
    const e = new THREE.Mesh(eyeGeo, silEyeMat); e.position.set(x, EYE_Y, 0.06); e.renderOrder = 8; head.add(e);
    const g = new THREE.Mesh(eyeGlowGeo, silEyeGlowMat); g.position.set(x, EYE_Y + 0.004, 0.06); g.renderOrder = 9; head.add(g);
    eyes.push(e);
  }

  // Pyre's 5-spike fire crown, fanning out at the shadow's tip
  const crown = new THREE.Group(); crown.position.set(0, 0, 0.36); head.add(crown);
  part(crown, [[-0.26, -0.06], [0.26, -0.06], [0.22, 0.08], [-0.22, 0.08]], 1.12, 1.4);
  const spikes = [];
  const fan = [-44, -22, 0, 22, 44], lens = [0.5, 0.7, 0.92, 0.7, 0.5];
  for (let i = 0; i < 5; i++) {
    const a = fan[i] * DEG;
    const node = new THREE.Group(); node.position.set(Math.sin(a) * 0.16, 0, 0.04); node.rotation.y = a; crown.add(node);
    part(node, [[-0.11, 0], [0.11, 0], [0.035, lens[i] * 0.7], [0, lens[i]], [-0.035, lens[i] * 0.7]], 1.3, 1.08);
    spikes.push({ node, ph: i * 1.3 });
  }

  scene.add(root);
  return { root, legL, legR, armL, armR, torso, head, eyes, crown, spikes, heelRing };
}
const shadowSil = buildShadowSilhouette();

const footholdGeo = new THREE.PlaneGeometry(2, 2);
footholdGeo.rotateX(-Math.PI / 2);
const footholdMesh = new THREE.Mesh(footholdGeo, footholdMat);
footholdMesh.renderOrder = 4;
footholdMesh.visible = false;
footholdMesh.frustumCulled = false;
scene.add(footholdMesh);
const footholdGlow = new THREE.Mesh(footholdGeo, new THREE.MeshBasicMaterial({ color: 0x9a6aff, map: TEX.glow, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
footholdGlow.renderOrder = 4;
footholdGlow.visible = false;
scene.add(footholdGlow);

const previewMesh = new THREE.Mesh(bridgeGeo, previewMat);
previewMesh.renderOrder = 6;
previewMesh.frustumCulled = false;
scene.add(previewMesh);
const ringGeo = new THREE.PlaneGeometry(1.8, 1.8);
ringGeo.rotateX(-Math.PI / 2);
const ringMesh = new THREE.Mesh(ringGeo, ringMat);
ringMesh.renderOrder = 7;
ringMesh.visible = false;
scene.add(ringMesh);

// =============================================================================
// PARTICLES (one pooled Points object)
// =============================================================================
const PMAX = 1600;
const pGeo = new THREE.BufferGeometry();
const pPos = new Float32Array(PMAX * 3), pCol = new Float32Array(PMAX * 3), pAlp = new Float32Array(PMAX), pSiz = new Float32Array(PMAX);
pGeo.setAttribute('position', new THREE.BufferAttribute(pPos, 3));
pGeo.setAttribute('pcolor', new THREE.BufferAttribute(pCol, 3));
pGeo.setAttribute('palpha', new THREE.BufferAttribute(pAlp, 1));
pGeo.setAttribute('psize', new THREE.BufferAttribute(pSiz, 1));
pGeo.setDrawRange(0, 0);
const pMat = new THREE.ShaderMaterial({
  uniforms: { uScale: { value: 40 } },
  transparent: true,
  depthWrite: false,
  blending: THREE.AdditiveBlending,
  vertexShader: `
    attribute vec3 pcolor; attribute float palpha; attribute float psize; uniform float uScale;
    varying vec3 vC; varying float vA;
    void main(){ vC = pcolor; vA = palpha; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); gl_PointSize = max(1.0, psize*uScale); }`,
  fragmentShader: `
    varying vec3 vC; varying float vA;
    void main(){ vec2 c = gl_PointCoord - 0.5; float d = length(c); if (d > 0.5) discard; float a = smoothstep(0.5, 0.05, d) * vA; gl_FragColor = vec4(vC*a, a); }`,
});
const particles = new THREE.Points(pGeo, pMat);
particles.frustumCulled = false;
particles.renderOrder = 20;
scene.add(particles);
const P_ = {
  n: 0,
  vel: new Float32Array(PMAX * 3), life: new Float32Array(PMAX), max: new Float32Array(PMAX),
  s0: new Float32Array(PMAX), s1: new Float32Array(PMAX), a0: new Float32Array(PMAX),
  grav: new Float32Array(PMAX), drag: new Float32Array(PMAX),
  c0: new Float32Array(PMAX * 3), c1: new Float32Array(PMAX * 3),
};
const _c1 = new THREE.Color(), _c2 = new THREE.Color();
function emit(x, y, z, o) {
  const count = o.count || 1;
  _c1.set(o.color != null ? o.color : 0xffffff);
  _c2.set(o.color2 != null ? o.color2 : (o.color != null ? o.color : 0xffffff));
  for (let k = 0; k < count; k++) {
    if (P_.n >= PMAX) return;
    const i = P_.n++;
    const sp = o.spread || 0;
    pPos[i * 3] = x + (Math.random() - 0.5) * sp;
    pPos[i * 3 + 1] = y + (Math.random() - 0.5) * (o.spreadY != null ? o.spreadY : sp);
    pPos[i * 3 + 2] = z + (Math.random() - 0.5) * sp;
    const a = Math.random() * Math.PI * 2, s = (o.speed || 0) * (0.4 + Math.random() * 0.6);
    P_.vel[i * 3] = Math.cos(a) * s + (o.vx || 0);
    P_.vel[i * 3 + 1] = (o.up || 0) * (0.6 + Math.random() * 0.4) + (o.vy || 0);
    P_.vel[i * 3 + 2] = Math.sin(a) * s + (o.vz || 0);
    const life = (o.life || 1) * (0.7 + Math.random() * 0.5);
    P_.life[i] = life; P_.max[i] = life;
    P_.s0[i] = o.size || 0.2; P_.s1[i] = o.sizeEnd != null ? o.sizeEnd : (o.size || 0.2) * 0.3;
    P_.a0[i] = o.alpha != null ? o.alpha : 1;
    P_.grav[i] = o.gravity || 0; P_.drag[i] = o.drag || 0;
    P_.c0[i * 3] = _c1.r; P_.c0[i * 3 + 1] = _c1.g; P_.c0[i * 3 + 2] = _c1.b;
    P_.c1[i * 3] = _c2.r; P_.c1[i * 3 + 1] = _c2.g; P_.c1[i * 3 + 2] = _c2.b;
  }
}
function updateParticles(dt) {
  let i = 0;
  while (i < P_.n) {
    P_.life[i] -= dt;
    if (P_.life[i] <= 0) {
      const j = --P_.n;
      if (i !== j) {
        for (let k = 0; k < 3; k++) {
          pPos[i * 3 + k] = pPos[j * 3 + k]; P_.vel[i * 3 + k] = P_.vel[j * 3 + k];
          P_.c0[i * 3 + k] = P_.c0[j * 3 + k]; P_.c1[i * 3 + k] = P_.c1[j * 3 + k];
        }
        P_.life[i] = P_.life[j]; P_.max[i] = P_.max[j]; P_.s0[i] = P_.s0[j]; P_.s1[i] = P_.s1[j];
        P_.a0[i] = P_.a0[j]; P_.grav[i] = P_.grav[j]; P_.drag[i] = P_.drag[j];
      }
      continue;
    }
    const d = Math.max(0, 1 - P_.drag[i] * dt);
    P_.vel[i * 3] *= d; P_.vel[i * 3 + 1] = P_.vel[i * 3 + 1] * d - P_.grav[i] * dt; P_.vel[i * 3 + 2] *= d;
    pPos[i * 3] += P_.vel[i * 3] * dt; pPos[i * 3 + 1] += P_.vel[i * 3 + 1] * dt; pPos[i * 3 + 2] += P_.vel[i * 3 + 2] * dt;
    const t = 1 - P_.life[i] / P_.max[i];
    pSiz[i] = P_.s0[i] + (P_.s1[i] - P_.s0[i]) * t;
    pAlp[i] = P_.a0[i] * (t < 0.15 ? t / 0.15 : 1 - (t - 0.15) / 0.85);
    pCol[i * 3] = P_.c0[i * 3] + (P_.c1[i * 3] - P_.c0[i * 3]) * t;
    pCol[i * 3 + 1] = P_.c0[i * 3 + 1] + (P_.c1[i * 3 + 1] - P_.c0[i * 3 + 1]) * t;
    pCol[i * 3 + 2] = P_.c0[i * 3 + 2] + (P_.c1[i * 3 + 2] - P_.c0[i * 3 + 2]) * t;
    i++;
  }
  pGeo.setDrawRange(0, P_.n);
  pGeo.attributes.position.needsUpdate = true;
  pGeo.attributes.pcolor.needsUpdate = true;
  pGeo.attributes.palpha.needsUpdate = true;
  pGeo.attributes.psize.needsUpdate = true;
}
function clearParticles() { P_.n = 0; pGeo.setDrawRange(0, 0); }

// =============================================================================
// AUDIO (tiny WebAudio synth — no files)
// =============================================================================
const AUDIO = { ctx: null, master: null, noise: null, muted: false, last: {} };
function ensureAudio() {
  try {
    if (!AUDIO.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      AUDIO.ctx = new AC();
      const comp = AUDIO.ctx.createDynamicsCompressor();
      comp.threshold.value = -14; comp.ratio.value = 4;
      AUDIO.master = AUDIO.ctx.createGain();
      AUDIO.master.gain.value = AUDIO.muted ? 0 : 0.42;
      AUDIO.master.connect(comp); comp.connect(AUDIO.ctx.destination);
      const len = AUDIO.ctx.sampleRate;
      AUDIO.noise = AUDIO.ctx.createBuffer(1, len, AUDIO.ctx.sampleRate);
      const d = AUDIO.noise.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    }
    if (AUDIO.ctx.state === 'suspended') AUDIO.ctx.resume();
  } catch (e) { /* audio is optional */ }
}
function tone(freq, dur, o = {}) {
  const a = AUDIO.ctx; if (!a || AUDIO.muted) return;
  const t0 = a.currentTime + (o.delay || 0);
  const osc = a.createOscillator(), g = a.createGain();
  osc.type = o.type || 'sine';
  osc.frequency.setValueAtTime(freq, t0);
  if (o.slide) osc.frequency.exponentialRampToValueAtTime(Math.max(20, freq * o.slide), t0 + dur);
  const v = o.vol != null ? o.vol : 0.25;
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(v, t0 + (o.attack || 0.008));
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(g); g.connect(AUDIO.master);
  osc.start(t0); osc.stop(t0 + dur + 0.05);
}
function noiseBurst(dur, o = {}) {
  const a = AUDIO.ctx; if (!a || AUDIO.muted || !AUDIO.noise) return;
  const t0 = a.currentTime + (o.delay || 0);
  const src = a.createBufferSource(); src.buffer = AUDIO.noise;
  const f = a.createBiquadFilter(); f.type = o.filter || 'bandpass'; f.frequency.setValueAtTime(o.freq || 1200, t0); f.Q.value = o.q || 1;
  if (o.slide) f.frequency.exponentialRampToValueAtTime(Math.max(40, (o.freq || 1200) * o.slide), t0 + dur);
  const g = a.createGain(); const v = o.vol != null ? o.vol : 0.2;
  g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(v, t0 + (o.attack || 0.01)); g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  src.connect(f); f.connect(g); g.connect(AUDIO.master);
  src.start(t0, Math.random() * 0.5); src.stop(t0 + dur + 0.05);
}
function throttled(name, gap) {
  const now = performance.now();
  if (AUDIO.last[name] && now - AUDIO.last[name] < gap * 1000) return false;
  AUDIO.last[name] = now; return true;
}
const SFX = {
  start() { [392, 523, 659, 784].forEach((f, i) => tone(f, 0.35, { type: 'triangle', vol: 0.16, delay: i * 0.07 })); },
  lock() { tone(880, 0.5, { type: 'triangle', vol: 0.2 }); tone(1320, 0.45, { type: 'sine', vol: 0.12, delay: 0.04 }); tone(1760, 0.6, { type: 'sine', vol: 0.08, delay: 0.09 }); noiseBurst(0.3, { freq: 6000, q: 2, vol: 0.06 }); },
  release() { tone(990, 0.45, { type: 'triangle', vol: 0.14, slide: 0.5 }); noiseBurst(0.4, { freq: 3000, q: 1.5, vol: 0.08, slide: 0.4 }); },
  sync() { [1046, 1318, 1568, 2093].forEach((f, i) => tone(f, 0.4, { type: 'sine', vol: 0.12, delay: i * 0.05 })); },
  invalid() { if (throttled('invalid', 0.25)) { tone(140, 0.18, { type: 'square', vol: 0.08 }); tone(110, 0.2, { type: 'square', vol: 0.06, delay: 0.08 }); } },
  shard() { [1318, 1760, 2349].forEach((f, i) => tone(f, 0.3, { type: 'sine', vol: 0.14, delay: i * 0.06 })); },
  checkpoint() { [523, 659, 784, 1046].forEach((f, i) => tone(f, 0.5, { type: 'triangle', vol: 0.14, delay: i * 0.08 })); },
  fall() { noiseBurst(0.7, { freq: 900, q: 0.8, vol: 0.22, slide: 0.3 }); tone(300, 0.5, { type: 'sawtooth', vol: 0.06, slide: 0.3 }); },
  burn() { noiseBurst(0.5, { freq: 500, q: 0.6, vol: 0.25 }); tone(180, 0.4, { type: 'sawtooth', vol: 0.08, slide: 0.5 }); },
  respawn() { tone(330, 0.4, { type: 'sine', vol: 0.12, slide: 2 }); noiseBurst(0.35, { freq: 2500, q: 2, vol: 0.05, slide: 2 }); },
  dash() { noiseBurst(0.22, { freq: 1800, q: 1.2, vol: 0.12, slide: 2.5 }); tone(600, 0.15, { type: 'sine', vol: 0.06, slide: 1.8 }); },
  burst() { tone(220, 0.9, { type: 'sawtooth', vol: 0.06, slide: 4 }); tone(440, 0.8, { type: 'triangle', vol: 0.1, slide: 3 }); },
  plate() { tone(260, 0.12, { type: 'square', vol: 0.06 }); tone(660, 0.3, { type: 'triangle', vol: 0.1, delay: 0.05 }); noiseBurst(0.25, { freq: 300, q: 1, vol: 0.08 }); },
  vent() { if (throttled('vent', 0.3)) noiseBurst(0.6, { freq: 220, q: 0.7, vol: 0.12, filter: 'lowpass' }); },
  tick() { tone(1500, 0.05, { type: 'square', vol: 0.05 }); },
  gate() { [523, 784, 1046, 1568].forEach((f, i) => tone(f, 0.6, { type: 'triangle', vol: 0.15, delay: i * 0.09 })); },
  victory() { [523, 659, 784, 1046, 1318, 1568].forEach((f, i) => tone(f, 0.7, { type: 'triangle', vol: 0.15, delay: i * 0.11 })); tone(262, 1.6, { type: 'sine', vol: 0.12, delay: 0.1 }); },
  defeat() { [392, 330, 262, 196].forEach((f, i) => tone(f, 0.6, { type: 'triangle', vol: 0.14, delay: i * 0.18 })); },
};

// =============================================================================
// GAME STATE — single source of truth
// =============================================================================
const approach = (v, target, maxDelta) => (v < target ? Math.min(target, v + maxDelta) : Math.max(target, v - maxDelta));
const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
const MIRROR_STEPS = CFG.MIRROR_STEPS_DEG.map((d) => d * DEG);

const G = {
  state: 'loading',            // loading | ready | playing | paused | won | lost
  runTime: 0,
  timeLeft: CFG.ROUND_TIME,
  gateIndex: 0,                // 0..5 = current gate, 6 = all cleared (go to exit)
  crossed: { pyre: false, umbra: false },
  respawn: { x: LEVEL.start.checkpoint.x, z: LEVEL.start.checkpoint.z },
  subReached: {},
  shards: LEVEL.shards.map(() => false),
  shardCount: 0,
  falls: 0, locks: 0, syncs: 0,
  sun: { phase: CFG.SUN_START_PHASE, mult: 1, burstT: 0, burstCd: 0 },
  lock: null,                  // { yaw, len, timer, dur } — angle locked, origin follows Pyre
  release: null,               // { yaw, len, t }
  pad: null,                   // crystal foothold { x, z, r, timer, dur }
  lockCd: 0,
  syncBonus: false,
  shardCharge: false,
  lastValid: null,
  live: { ox: 0, oz: 0, yaw: 0, len: CFG.BRIDGE_LENGTH, valid: false, status: 'idle', landDist: -1, landRegion: -1, mirrorBlend: 0, mirror: null, lit: false, sunYaw: 0, theta: 0 },
  bridge: { ox: 0, oz: 0, yaw: 0, len: CFG.BRIDGE_LENGTH, mode: 'live', valid: false, solid: false, status: 'idle', landDist: -1 },
  mirrors: LEVEL.mirrors.map((m) => ({ def: m, step: m.startStep, yaw: MIRROR_STEPS[m.startStep], target: MIRROR_STEPS[m.startStep], ping: 1 })),
  plates: [],
  vents: LEVEL.vents.map((v) => ({ def: v, phase: 0, k: 0 })),
  winT: 0, loseT: 0, overlayShown: false,
  lastTick: 999,
  furthestZ: LEVEL.start.umbra.z,
  hintFlash: { msg: '', t: 0 },
  announced: {},
};
G.mirrors.forEach((m, mi) => m.def.plates.forEach((pl, pi) => G.plates.push({ def: pl, mirror: m, view: mirrorViews[mi].plates[pi], inside: false, cool: 0 })));

function makePlayer(start) {
  return {
    x: start.x, z: start.z, vx: 0, vz: 0, facing: Math.PI, region: 0, speed: 0, walk: 0,
    onStone: true, onLava: false, rooted: false,
    state: 'normal', lavaT: 0, fallT: 0, spawnT: 0, invuln: 0, dashCd: 0, dash: null,
    onBridge: false, onPad: false, supported: true, fallKind: '', y: 0, tethered: 0,
    stepDx: 0, stepDz: 0,
  };
}
const players = { pyre: makePlayer(LEVEL.start.pyre), umbra: makePlayer(LEVEL.start.umbra) };
const BOTH = [players.pyre, players.umbra];

// =============================================================================
// INPUT
// =============================================================================
const KEYS = {
  p1: { left: ['KeyA'], right: ['KeyD'], up: ['KeyW'], down: ['KeyS'] },
  p2: { left: ['ArrowLeft'], right: ['ArrowRight'], up: ['ArrowUp'], down: ['ArrowDown'] },
  lock: ['Space'],
  burst: ['KeyE', 'KeyQ'],
  dash: ['ShiftRight', 'Slash', 'Period', 'Numpad0', 'NumpadEnter'],
  restart: ['KeyR'],
  confirm: ['Enter'],
  pause: ['KeyP', 'Escape'],
  mute: ['KeyM'],
};
const GAME_CODES = new Set([].concat(
  KEYS.p1.left, KEYS.p1.right, KEYS.p1.up, KEYS.p1.down, KEYS.p2.left, KEYS.p2.right, KEYS.p2.up, KEYS.p2.down,
  KEYS.lock, KEYS.burst, KEYS.dash, KEYS.restart, KEYS.confirm, KEYS.mute, ['KeyP'],
));
const held = new Set();
function inputVec(map, out) {
  let x = 0, z = 0;
  if (map.right.some((c) => held.has(c))) x += 1;
  if (map.left.some((c) => held.has(c))) x -= 1;
  if (map.down.some((c) => held.has(c))) z += 1;
  if (map.up.some((c) => held.has(c))) z -= 1;
  const l = Math.hypot(x, z);
  if (l > 0) { x /= l; z /= l; }   // diagonals are not faster
  out.x = x; out.z = z;
  return out;
}
const _in1 = { x: 0, z: 0 }, _in2 = { x: 0, z: 0 };

// =============================================================================
// MOVEMENT & COLLISION
// =============================================================================
// A crossing is under way while either player is over lava, a lock holds, or a foothold stands.
function crossingActive() {
  const p = players.pyre, u = players.umbra;
  if (u.state !== 'normal') return false;
  return !!G.lock || !!G.pad || p.onLava || !floorAt(u.x, u.z);
}
function moveBody(p, dx, dz, other, tether) {
  const dist = Math.hypot(dx, dz);
  const n = Math.max(1, Math.ceil(dist / 0.2));
  for (let i = 0; i < n; i++) {
    let nx = p.x + dx / n, nz = p.z + dz / n;
    nx = clamp(nx, -CFG.WALK_LIMIT, CFG.WALK_LIMIT);
    nz = clamp(nz, CFG.Z_MIN, CFG.Z_MAX);
    for (const o of LEVEL.obstacles) {
      const ox = nx - o.x, oz = nz - o.z, d = Math.hypot(ox, oz), min = o.r + CFG.PLAYER_RADIUS;
      if (d < min) {
        if (d > 1e-6) { nx = o.x + (ox / d) * min; nz = o.z + (oz / d) * min; }
        else nz = o.z + min;
      }
    }
    // shared-screen tether: you may not move further than MAX_SEPARATION from your partner
    if (other) {
      const before = Math.abs(p.z - other.z), after = Math.abs(nz - other.z);
      if (after > CFG.MAX_SEPARATION && after > before) { nz = p.z; p.tethered = 0.6; }
    }
    // co-op crossing tether (Euclidean): Pyre may not walk away from Umbra mid-crossing
    if (other && tether) {
      const before = Math.hypot(p.x - other.x, p.z - other.z), after = Math.hypot(nx - other.x, nz - other.z);
      if (after > tether && after > before) { nx = p.x; nz = p.z; p.tethered = 0.6; }
    }
    p.x = nx; p.z = nz;
  }
}

function updatePyre(dt) {
  const p = players.pyre;
  p.tethered = Math.max(0, p.tethered - dt);
  inputVec(KEYS.p1, _in1);
  // while the Shadow Lock holds, Pyre walks at escort pace so Umbra can stay on his tail
  const sp = p.rooted ? 0 : G.lock ? CFG.ESCORT_SPEED : CFG.PYRE_SPEED;
  const k = 1 - Math.exp(-CFG.ACCEL * dt);
  p.vx += (_in1.x * sp - p.vx) * k;
  p.vz += (_in1.z * sp - p.vz) * k;
  if (p.rooted) { p.vx = 0; p.vz = 0; }
  const u = players.umbra;
  const x0 = p.x, z0 = p.z;
  moveBody(p, p.vx * dt, p.vz * dt, u.state === 'normal' ? u : null, crossingActive() ? CFG.TETHER_CROSSING : 0);
  p.stepDx = p.x - x0; p.stepDz = p.z - z0;   // Umbra rides along by this much when on the locked shadow
  const exact = floorAt(p.x, p.z);
  const foot = exact || floorNear(p.x, p.z, CFG.EDGE_TOL);
  p.onLava = !exact;
  p.onStone = !!foot;
  if (foot) p.region = foot.id;
  p.speed = Math.hypot(p.vx, p.vz);
  if (p.speed > 0.4) p.facing = angleLerp(p.facing, Math.atan2(p.vx, p.vz), 1 - Math.exp(-14 * dt));
}

// =============================================================================
// SUN, MIRRORS, LIVE SHADOW, BRIDGE STATE
// =============================================================================
function updateSun(dt) {
  const s = G.sun;
  s.burstT = Math.max(0, s.burstT - dt);
  s.burstCd = Math.max(0, s.burstCd - dt);
  s.mult = approach(s.mult, s.burstT > 0 ? CFG.BURST_MULT : 1, 14 * dt);
  s.phase += dt * s.mult;
}
function updateMirrors(dt) {
  for (const m of G.mirrors) m.yaw = approach(m.yaw, m.target, CFG.MIRROR_TURN_RATE * dt);
}
function rotateMirror(m, dir) {
  const n = MIRROR_STEPS.length;
  let next;
  if (dir === 0) {
    next = m.step + m.ping;
    if (next < 0 || next >= n) { m.ping = -m.ping; next = m.step + m.ping; }
  } else next = clamp(m.step + dir, 0, n - 1);
  if (next === m.step) { flash('THE MIRROR CAN’T TURN FURTHER THAT WAY', 'info'); SFX.invalid(); return; }
  m.step = next;
  m.target = MIRROR_STEPS[next];
  SFX.plate();
  if (!G.announced['mirror' + m.def.id]) { G.announced['mirror' + m.def.id] = true; toast('MIRROR TURNED — WATCH WHERE ITS LIGHT FALLS', 'info'); }
}

function updateLiveShadow(dt) {
  const L = G.live, p = players.pyre;
  const theta = sunAzimuth(G.sun.phase);
  const sunYaw = shadowYawFromSun(theta);
  let lit = null;
  for (const m of G.mirrors) if (mirrorLight(m.def.x, m.def.z, m.yaw, p.x, p.z)) { lit = m; break; }
  if (lit) {
    if (!L.lit) { if (!G.announced.mirrorLight) { G.announced.mirrorLight = true; toast('MIRROR LIGHT — PYRE’S SHADOW POINTS AWAY FROM THE MIRROR AND HOLDS STILL', 'good', 2.6); } }
    L.mirror = lit;
  }
  L.mirrorBlend = approach(L.mirrorBlend, lit ? 1 : 0, CFG.MIRROR_BLEND_RATE * dt);
  const e = smoothstep(0, 1, L.mirrorBlend);
  let yaw = sunYaw, len = CFG.BRIDGE_LENGTH;
  if (L.mirror && e > 0) {
    const myaw = Math.atan2(p.x - L.mirror.def.x, p.z - L.mirror.def.z);
    yaw = angleLerp(sunYaw, myaw, e);
    len = lerp(CFG.BRIDGE_LENGTH, CFG.MIRROR_LENGTH, e);
  }
  if (!lit && L.mirrorBlend <= 0) L.mirror = null;
  L.lit = !!lit; L.theta = theta; L.sunYaw = sunYaw;
  L.ox = p.x; L.oz = p.z; L.yaw = yaw; L.len = len;
  // ALIGNED = the shadow falls on Umbra, so a lock puts her right on Pyre's tail
  const u = players.umbra;
  const crossing = crossingActive();
  L.valid = u.state === 'normal' && shadowCovers(L.ox, L.oz, L.yaw, L.len, u.x, u.z, L.valid ? CFG.ALIGN_TOL : 0);
  L.status = L.valid ? 'valid' : crossing ? 'unstable' : 'idle';
  if (L.valid) {
    const lv = G.lastValid || (G.lastValid = {});
    lv.yaw = L.yaw; lv.len = L.len;
    lv.t = G.runTime; lv.px = p.x; lv.pz = p.z; lv.ux = u.x; lv.uz = u.z;
  }
}

// The shadow's ORIGIN is always Pyre's feet. A lock only freezes its ANGLE.
function updateBridge(dt) {
  const B = G.bridge, L = G.live;
  B.ox = L.ox; B.oz = L.oz;
  if (G.lock) {
    const lk = G.lock;
    lk.timer -= dt;
    B.yaw = lk.yaw; B.len = lk.len;
    B.mode = 'frozen'; B.valid = true; B.solid = true; B.status = 'valid';
    if (lk.timer <= 0) endLock();
    return;
  }
  if (G.release) {
    const r = G.release;
    r.t += dt;
    const k = easeInOut(clamp(r.t / CFG.RELEASE_TIME, 0, 1));
    B.yaw = angleLerp(r.yaw, L.yaw, k); B.len = lerp(r.len, L.len, k);
    B.mode = 'release'; B.valid = false; B.solid = false; B.status = 'unstable';
    if (r.t >= CFG.RELEASE_TIME) G.release = null;
    return;
  }
  B.yaw = L.yaw; B.len = L.len;
  B.mode = 'live'; B.valid = L.valid; B.solid = false; B.status = L.status;
}

function tryLock() {
  if (G.state !== 'playing') return;
  const p = players.pyre, u = players.umbra;
  if (G.lock) { flash('ALREADY LOCKED — ' + Math.max(0, G.lock.timer).toFixed(1) + 's LEFT', 'info'); return; }
  if (G.lockCd > 0) { flash('SHADOW LOCK RECHARGING — ' + G.lockCd.toFixed(1) + 's', 'warn'); SFX.invalid(); return; }
  const gate = LEVEL.gates[G.gateIndex];
  if (gate && gate.lockAllowed === false) { flash('THE LOCK DOESN’T WORK HERE', 'warn'); SFX.invalid(); return; }
  const L = G.live;
  let geo = null;
  if (L.valid && !G.release) geo = { yaw: L.yaw, len: L.len };
  else if (G.lastValid && G.runTime - G.lastValid.t <= CFG.LOCK_ASSIST) geo = { yaw: G.lastValid.yaw, len: G.lastValid.len };
  // never lock an angle that misses Umbra: re-check from where Pyre stands now
  if (geo && !(u.state === 'normal' && shadowCovers(p.x, p.z, geo.yaw, geo.len, u.x, u.z, CFG.ALIGN_TOL))) geo = null;
  if (!geo) { flash('SHADOW NOT ON UMBRA — SWING IT ONTO HER', 'warn'); SFX.invalid(); return; }
  G.lock = { yaw: geo.yaw, len: geo.len, timer: CFG.LOCK_DURATION, dur: CFG.LOCK_DURATION };
  G.release = null;
  G.locks++;
  // the shadow state switches to the locked angle immediately (render == collision)
  const B = G.bridge;
  B.ox = p.x; B.oz = p.z; B.yaw = geo.yaw; B.len = geo.len; B.mode = 'frozen'; B.valid = true; B.solid = true;
  const loc = {};
  bridgeLocal(u.x, u.z, p.x, p.z, geo.yaw, geo.len, CFG.BRIDGE_WIDTH, loc);
  G.syncBonus = Math.abs(loc.across) < 0.3 && loc.along > 1.2;   // dead-centre on the tail
  burstAlongBridge({ ox: p.x, oz: p.z, yaw: geo.yaw, len: geo.len }, 0x9ffcff, 0xa070ff, 46);
  SFX.lock();
  CAM.shake = Math.max(CAM.shake, 0.06);
  if (G.syncBonus) {
    G.syncs++;
    emit(u.x, 1.0, u.z, { count: 40, speed: 4, up: 3, life: 0.8, size: 0.28, color: 0xffffff, color2: 0x45eeff, gravity: 3, drag: 1.5 });
    SFX.sync();
    toast('PERFECT SYNC! — NEXT LOCK RECHARGES TWICE AS FAST', 'good', 2.2);
  } else toast('SHADOW LOCKED — WALK TOGETHER!', 'good', 1.4);
}
function endLock() {
  const lk = G.lock;
  if (!lk) return;
  const p = players.pyre;
  G.release = { yaw: lk.yaw, len: lk.len, t: 0 };
  G.lock = null;
  G.lockCd = G.shardCharge ? 0 : CFG.LOCK_COOLDOWN * (G.syncBonus ? CFG.SYNC_REFUND : 1);
  G.syncBonus = false;
  G.shardCharge = false;
  burstAlongBridge({ ox: p.x, oz: p.z, yaw: lk.yaw, len: lk.len }, 0xd8b8ff, 0x45eeff, 34);
  SFX.release();
  // the lock timer hit zero: a crystal foothold forms right under Umbra
  const u = players.umbra;
  if (u.state === 'normal') spawnFoothold(u.x, u.z);
}

// ---- crystal foothold: temporary safe ground between chained locks
function spawnFoothold(x, z) {
  G.pad = { x, z, r: CFG.FOOTHOLD_RADIUS, timer: CFG.FOOTHOLD_TIME, dur: CFG.FOOTHOLD_TIME };
  for (let i = 0; i < 34; i++) {
    const a = (i / 34) * Math.PI * 2;
    emit(x + Math.cos(a) * CFG.FOOTHOLD_RADIUS, 0.2, z + Math.sin(a) * CFG.FOOTHOLD_RADIUS, { count: 1, vx: -Math.cos(a) * 2.2, vz: -Math.sin(a) * 2.2, up: 1.6, life: 0.5, size: 0.24, sizeEnd: 0.04, color: 0xbffcff, color2: 0xa070ff, gravity: 2 });
  }
  SFX.plate();
  if (!G.announced.foothold) {
    G.announced.foothold = true;
    toast('CRYSTAL FOOTHOLD — UMBRA IS SAFE FOR ' + CFG.FOOTHOLD_TIME.toFixed(1) + 's. RE-ALIGN AND LOCK AGAIN!', 'info', 2.6);
  }
}
function updateFoothold(dt) {
  const pad = G.pad;
  if (!pad) return;
  pad.timer -= dt;
  if (pad.timer <= 0) {
    for (let i = 0; i < 26; i++) {
      const a = Math.random() * Math.PI * 2, r = Math.random() * pad.r;
      emit(pad.x + Math.cos(a) * r, 0.15, pad.z + Math.sin(a) * r, { count: 1, up: 1.4, speed: 0.4, life: 0.5, size: 0.2, sizeEnd: 0.03, color: 0xd8b8ff, color2: 0x45eeff, gravity: 1.5 });
    }
    G.pad = null;
  }
}
function onFoothold(x, z) {
  const pad = G.pad;
  return !!pad && Math.hypot(x - pad.x, z - pad.z) <= pad.r;
}
function burstAlongBridge(geo, c1, c2, count) {
  const dx = Math.sin(geo.yaw), dz = Math.cos(geo.yaw);
  for (let i = 0; i < count; i++) {
    const t = Math.random() * geo.len, a = (Math.random() - 0.5) * CFG.BRIDGE_WIDTH;
    emit(geo.ox + dx * t + dz * a, CFG.BRIDGE_Y + 0.1, geo.oz + dz * t - dx * a, { count: 1, speed: 0.8, up: 2.2, life: 0.7, size: 0.2, sizeEnd: 0.04, color: c1, color2: c2, gravity: 2.5, drag: 1 });
  }
}

function tryBurst() {
  if (G.state !== 'playing') return;
  if (G.gateIndex < CFG.BURST_GATE) { flash('SOLAR BURST UNLOCKS AT GATE 5', 'info'); SFX.invalid(); return; }
  if (G.sun.burstCd > 0) { flash('SOLAR BURST RECHARGING — ' + G.sun.burstCd.toFixed(1) + 's', 'warn'); SFX.invalid(); return; }
  G.sun.burstT = CFG.BURST_TIME;
  G.sun.burstCd = CFG.BURST_COOLDOWN;
  SFX.burst();
  toast('SOLAR BURST — THE SUN RACES AHEAD', 'good', 1.5);
  const p = players.pyre;
  emit(p.x, 2.0, p.z, { count: 30, speed: 3, up: 2, life: 0.9, size: 0.3, color: 0xffe27a, color2: 0xff6a1a, gravity: 1, drag: 1.2 });
}

// =============================================================================
// UMBRA: movement, support, falls, dash
// =============================================================================
const _loc = { along: 0, across: 0 };
function updateUmbra(dt) {
  const u = players.umbra;
  u.dashCd = Math.max(0, u.dashCd - dt);
  if (u.state === 'falling') { u.fallT += dt; if (u.fallT >= CFG.FALL_TIME) respawnUmbra(); return; }
  if (u.state === 'respawning') { u.spawnT += dt; if (u.spawnT >= CFG.RESPAWN_TIME) { u.state = 'normal'; u.invuln = CFG.INVULN_TIME; } return; }
  u.invuln = Math.max(0, u.invuln - dt);
  u.tethered = Math.max(0, u.tethered - dt);
  const B = G.bridge, p = players.pyre;
  // tail escort: on the locked shadow (off stone) Umbra rides along with Pyre's step.
  // Test against where the shadow was before Pyre moved this step.
  if (B.solid && !u.dash && (p.stepDx || p.stepDz) && !floorAt(u.x, u.z) &&
      bridgeLocal(u.x, u.z, B.ox - p.stepDx, B.oz - p.stepDz, B.yaw, B.len, CFG.BRIDGE_WIDTH)) {
    moveBody(u, p.stepDx, p.stepDz, null);
  }
  const riding = B.solid && !u.dash && !floorAt(u.x, u.z) && bridgeLocal(u.x, u.z, B.ox, B.oz, B.yaw, B.len, CFG.BRIDGE_WIDTH);
  if (u.dash) {
    u.dash.t += dt;
    const sp = CFG.DASH_DIST / CFG.DASH_TIME;
    u.vx = u.dash.dx * sp; u.vz = u.dash.dz * sp;
    moveBody(u, u.vx * dt, u.vz * dt, p);
    if (Math.random() < 0.9) emit(u.x, 0.8, u.z, { count: 2, spread: 0.3, life: 0.35, size: 0.32, sizeEnd: 0.05, color: 0x8ff8ff, color2: 0x7a5cff, alpha: 0.9 });
    if (u.dash.t >= CFG.DASH_TIME) { u.dash = null; u.vx *= 0.4; u.vz *= 0.4; }
  } else {
    inputVec(KEYS.p2, _in2);
    const sp = CFG.UMBRA_SPEED * (u.supported ? 1 : CFG.LAVA_SLOW);
    let tvx = _in2.x * sp, tvz = _in2.z * sp;
    // bridge guidance: on a solid bridge over lava, steer along the bridge
    if (B.solid && u.onBridge && (_in2.x || _in2.z)) {
      const ax = Math.sin(B.yaw), az = Math.cos(B.yaw);
      const proj = _in2.x * ax + _in2.z * az;
      if (Math.abs(proj) > 0.35) {
        const sg = Math.sign(proj);
        let rx = 0.85 * sg * ax + 0.15 * _in2.x, rz = 0.85 * sg * az + 0.15 * _in2.z;
        const rl = Math.hypot(rx, rz) || 1; rx /= rl; rz /= rl;
        const across = (u.x - B.ox) * az - (u.z - B.oz) * ax;
        const corr = clamp(-across * 3.0, -1.6, 1.6);
        tvx = rx * sp + az * corr;
        tvz = rz * sp - ax * corr;
      }
    }
    const k = 1 - Math.exp(-CFG.ACCEL * dt);
    u.vx += (tvx - u.vx) * k;
    u.vz += (tvz - u.vz) * k;
    moveBody(u, u.vx * dt, u.vz * dt, p);
    // on Pyre's tail: over lava the locked shadow has soft edges — Umbra can't
    // overtake his heel or slip off its sides (stone, the foothold or a dash take her off)
    if (riding && !floorNear(u.x, u.z, CFG.UMBRA_EDGE_TOL) && !onFoothold(u.x, u.z)) {
      const ax = Math.sin(B.yaw), az = Math.cos(B.yaw);
      const vx = u.x - B.ox, vz = u.z - B.oz;
      const along = clamp(vx * ax + vz * az, 0.3, B.len - 0.05);
      const across = clamp(vx * az - vz * ax, -CFG.BRIDGE_WIDTH * 0.5 + 0.05, CFG.BRIDGE_WIDTH * 0.5 - 0.05);
      u.x = B.ox + ax * along + az * across;
      u.z = B.oz + az * along - ax * across;
    }
  }
  // support: stone, the locked shadow, a crystal foothold, or mid-dash
  const exact = floorAt(u.x, u.z);
  const stone = exact || floorNear(u.x, u.z, CFG.UMBRA_EDGE_TOL);
  const onB = B.solid && bridgeLocal(u.x, u.z, B.ox, B.oz, B.yaw, B.len, CFG.BRIDGE_WIDTH, _loc);
  const onPad = onFoothold(u.x, u.z);
  u.onBridge = !!onB && !exact;
  u.onPad = onPad && !exact && !u.onBridge;
  u.supported = !!stone || !!onB || onPad || !!u.dash;
  u.onStone = !!stone;
  if (stone) u.region = stone.id;
  u.speed = Math.hypot(u.vx, u.vz);
  if (u.speed > 0.4) u.facing = angleLerp(u.facing, Math.atan2(u.vx, u.vz), 1 - Math.exp(-14 * dt));
  if (u.supported) u.lavaT = 0;
  else {
    u.lavaT += dt;
    if (u.lavaT >= CFG.FALL_GRACE) { startFall('lava'); return; }
  }
  if (!u.dash && u.invuln <= 0) {
    for (const v of G.vents) {
      if (v.phase === 2 && Math.hypot(u.x - v.def.x, u.z - v.def.z) < v.def.r) { startFall('burn'); return; }
    }
  }
  if (u.supported && exact) G.furthestZ = Math.min(G.furthestZ, u.z);
}
function tryDash() {
  const u = players.umbra;
  if (G.state !== 'playing' || u.state !== 'normal' || u.dash) return;
  if (u.dashCd > 0) { SFX.invalid(); return; }
  inputVec(KEYS.p2, _in2);
  let dx = _in2.x, dz = _in2.z;
  if (!dx && !dz) { dx = Math.sin(u.facing); dz = Math.cos(u.facing); }
  u.dash = { t: 0, dx, dz };
  u.dashCd = CFG.DASH_COOLDOWN;
  u.lavaT = 0;
  SFX.dash();
  emit(u.x, 0.7, u.z, { count: 14, speed: 2.5, up: 1, life: 0.4, size: 0.25, color: 0x8ff8ff, color2: 0x7a5cff, drag: 3 });
}
function startFall(kind) {
  const u = players.umbra;
  u.state = 'falling'; u.fallT = 0; u.fallKind = kind;
  u.dash = null; u.vx = 0; u.vz = 0; u.lavaT = 0; u.onBridge = false;
  G.falls++;
  if (kind === 'burn') {
    emit(u.x, 0.8, u.z, { count: 50, speed: 4, up: 5, life: 0.8, size: 0.32, color: 0xffd36a, color2: 0xff3a0a, gravity: 6, drag: 1 });
    SFX.burn();
    toast('UMBRA GOT BURNED — BACK TO THE CHECKPOINT', 'bad', 1.8);
  } else {
    emit(u.x, 0.2, u.z, { count: 40, speed: 3, up: 4, life: 0.8, size: 0.28, color: 0xffb040, color2: 0xff3a0a, gravity: 8, drag: 0.6 });
    SFX.fall();
    toast('UMBRA FELL INTO THE LAVA — BACK TO THE CHECKPOINT', 'bad', 1.8);
  }
  CAM.shake = Math.max(CAM.shake, 0.16);
}
function respawnUmbra() {
  const u = players.umbra;
  u.x = G.respawn.x; u.z = G.respawn.z; u.vx = 0; u.vz = 0;
  u.state = 'respawning'; u.spawnT = 0; u.lavaT = 0; u.dash = null; u.supported = true; u.onBridge = false;
  const f = floorAt(u.x, u.z);
  if (f) u.region = f.id;
  for (let i = 0; i < 26; i++) {
    const a = (i / 26) * Math.PI * 2;
    emit(u.x + Math.cos(a) * 1.4, 0.4, u.z + Math.sin(a) * 1.4, { count: 1, vx: -Math.cos(a) * 3.2, vz: -Math.sin(a) * 3.2, up: 1.2, life: 0.45, size: 0.26, color: 0x45eeff, color2: 0xa070ff });
  }
  SFX.respawn();
}

// =============================================================================
// PLATES, VENTS, SHARDS, GATES, EXIT
// =============================================================================
function updatePlates(dt) {
  for (const pl of G.plates) {
    pl.cool = Math.max(0, pl.cool - dt);
    let inside = false;
    for (const who of BOTH) {
      if (who === players.umbra && who.state !== 'normal') continue;
      if (Math.hypot(who.x - pl.def.x, who.z - pl.def.z) < CFG.PLATE_RADIUS) inside = true;
    }
    if (inside && !pl.inside && pl.cool <= 0) {
      rotateMirror(pl.mirror, pl.def.dir);
      pl.cool = 0.35;
      pl.view.flash = 1;
    }
    pl.inside = inside;
  }
}
function updateVents() {
  for (const v of G.vents) {
    const ph = ventPhase(v.def, G.runTime);
    if (ph.phase === 2 && v.phase !== 2) onVentErupt(v);
    v.phase = ph.phase; v.k = ph.k;
  }
}
function onVentErupt(v) {
  const d = v.def;
  const onStone = !!floorAt(d.x, d.z);
  emit(d.x, onStone ? 0.2 : LAVA_Y + 0.2, d.z, { count: 26, spread: d.r * 0.8, speed: 1.6, up: 9, life: 0.9, size: 0.32, sizeEnd: 0.06, color: 0xffe27a, color2: 0xff3a0a, gravity: 9, drag: 0.4 });
  const near = Math.abs(d.z - CAM.tz) < 12;
  if (near) { SFX.vent(); CAM.shake = Math.max(CAM.shake, 0.05); }
}
function updateShards() {
  for (let i = 0; i < LEVEL.shards.length; i++) {
    if (G.shards[i]) continue;
    const s = LEVEL.shards[i];
    for (const who of BOTH) {
      if (who === players.umbra && who.state !== 'normal') continue;
      if (Math.hypot(who.x - s.x, who.z - s.z) < CFG.SHARD_RADIUS) { collectShard(i); break; }
    }
  }
}
function collectShard(i) {
  G.shards[i] = true;
  G.shardCount++;
  if (G.lock) G.shardCharge = true; else G.lockCd = 0;
  const s = LEVEL.shards[i];
  emit(s.x, 1.0, s.z, { count: 44, speed: 4.2, up: 3.5, life: 0.9, size: 0.3, sizeEnd: 0.04, color: 0xfff0a0, color2: 0xff9a2a, gravity: 4, drag: 1.4 });
  SFX.shard();
  toast('SUN SHARD ' + G.shardCount + ' / ' + LEVEL.shards.length + ' — SHADOW LOCK RECHARGED', 'good', 1.9);
}
function updateGates() {
  if (G.gateIndex >= LEVEL.gates.length) return;
  const gate = LEVEL.gates[G.gateIndex];
  const p = players.pyre, u = players.umbra;
  if (!G.crossed.pyre && p.region >= gate.clearRegion && p.onStone) G.crossed.pyre = true;
  if (u.state === 'normal' && gate.sub && u.onStone) {
    for (const s of gate.sub) {
      const key = G.gateIndex + ':' + s.region;
      if (!G.subReached[key] && u.region === s.region) {
        G.subReached[key] = true;
        G.respawn = { x: s.x, z: s.z };
        toast('HALFWAY! UMBRA’S CHECKPOINT MOVED UP', 'good', 1.8);
        SFX.checkpoint();
      }
    }
  }
  if (!G.crossed.umbra && u.state === 'normal' && u.region >= gate.clearRegion && u.onStone) G.crossed.umbra = true;
  if (G.crossed.pyre && G.crossed.umbra) clearGate();
}
function clearGate() {
  const i = G.gateIndex;
  const gate = LEVEL.gates[i];
  G.respawn = { x: gate.checkpoint.x, z: gate.checkpoint.z };
  G.gateIndex = i + 1;
  G.crossed = { pyre: false, umbra: false };
  if (G.lock) G.shardCharge = true; else G.lockCd = 0;   // checkpoint recharges the Shadow Lock
  if (CFG.GATE_TIME_BONUS > 0) G.timeLeft += CFG.GATE_TIME_BONUS;
  const cp = checkpoints[i];
  cp.active = true; cp.flash = 1;
  emit(gate.checkpoint.x, 0.6, gate.checkpoint.z, { count: 60, spread: 2.4, speed: 2, up: 6, life: 1.1, size: 0.3, sizeEnd: 0.05, color: 0x9ffcff, color2: 0xa070ff, gravity: 2, drag: 1 });
  SFX.gate();
  CAM.shake = Math.max(CAM.shake, 0.08);
  if (G.gateIndex < LEVEL.gates.length) {
    const next = LEVEL.gates[G.gateIndex];
    toast('GATE ' + (i + 1) + ' CLEARED!  NEXT: ' + next.name, 'good', 2.3);
    if (G.gateIndex === CFG.BURST_GATE) setTimeout(() => { if (G.state === 'playing') toast('SOLAR BURST UNLOCKED — PYRE PRESS E TO SPEED UP THE SUN', 'info', 2.6); }, 2400);
  } else {
    toast('ALL SIX GATES CLEARED — REACH THE EXIT ARCH TOGETHER!', 'good', 2.6);
  }
}
function inExit(p) {
  const e = LEVEL.exitZone;
  return p.x >= e.x0 && p.x <= e.x1 && p.z >= e.z0 && p.z <= e.z1;
}
function checkExit() {
  const p = players.pyre, u = players.umbra;
  if (u.state === 'normal' && inExit(p) && inExit(u)) winRun();
}

// =============================================================================
// RUN FLOW: start, restart, pause, win, lose
// =============================================================================
function simStep(dt) {
  G.runTime += dt;
  G.timeLeft -= dt;
  if (G.timeLeft <= 0) { G.timeLeft = 0; loseRun(); return; }
  const sec = Math.ceil(G.timeLeft);
  if (sec !== G.lastTick) { G.lastTick = sec; if (sec <= 10) SFX.tick(); }
  updateSun(dt);
  updateMirrors(dt);
  updateVents();
  updatePyre(dt);
  updateLiveShadow(dt);
  updateBridge(dt);
  updateFoothold(dt);
  updateUmbra(dt);
  updatePlates(dt);
  updateShards();
  updateGates();
  if (!G.lock) G.lockCd = Math.max(0, G.lockCd - dt);
  if (G.gateIndex >= LEVEL.gates.length) checkExit();
}
function resetPlayer(p, start) {
  Object.assign(p, makePlayer(start));
}
function resetRun() {
  G.runTime = 0;
  G.timeLeft = CFG.ROUND_TIME;
  G.gateIndex = 0;
  G.crossed = { pyre: false, umbra: false };
  G.respawn = { x: LEVEL.start.checkpoint.x, z: LEVEL.start.checkpoint.z };
  G.subReached = {};
  G.shards.fill(false);
  G.shardCount = 0;
  G.falls = 0; G.locks = 0; G.syncs = 0;
  G.sun.phase = CFG.SUN_START_PHASE; G.sun.mult = 1; G.sun.burstT = 0; G.sun.burstCd = 0;
  G.lock = null; G.release = null; G.pad = null; G.lockCd = 0; G.syncBonus = false; G.shardCharge = false; G.lastValid = null;
  Object.assign(G.live, { valid: false, status: 'idle', landDist: -1, landRegion: -1, mirrorBlend: 0, mirror: null, lit: false });
  Object.assign(G.bridge, { mode: 'live', valid: false, solid: false, status: 'idle', landDist: -1 });
  for (const m of G.mirrors) { m.step = m.def.startStep; m.yaw = m.target = MIRROR_STEPS[m.step]; m.ping = 1; }
  for (const pl of G.plates) { pl.inside = false; pl.cool = 0; pl.view.flash = 0; }
  for (const v of G.vents) { v.phase = 0; v.k = 0; }
  G.winT = 0; G.loseT = 0; G.overlayShown = false;
  G.lastTick = 999;
  G.furthestZ = LEVEL.start.umbra.z;
  G.hintFlash = { msg: '', t: 0 };
  G.announced = {};
  resetPlayer(players.pyre, LEVEL.start.pyre);
  resetPlayer(players.umbra, LEVEL.start.umbra);
  for (const cp of checkpoints) { cp.active = false; cp.flash = 0; }
  clearParticles();
  hideToast();
  ARC.next = -1; ARC.any = false; ARC.timer = 0;
  // compute the starting shadow so the first frame is consistent
  updateLiveShadow(0);
  updateBridge(0);
  updateCamera(0, true);
}
function startRun() {
  resetRun();
  G.state = 'playing';
  setOverlayVisible(false);
  ensureAudio();
  SFX.start();
  toast('GATE 1 — ' + LEVEL.gates[0].name + '.  PYRE, LEAD — UMBRA RIDES YOUR SHADOW!', 'info', 2.6);
}
function restartRun() {
  if (G.state === 'loading') return;
  startRun();
}
function pauseRun(auto) {
  if (G.state !== 'playing') return;
  G.state = 'paused';
  held.clear();
  hideToast();
  setOverlay('PAUSED', auto ? 'The window lost focus, so the run is paused.<br>Press <b>ENTER</b> or the button to continue.' : 'Press <b>ENTER</b>, <b>P</b> or the button to continue. <b>R</b> restarts.', 'RESUME');
}
function resumeRun() {
  if (G.state !== 'paused') return;
  G.state = 'playing';
  setOverlayVisible(false);
  ensureAudio();
}
function loseRun() {
  if (G.state !== 'playing') return;
  G.state = 'lost';
  G.loseT = 0;
  G.lock = null; G.release = null;
  players.pyre.rooted = false;
  SFX.defeat();
}
function winRun() {
  if (G.state !== 'playing') return;
  G.state = 'won';
  G.winT = 0;
  G.lock = null; G.release = null;
  players.pyre.rooted = false;
  SFX.victory();
  emit(0, 1.0, -58.4, { count: 120, spread: 3, speed: 3, up: 8, life: 1.6, size: 0.35, sizeEnd: 0.05, color: 0xfff0a0, color2: 0x45eeff, gravity: 4, drag: 0.8 });
}
function formatTime(s) {
  const t = Math.max(0, Math.ceil(s));
  return Math.floor(t / 60) + ':' + String(t % 60).padStart(2, '0');
}
function showEndOverlay() {
  G.overlayShown = true;
  hideToast();
  const shards = G.shardCount + ' / ' + LEVEL.shards.length;
  if (G.state === 'won') {
    setOverlay('ESCAPED!', 'Pyre and Umbra made it out together.<br>Time left <b>' + formatTime(G.timeLeft) + '</b> · Sun shards <b>' + shards + '</b> · Falls <b>' + G.falls + '</b> · Perfect syncs <b>' + G.syncs + '</b><br><br>Press <b>ENTER</b> or <b>R</b> to play again.', 'PLAY AGAIN');
  } else {
    const where = G.gateIndex >= LEVEL.gates.length ? 'the exit' : 'Gate ' + (G.gateIndex + 1) + ' · ' + LEVEL.gates[G.gateIndex].name;
    setOverlay('THE SUN HAS SET', 'Time ran out at <b>' + where + '</b>.<br>Sun shards <b>' + shards + '</b> · Falls <b>' + G.falls + '</b><br><br>Press <b>ENTER</b> or <b>R</b> to try again.', 'TRY AGAIN');
  }
}
function showStartOverlay() {
  setOverlay('UMBRA',
    'Escape the volcanic temple before the sun sets — <b>6 lava gates in 2:30</b>.<br>' +
    '<span style="color:#ffb066"><b>PYRE</b></span> walks on lava. His shadow trails from his feet and swings with the sun. When it falls on Umbra it glows <span style="color:#7ff6ff">cyan</span> — lock its angle and walk her across.<br>' +
    '<span style="color:#7ff6ff"><b>UMBRA</b></span> crosses lava on Pyre’s tail. When a lock runs out, a crystal foothold holds her until the next one.' +
    '<div class="umbra-overlay-keys">' +
    '<b>W A S D</b><span>Pyre moves</span><b>SPACE</b><span>Shadow Lock (lock the angle)</span><b>E</b><span>Solar Burst (from Gate 5)</span>' +
    '<span class="u"><b class="u">ARROWS</b></span><span>Umbra moves</span><span class="u"><b class="u">RIGHT SHIFT</b></span><span>Shadow Dash (also the / key or Numpad 0)</span>' +
    '<b>R</b><span>restart · <b>P</b> pause · <b>M</b> mute</span></div>',
    'START RUN');
}
function confirmOverlay() {
  if (G.state === 'ready') startRun();
  else if (G.state === 'paused') resumeRun();
  else if (G.state === 'won' || G.state === 'lost') restartRun();
}
function toggleMute() {
  AUDIO.muted = !AUDIO.muted;
  if (AUDIO.master) AUDIO.master.gain.value = AUDIO.muted ? 0 : 0.42;
  toast(AUDIO.muted ? 'SOUND OFF' : 'SOUND ON', 'info', 1.0);
}

// =============================================================================
// ALIGNMENT FORECAST — which sun positions give a valid bridge from Pyre's spot
// (drives the cyan arcs on the sun track and the "alignment in 1.4s" hint)
// =============================================================================
const ARC = { valid: trackValid, any: false, next: -1, timer: 0 };
function computeArcs() {
  const p = players.pyre, u = players.umbra;
  ARC.any = false;
  for (let i = 0; i <= TRACK_N; i++) {
    const s = -1 + (2 * i) / TRACK_N;
    const ok = u.state === 'normal' && shadowCovers(p.x, p.z, shadowYawFromSun(s * CFG.SUN_MAX_DEG * DEG), CFG.BRIDGE_LENGTH, u.x, u.z, 0);
    ARC.valid[i] = ok ? 1 : 0;
    if (ok) ARC.any = true;
  }
  ARC.next = -1;
  if (ARC.any) {
    for (let t = 0; t <= CFG.SUN_PERIOD; t += 0.05) {
      const s = sunNorm(G.sun.phase + t);
      if (ARC.valid[Math.round(((s + 1) / 2) * TRACK_N)]) { ARC.next = t; break; }
    }
  }
}
function paintTrack() {
  const mirrorLit = G.live.mirrorBlend > 0.5;
  for (let i = 0; i <= TRACK_N; i++) {
    let r = 0.42, g = 0.22, b = 0.12;
    if (mirrorLit) { r = 0.22; g = 0.15; b = 0.1; }
    else if (ARC.valid[i]) { r = 0.18; g = 0.85; b = 1.0; }
    trackCol[i * 6] = r; trackCol[i * 6 + 1] = g; trackCol[i * 6 + 2] = b;
    trackCol[i * 6 + 3] = r; trackCol[i * 6 + 4] = g; trackCol[i * 6 + 5] = b;
  }
  trackGeo.attributes.color.needsUpdate = true;
}

// =============================================================================
// VISUAL UPDATE (runs every frame; never changes gameplay state)
// =============================================================================
let vtime = 0;
const COL = {
  idleFill: vec3(0x1d1029), idleEdge: vec3(0x6e3c5e),
  unstableFill: vec3(0x2c1838), unstableEdge: vec3(0xff5a2a),
  alignedFill: vec3(0x5a2aa6), alignedEdge: vec3(0x45eeff),
  frozenFill: vec3(0x7a46ff), frozenEdge: vec3(0xc8fdff),
  releaseFill: vec3(0x4a2a7c), releaseEdge: vec3(0xd0a8ff),
};
function updateBridgeVisual(dt) {
  const B = G.bridge, p = players.pyre, S = shadowSil;
  S.root.visible = G.state !== 'lost';
  S.root.position.set(B.ox, CFG.BRIDGE_Y, B.oz);
  S.root.rotation.set(0, B.yaw, 0);
  S.root.scale.set(1, 1, B.len / CFG.BRIDGE_LENGTH);
  // walk cycle, in step with Pyre's stride
  const run = clamp(p.speed / CFG.PYRE_SPEED, 0, 1);
  const stride = Math.max(run, G.lock && p.speed > 0.3 ? 0.55 : 0);
  const sw = Math.sin(p.walk) * stride;
  S.legL.rotation.y = sw * 0.34; S.legR.rotation.y = -sw * 0.34;
  S.armL.rotation.y = -sw * 0.42; S.armR.rotation.y = sw * 0.42;
  S.torso.rotation.y = sw * 0.035;
  S.head.position.x = Math.sin(p.walk) * 0.07 * stride;
  S.head.rotation.y = Math.sin(p.walk + 0.6) * 0.06 * stride;
  S.head.position.z = 0.76 * CFG.BRIDGE_LENGTH + Math.abs(Math.cos(p.walk)) * 0.06 * stride;
  const flare = G.lock ? 1.25 : 1;
  for (const s of S.spikes) s.node.scale.set(1, 1, (0.86 + 0.16 * Math.sin(vtime * 12 + s.ph) + 0.08 * Math.sin(vtime * 29 + s.ph * 2)) * flare);
  silEyeMat.color.setHex(B.mode === 'frozen' ? 0xdffeff : B.valid ? 0x9ffcff : 0xfff09a);
  silEyeGlowMat.color.setHex(B.mode === 'frozen' || B.valid ? 0x45eeff : 0xffa040);
  silEyeGlowMat.opacity = 0.6 + 0.25 * Math.sin(vtime * 6);
  silHeelRingMat.opacity = (G.lock ? 0.85 : 0.45) + 0.15 * Math.sin(vtime * 8);
  S.heelRing.scale.setScalar(1 + (G.lock ? 0.08 * Math.sin(vtime * 9) : 0));
  silFillMat.uniforms.uTime.value = vtime;
  silFillMat.uniforms.uO.value.set(B.ox, B.oz);
  silFillMat.uniforms.uD.value.set(Math.sin(B.yaw), Math.cos(B.yaw));
  const u = bridgeMat.uniforms;
  u.uTime.value = vtime; u.uL.value = B.len; u.uW.value = CFG.BRIDGE_WIDTH;
  let fill, edge, glow, frozen = 0, dim = 0;
  if (B.mode === 'frozen') { fill = COL.frozenFill; edge = COL.frozenEdge; glow = 1.0; frozen = 1; }
  else if (B.mode === 'release') { fill = B.valid ? COL.releaseFill : COL.unstableFill; edge = B.valid ? COL.releaseEdge : COL.unstableEdge; glow = 0.6; }
  else if (B.valid) { fill = COL.alignedFill; edge = COL.alignedEdge; glow = 0.8; }
  else if (B.status === 'idle' || B.status === 'nostone' || (B.status === 'blocked' && !(B.lavaStart >= 0))) { fill = COL.idleFill; edge = COL.idleEdge; glow = 0.15; dim = 1; }
  else { fill = COL.unstableFill; edge = COL.unstableEdge; glow = 0.35; }
  const k = 1 - Math.exp(-(B.mode === 'frozen' ? 24 : 11) * dt);
  u.uFill.value.lerp(fill, k);
  u.uEdge.value.lerp(edge, k);
  u.uGlow.value += (glow - u.uGlow.value) * k;
  u.uFrozen.value += (frozen - u.uFrozen.value) * k;
  u.uDim.value += (dim - u.uDim.value) * k;
  // rim + heel ring take the edge colour (uniforms hold raw sRGB values)
  const ev = u.uEdge.value;
  silRimMat.color.setRGB(ev.x, ev.y, ev.z, THREE.SRGBColorSpace);
  silHeelRingMat.color.setRGB(ev.x, ev.y, ev.z, THREE.SRGBColorSpace);
  let crack = 0;
  if (G.lock) crack = clamp((0.8 - G.lock.timer) / 0.8, 0, 1);
  else if (G.release) crack = 1 - clamp(G.release.t / CFG.RELEASE_TIME, 0, 1);
  u.uCrack.value = crack;
  let vi = 0;
  const ex = B.ox + Math.sin(B.yaw) * B.len, ez = B.oz + Math.cos(B.yaw) * B.len;
  for (const v of G.vents) {
    if (vi >= 4) break;
    const d = v.def;
    if (distToSegment(d.x, d.z, B.ox, B.oz, ex, ez) > d.r + CFG.BRIDGE_WIDTH) continue;
    const w = v.phase === 2 ? 1 : v.phase === 1 ? -v.k : 0;
    if (w === 0) continue;
    u.uVent.value[vi].set(d.x, d.z, d.r, w);
    vi++;
  }
  for (; vi < 4; vi++) u.uVent.value[vi].set(0, 0, 0, 0);
}
function updatePreview(dt) {
  const L = G.live;
  const show = G.state === 'playing' && G.gateIndex >= 1 && !G.lock && !G.release && L.mirrorBlend < 0.05 && ARC.any && !G.bridge.valid;
  const a = approach(previewMat.uniforms.uAlpha.value, show ? 0.9 : 0, dt * 3.5);
  previewMat.uniforms.uAlpha.value = a;
  previewMesh.visible = a > 0.01;
  if (!previewMesh.visible) return;
  const yaw = shadowYawFromSun(sunAzimuth(G.sun.phase + 0.9 * G.sun.mult));
  previewMesh.position.set(L.ox, CFG.BRIDGE_Y + 0.03, L.oz);
  previewMesh.rotation.set(0, yaw, 0);
  previewMesh.scale.set(CFG.BRIDGE_WIDTH, 1, CFG.BRIDGE_LENGTH);
  previewMat.uniforms.uL.value = CFG.BRIDGE_LENGTH;
  previewMat.uniforms.uTime.value = vtime;
}
function updateLockRing() {
  if (!G.lock || G.state === 'lost') { ringMesh.visible = false; return; }
  const lk = G.lock, B = G.bridge;
  ringMesh.visible = true;
  // the countdown ring rides on Pyre's heel pad, moving with him
  ringMesh.position.set(B.ox, 0.2, B.oz);
  const left = clamp(lk.timer / lk.dur, 0, 1);
  ringMat.uniforms.uProgress.value = left;
  ringMat.uniforms.uColor.value.copy(left < 0.32 ? RING_LOW : RING_OK);
}
function updateFootholdVisual(dt) {
  const pad = G.pad;
  const fu = footholdMat.uniforms;
  fu.uTime.value = vtime;
  const target = pad && G.state !== 'lost' ? 1 : 0;
  fu.uAlpha.value = approach(fu.uAlpha.value, target, dt * (target ? 9 : 4));
  footholdMesh.visible = fu.uAlpha.value > 0.01;
  footholdGlow.visible = footholdMesh.visible;
  if (!pad) return;
  const left = clamp(pad.timer / pad.dur, 0, 1);
  fu.uLeft.value = left;
  fu.uR.value = pad.r;
  footholdMesh.position.set(pad.x, CFG.BRIDGE_Y + 0.035, pad.z);
  footholdMesh.scale.setScalar(pad.r);
  footholdGlow.position.set(pad.x, CFG.BRIDGE_Y + 0.03, pad.z);
  footholdGlow.scale.setScalar(pad.r * 1.45);
  footholdGlow.material.opacity = (0.35 + 0.12 * Math.sin(vtime * 5)) * fu.uAlpha.value * (0.4 + 0.6 * left);
  if (G.state === 'playing' && Math.random() < dt * 14) {
    const a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * pad.r * 0.85;
    emit(pad.x + Math.cos(a) * r, 0.15, pad.z + Math.sin(a) * r, { count: 1, up: 1.1, speed: 0.15, life: 0.6, size: 0.14, sizeEnd: 0.02, color: 0xbffcff, color2: 0xa070ff, gravity: -0.4 });
  }
}
const _sunPos = { x: 0, y: 0 };
function sunElevation(s) { return (22 + 34 * (1 - s * s)) * DEG; }
function updateSunVisual(dt, ecl) {
  const s = sunNorm(G.sun.phase);
  sunScreen(s, _sunPos);
  const z = -SUN_DEPTH;
  sunCore.position.set(_sunPos.x, _sunPos.y, z);
  sunHalo.position.set(_sunPos.x, _sunPos.y, z - 0.3);
  sunRays.position.set(_sunPos.x, _sunPos.y, z - 0.2);
  sunCorona.position.set(_sunPos.x, _sunPos.y, z + 0.2);
  const burst = G.sun.burstT > 0 ? 1 : 0;
  sunRays.rotation.z += dt * (0.25 + 1.6 * burst);
  sunHalo.material.opacity = (0.62 + 0.08 * Math.sin(vtime * 2.2) + 0.3 * burst) * (1 - 0.45 * ecl);
  sunRays.material.opacity = (0.55 + 0.35 * burst) * (1 - 0.6 * ecl);
  const r = sunCore.scale.x * 0.5;
  sunMoon.visible = ecl > 0.02;
  sunMoon.position.set(_sunPos.x + (1 - ecl) * r * 2.3 + 0.12 * r, _sunPos.y + 0.08 * r, z + 0.1);
  sunCorona.material.opacity = 0.85 * ecl;
  if (G.state === 'lost') { sunCore.material.color.setHex(0xa84a2a); } else sunCore.material.color.setHex(burst ? 0xfff6c8 : 0xffe7a0);
  const theta = s * CFG.SUN_MAX_DEG * DEG, elev = sunElevation(s);
  sunLight.position.set(CAM.tx + Math.sin(theta) * Math.cos(elev) * 40, Math.sin(elev) * 40, CAM.tz - Math.cos(theta) * Math.cos(elev) * 40);
  sunLight.target.position.set(CAM.tx, 0, CAM.tz);
}
function updateFakeShadows() {
  const s = sunNorm(G.sun.phase);
  const yaw = shadowYawFromSun(s * CFG.SUN_MAX_DEG * DEG);
  const k = clamp(1 / Math.tan(sunElevation(s)), 0.6, 2.4) * 0.55;
  for (const m of shadowCasters) {
    m.rotation.y = yaw;
    m.scale.set(m.userData.width, 1, m.userData.height * k);
  }
}
function updateCharacters(dt) {
  const p = players.pyre, u = players.umbra, pv = pyreView, uv = umbraView;
  const won = G.state === 'won';
  // ---- Pyre
  pv.group.position.set(p.x, won ? Math.abs(Math.sin(vtime * 7)) * 0.5 : 0, p.z);
  pv.group.rotation.y = won ? pv.group.rotation.y + dt * 4 : p.facing;
  const run = clamp(p.speed / CFG.PYRE_SPEED, 0, 1);
  if (run > 0.05) p.walk += dt * (7 + 7 * run);
  const sw = Math.sin(p.walk) * 0.75 * run;
  pv.legL.rotation.x = sw; pv.legR.rotation.x = -sw;
  const channeling = !!G.lock;   // Pyre holds the Shadow Lock while he escorts Umbra
  if (won || (channeling && run < 0.05)) { pv.armL.rotation.set(-2.5, 0, -0.3); pv.armR.rotation.set(-2.5, 0, 0.3); }
  else { pv.armL.rotation.set(-sw * 0.8, 0, -0.1); pv.armR.rotation.set(sw * 0.8, 0, 0.1); }
  pv.body.position.y = Math.abs(Math.sin(p.walk)) * 0.07 * run;
  pv.body.rotation.x = 0.12 * run;
  const flare = channeling ? 1.7 : 1;
  for (const f of pv.crownFlames) {
    const s = (0.85 + 0.3 * Math.sin(vtime * 13 + f.ph) + 0.15 * Math.sin(vtime * 31 + f.ph * 2)) * flare;
    f.f.scale.set(1, s, 1); f.fi.scale.set(1, s * 1.1, 1);
  }
  pv.glow.material.opacity = 0.55 + 0.15 * Math.sin(vtime * 7) + (channeling ? 0.35 : 0);
  pv.lavaRing.material.opacity = approach(pv.lavaRing.material.opacity, p.onLava ? 0.75 : 0, dt * 5);
  pv.lavaRing.position.y = p.onLava ? LAVA_Y + 0.08 : 0.05;
  pv.blob.visible = !p.onLava;
  pv.channel.material.opacity = approach(pv.channel.material.opacity, channeling ? 0.85 : 0, dt * 6);
  pv.channel.scale.setScalar(1 + 0.15 * Math.sin(vtime * 9));
  if (G.state === 'playing' || G.state === 'ready' || won) {
    if (Math.random() < dt * (channeling ? 26 : 10)) {
      const a = Math.random() * 6.28;
      emit(p.x + Math.sin(a) * 0.2, 2.1, p.z + Math.cos(a) * 0.2, { count: 1, up: 1.6, speed: 0.3, life: 0.6, size: 0.14, sizeEnd: 0.02, color: 0xffd36a, color2: 0xff4a0a, gravity: -0.5 });
    }
    if (p.onLava && p.speed > 1 && Math.random() < dt * 40) {
      emit(p.x, LAVA_Y + 0.1, p.z, { count: 1, spread: 0.5, up: 2.2, speed: 0.6, life: 0.5, size: 0.2, sizeEnd: 0.03, color: 0xffe27a, color2: 0xff3a0a, gravity: 4 });
    }
  }
  const hintA = G.state === 'ready' ? 1 : G.state === 'playing' ? clamp(1 - (G.runTime - 9) / 2, 0, 1) : 0;
  pv.hint.material.opacity = hintA; uv.hint.material.opacity = hintA;
  pv.hint.visible = hintA > 0.01; uv.hint.visible = hintA > 0.01;
  // ---- Umbra
  const raised = u.onBridge || u.onPad;
  let uy = raised ? CFG.BRIDGE_Y : 0;
  let scale = 1, spin = 0;
  uv.danger.material.opacity = 0;
  uv.body.position.y = 0;
  if (u.state === 'falling') {
    const t = clamp(u.fallT / CFG.FALL_TIME, 0, 1);
    uy = -1.5 * t * t; scale = 1 - 0.55 * t; spin = t * 6;
    if (u.fallKind === 'lava' && Math.random() < dt * 30) emit(u.x, LAVA_Y + 0.1, u.z, { count: 1, spread: 0.6, up: 2.5, life: 0.5, size: 0.2, color: 0xffb040, color2: 0x3a0a0a, gravity: 3 });
  } else if (u.state === 'respawning') {
    const t = clamp(u.spawnT / CFG.RESPAWN_TIME, 0, 1);
    scale = Math.max(0.02, 1 + 2.70158 * Math.pow(t - 1, 3) + 1.70158 * Math.pow(t - 1, 2));
  } else {
    if (!u.supported) {
      const t = clamp(u.lavaT / CFG.FALL_GRACE, 0, 1);
      uv.body.position.y = -0.35 * t;
      uv.danger.material.opacity = 0.4 + 0.5 * t;
      if (Math.random() < dt * 40) emit(u.x, 0.1, u.z, { count: 1, spread: 0.5, up: 2, life: 0.4, size: 0.18, color: 0xffd36a, color2: 0xff3a0a, gravity: 2 });
    }
    if (u.dash) uy += 0.35 * Math.sin((Math.PI * u.dash.t) / CFG.DASH_TIME);
  }
  if (won) uy += Math.abs(Math.sin(vtime * 7 + 1.2)) * 0.5;
  uy += 0.05 + 0.04 * Math.sin(vtime * 3.1);
  uv.group.position.set(u.x, uy, u.z);
  uv.group.rotation.y = (won ? uv.group.rotation.y - dt * 4 : u.facing) + spin;
  uv.body.scale.setScalar(scale);
  const urun = clamp(u.speed / CFG.UMBRA_SPEED, 0, 1);
  uv.cloak.rotation.x = 0.16 * urun;
  if (urun > 0.05) u.walk += dt * (6 + 8 * urun);
  uv.wisps.forEach((w, i) => {
    const a = vtime * 2.2 + w.ph;
    w.w.position.set(Math.cos(a) * 0.62, 0.95 + 0.22 * Math.sin(vtime * 3 + i), Math.sin(a) * 0.62);
  });
  uv.scarf.forEach((s, i) => {
    s.position.x = Math.sin(vtime * 7 + i * 0.9) * 0.05 * (i + 1) * (0.4 + urun);
    s.position.y = 1.16 - i * (0.03 + 0.04 * (1 - urun));
  });
  uv.glow.material.opacity = 0.3 + (u.invuln > 0 ? 0.35 + 0.25 * Math.sin(vtime * 14) : 0);
  uv.blob.visible = u.state === 'normal';
  uv.blob.position.y = (raised ? CFG.BRIDGE_Y + 0.05 : 0) + 0.02 - uy;
  uv.shadow.visible = u.state === 'normal' && !u.dash;
  uv.shadow.position.set(u.x, raised ? CFG.BRIDGE_Y + 0.05 : 0.02, u.z);
}
function updateMirrorVisuals(dt) {
  G.mirrors.forEach((m, i) => {
    const v = mirrorViews[i];
    v.yaw.rotation.y = m.yaw;
    const litHere = G.live.mirror === m && G.live.mirrorBlend > 0;
    const near = Math.abs(m.def.z - CAM.tz) < 18;
    v.wedgeMat.opacity = approach(v.wedgeMat.opacity, near ? (litHere ? 0.42 : 0.24) : 0, dt * 2);
    v.wedge.visible = v.wedgeMat.opacity > 0.005;
    v.glint.material.opacity = 0.55 + 0.25 * Math.sin(vtime * 3 + i) + (litHere ? 0.25 : 0);
    const e = litHere ? smoothstep(0, 1, G.live.mirrorBlend) : 0;
    v.rayMat.opacity = 0.6 * e;
    v.ray.visible = e > 0.01;
    if (v.ray.visible) {
      const p = players.pyre, dx = p.x - m.def.x, dz = p.z - m.def.z;
      v.ray.rotation.y = Math.atan2(dx, dz);
      v.ray.scale.set(0.22 + 0.05 * Math.sin(vtime * 10), 1, Math.hypot(dx, dz));
    }
  });
  for (const pl of G.plates) {
    pl.view.flash = Math.max(0, pl.view.flash - dt * 2.5);
    pl.view.mat.opacity = 0.42 + 0.45 * pl.view.flash + (pl.inside ? 0.2 : 0);
    pl.view.rim.position.y = pl.inside ? 0.0 : 0.04;
  }
}
function updateVentVisuals(dt) {
  G.vents.forEach((v, i) => {
    const vv = ventViews[i];
    const ph = G.state === 'ready' ? ventPhase(v.def, vtime) : v;
    const warn = ph.phase === 1 ? ph.k : 0;
    vv.warn.material.opacity = warn > 0 ? 0.3 + 0.6 * warn : 0;
    vv.warn.scale.setScalar(v.def.r * (ph.phase === 1 ? 0.55 + 0.45 * warn : 1));
    const erupt = ph.phase === 2 ? Math.sin(Math.PI * clamp(ph.k * 1.25 + 0.08, 0, 1)) : 0;
    vv.column.visible = erupt > 0.02;
    vv.column.scale.y = Math.max(0.001, erupt);
    vv.column.position.y = 1.7 * erupt;
    vv.glow.material.opacity = 0.9 * erupt + 0.3 * warn;
    vv.core.material.opacity = 0.4 + 0.35 * warn + 0.5 * erupt;
    if (erupt > 0.25 && Math.random() < dt * 24) {
      emit(v.def.x, (vv.onStone ? 0.2 : LAVA_Y) + 1.5 * Math.random(), v.def.z, { count: 1, spread: v.def.r, up: 4, speed: 1, life: 0.6, size: 0.24, color: 0xffd36a, color2: 0xff3a0a, gravity: 3 });
    }
  });
}
function updateShardVisuals(dt) {
  shardViews.forEach((s, i) => {
    s.g.visible = !G.shards[i];
    if (!s.g.visible) return;
    s.gem.rotation.y += dt * 1.6;
    s.gem.position.y = 0.95 + 0.14 * Math.sin(vtime * 2.4 + s.ph);
    s.halo.position.y = s.gem.position.y;
    s.halo.material.opacity = 0.65 + 0.2 * Math.sin(vtime * 4 + s.ph);
    s.ring.rotation.z += dt * 0.8;
  });
}
function updateCheckpointVisuals(dt) {
  for (const cp of checkpoints) {
    cp.flash = Math.max(0, cp.flash - dt * 0.7);
    cp.mat.opacity = approach(cp.mat.opacity, cp.active ? 0.85 : 0.3, dt * 2);
    cp.mat.color.setHex(cp.active ? 0x45eeff : 0x9a6aff);
    cp.disc.rotation.z += dt * (cp.active ? 0.7 : 0.15);
    cp.beam.material.opacity = cp.flash * 0.45;
    cp.beam.visible = cp.flash > 0.01;
    for (const sp of cp.spikes) {
      sp.material.emissive.setHex(cp.active ? 0x2aa8c8 : 0x2a1050);
      sp.rotation.y += dt * (cp.active ? 1.5 : 0.3);
    }
  }
}
function updateDecor(dt) {
  for (const r of runeRings) {
    r.ring.rotation.z += dt * 0.6;
    r.ring.position.y = 1.6 + 0.12 * Math.sin(vtime * 1.4 + r.ph);
    r.crystal.rotation.y += dt;
    r.crystal.position.y = 3.25 + 0.1 * Math.sin(vtime * 2 + r.ph);
  }
  for (const f of flames) {
    const s = 0.85 + 0.25 * Math.sin(vtime * 11 + f.ph) + 0.12 * Math.sin(vtime * 23 + f.ph);
    f.f1.scale.set(1, s, 1); f.f2.scale.set(1, s * 1.15, 1);
    f.glow.material.opacity = 0.55 + 0.15 * Math.sin(vtime * 9 + f.ph);
    if (Math.abs(f.z - CAM.tz) < 14 && Math.random() < dt * 2.5) emit(f.x, f.y + 0.2, f.z, { count: 1, up: 1.8, speed: 0.3, life: 0.9, size: 0.12, color: 0xffc04a, color2: 0xff3a0a, gravity: -0.3 });
  }
  for (const m of floatingRocks) {
    m.position.y = m.userData.y0 + 0.35 * Math.sin(vtime * m.userData.sp + m.userData.ph);
    m.rotation.y += dt * 0.1;
  }
  const exitOpen = G.gateIndex >= LEVEL.gates.length;
  portalMat.uniforms.uPower.value = approach(portalMat.uniforms.uPower.value, G.state === 'won' ? 1.8 : exitOpen ? 1.2 : 0.55, dt);
  exitFx.exitDisc.material.opacity = exitOpen ? 0.4 + 0.25 * Math.sin(vtime * 4) : 0.18;
  exitFx.emblemGlow.material.opacity = 0.7 + 0.2 * Math.sin(vtime * 2);
}
function updateAmbient(dt) {
  // embers drifting up from the lava near the camera
  const n = Math.random() < dt * 22 ? 1 : 0;
  for (let i = 0; i < n; i++) {
    const x = (Math.random() * 2 - 1) * 8.3, z = CAM.tz + (Math.random() * 2 - 1) * 11;
    if (!floorAt(x, z)) emit(x, LAVA_Y + 0.05, z, { count: 1, up: 1.3, speed: 0.25, life: 1.6, size: 0.12, sizeEnd: 0.02, color: 0xffb040, color2: 0xff2a0a, gravity: -0.2, alpha: 0.85 });
  }
  if (Math.random() < dt * 6) {
    const side = Math.random() < 0.5 ? -1 : 1;
    emit(side * (11.5 + Math.random() * 5), -2 + Math.random() * 2, CAM.tz + (Math.random() * 2 - 1) * 12, { count: 1, up: 1.6, speed: 0.4, life: 2.2, size: 0.16, color: 0xff8a2a, color2: 0x5a0a0a, gravity: -0.1, alpha: 0.7 });
  }
}
function eclipseFactor() { return smoothstep(-27, -40, CAM.tz); }
function updateEclipse(ecl) {
  hemi.intensity = 0.46 * LIGHT_SCALE * (1 - 0.4 * ecl);
  ambient.intensity = 0.2 * LIGHT_SCALE * (1 - 0.25 * ecl);
  sunLight.intensity = 0.78 * LIGHT_SCALE * (1 - 0.55 * ecl);
  scene.fog.color.copy(FOG_BASE).lerp(FOG_ECLIPSE, ecl);
  lavaMat.uniforms.uHeat.value = 1 + 0.15 * ecl;
}
function updateCamera(dt, snap) {
  const p = players.pyre, u = players.umbra;
  const mz = (p.z + u.z) / 2 - 2.8;
  const mx = ((p.x + u.x) / 2) * 0.12;
  const need = clamp((Math.abs(p.z - u.z) * Math.sin(CAM.elev) * 0.5 + 3.0) / CAM.halfH, 1, 1.42);
  const oldZoom = CAM.zoom;
  if (snap) { CAM.tz = mz; CAM.tx = mx; CAM.zoom = need; CAM.shake = 0; }
  else {
    CAM.tz += (mz - CAM.tz) * (1 - Math.exp(-3.2 * dt));
    CAM.tx += (mx - CAM.tx) * (1 - Math.exp(-3.0 * dt));
    CAM.zoom += (need - CAM.zoom) * (1 - Math.exp(-2.2 * dt));
  }
  CAM.tz = clamp(CAM.tz, CFG.Z_FRONT + 7.0, CFG.Z_BACK - 7.5);
  CAM.shake = Math.max(0, CAM.shake - dt * 0.6);
  const sh = CAM.shake * CAM.shake * 4;
  placeCamera((Math.random() - 0.5) * sh, (Math.random() - 0.5) * sh);
  if (snap || Math.abs(CAM.zoom - oldZoom) > 1e-4) { applyFrustum(); layoutSunTrack(); }
}

// =============================================================================
// HUD
// =============================================================================
const HUD = {};
function setText(el, key, text) { if (HUD[key] !== text) { HUD[key] = text; el.textContent = text; } }
function setStyle(el, key, prop, value) { const k = key + ':' + prop; if (HUD[k] !== value) { HUD[k] = value; el.style[prop] = value; } }
const pills = (function makePills() {
  const wrap = document.createElement('div');
  wrap.id = 'umbra-abilities';
  const burst = document.createElement('div'); burst.className = 'umbra-pill burst hidden';
  const dash = document.createElement('div'); dash.className = 'umbra-pill';
  wrap.appendChild(burst); wrap.appendChild(dash);
  document.body.appendChild(wrap);
  return { wrap, burst, dash };
})();
const TOAST = { t: 0 };
function toast(msg, kind = 'info', dur = 1.9) {
  const el = ui.toast;
  el.textContent = msg;
  el.dataset.kind = kind;
  el.classList.add('show', 'visible', 'active');
  el.classList.remove('hidden');
  el.style.opacity = '1';
  el.style.borderColor = kind === 'bad' ? '#ff5a3a' : kind === 'good' ? '#45eeff' : kind === 'warn' ? '#ffb040' : '#a07aff';
  if (getComputedStyle(el).display === 'none') el.style.display = 'block';
  TOAST.t = dur;
}
function hideToast() {
  const el = ui.toast;
  el.classList.remove('show', 'visible', 'active');
  el.style.opacity = '0';
  TOAST.t = 0;
}
function flash(msg, kind) {
  toast(msg, kind || 'warn', 1.4);
  G.hintFlash = { msg, t: 1.4 };
}
function computeHint() {
  if (G.hintFlash.t > 0) return G.hintFlash.msg;
  if (G.state === 'ready') return 'Press ENTER or click START RUN.';
  if (G.state === 'paused') return 'Paused.';
  if (G.state === 'won') return 'You escaped!';
  if (G.state === 'lost') return 'The sun has set.';
  const p = players.pyre, u = players.umbra, B = G.bridge, L = G.live;
  if (u.state !== 'normal') return 'Umbra is returning to the checkpoint…';
  if (G.gateIndex >= LEVEL.gates.length) return 'Both of you: step into the glowing exit arch!';
  const gi = G.gateIndex;
  if (p.tethered > 0) return 'Too far apart — Umbra, move up! (the camera keeps you both on screen)';
  if (u.tethered > 0) return 'Too far apart — Pyre, come back toward Umbra.';
  if (G.lock) return 'ESCORT — walk forward together! Umbra, stay on Pyre’s shadow (' + Math.max(0, G.lock.timer).toFixed(1) + 's)' + (gi === 4 ? ' Mind the vents.' : '');
  const uOnLavaSide = !floorAt(u.x, u.z);
  const tooClose = Math.hypot(p.x - u.x, p.z - u.z) < 0.9;
  if (G.pad && u.onPad) {
    const t = Math.max(0, G.pad.timer).toFixed(1);
    if (B.valid && G.lockCd <= 0) return 'ALIGNED! Pyre: SPACE — lock again and keep going! (foothold ' + t + 's)';
    if (tooClose) return 'CRYSTAL FOOTHOLD ' + t + 's — Pyre: take a step ahead so your shadow trails onto Umbra.';
    if (G.lockCd > 0) return 'CRYSTAL FOOTHOLD ' + t + 's — lock recharging… Pyre, swing your shadow back onto Umbra.';
    return 'CRYSTAL FOOTHOLD ' + t + 's — Pyre: move until your shadow falls on Umbra, then SPACE.';
  }
  if (G.release) return 'The shadow is swinging free — Umbra, stay on stone or the foothold!';
  if (uOnLavaSide && u.supported) return 'Umbra, get onto solid ground!';
  if (B.valid) {
    if (G.lockCd > 0) return 'ALIGNED — lock recharging (' + G.lockCd.toFixed(1) + 's)…';
    return 'ALIGNED! Pyre: SPACE to lock the angle, then walk Umbra across on your tail.' + (gi === 4 ? ' Dodge the vents.' : '');
  }
  if (L.lit) return 'Mirror light holds Pyre’s shadow still — move so it falls on Umbra.';
  if (!p.onLava) {
    if (gi === 3) return 'Pyre: step into the bend ahead of Umbra — the mirror’s light holds your shadow steady (gold plates turn it).';
    return 'Pyre: step into the lava ahead of Umbra — your shadow trails behind you.';
  }
  if (tooClose) return 'Pyre: step ahead of Umbra — your shadow trails behind you onto her.';
  if (ARC.any && ARC.next >= 0) return 'Shadow on Umbra in ' + ARC.next.toFixed(1) + 's (cyan on the sun track) — get ready.';
  if (!ARC.any) return 'Pyre: get closer to Umbra — your shadow can’t reach her from there.';
  return 'Watch the sun track — cyan marks when Pyre’s shadow falls on Umbra.';
}
function updateHUD(dt) {
  TOAST.t -= dt;
  if (TOAST.t <= 0 && HUD.toastOn !== false) { hideToast(); HUD.toastOn = false; }
  if (TOAST.t > 0) HUD.toastOn = true;
  G.hintFlash.t = Math.max(0, G.hintFlash.t - dt);
  setText(ui.timer, 'timer', formatTime(G.timeLeft));
  const urgent = G.timeLeft <= CFG.URGENT_TIME && (G.state === 'playing' || G.state === 'paused' || G.state === 'lost');
  if (HUD.urgent !== urgent) {
    HUD.urgent = urgent;
    ui.timer.classList.toggle('urgent', urgent);
    ui.timer.classList.toggle('umbra-urgent', urgent);
    ui.timer.style.color = urgent ? '#ff4b3a' : '';
    ui.timer.style.textShadow = urgent ? '0 0 10px rgba(255,60,40,0.8)' : '';
  }
  let st, col;
  if (G.lock) { st = 'LOCKED'; col = '#c8fdff'; }
  else if (G.release) { st = 'RELEASING'; col = '#d0a8ff'; }
  else if (G.bridge.valid) { st = 'ALIGNED'; col = '#45eeff'; }
  else { st = 'UNSTABLE'; col = '#ff7a3a'; }
  setText(ui.shadowState, 'shadow', st);
  setStyle(ui.shadowState, 'shadow', 'color', col);
  if (ui.shadowState.dataset.state !== st.toLowerCase()) ui.shadowState.dataset.state = st.toLowerCase();
  let ls, lc;
  if (G.lock) { ls = Math.max(0, G.lock.timer).toFixed(1) + 's LEFT'; lc = '#c8fdff'; }
  else if (G.lockCd > 0) { ls = G.lockCd.toFixed(1) + 's CHARGE'; lc = '#ffb066'; }
  else { ls = 'READY'; lc = '#7dffb0'; }
  setText(ui.lockState, 'lock', ls);
  setStyle(ui.lockState, 'lock', 'color', lc);
  const counts = G.shardCount + ' / ' + LEVEL.shards.length;
  let shardText;
  if (shardHasOwnLabel && /\d+\s*\/\s*\d+/.test(shardTemplate)) shardText = shardTemplate.replace(/\d+\s*\/\s*\d+/, counts);
  else if (shardParentLabel) shardText = counts;
  else shardText = 'SUN SHARDS: ' + counts;
  setText(ui.shardState, 'shards', shardText);
  const total = LEVEL.start.umbra.z + 58.4;
  const pct = clamp((LEVEL.start.umbra.z - G.furthestZ) / total, 0, 1) * 100;
  setStyle(ui.progressFill, 'pf', 'width', pct.toFixed(1) + '%');
  const gi = Math.min(G.gateIndex, LEVEL.gates.length);
  const progress = gi >= LEVEL.gates.length ? 'EXIT · ALL 6 GATES CLEARED' : 'GATE ' + (gi + 1) + ' / 6 · ' + LEVEL.gates[gi].name;
  setText(ui.progressText, 'progress', progress);
  const objective = G.state === 'ready' ? 'Escape the volcanic temple: six lava gates, one exit, 2:30 on the clock.'
    : gi >= LEVEL.gates.length ? 'Reach the exit arch together before the sun sets.'
    : LEVEL.gates[gi].objective;
  setText(ui.objective, 'objective', objective);
  setText(ui.hint, 'hint', computeHint());
  // ability pills
  const burstOn = G.gateIndex >= CFG.BURST_GATE && G.state !== 'ready';
  if (HUD.burstOn !== burstOn) { HUD.burstOn = burstOn; pills.burst.classList.toggle('hidden', !burstOn); }
  if (burstOn) {
    const ready = G.sun.burstCd <= 0;
    setText(pills.burst, 'pb', G.sun.burstT > 0 ? 'E · SOLAR BURST!' : ready ? 'E · SOLAR BURST READY' : 'E · BURST ' + G.sun.burstCd.toFixed(1) + 's');
    pills.burst.classList.toggle('ready', ready || G.sun.burstT > 0);
  }
  const dashReady = players.umbra.dashCd <= 0;
  setText(pills.dash, 'pd', dashReady ? 'R-SHIFT · DASH READY' : 'R-SHIFT · DASH ' + players.umbra.dashCd.toFixed(1) + 's');
  pills.dash.classList.toggle('ready', dashReady);
  setStyle(pills.wrap, 'pw', 'display', G.state === 'playing' || G.state === 'paused' ? '' : 'none');
}

function updateVisuals(dt) {
  vtime += dt;
  if (G.state === 'ready') {
    G.sun.phase += dt;
    updateLiveShadow(dt);
    updateBridge(dt);
  }
  if (G.state === 'lost') { G.loseT += dt; if (!G.overlayShown && G.loseT > 1.1) showEndOverlay(); }
  if (G.state === 'won') { G.winT += dt; if (!G.overlayShown && G.winT > 1.8) showEndOverlay(); }
  lavaMat.uniforms.uTime.value = vtime;
  abyssMat.uniforms.uTime.value = vtime;
  lavaFallMat.uniforms.uTime.value = vtime;
  portalMat.uniforms.uTime.value = vtime;
  fireColumnMat.uniforms.uTime.value = vtime;
  ARC.timer -= dt;
  if (G.state === 'playing' && ARC.timer <= 0) { ARC.timer = 1 / 12; computeArcs(); paintTrack(); }
  if (G.state === 'ready' && ARC.timer <= 0) { ARC.timer = 0.5; ARC.valid.fill(0); paintTrack(); }
  const ecl = eclipseFactor();
  updateSunVisual(dt, ecl);
  updateEclipse(ecl);
  updateFakeShadows();
  updateCharacters(dt);
  updateBridgeVisual(dt);
  updatePreview(dt);
  updateLockRing();
  updateFootholdVisual(dt);
  updateMirrorVisuals(dt);
  updateVentVisuals(dt);
  updateShardVisuals(dt);
  updateCheckpointVisuals(dt);
  updateDecor(dt);
  if (G.state !== 'paused') updateAmbient(dt);
  if (G.state !== 'paused') updateParticles(dt);
  pMat.uniforms.uScale.value = CAM.pxPerUnit;
  updateCamera(dt, false);
  updateHUD(dt);
}

// =============================================================================
// INPUT HANDLERS
// =============================================================================
const KEY_FALLBACK = { ' ': 'Space', ArrowUp: 'ArrowUp', ArrowDown: 'ArrowDown', ArrowLeft: 'ArrowLeft', ArrowRight: 'ArrowRight', Enter: 'Enter', Escape: 'Escape' };
function keyCode(e) {
  if (e.code) return e.code;
  if (KEY_FALLBACK[e.key]) return KEY_FALLBACK[e.key];
  if (e.key && e.key.length === 1 && /[a-z]/i.test(e.key)) return 'Key' + e.key.toUpperCase();
  return '';
}
function isTypingTarget(t) {
  return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
}
function handleAction(code) {
  if (KEYS.mute.includes(code)) { toggleMute(); return; }
  if (KEYS.restart.includes(code)) { restartRun(); return; }
  if (KEYS.confirm.includes(code)) { confirmOverlay(); return; }
  if (KEYS.pause.includes(code)) { if (G.state === 'playing') pauseRun(false); else if (G.state === 'paused') resumeRun(); return; }
  if (G.state !== 'playing') return;
  if (KEYS.lock.includes(code)) tryLock();
  else if (KEYS.burst.includes(code)) tryBurst();
  else if (KEYS.dash.includes(code)) tryDash();
}
function onKeyDown(e) {
  if (isTypingTarget(e.target)) return;
  const code = keyCode(e);
  if (GAME_CODES.has(code)) e.preventDefault();   // no page scrolling, no button activation
  ensureAudio();
  if (!e.repeat) handleAction(code);                // actions fire once per press
  if (GAME_CODES.has(code)) held.add(code);
}
function onKeyUp(e) {
  const code = keyCode(e);
  held.delete(code);
  if (code === 'Space' || code === 'Enter') e.preventDefault();
}

// =============================================================================
// MAIN LOOP (exactly one)
// =============================================================================
const STEP = 1 / 120;
const dbg = { manual: false, snap: false, frames: 0 };
let lastNow = performance.now(), acc = 0, frameErrors = 0;
const PERF = { t: 0, frames: 0, cap: Math.min(window.devicePixelRatio || 1, 2) };
function adaptQuality(rawDt) {
  PERF.t += rawDt; PERF.frames++;
  if (PERF.t < 2.5) return;
  const avg = PERF.t / PERF.frames;
  PERF.t = 0; PERF.frames = 0;
  if (avg > 0.024 && PERF.cap > 1) {           // slower than ~42 fps: render fewer pixels
    PERF.cap = Math.max(1, PERF.cap - 0.25);
    renderer.setPixelRatio(PERF.cap);
    renderer.setSize(viewW, viewH, false);
    applyFrustum();
  }
}
function frame(now) {
  requestAnimationFrame(frame);
  dbg.frames++;
  let dt = (now - lastNow) / 1000;
  lastNow = now;
  if (!(dt > 0)) dt = 0;
  if (dt < 0.25 && !DEBUG) adaptQuality(dt);
  if (dt > 0.05) dt = 0.05;           // tab was hidden or the frame hitched
  try {
    if (G.state === 'playing' && !dbg.manual) {
      acc += dt;
      let n = 0;
      while (acc >= STEP && n < 8) {
        simStep(STEP);
        acc -= STEP; n++;
        if (G.state !== 'playing') { acc = 0; break; }
      }
    } else acc = 0;
    if (dbg.snap) { dbg.snap = false; updateCamera(0, true); }
    updateVisuals(dt);
    renderer.render(scene, camera);
  } catch (err) {
    if (frameErrors++ < 3) console.error('[UMBRA] frame error:', err);
  }
}

// =============================================================================
// DEBUG HELPERS (only with ?debug)
// =============================================================================
if (DEBUG) {
  window.__umbra = {
    G, players, LEVEL, CFG, held, dbg, ARC, CAM, renderer, camera, scene,
    analyzeBridge, floorAt, floorNear, sunAzimuth, sunNorm, shadowYawFromSun, mirrorLight, bridgeLocal, ventPhase,
    step(seconds, dt = STEP) {
      const n = Math.round(seconds / dt);
      for (let i = 0; i < n; i++) { if (G.state !== 'playing') break; simStep(dt); }
      return G.state;
    },
    press(code) { held.add(code); },
    release(code) { held.delete(code); },
    releaseAll() { held.clear(); },
    tap(code) { handleAction(code); },
    start() { startRun(); },
    restart() { restartRun(); },
    teleport(who, x, z) { const p = players[who]; p.x = x; p.z = z; p.vx = 0; p.vz = 0; },
    render(dt = 1 / 60, snap = true) { updateVisuals(dt); if (snap) updateCamera(0, true); renderer.render(scene, camera); },
    computeArcs() { computeArcs(); return { any: ARC.any, next: ARC.next }; },
    missingIds,
  };
}

// =============================================================================
// START
// =============================================================================
window.addEventListener('keydown', onKeyDown, { passive: false });
window.addEventListener('keyup', onKeyUp, { passive: false });
window.addEventListener('blur', () => { held.clear(); if (G.state === 'playing' && !DEBUG) pauseRun(true); });
document.addEventListener('visibilitychange', () => { if (document.hidden) { held.clear(); if (G.state === 'playing' && !DEBUG) pauseRun(true); } });
window.addEventListener('resize', resize);
if (window.ResizeObserver && container.tagName !== 'CANVAS') new ResizeObserver(() => resize()).observe(container);
ui.startButton.addEventListener('click', (e) => { e.preventDefault(); ensureAudio(); confirmOverlay(); });
renderer.domElement.addEventListener('webglcontextlost', (e) => { e.preventDefault(); if (G.state === 'playing') pauseRun(true); }, false);

resize();
resetRun();
G.state = 'ready';
paintTrack();
showStartOverlay();
requestAnimationFrame(frame);
console.info('[UMBRA] ready — Three.js r' + REV + (missingIds.length ? ' (created missing HUD elements: ' + missingIds.join(', ') + ')' : ''));

})().catch((err) => {
  console.error('[UMBRA] failed to start:', err);
  const t = document.getElementById('overlayText');
  if (t) t.textContent = 'UMBRA failed to start: ' + (err && err.message ? err.message : err);
});