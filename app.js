// ORBIT LINES
// Draw a line (straight, or with one bend) on a circle that stands for the Earth.
// Satellites whose ground tracks run along your line get picked out.
//
// The whole idea, in four steps:
//   1. DRAW    snap your stroke to a straight line or one bend           fitShape()
//   2. SAMPLE  turn that shape into 48 evenly spaced points on the globe  resample()
//   3. TRACKS  run every satellite's orbit forward 2 hours -> ground track  loadSatellites()
//   4. MATCH   a point is "hit" if a track passes near it; rank by hits     match()
//
// Points on the globe are unit vectors [x, y, z]: z points at the north pole,
// x points at longitude 0 on the equator. Everything else is just drawing.

// ---------- settings --------------------------------------------------------
const EARTH_KM = 6371;
const MINUTES = 121;                 // every satellite gets one position per minute, for 2 hours
const POINTS = 48;                   // points along your line
const SAME_PASS = 30;                // a satellite's hits must happen within 30 min of each other
const LIME = '#c8ff00', WHITE = '#f2f2f2';
const DEG = Math.PI / 180;
const CAMERA = { lon: -40 * DEG, lat: 25 * DEG };   // fixed view of the globe

// ---------- state -----------------------------------------------------------
const canvas = document.getElementById('c'), ctx = canvas.getContext('2d');
const head = document.getElementById('head'), list = document.getElementById('list');
let cx, cy, radius;                  // where the circle is on screen (set every frame)
let sats = [];                       // { name, alt, inc, track }  track = flat [x,y,z, x,y,z, ...], one per minute
let drawing = false, sketch = [];    // your stroke so far, in screen pixels
let line = null;                     // the recognized line: { keys, points, tol }
let results = [], selected = 0;      // matching satellites, and which one is highlighted
let showStarlink = true;             // the Starlink toggle: off hides them everywhere (dots, matching, list)
let revealedAt = 0;                  // when the first line was finished (satellites fade in from here)

// ---------- vector helpers --------------------------------------------------
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const unit = v => { const n = Math.hypot(...v) || 1; return v.map(x => x / n); };
const angle = (a, b) => Math.acos(clamp(dot(a, b), -1, 1));
const slerp = (a, b, t) => {                         // point t (0..1) of the way from a to b, along the globe's surface
  const w = angle(a, b); if (w < 1e-6) return a;
  return a.map((x, i) => (x * Math.sin((1 - t) * w) + b[i] * Math.sin(t * w)) / Math.sin(w));
};

// ---------- screen <-> globe (orthographic projection) ----------------------
const [cosLon, sinLon, cosLat, sinLat] = [Math.cos(CAMERA.lon), Math.sin(CAMERA.lon), Math.cos(CAMERA.lat), Math.sin(CAMERA.lat)];

function toScreen([x, y, z]) {                       // globe -> pixels. `front` = on the side facing us
  const a = x * cosLon + y * sinLon, b = -x * sinLon + y * cosLon;
  return { x: cx + radius * b, y: cy - radius * (z * cosLat - a * sinLat), front: a * cosLat + z * sinLat > 0 };
}
function toGlobe(px, py) {                           // pixels -> globe (null if outside the circle)
  const sx = (px - cx) / radius, sy = (cy - py) / radius, depth2 = 1 - sx * sx - sy * sy;
  if (depth2 < 0) return null;
  const d = Math.sqrt(depth2), a = d * cosLat - sy * sinLat, z = d * sinLat + sy * cosLat;
  return [a * cosLon - sx * sinLon, a * sinLon + sx * cosLon, z];
}

