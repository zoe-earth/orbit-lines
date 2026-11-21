#!/usr/bin/env python3
"""Build data/sats.json from CelesTrak GP data.

Browsers can't call CelesTrak directly (no CORS header), so we fetch a
snapshot here and the app reads data/sats.json.

CelesTrak rules of the road:
  * one download per group every 2 hours (a repeat gets HTTP 403)
  * big groups (Starlink, ~9k objects) can stream slowly

So each group is cached raw in data/raw/ and skipped while fresh, downloads
have hard timeouts, truncated JSON is salvaged, and a locked/failed group is
just skipped -- re-run the script later and it fills in what's missing.
Element sets go stale in a few weeks (SGP4 is accurate near the epoch):
re-run to refresh.

    python3 tools/fetch_sats.py            # fetch what's missing/stale, rebuild
    python3 tools/fetch_sats.py --rebuild  # only rebuild sats.json from cache
"""
import json, sys, time, pathlib, subprocess

ROOT = pathlib.Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"; RAW.mkdir(parents=True, exist_ok=True)
# (group, timeout seconds). Big ones get longer.
GROUPS = [("stations",60),("visual",60),("weather",60),("noaa",60),("goes",60),("resource",60),
          ("sarsat",60),("science",60),("geo",90),("gps-ops",60),("glo-ops",60),("galileo",60),
          ("beidou",60),("oneweb",120),("planet",120),("spire",120),("iridium-NEXT",60),
          ("globalstar",60),("orbcomm",60),("intelsat",60),("ses",60),("amateur",90),
          ("cubesat",120),("engineering",60),("military",60),("radar",60),("geodetic",60),
          ("argos",60),("tdrss",60),("x-comm",60),("other-comm",60),("satnogs",90),
          ("gorizont",60),("raduga",60),("molniya",60),("musson",60),("education",60),
          ("dmc",60),("new",60),("last-30-days",90),("starlink",900)]
KEEP = ["OBJECT_NAME","OBJECT_ID","NORAD_CAT_ID","EPOCH","MEAN_MOTION","ECCENTRICITY",
        "INCLINATION","RA_OF_ASC_NODE","ARG_OF_PERICENTER","MEAN_ANOMALY","BSTAR",
        "MEAN_MOTION_DOT","MEAN_MOTION_DDOT","EPHEMERIS_TYPE","CLASSIFICATION_TYPE",
        "ELEMENT_SET_NO","REV_AT_EPOCH"]

def salvage(text):
    """Parse a possibly-truncated JSON array of flat objects."""
    try: return json.loads(text), True
    except Exception: pass
    cut = text.rfind("},")
    if cut < 0: return [], False
    try: return json.loads(text[:cut+1] + "]"), False
    except Exception: return [], False

def fetch(g, tmo):
    f, part = RAW / f"{g}.json", RAW / f"{g}.partial.json"
    if f.exists() and time.time() - f.stat().st_mtime < 7200:
        return json.loads(f.read_text())
    url = f"https://celestrak.org/NORAD/elements/gp.php?GROUP={g}&FORMAT=json"
    tmp = RAW / f"{g}.tmp"
    r = subprocess.run(["curl","-s","-m",str(tmo),"-o",str(tmp),"-w","%{http_code}",url],
                       capture_output=True, text=True)
    code = r.stdout.strip()
    text = tmp.read_text(errors="replace") if tmp.exists() else ""
    tmp.unlink(missing_ok=True)
    if code == "403" or text.startswith("GP data has not"):
        print(f"  {g}: locked (downloaded <2h ago) -> using cache" if (f.exists() or part.exists()) else f"  {g}: locked (downloaded <2h ago), no cache")
    else:
        data, full = salvage(text)
        if data:
            (f if full else part).write_text(json.dumps(data))
            if not full: print(f"  {g}: PARTIAL ({len(data)} objects, timed out) -- re-run in 2h for the rest")
            return data
        print(f"  {g}: no data (curl code {r.returncode}, http {code})")
    for p in (f, part):
        if p.exists(): return json.loads(p.read_text())
    return []

rebuild_only = "--rebuild" in sys.argv
sats = {}
for g, tmo in GROUPS:
    if rebuild_only:
        data = [x for p in (RAW/f"{g}.json", RAW/f"{g}.partial.json") if p.exists() for x in json.loads(p.read_text())]
    else:
        data = fetch(g, tmo); time.sleep(0.5)
    for r in data:
        if isinstance(r, dict) and "NORAD_CAT_ID" in r:
            sats[r["NORAD_CAT_ID"]] = {k: r[k] for k in KEEP if k in r}
    print(f"{g:14s} {len(data):6d}   total {len(sats)}", flush=True)
dest = ROOT / "data" / "sats.json"
dest.write_text(json.dumps(list(sats.values()), separators=(",", ":")))
print(f"wrote {len(sats)} satellites -> {dest} ({dest.stat().st_size/1e6:.1f} MB)")
