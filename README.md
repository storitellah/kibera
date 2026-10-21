# Kibera Photo Map

A community photo map of Kibera, Nairobi, built on [OpenStreetMap](https://www.openstreetmap.org).
Each photo sits on the map where it was taken. You can filter by village or theme, search
captions, open photos full-screen, and share a link to any single photo.

It is a static site: plain HTML, CSS and JavaScript with [Leaflet](https://leafletjs.com),
and no build step. Host it anywhere (GitHub Pages, Netlify, a USB stick with a local server).

> The ten photos in `photos/` are **generated placeholders** that only exercise the pipeline.
> Replace them with real photos.

## Run it locally

```sh
python3 -m http.server 8000
# open http://localhost:8000
```

The page loads its data with `fetch()`, so it has to be served over HTTP. Opening `index.html`
straight from disk won't load the photos.

## How it's built

| Piece | Choice | Why |
|---|---|---|
| Basemap | **Humanitarian (HOT)** tiles by default, OSM Standard as a switchable layer | The HOT style shows informal settlements, paths, water points and community facilities well. Much of Kibera's OSM detail comes from [Map Kibera](https://mapkibera.org). |
| Map library | Leaflet 1.9.4 + Leaflet.markercluster 1.5.3 (in `vendor/`) | Light, mobile-friendly, works without a CDN. |
| Markers | Round photo thumbnails. Clusters show the first photo plus a count. | The map reads as a photo album, not a field of pins. |
| Village labels | `data/villages.geojson` | Ships with **approximate** positions for 12 villages. Replace them with OSM's place nodes (see below). |
| Boundary | `data/kibera-osm.geojson` (optional) | Fetched from OSM and drawn as a dashed outline. |
| Photo metadata | `data/photos.json` | One file you can edit by hand and review in pull requests. |

### Layout

- **Desktop:** a sidebar on the left (title, search, village and theme chips, photo list, credits) and the map filling the rest of the screen. Hovering a card highlights its marker. Clicking a card or marker opens the lightbox.
- **Mobile (under 760px):** the map on top and a scrolling list below. Chip rows scroll sideways.
- **Lightbox:** the photo with its caption, village, photographer, date, licence and tags. *Show on map* zooms to the marker. Use the ← → keys to step through photos and Esc to close.
- **Deep links:** `…/#photo=<id>` opens that photo directly.

### Visual design

Warm paper background (`#f6f1e9`), dark ink text, rust accents (`#b4532a`) that echo the iron
roofs, and leaf green for theme filters. Headings use a serif (Palatino/Iowan) for a documentary
feel; the interface uses the system sans-serif. All colours are CSS variables at the top of
`css/style.css`.

## Adding photos

### Option A: the ingest script (recommended)

1. Copy original photos into `photos/originals/`. This folder is git-ignored, so originals with
   full EXIF data are never published.
2. Run:
   ```sh
   pip install Pillow
   python3 scripts/build_photos.py            # or add --jitter 15 to blur positions by ~15 m
   ```
   For each photo this reads its GPS position, date and artist from EXIF. It writes a 1600px web
   copy to `photos/full/` and a 320px square thumbnail to `photos/thumbs/`, both auto-rotated and
   **with all metadata removed**. It then adds an entry to `data/photos.json`, and fills in the
   nearest village when the photo is within 800 m of one.
3. Edit `data/photos.json` to add a title, caption, tags and consent for each photo. When you
   re-run the script, it keeps your edits.

Photos without GPS are added with `"lat": null` and stay off the map until you set their
position. You can find coordinates by right-clicking on openstreetmap.org → *Show address*.

### Option B: in the browser

Click **+ Add photos**, then drop in images. The app reads each photo's GPS data in the browser,
and nothing is uploaded. Photos without GPS can be placed by clicking the map, and every pin can
be dragged. Fill in the title, village, caption and photographer, then click **Download entries
(JSON)**. Paste the downloaded entries into `data/photos.json`, and save the resized images as
`photos/full/<id>.jpg` and `photos/thumbs/<id>.jpg`. The script in Option A does the resizing
for you.

### `photos.json` fields

```jsonc
{
  "id": "lindi-water-point",          // unique; used in URLs and file names
  "title": "Water point",
  "caption": "Residents queue with jerrycans at a water kiosk.",
  "village": "Lindi",
  "tags": ["water", "daily life"],    // become theme filter chips
  "lat": -1.315, "lng": 36.7928,
  "date": "2026-03-19",
  "photographer": "Jane Achieng",
  "license": "CC BY-SA 4.0",
  "consent": "verbal, 2026-03-19",    // record how consent was given
  "alt": "optional alt text (defaults to title)",
  "src": "photos/full/lindi-water-point.jpg",
  "thumb": "photos/thumbs/lindi-water-point.jpg"
}
```

The village and theme chips are built from whatever values appear in the data, so there is no
list to keep in sync.

## Real village labels and boundary from OpenStreetMap

```sh
python3 scripts/fetch_osm.py --villages
```

This queries the Overpass API for the Kibera boundary and the named places inside it. It writes
`data/kibera-osm.geojson` and, with `--villages`, overwrites `data/villages.geojson`. It uses the
standard library only. Review the result and commit it. If a village is missing or misplaced in
OSM, fix it on openstreetmap.org so everyone benefits.

## Ethics and privacy

Kibera has been photographed a great deal, often without people's say. Some guidelines for this
project:

- **Ask first.** Get consent from anyone recognisable and note it in `consent`. Take extra care with children.
- **Credit local photographers.** Put real names in `photographer` and let them choose the licence.
- **Show ordinary life, not only hardship.** Markets, schools, sport, faith, music and work.
- **Protect homes.** Use `--jitter` when a photo could identify where someone lives. The script also strips EXIF so published files carry no GPS or device data.
- **Keep originals private.** `photos/originals/` is git-ignored for this reason.

## Publishing on GitHub Pages

Go to Settings → Pages → *Deploy from a branch* → choose `main` and `/ (root)`. No build step is
needed.

Tiles come from tile.openstreetmap.org and tile.openstreetmap.fr. They are fine for a community
site with modest traffic under the [OSM tile usage policy](https://operations.osmfoundation.org/policies/tiles/).
If traffic grows, switch to a commercial tile provider or host your own tiles. The URLs are at
the top of `js/app.js`.

## Project layout

```
index.html              page shell
css/style.css           all styles (design tokens at the top)
js/app.js               map, filters, lightbox, in-browser contribute tool
data/photos.json        photo metadata
data/villages.geojson   village label points (approximate until refreshed from OSM)
photos/full|thumbs/     published web images (metadata stripped)
photos/originals/       your originals; git-ignored
scripts/build_photos.py ingest originals → web images + photos.json
scripts/fetch_osm.py    boundary + village names from OSM
vendor/                 Leaflet, markercluster, exifr (with their licences)
```

## Credits

Map data © OpenStreetMap contributors (ODbL). HOT tile style by the Humanitarian OpenStreetMap
Team, hosted by OSM France. Leaflet (BSD-2), Leaflet.markercluster (MIT), exifr (MIT).
