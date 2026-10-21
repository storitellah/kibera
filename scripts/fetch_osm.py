#!/usr/bin/env python3
"""Fetch Kibera's boundary and village names from OpenStreetMap (Overpass API).

    python3 scripts/fetch_osm.py [--villages]

Writes data/kibera-osm.geojson (boundary polygon(s)), which the map draws as a
dashed outline. With --villages it also replaces data/villages.geojson with the
named place nodes OSM has inside the area, in place of the approximate
positions shipped with the repo.

Standard library only. Data © OpenStreetMap contributors, ODbL.
"""
import argparse
import json
import sys
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OVERPASS = "https://overpass-api.de/api/interpreter"
BBOX = (-1.3285, 36.7620, -1.2975, 36.8085)  # south, west, north, east
PLACE_TYPES = "neighbourhood|quarter|village|hamlet|suburb|locality"

QUERY = f"""
[out:json][timeout:90];
(
  relation["name"="Kibera"]({','.join(map(str, BBOX))});
  way["name"="Kibera"]["place"]({','.join(map(str, BBOX))});
  way["name"="Kibera"]["boundary"]({','.join(map(str, BBOX))});
);
out geom;
node["place"~"^({PLACE_TYPES})$"]["name"]({','.join(map(str, BBOX))});
out;
"""


def overpass(query):
    body = urllib.parse.urlencode({"data": query}).encode()
    req = urllib.request.Request(OVERPASS, data=body, headers={"User-Agent": "kibera-photo-map/1.0"})
    with urllib.request.urlopen(req, timeout=120) as res:
        return json.load(res)


def coords(geom):
    return [(round(p["lon"], 7), round(p["lat"], 7)) for p in geom]


def join_rings(segments):
    """Join way segments that share end points into closed rings."""
    segs = [list(s) for s in segments if len(s) > 1]
    rings = []
    while segs:
        ring = segs.pop(0)
        changed = True
        while ring[0] != ring[-1] and changed:
            changed = False
            for i, s in enumerate(segs):
                if s[0] == ring[-1]:
                    ring += s[1:]
                elif s[-1] == ring[-1]:
                    ring += s[::-1][1:]
                elif s[-1] == ring[0]:
                    ring = s[:-1] + ring
                elif s[0] == ring[0]:
                    ring = s[::-1][:-1] + ring
                else:
                    continue
                segs.pop(i)
                changed = True
                break
        if ring[0] == ring[-1] and len(ring) >= 4:
            rings.append(ring)
    return rings


def to_feature(el):
    props = {"osm_id": f"{el['type']}/{el['id']}", **el.get("tags", {})}
    if el["type"] == "way":
        ring = coords(el.get("geometry", []))
        if len(ring) < 4 or ring[0] != ring[-1]:
            return None
        return {"type": "Feature", "properties": props, "geometry": {"type": "Polygon", "coordinates": [ring]}}
    outers = [coords(m["geometry"]) for m in el.get("members", []) if m.get("role") == "outer" and m.get("geometry")]
    rings = join_rings(outers)
    if not rings:
        return None
    return {"type": "Feature", "properties": props,
            "geometry": {"type": "MultiPolygon", "coordinates": [[r] for r in rings]}}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--villages", action="store_true", help="also overwrite data/villages.geojson")
    args = ap.parse_args()

    try:
        data = overpass(QUERY)
    except Exception as err:  # network, HTTP 429/504 from a busy server, …
        sys.exit(f"Overpass request failed: {err}")

    areas = [f for el in data["elements"] if el["type"] in ("way", "relation") and (f := to_feature(el))]
    places = [el for el in data["elements"] if el["type"] == "node" and el["tags"].get("name") != "Kibera"]

    attribution = "© OpenStreetMap contributors, ODbL 1.0"
    out = ROOT / "data" / "kibera-osm.geojson"
    out.write_text(json.dumps({"type": "FeatureCollection", "attribution": attribution, "features": areas}) + "\n")
    print(f"{len(areas)} boundary feature(s) -> {out.relative_to(ROOT)}")

    if args.villages:
        if not places:
            sys.exit("No named places found; keeping the existing villages.geojson.")
        feats = [{"type": "Feature",
                  "properties": {"name": el["tags"]["name"], "place": el["tags"]["place"], "osm_id": f"node/{el['id']}"},
                  "geometry": {"type": "Point", "coordinates": [el["lon"], el["lat"]]}}
                 for el in sorted(places, key=lambda e: e["tags"]["name"])]
        vout = ROOT / "data" / "villages.geojson"
        vout.write_text(json.dumps({"type": "FeatureCollection", "attribution": attribution, "features": feats}, indent=1) + "\n")
        print(f"{len(feats)} place(s) -> {vout.relative_to(ROOT)}")
    else:
        print(f"{len(places)} named place(s) found; re-run with --villages to use them as labels.")


if __name__ == "__main__":
    main()