// ---------- 3. TRACKS: where is every satellite for the next 2 hours? -------
async function loadSatellites() {
  const catalog = await (await fetch('data/sats.json')).json();    // orbital elements (CelesTrak)
  const start = Date.now();
  const spin = [...Array(MINUTES)].map((_, m) => satellite.gstime(new Date(start + m * 60000)));   // Earth's rotation each minute

  for (const [n, o] of catalog.entries()) {
    if (n % 400 === 0) { head.textContent = `loading satellites… ${n} / ${catalog.length}`; await new Promise(r => setTimeout(r)); }   // let the page breathe
    const rec = satellite.json2satrec(o), epoch = Date.parse(o.EPOCH + 'Z'), track = [];
    for (let m = 0; m < MINUTES; m++) {
      const p = satellite.sgp4(rec, (start + m * 60000 - epoch) / 60000)?.position;   // position in space (km)
      if (!p || isNaN(p.x)) break;                                                     // propagation failed
      const r = Math.hypot(p.x, p.y, p.z), c = Math.cos(spin[m]), s = Math.sin(spin[m]);
      if (r < EARTH_KM + 120) break;                                                   // already re-entered
      track.push((p.x * c + p.y * s) / r, (-p.x * s + p.y * c) / r, p.z / r);          // turn with the Earth, keep direction only
    }
    if (track.length === MINUTES * 3) sats.push({
      name: o.OBJECT_NAME, inc: +o.INCLINATION, track, starlink: o.OBJECT_NAME.startsWith('STARLINK'),
      alt: Math.round(Math.cbrt(398600.4418 / (o.MEAN_MOTION * 2 * Math.PI / 86400) ** 2) - EARTH_KM),   // Kepler's 3rd law
    });
  }
  showPrompt();
}

// where is a satellite at a given minute (can be fractional)?  -> unit vector
function trackPoint(track, minute) {
  const m = clamp(Math.floor(minute), 0, MINUTES - 2), t = clamp(minute - m, 0, 1), i = m * 3;
  return unit([0, 1, 2].map(k => track[i + k] * (1 - t) + track[i + 3 + k] * t));
}

// same idea, but straight to pixels with no allocations (called ~25,000 times per frame)
function trackScreen(track, minute) {
  const m = clamp(Math.floor(minute), 0, MINUTES - 2), t = clamp(minute - m, 0, 1), i = m * 3;
  const x = track[i] * (1 - t) + track[i + 3] * t, y = track[i + 1] * (1 - t) + track[i + 4] * t, z = track[i + 2] * (1 - t) + track[i + 5] * t;
  const a = x * cosLon + y * sinLon, b = -x * sinLon + y * cosLon;
  return { x: cx + radius * b, y: cy - radius * (z * cosLat - a * sinLat), front: a * cosLat + z * sinLat > 0 };
}

