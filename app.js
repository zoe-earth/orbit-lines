// ORBIT LINES — draw a line (straight, or with ONE bend) inside the circle;
// see which satellites' ground tracks follow it.
//
//   1. your stroke is snapped to a straight line or a single-bend polyline
//   2. that shape is resampled to NS evenly spaced points (the "recognized" line)
//   3. every satellite's ground track (next 2 h, 1-min steps) is compared to those points
//   4. a point is "hit" if the track passes within a tolerance of it (one pass only)
//   5. satellites are ranked by how many points they hit
//
// Controls: drag = draw · ←/→ = pick a match · esc = clear

const DEG = Math.PI / 180, RE = 6371, K = 121, NS = 48, GATE = 30;
const cv = document.getElementById('c'), ctx = cv.getContext('2d'), head = document.getElementById('head'), list = document.getElementById('list');
const view = { lon: -40 * DEG, lat: 25 * DEG };            // fixed camera on the globe
let W, H, cx, cy, R;
let sats = [];                                              // {name, inc, alt, track: Float32Array(K*3)} unit vectors, Earth-fixed
let revealAt = 0, raw = [], keys = null, stroke = null, results = [], sel = 0, drawing = false;
const t0 = Date.now();

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const ang = (a, b) => Math.acos(clamp(dot(a, b), -1, 1));
const norm = v => { const l = Math.hypot(...v) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
const slerp = (a, b, t) => { const w = ang(a, b); if (w < 1e-6) return a; const s = Math.sin(w), x = Math.sin((1 - t) * w) / s, y = Math.sin(t * w) / s; return [0, 1, 2].map(i => a[i] * x + b[i] * y); };

// ---- orthographic projection of unit vectors onto the circle ---------------
function proj(x, y, z) {
  const cl = Math.cos(view.lon), sl = Math.sin(view.lon), cp = Math.cos(view.lat), sp = Math.sin(view.lat);
  const X = x * cl + y * sl, Y = -x * sl + y * cl;
  return { x: cx + R * Y, y: cy - R * (z * cp - X * sp), front: X * cp + z * sp > 0 };
}
function unproject(px, py) {                                // screen -> point on the globe (or null outside the circle)
  const sx = (px - cx) / R, sy = (cy - py) / R, r2 = sx * sx + sy * sy;
  if (r2 > 1) return null;
  const d = Math.sqrt(1 - r2), cl = Math.cos(view.lon), sl = Math.sin(view.lon), cp = Math.cos(view.lat), sp = Math.sin(view.lat);
  const X = d * cp - sy * sp, Z = d * sp + sy * cp;
  return [X * cl - sx * sl, X * sl + sx * cl, Z];
}

// ---- data: propagate every satellite over the next two hours ---------------
async function load() {
  const omm = await (await fetch('data/sats.json')).json();
  const gm = [...Array(K)].map((_, k) => satellite.gstime(new Date(t0 + k * 60000)));
  for (const o of omm) {
    const rec = satellite.json2satrec(o), epoch = Date.parse(o.EPOCH + 'Z'), tr = new Float32Array(K * 3);
    let ok = !rec.error;
    for (let k = 0; ok && k < K; k++) {
      const p = satellite.sgp4(rec, (t0 + k * 60000 - epoch) / 60000)?.position;
      if (!p || isNaN(p.x)) { ok = false; break; }
      const r = Math.hypot(p.x, p.y, p.z), c = Math.cos(gm[k]), s = Math.sin(gm[k]);
      if (r < RE + 120) { ok = false; break; }
      tr.set([(p.x * c + p.y * s) / r, (-p.x * s + p.y * c) / r, p.z / r], k * 3);
    }
    if (ok) sats.push({ name: o.OBJECT_NAME, inc: +o.INCLINATION, track: tr, alt: (Math.cbrt(398600.4418 / (o.MEAN_MOTION * 2 * Math.PI / 86400) ** 2) - RE) | 0 });
  }
  showPrompt();
}

// ---- line recognition: snap the stroke to ≤ 1 bend -------------------------
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
function segDist(p, a, b) {                                 // angular distance from p to the great-circle arc a→b
  const n = cross(a, b), nl = Math.hypot(...n); if (nl < 1e-9) return ang(p, a);
  const u = [n[0] / nl, n[1] / nl, n[2] / nl], h = dot(p, u), q = [p[0] - h * u[0], p[1] - h * u[1], p[2] - h * u[2]];
  if (dot(cross(a, q), u) >= 0 && dot(cross(q, b), u) >= 0) return Math.abs(Math.asin(clamp(h, -1, 1)));   // projects inside the arc
  return Math.min(ang(p, a), ang(p, b));
}
function fitShape(pts) {                                    // -> [A, B] or [A, C, B]
  const n = pts.length; if (n < 2) return null;
  const A = pts[0], B = pts[n - 1], P = pts.filter((_, i) => i % Math.ceil(n / 120) === 0);
  const err = ks => Math.sqrt(P.reduce((s, p) => s + Math.min(...ks.slice(1).map((k, i) => segDist(p, ks[i], k))) ** 2, 0) / P.length);
  let path = 0; for (let i = 1; i < n; i++) path += ang(pts[i - 1], pts[i]);
  const straight = err([A, B]);
  let best = null, bestErr = Infinity;
  for (const C of P) {
    const a = ang(A, C), b = ang(C, B); if (Math.min(a, b) < 0.2 * (a + b)) continue;      // each leg ≥ 20% of the line
    const e = err([A, C, B]); if (e < bestErr) { bestErr = e; best = C; }
  }
  return best && straight > 0.04 * path && bestErr < 0.55 * straight ? [A, best, B] : [A, B];
}

function recognize(k) {                                     // shape -> NS evenly spaced points + tolerance
  const legs = k.slice(1).map((p, i) => ang(k[i], p)), total = legs.reduce((a, b) => a + b, 0), lenKm = total * RE;
  if (lenKm < 250) return null;
  const pts = [];
  for (let j = 0; j < NS; j++) {
    let d = total * j / (NS - 1), i = 0; while (i < legs.length - 1 && d > legs[i]) { d -= legs[i]; i++; }
    pts.push(norm(slerp(k[i], k[i + 1], clamp(d / legs[i], 0, 1))));
  }
  const c = norm(pts.reduce((a, p) => a.map((v, i) => v + p[i]), [0, 0, 0]));
  return { keys: k, pts, c, lenKm, tol: clamp(lenKm * .045, 90, 450) / RE };
}

function match(st) {
  const res = [], dj = new Float64Array(NS), ij = new Float64Array(NS);
  for (const sat of sats) {
    const T = sat.track, hit = new Uint8Array(NS); let cnt = 0, dev = 0, best = 1e9, bj = 0;
    for (let j = 0; j < NS; j++) {
      const [px, py, pz] = st.pts[j]; let md = 1e9, mi = 0;
      for (let k = 0; k < K - 1; k++) {                     // nearest point on the track polyline
        const o = k * 3, ax = T[o], ay = T[o + 1], az = T[o + 2], ex = T[o + 3] - ax, ey = T[o + 4] - ay, ez = T[o + 5] - az, ee = ex * ex + ey * ey + ez * ez;
        const t = ee < 1e-18 ? 0 : clamp(((px - ax) * ex + (py - ay) * ey + (pz - az) * ez) / ee, 0, 1);
        const d2 = (px - ax - t * ex) ** 2 + (py - ay - t * ey) ** 2 + (pz - az - t * ez) ** 2;
        if (d2 < md) { md = d2; mi = k + t; }
      }
      dj[j] = Math.sqrt(md); ij[j] = mi; if (dj[j] < best) { best = dj[j]; bj = j; }
    }
    if (best > st.tol) continue;
    const passes = [];
    for (let j = 0; j < NS; j++) if (dj[j] <= st.tol && Math.abs(ij[j] - ij[bj]) <= GATE) { hit[j] = 1; cnt++; dev += dj[j]; passes.push(ij[j]); }
    passes.sort((a, b) => a - b);
    res.push({ sat, hit, cov: cnt / NS, dev: dev / cnt * RE, pass: passes[passes.length >> 1] });
  }
  let sel; for (const th of [.9, .75, .6, .45, .3]) { sel = res.filter(r => r.cov >= th); if (sel.length >= 5) break; }
  return sel.sort((a, b) => (b.cov - b.dev / 2000) - (a.cov - a.dev / 2000));
}

// ---- input -----------------------------------------------------------------
cv.onpointerdown = e => {
  const g = unproject(e.clientX, e.clientY); if (!g) return;
  cv.setPointerCapture(e.pointerId);
  stroke = null; results = []; raw = [g]; keys = null; drawing = true; head.textContent = ''; list.textContent = '';
};
cv.onpointermove = e => {
  const g = drawing && unproject(e.clientX, e.clientY); if (!g) return;
  const l = raw[raw.length - 1], px = ang(l, g) * R, steps = Math.ceil(px / 5);
  if (px > 3) for (let i = 1; i <= steps; i++) raw.push(norm(l.map((v, k) => v + (g[k] - v) * i / steps)));
  keys = fitShape(raw);                                     // live: show what the software recognizes
};
cv.onpointerup = () => {
  if (!drawing) return; drawing = false;
  stroke = keys && recognize(keys);
  if (!stroke) { raw = []; keys = null; return showPrompt('too short — draw a longer line'); }
  results = match(stroke); results.forEach(q => q.phase = Math.random() * 16); sel = 0; showResults();
  if (!revealAt) revealAt = performance.now(); document.body.classList.add('started');   // first line drawn: bring in the satellites + UI
};
function restart() { stroke = null; raw = []; keys = null; results = []; drawing = false; revealAt = 0; document.body.classList.remove('started'); showPrompt(); }
document.getElementById('restart').onclick = restart;
addEventListener('keydown', e => {
  if (e.key === 'Escape') restart();
  if (results.length && e.key === 'ArrowRight') { sel = (sel + 1) % results.length; showResults(); }
  if (results.length && e.key === 'ArrowLeft') { sel = (sel + results.length - 1) % results.length; showResults(); }
});

function showPrompt(msg = '') { head.textContent = `draw one line in the circle:\nstraight, or with one bend\n${msg}`; list.textContent = ''; }
function showResults() {
  head.textContent = `${stroke.keys.length === 3 ? 'one bend' : 'straight line'} · ${results.length} satellites on your line (±${(stroke.tol * RE).toFixed(0)} km)\n` +
    (results.length ? '' : 'none — try another line\n') + 'click a name, or ← → · esc to clear';
  list.textContent = '';
  results.forEach((r, i) => {
    const row = document.createElement('div');
    row.className = 'row' + (i === sel ? ' sel' : '');
    const a = document.createElement('span'), b = document.createElement('span');
    a.textContent = r.sat.name; b.textContent = `${r.sat.alt} km · ${r.sat.inc.toFixed(0)}°`; row.append(a, b);
    row.onclick = () => { sel = i; showResults(); };
    list.appendChild(row);
    if (i === sel) row.scrollIntoView({ block: 'nearest' });
  });
}

// ---- drawing ---------------------------------------------------------------
function path(vs) { ctx.beginPath(); let pen = false; for (const v of vs) { const p = proj(...v); if (p.front) { pen ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y); pen = true; } else pen = false; } }
function trackVecs(T, a, b) { const out = []; for (let k = Math.max(0, Math.floor(a)); k < Math.min(K - 1, Math.ceil(b)); k++) for (let q = 0; q < 3; q++) { const o = k * 3, f = q / 3; out.push(norm([0, 1, 2].map(i => T[o + i] + (T[o + 3 + i] - T[o + i]) * f))); } return out; }
function satAt(T, m) { const k = clamp(Math.floor(m), 0, K - 2), f = clamp(m - k, 0, 1), o = k * 3; return norm([0, 1, 2].map(i => T[o + i] + (T[o + 3 + i] - T[o + i]) * f)); }
function arcPoints(k) { const out = []; for (let i = 0; i < k.length - 1; i++) for (let q = 0; q <= 30; q++) out.push(slerp(k[i], k[i + 1], q / 30)); return out; }

