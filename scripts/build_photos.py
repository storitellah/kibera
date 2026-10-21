#!/usr/bin/env python3
"""Turn original photos into web images and entries in data/photos.json.

    python3 scripts/build_photos.py [--jitter METRES]

For every image in photos/originals/ this:
  * reads GPS position, capture date and artist from EXIF,
  * writes photos/full/<id>.jpg (1600px long edge) and photos/thumbs/<id>.jpg
    (320px square), auto-rotated and with ALL metadata stripped,
  * adds or updates the entry in data/photos.json.

Fields you edit by hand in photos.json (title, caption, tags, village, consent,
or a lat/lng you corrected) are kept on re-runs. Photos without GPS are added
with lat/lng = null and are hidden on the map until you fill them in.

--jitter shifts each new photo's published position by up to METRES in a
direction derived from its id, so exact doorsteps aren't revealed.

Requires Pillow (pip install Pillow).
"""
import argparse
import hashlib
import json
import math
import re
import sys
from datetime import datetime
from pathlib import Path

from PIL import Image, ImageOps

ROOT = Path(__file__).resolve().parent.parent
ORIGINALS = ROOT / "photos" / "originals"
FULL = ROOT / "photos" / "full"
THUMBS = ROOT / "photos" / "thumbs"
PHOTOS_JSON = ROOT / "data" / "photos.json"
VILLAGES = ROOT / "data" / "villages.geojson"

EXTS = {".jpg", ".jpeg", ".png", ".tif", ".tiff", ".webp"}
FULL_SIZE = 1600
THUMB_SIZE = 320

GPS_IFD = 0x8825
EXIF_IFD = 0x8769
TAG_ARTIST = 315
TAG_DATETIME_ORIGINAL = 36867


def slugify(name):
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")


def dms_to_deg(dms, ref):
    deg = float(dms[0]) + float(dms[1]) / 60 + float(dms[2]) / 3600
    return -deg if ref in ("S", "W") else deg


def read_exif(img):
    exif = img.getexif()
    out = {"lat": None, "lng": None, "date": "", "photographer": ""}
    gps = exif.get_ifd(GPS_IFD)
    try:
        out["lat"] = round(dms_to_deg(gps[2], gps[1]), 6)
        out["lng"] = round(dms_to_deg(gps[4], gps[3]), 6)
    except (KeyError, IndexError, TypeError, ZeroDivisionError):
        pass
    raw_date = exif.get_ifd(EXIF_IFD).get(TAG_DATETIME_ORIGINAL)
    if raw_date:
        try:
            out["date"] = datetime.strptime(str(raw_date).strip(), "%Y:%m:%d %H:%M:%S").date().isoformat()
        except ValueError:
            pass
    out["photographer"] = str(exif.get(TAG_ARTIST, "") or "").strip()
    return out


def jitter(lat, lng, key, metres):
    h = hashlib.sha256(key.encode()).digest()
    angle = h[0] / 255 * 2 * math.pi
    dist = (0.5 + h[1] / 510) * metres  # between 50% and 100% of the max
    dlat = dist * math.cos(angle) / 111_320
    dlng = dist * math.sin(angle) / (111_320 * math.cos(math.radians(lat)))
    return round(lat + dlat, 6), round(lng + dlng, 6)


def load_villages():
    if not VILLAGES.exists():
        return []
    gj = json.loads(VILLAGES.read_text())
    return [(f["properties"]["name"], f["geometry"]["coordinates"][1], f["geometry"]["coordinates"][0])
            for f in gj.get("features", []) if f.get("geometry", {}).get("type") == "Point"]


def nearest_village(lat, lng, villages, max_m=800):
    best, best_d = "", float("inf")
    for name, vlat, vlng in villages:
        dx = (lng - vlng) * 111_320 * math.cos(math.radians(lat))
        dy = (lat - vlat) * 111_320
        d = math.hypot(dx, dy)
        if d < best_d:
            best, best_d = name, d
    return best if best_d <= max_m else ""


def save_web_images(img, pid):
    img = ImageOps.exif_transpose(img).convert("RGB")
    full = img.copy()
    full.thumbnail((FULL_SIZE, FULL_SIZE), Image.LANCZOS)
    full.save(FULL / f"{pid}.jpg", "JPEG", quality=82, optimize=True, progressive=True)
    thumb = ImageOps.fit(img, (THUMB_SIZE, THUMB_SIZE), Image.LANCZOS)
    thumb.save(THUMBS / f"{pid}.jpg", "JPEG", quality=78, optimize=True)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--jitter", type=float, default=0, help="max metres to offset new photo positions")
    args = ap.parse_args()

    if not ORIGINALS.is_dir():
        sys.exit(f"Put your photos in {ORIGINALS.relative_to(ROOT)}/ first.")
    FULL.mkdir(parents=True, exist_ok=True)
    THUMBS.mkdir(parents=True, exist_ok=True)

    data = json.loads(PHOTOS_JSON.read_text()) if PHOTOS_JSON.exists() else {"photos": []}
    by_id = {p["id"]: p for p in data["photos"]}
    villages = load_villages()
    added, updated, no_gps = 0, 0, []

    for path in sorted(ORIGINALS.iterdir()):
        if path.suffix.lower() not in EXTS:
            continue
        pid = slugify(path.stem)
        with Image.open(path) as img:
            meta = read_exif(img)
            save_web_images(img, pid)

        entry = by_id.get(pid)
        if entry is None:
            lat, lng = meta["lat"], meta["lng"]
            if lat is not None and args.jitter:
                lat, lng = jitter(lat, lng, pid, args.jitter)
            entry = {
                "id": pid,
                "title": path.stem.replace("_", " ").replace("-", " ").strip().capitalize(),
                "caption": "",
                "village": "",
                "tags": [],
                "lat": lat,
                "lng": lng,
                "date": meta["date"],
                "photographer": meta["photographer"],
                "license": "CC BY-SA 4.0",
                "consent": "",
            }
            data["photos"].append(entry)
            by_id[pid] = entry
            added += 1
        else:
            for k in ("lat", "lng", "date", "photographer"):
                if entry.get(k) in (None, "") and meta[k] not in (None, ""):
                    entry[k] = meta[k]
            updated += 1

        entry["src"] = f"photos/full/{pid}.jpg"
        entry["thumb"] = f"photos/thumbs/{pid}.jpg"
        if not entry.get("village") and entry.get("lat") is not None:
            entry["village"] = nearest_village(entry["lat"], entry["lng"], villages)
        if entry.get("lat") is None:
            no_gps.append(path.name)

    PHOTOS_JSON.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n")
    print(f"{added} added, {updated} updated -> {PHOTOS_JSON.relative_to(ROOT)}")
    if no_gps:
        print("No GPS (set lat/lng by hand or use 'Add photos' in the app):")
        for n in no_gps:
            print(f"  - {n}")


if __name__ == "__main__":
    main()