// ---------- 1. DRAW: snap the stroke to a straight line or one bend ---------
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
function distToSegment(p, a, b) {                    // 2D: how far is p from the segment a-b?
  const len2 = (b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2;
  const t = len2 ? clamp(((p[0] - a[0]) * (b[0] - a[0]) + (p[1] - a[1]) * (b[1] - a[1])) / len2, 0, 1) : 0;
  return dist(p, [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]);
}

function fitShape(pts) {                             // pixels in -> [start, end] or [start, corner, end]
  const A = pts[0], B = pts[pts.length - 1];
  const few = pts.filter((_, i) => i % Math.ceil(pts.length / 100) === 0);
  const error = corners => Math.sqrt(few.reduce((sum, p) =>       // how far the stroke strays from these segments (RMS)
    sum + Math.min(...corners.slice(1).map((c, i) => distToSegment(p, corners[i], c))) ** 2, 0) / few.length);

  let strokeLength = 0; for (let i = 1; i < pts.length; i++) strokeLength += dist(pts[i - 1], pts[i]);
  const straight = error([A, B]);
  if (straight < 0.04 * strokeLength) return [A, B];             // already pretty straight

  let best = [A, B], bestError = 0.55 * straight;                // a bend must be clearly better than straight
  for (const C of few) {                                         // try every point as the corner
    const a = dist(A, C), b = dist(C, B);
    if (Math.min(a, b) < 0.2 * (a + b)) continue;                // each side must be a real leg, not a stub
    const e = error([A, C, B]);
    if (e < bestError) { bestError = e; best = [A, C, B]; }
  }
  return best;
}

// ---------- 2. SAMPLE: evenly spaced points along the shape, on the globe ---
function resample(keys, n) {                         // keys = 2 or 3 points on the globe
  const legs = keys.slice(1).map((k, i) => angle(keys[i], k)), total = legs.reduce((a, b) => a + b, 0);
  return [...Array(n)].map((_, j) => {
    let d = total * j / (n - 1), leg = 0;
    while (leg < legs.length - 1 && d > legs[leg]) d -= legs[leg++];
    return unit(slerp(keys[leg], keys[leg + 1], clamp(d / legs[leg], 0, 1)));
  });
}

function recognize(pixels) {                         // your stroke (pixels) -> the recognized line, or null if too short
  const keys = fitShape(pixels).map(p => toGlobe(...p));
  const length = keys.slice(1).reduce((sum, k, i) => sum + angle(keys[i], k), 0) * EARTH_KM;   // km
  if (length < 250) return null;
  return { keys, points: resample(keys, POINTS), tol: clamp(length * 0.045, 90, 450) / EARTH_KM };   // tolerance ~4.5% of length
}

// ---------- 4. MATCH: which orbits pass near the line? ----------------------
function closestOnTrack(track, p) {                  // -> [distance, minute] of the nearest point on the ground track
  let best = Infinity, bestMinute = 0;
  for (let m = 0; m < MINUTES - 1; m++) {            // the track is a chain of short segments, one per minute
    const i = m * 3, ex = track[i + 3] - track[i], ey = track[i + 4] - track[i + 1], ez = track[i + 5] - track[i + 2];
    const len2 = ex * ex + ey * ey + ez * ez;
    const t = len2 ? clamp(((p[0] - track[i]) * ex + (p[1] - track[i + 1]) * ey + (p[2] - track[i + 2]) * ez) / len2, 0, 1) : 0;
    const dx = p[0] - track[i] - t * ex, dy = p[1] - track[i + 1] - t * ey, dz = p[2] - track[i + 2] - t * ez;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 < best) { best = d2; bestMinute = m + t; }
  }
  return [Math.sqrt(best), bestMinute];
}

function match(line) {
  const found = [];
  for (const sat of sats) {
    if (sat.starlink && !showStarlink) continue;
    const nearest = line.points.map(p => closestOnTrack(sat.track, p));           // [distance, minute] for every point
    const closest = nearest.reduce((a, b) => (b[0] < a[0] ? b : a));
    if (closest[0] > line.tol) continue;                                           // never comes near the line
    const hit = nearest.map(([d, m]) => d <= line.tol && Math.abs(m - closest[1]) <= SAME_PASS);   // near, and on the same pass
    const minutes = nearest.filter((_, i) => hit[i]).map(h => h[1]).sort((a, b) => a - b);
    found.push({ sat, hit, coverage: minutes.length / POINTS, pass: minutes[minutes.length >> 1], phase: Math.random() * 16 });
  }
  found.sort((a, b) => b.coverage - a.coverage);
  const good = found.filter(r => r.coverage >= 0.5);
  return good.length ? good : found.slice(0, 5);                                   // best 5 if nothing covers half
}