const INK = '#f2f2f2', ACCENT = '#c8ff00';
function frame(now) {
  if (W !== innerWidth || H !== innerHeight) { W = cv.width = innerWidth; H = cv.height = innerHeight; }
  cx = W / 2 + 150; cy = H / 2; R = Math.min(W - 400, H - 50) / 2;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#050505'; ctx.beginPath(); ctx.arc(cx, cy, R, 0, 7); ctx.fill();            // the Earth: just a circle
  ctx.strokeStyle = INK; ctx.lineWidth = 1; ctx.stroke();

  const r = results[sel], e = now / 1000;                // seconds since page load (rAF time)
  ctx.lineCap = ctx.lineJoin = 'round';
  // the whole catalog, always orbiting (real orbital motion, sped up); fades at the loop point so nothing teleports
  const rv = revealAt ? clamp((now - revealAt) / 2500, 0, 1) : 0;      // satellites fade in after the first line
  if (rv > 0) { const gm = (e * 2) % 120, fade = rv * Math.min(1, gm / 4, (120 - gm) / 4); ctx.beginPath(); const gh = [];
    for (const s of sats) {
      const a = proj(...satAt(s.track, gm - 1)), b = proj(...satAt(s.track, gm));
      if (!b.front) continue;
      if (a.front) { ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); }
      gh.push(b);
    }
    ctx.strokeStyle = `rgba(255,255,255,${.2 * fade})`; ctx.lineWidth = 1; ctx.stroke();
    ctx.fillStyle = `rgba(255,255,255,${.45 * fade})`; for (const p of gh) ctx.fillRect(p.x - .9, p.y - .9, 1.8, 1.8); }

  if (stroke) {
    ctx.strokeStyle = 'rgba(200,255,0,.13)'; ctx.lineWidth = 2 * stroke.tol * R; path(arcPoints(stroke.keys)); ctx.stroke();       // tolerance band
    ctx.strokeStyle = INK; ctx.lineWidth = 2; path(arcPoints(stroke.keys)); ctx.stroke();                                          // recognized line
    stroke.pts.forEach((v, j) => { const p = proj(...v); if (!p.front) return; ctx.beginPath(); ctx.arc(p.x, p.y, r?.hit[j] ? 2.6 : 1.6, 0, 7); ctx.fillStyle = r?.hit[j] ? ACCENT : INK; ctx.fill(); });
    if (stroke.keys.length === 3) { const p = proj(...stroke.keys[1]); ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(p.x, p.y, 8, 0, 7); ctx.stroke(); }   // the bend

    // satellite particles: each floats along its own orbit, passing through the line at its own time
    const pos = q => clamp(q.pass + (e * 1 + q.phase) % 16 - 8, 0, K - 1.01);
    if (r) { ctx.strokeStyle = 'rgba(200,255,0,.55)'; ctx.lineWidth = 1; path(trackVecs(r.sat.track, 0, K)); ctx.stroke(); }          // selected: whole 2 h orbit
    ctx.strokeStyle = 'rgba(255,255,255,.4)'; ctx.lineWidth = 1; ctx.beginPath(); const heads = [];
    for (const q of results) {
      const m = pos(q), a = proj(...satAt(q.sat.track, m - .8)), b = proj(...satAt(q.sat.track, m));
      if (!b.front) continue;
      if (a.front) { ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); }
      heads.push([b, q]);
    }
    ctx.stroke();
    ctx.font = '12px Helvetica, Arial, sans-serif';
    for (const [p, q] of heads) {
      const on = q === r; ctx.fillStyle = on ? ACCENT : INK; ctx.beginPath(); ctx.arc(p.x, p.y, on ? 5 : 2.6, 0, 7); ctx.fill();
      if (on) { ctx.fillStyle = INK; ctx.fillText(q.sat.name, p.x + 10, p.y - 8); }
    }
  } else if (drawing && raw.length > 1) {
    ctx.strokeStyle = 'rgba(255,255,255,.4)'; ctx.lineWidth = 1.5; path(raw); ctx.stroke();                                        // what you drew
    if (keys) { ctx.strokeStyle = INK; ctx.lineWidth = 2.5; path(arcPoints(keys)); ctx.stroke(); }                                // what it snaps to
  }
  requestAnimationFrame(frame);
}

load().catch(e => head.textContent ='could not load data/sats.json — serve this folder over http\n' + e);
requestAnimationFrame(frame);
