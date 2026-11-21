#!/usr/bin/env node
// Build data/sats.json from CelesTrak GP (orbital element) data.  Needs Node 18+.
//
// Browsers can't call CelesTrak directly (no CORS header), so we take a snapshot
// here and the app reads data/sats.json.
//
// CelesTrak rules of the road:
//   * one download per group every 2 hours (a repeat gets HTTP 403)
//   * big groups (Starlink, ~9k objects) can stream slowly
// So each group is cached raw in data/raw/ and skipped while fresh, downloads have
// hard timeouts, truncated JSON is salvaged, and a locked/failed group is just
// skipped -- run again later and it fills in what's missing.
//
//   npm run fetch-data      fetch what's missing/stale, rebuild data/sats.json
//   npm run rebuild-data    only rebuild sats.json from the cache (no network)

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RAW = path.join(ROOT, 'data', 'raw');
const GROUPS = [   // [group, timeout seconds] -- big ones get longer
  ['stations', 60], ['visual', 60], ['weather', 60], ['goes', 60], ['resource', 60], ['sarsat', 60],
  ['science', 60], ['geo', 90], ['gps-ops', 60], ['glo-ops', 60], ['galileo', 60], ['beidou', 60],
  ['oneweb', 120], ['planet', 120], ['spire', 120], ['iridium-NEXT', 60], ['globalstar', 60],
  ['orbcomm', 60], ['intelsat', 60], ['ses', 60], ['amateur', 90], ['cubesat', 120],
  ['engineering', 60], ['military', 60], ['radar', 60], ['geodetic', 60], ['argos', 60],
  ['tdrss', 60], ['x-comm', 60], ['other-comm', 60], ['satnogs', 90], ['musson', 60],
  ['education', 60], ['dmc', 60], ['last-30-days', 90], ['starlink', 900],
];
const KEEP = ['OBJECT_NAME', 'OBJECT_ID', 'NORAD_CAT_ID', 'EPOCH', 'MEAN_MOTION', 'ECCENTRICITY',
  'INCLINATION', 'RA_OF_ASC_NODE', 'ARG_OF_PERICENTER', 'MEAN_ANOMALY', 'BSTAR',
  'MEAN_MOTION_DOT', 'MEAN_MOTION_DDOT', 'EPHEMERIS_TYPE', 'CLASSIFICATION_TYPE',
  'ELEMENT_SET_NO', 'REV_AT_EPOCH'];

const exists = p => fs.access(p).then(() => true, () => false);
const readJSON = async p => JSON.parse(await fs.readFile(p, 'utf8'));

function salvage(text) {              // parse a possibly-truncated JSON array of flat objects
  try { return [JSON.parse(text), true]; } catch { /* fall through */ }
  const cut = text.lastIndexOf('},');
  if (cut < 0) return [[], false];
  try { return [JSON.parse(text.slice(0, cut + 1) + ']'), false]; } catch { return [[], false]; }
}

async function download(url, seconds) {   // keeps whatever arrived if the timeout hits
  const ac = new AbortController(), timer = setTimeout(() => ac.abort(), seconds * 1000);
  let status = 0, text = '';
  try {
    const res = await fetch(url, { signal: ac.signal });
    status = res.status;
    const reader = res.body.getReader(), dec = new TextDecoder();
    for (;;) { const { done, value } = await reader.read(); if (done) break; text += dec.decode(value, { stream: true }); }
  } catch { /* timeout or network error: use what we have */ } finally { clearTimeout(timer); }
  return { status, text };
}

async function fetchGroup(group, seconds) {
  const full = path.join(RAW, `${group}.json`), part = path.join(RAW, `${group}.partial.json`);
  if (await exists(full) && Date.now() - (await fs.stat(full)).mtimeMs < 2 * 3600e3) return readJSON(full);
  const { status, text } = await download(`https://celestrak.org/NORAD/elements/gp.php?GROUP=${group}&FORMAT=json`, seconds);
  if (status === 403 || text.startsWith('GP data has not')) {
    console.log(`  ${group}: locked (downloaded <2h ago)`);
  } else {
    const [data, isFull] = salvage(text);
    if (data.length) {
      await fs.writeFile(isFull ? full : part, JSON.stringify(data));
      if (!isFull) console.log(`  ${group}: PARTIAL (${data.length} objects, timed out) -- run again in 2h for the rest`);
      return data;
    }
    console.log(`  ${group}: no data (http ${status})`);
  }
  for (const p of [full, part]) if (await exists(p)) return readJSON(p);
  return [];
}

await fs.mkdir(RAW, { recursive: true });
const rebuildOnly = process.argv.includes('--rebuild');
const sats = new Map();
for (const [group, seconds] of GROUPS) {
  let data = [];
  if (rebuildOnly) {
    for (const p of [`${group}.json`, `${group}.partial.json`].map(f => path.join(RAW, f))) if (await exists(p)) data.push(...await readJSON(p));
  } else {
    data = await fetchGroup(group, seconds);
    await new Promise(r => setTimeout(r, 500));   // be polite
  }
  for (const o of data) if (o && o.NORAD_CAT_ID !== undefined) sats.set(o.NORAD_CAT_ID, Object.fromEntries(KEEP.filter(k => k in o).map(k => [k, o[k]])));
  console.log(`${group.padEnd(14)} ${String(data.length).padStart(6)}   total ${sats.size}`);
}
const dest = path.join(ROOT, 'data', 'sats.json');
await fs.writeFile(dest, JSON.stringify([...sats.values()]));
console.log(`wrote ${sats.size} satellites -> ${dest} (${((await fs.stat(dest)).size / 1e6).toFixed(1)} MB)`);