// ---------- input -----------------------------------------------------------
canvas.onpointerdown = e => {
  if (!toGlobe(e.clientX, e.clientY)) return;                // must start inside the circle
  canvas.setPointerCapture(e.pointerId);
  line = null; results = []; sketch = [[e.clientX, e.clientY]]; drawing = true;
  head.textContent = ''; list.textContent = '';
};
canvas.onpointermove = e => {
  if (!drawing || !toGlobe(e.clientX, e.clientY)) return;
  const p = [e.clientX, e.clientY];
  if (dist(p, sketch[sketch.length - 1]) > 3) sketch.push(p);
};
canvas.onpointerup = () => {
  if (!drawing) return; drawing = false;
  line = sketch.length > 1 ? recognize(sketch) : null;
  if (!line) { sketch = []; return showPrompt('too short — draw a longer line'); }
  results = match(line); selected = 0; showResults();
  if (!revealedAt) revealedAt = performance.now();           // first line: bring the satellites in
  document.body.classList.add('started');
};
function toggleStarlink() {
  showStarlink = !showStarlink;
  const button = document.getElementById('starlink');
  button.textContent = 'Starlink: ' + (showStarlink ? 'on' : 'off'); button.classList.toggle('off', !showStarlink);
  if (line) { results = match(line); selected = 0; showResults(); }   // find the matches again without/with Starlink
}
document.getElementById('starlink').onclick = toggleStarlink;
function restart() {
  line = null; sketch = []; results = []; drawing = false; revealedAt = 0;
  document.body.classList.remove('started'); showPrompt();
}
document.getElementById('restart').onclick = restart;
addEventListener('keydown', e => {
  if (e.key === 'Escape') restart();
  if (e.key === 's' || e.key === 'S') toggleStarlink();
  if (!results.length) return;
  if (e.key === 'ArrowRight') { selected = (selected + 1) % results.length; showResults(); }
  if (e.key === 'ArrowLeft') { selected = (selected + results.length - 1) % results.length; showResults(); }
});

// ---------- text + list -----------------------------------------------------
function showPrompt(message = '') {
  head.textContent = `draw one line in the circle:\nstraight, or with one bend\n${message}`; list.textContent = '';
}
function showResults() {
  const starlinks = results.filter(r => r.sat.starlink).length;
  head.textContent = `${line.keys.length === 3 ? 'one bend' : 'straight line'} · ${results.length} satellites on your line ` +
    `(±${Math.round(line.tol * EARTH_KM)} km)\n${showStarlink ? `${starlinks} Starlink · ${results.length - starlinks} other` : 'Starlink hidden'}\n` +
    `${results.length ? '' : 'none — try another line\n'}click a name, or ← → · esc to clear`;
  list.textContent = '';
  results.forEach((r, i) => {
    const row = document.createElement('div'), name = document.createElement('span'), info = document.createElement('span');
    row.className = 'row' + (i === selected ? ' sel' : '');
    name.textContent = r.sat.name; info.textContent = `${r.sat.alt} km · ${Math.round(r.sat.inc)}°`;
    if (r.sat.starlink) { const tag = document.createElement('span'); tag.className = 'tag'; tag.textContent = 'STARLINK  '; info.prepend(tag); }
    row.append(name, info);
    row.onclick = () => { selected = i; showResults(); };
    list.appendChild(row);
    if (i === selected) row.scrollIntoView({ block: 'nearest' });
  });
}

// ---------- drawing helpers -------------------------------------------------
function strokePath(color, width) { ctx.strokeStyle = color; ctx.lineWidth = width; ctx.stroke(); }
function dot2d(p, r, color) { ctx.fillStyle = color; ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, 7); ctx.fill(); }
function ring2d(p, r, color) { ctx.strokeStyle = color; ctx.lineWidth = 1.2; ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, 7); ctx.stroke(); }

function polyline(vectors) {                         // trace globe points as a path, breaking at the horizon
  ctx.beginPath(); let down = false;
  for (const v of vectors) {
    const p = toScreen(v);
    if (p.front) { down ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y); down = true; } else down = false;
  }
}
function trail(track, minute, length) {              // adds a short comet trail to the current path; returns the head position
  const head = trackScreen(track, minute), tail = trackScreen(track, minute - length);
  if (!head.front) return null;
  if (tail.front) { ctx.moveTo(tail.x, tail.y); ctx.lineTo(head.x, head.y); }
  return head;
}

