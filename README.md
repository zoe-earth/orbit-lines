# Orbit Lines

Draw one line on the Earth, and see which satellites' orbits follow it.

The Earth is just a circle. Draw a line on it (straight, or with one bend). Once you lift the pen, the
line is recognized, every satellite in the catalog starts orbiting, and the ones whose ground track runs
along your line are picked out and listed. Click a name to see its full orbit.

Inspired by Zach Lieberman's *Land Lines* and NASA's *Your Name in Landsat*.

## How it works

1. Your stroke is snapped to a straight line or a single-bend polyline (fewer shapes = easier to recognize).
2. That shape is resampled to 48 evenly spaced points on the sphere.
3. Every satellite is propagated over the next two hours with SGP4 ([satellite.js](https://github.com/shashwatak/satellite-js)),
   giving a ground track.
4. A point on your line is "hit" if the track passes within a tolerance (4.5% of the line's length, 90–450 km).
   Satellites are ranked by how much of the line they hit.

The direction you draw matters: a north–south line catches polar, sun-synchronous satellites (~98° inclination);
a diagonal catches mid-inclination ones. No orbit bends, so a bent line only ever matches one leg.

All the logic is in [`app.js`](app.js) (`fitShape` → `recognize` → `match`), no build step, no framework.

## Recreate it from scratch

Build it in this order; each step works on its own before you add the next.

1. **A circle that is a globe.** Canvas + an orthographic projection (`toScreen` / `toGlobe`). Points on the globe are
   unit vectors `[x, y, z]`.
2. **Draw a line on it.** Collect pointer positions in pixels; ignore points outside the circle.
3. **Snap it** (`fitShape`): compare your stroke to a straight segment, then try every point as a corner and keep the
   corner only if it fits clearly better. Do this in plain 2D pixels, no spherical math needed.
4. **Put it on the globe** (`recognize`, `resample`): convert the 2–3 key points to unit vectors and walk along the
   arcs (`slerp`) to get 48 evenly spaced points.
5. **Get satellite tracks** (`loadSatellites`): feed CelesTrak orbital elements to satellite.js `sgp4()` once per
   minute for 2 hours, rotate each position by the Earth's spin (`gstime`), keep just the direction.
6. **Match** (`match`): for each point on your line find the nearest spot on each track; a point is "hit" if that's
   within a tolerance. Rank satellites by how many points they hit.
7. **Make it move**: interpolate each track by fractional minute (`trackPoint`) and draw a short trail.

## Run it

It's a static site, but it loads `data/sats.json`, so it must be served over http (not opened as `file://`).

- **VS Code:** install the recommended *Live Server* extension, right-click `index.html` → *Open with Live Server*.
- **npm:** `npm start` (serves on http://localhost:8010)
- **anything else:** `python3 -m http.server 8010`

## Deploy to GitHub Pages

Repo → *Settings* → *Pages* → *Deploy from a branch* → `main` / `(root)`. Everything uses relative paths, so it works as is.

## Data

`data/sats.json` is a snapshot of orbital elements from [CelesTrak](https://celestrak.org). Elements go stale
within a few weeks (SGP4 is only accurate near each element's epoch), so refresh it now and then
(needs Node 18+):

```bash
npm run fetch-data      # fetch what's missing/stale, rebuild data/sats.json
npm run rebuild-data    # rebuild from the local cache only, no network
```

CelesTrak allows one download per group every 2 hours (a repeat gets HTTP 403), so groups are cached in
`data/raw/` (git-ignored) and locked groups are skipped; run it again later to fill gaps. The **Starlink**
group (~9k objects) is big and streams slowly, so it may need a second run. A Python version of the
same script is in `tools/fetch_sats.py`.

## Credits

- Orbital data: [CelesTrak](https://celestrak.org) (Dr. T.S. Kelso)
- SGP4 propagation: [satellite.js](https://github.com/shashwatak/satellite-js) 6.0.2 (MIT), vendored in `vendor/`