// ---------- drawing the scene ----------------------------------------------
function drawCatalog(seconds, fadeIn) {              // every satellite, orbiting (real motion, 2 min per second)
  const minute = (seconds * 2) % 120, fade = fadeIn * Math.min(1, minute / 4, (120 - minute) / 4);   // fade at the loop point
  const heads = []; ctx.beginPath();
  for (const s of sats) { if (s.starlink && !showStarlink) continue; const h = trail(s.track, minute, 1); if (h) heads.push(h); }
  strokePath(`rgba(255,255,255,${0.2 * fade})`, 1);
  ctx.fillStyle = `rgba(255,255,255,${0.45 * fade})`;
  for (const h of heads) ctx.fillRect(h.x - 0.9, h.y - 0.9, 1.8, 1.8);
}

function drawLine(top) {
  const arc = resample(line.keys, 100);
  polyline(arc); strokePath('rgba(200,255,0,.13)', 2 * line.tol * radius);                // tolerance band
  polyline(arc); strokePath(WHITE, 2);                                                       // the recognized line
  line.points.forEach((v, j) => {                                                            // its sample points; lime = hit by the selected satellite
    const p = toScreen(v); if (p.front) dot2d(p, top?.hit[j] ? 2.6 : 1.6, top?.hit[j] ? LIME : WHITE);
  });
  if (line.keys.length === 3) { const bend = toScreen(line.keys[1]); ctx.beginPath(); ctx.arc(bend.x, bend.y, 8, 0, 7); strokePath(WHITE, 1); }   // ring at the bend
}

function drawMatches(seconds, top) {                 // each match floats along its own orbit, crossing your line at its own time
  if (top) {                                         // the selected satellite's whole 2 hour orbit
    polyline([...Array(MINUTES * 3)].map((_, i) => trackPoint(top.sat.track, i / 3)));
    strokePath('rgba(200,255,0,.55)', 1);
  }
  const heads = []; ctx.beginPath();
  for (const r of results) {
    const minute = clamp(r.pass + (seconds + r.phase) % 16 - 8, 0, MINUTES - 1.01);       // wander +-8 min around the crossing
    const h = trail(r.sat.track, minute, 0.8); if (h) heads.push([h, r]);
  }
  strokePath('rgba(255,255,255,.4)', 1);
  ctx.font = '12px Helvetica, Arial, sans-serif';
  for (const [h, r] of heads) {
    if (r === top) dot2d(h, 5, LIME); else if (r.sat.starlink) ring2d(h, 3, WHITE); else dot2d(h, 2.6, WHITE);   // ring = Starlink
    if (r === top) { ctx.fillStyle = WHITE; ctx.fillText(r.sat.name, h.x + 10, h.y - 8); }
  }
}

function drawSketch() {                              // while you draw: your raw stroke, and what it snaps to
  if (sketch.length < 2) return;
  ctx.beginPath(); sketch.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); strokePath('rgba(255,255,255,.4)', 1.5);
  polyline(resample(fitShape(sketch).map(p => toGlobe(...p)), 100)); strokePath(WHITE, 2.5);
}

function frame(now) {
  canvas.width = innerWidth; canvas.height = innerHeight;
  cx = innerWidth / 2 + 150; cy = innerHeight / 2; radius = Math.min(innerWidth - 400, innerHeight - 50) / 2;
  ctx.lineCap = ctx.lineJoin = 'round';

  ctx.fillStyle = '#050505'; ctx.beginPath(); ctx.arc(cx, cy, radius, 0, 7); ctx.fill();   // the Earth: just a circle
  strokePath(WHITE, 1);

  const seconds = now / 1000, top = results[selected];
  const fadeIn = revealedAt ? clamp((now - revealedAt) / 2500, 0, 1) : 0;
  if (fadeIn > 0) drawCatalog(seconds, fadeIn);
  if (line) { drawLine(top); drawMatches(seconds, top); }
  else if (drawing) drawSketch();
  requestAnimationFrame(frame);
}

// ---------- go --------------------------------------------------------------
loadSatellites().catch(e => { head.textContent = 'could not load data/sats.json — serve this folder over http\n' + e; });
requestAnimationFrame(frame);
