/* Kibera Photo Map
 * Leaflet + OpenStreetMap. Photos come from data/photos.json; village labels from
 * data/villages.geojson; an optional OSM boundary from data/kibera-osm.geojson
 * (generate it with scripts/fetch_osm.py).
 */
(function () {
  'use strict';

  const KIBERA_CENTER = [-1.3127, 36.7860];
  const KIBERA_BOUNDS = L.latLngBounds([-1.3285, 36.7620], [-1.2975, 36.8085]);

  const state = {
    photos: [],
    visible: [],
    village: null,
    tags: new Set(),
    query: '',
    activeId: null,
    markers: new Map(), // photo id -> L.Marker
  };

  // ---------- Map ----------
  const osm = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  });
  const hot = L.tileLayer('https://{s}.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png', {
    maxZoom: 19,
    subdomains: 'abc',
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, tiles style by <a href="https://www.hotosm.org/">HOT</a> hosted by <a href="https://openstreetmap.fr/">OSM France</a>',
  });

  const map = L.map('map', {
    center: KIBERA_CENTER,
    zoom: 16,
    minZoom: 13,
    maxBounds: KIBERA_BOUNDS.pad(1.5),
    layers: [hot],
    zoomControl: false,
  });
  L.control.zoom({ position: 'topright' }).addTo(map);
  L.control.scale({ imperial: false, position: 'bottomright' }).addTo(map);

  const villageLayer = L.layerGroup().addTo(map);
  const boundaryLayer = L.layerGroup().addTo(map);

  const cluster = L.markerClusterGroup({
    showCoverageOnHover: false,
    maxClusterRadius: 48,
    spiderfyOnMaxZoom: true,
    iconCreateFunction(c) {
      const first = c.getAllChildMarkers()[0].options.photo;
      return L.divIcon({
        className: '',
        iconSize: [54, 54],
        html: `<div class="photo-cluster"><div class="photo-marker"><img src="${esc(first.thumb)}" alt=""></div><span class="count">${c.getChildCount()}</span></div>`,
      });
    },
  }).addTo(map);

  L.control.layers(
    { 'Humanitarian (HOT)': hot, 'OpenStreetMap Standard': osm },
    { 'Village names': villageLayer, 'Kibera boundary': boundaryLayer, 'Photos': cluster },
    { position: 'topright' }
  ).addTo(map);

  // ---------- Helpers ----------
  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function fmtDate(d) {
    if (!d) return '';
    const dt = new Date(d);
    return isNaN(dt) ? d : dt.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }
  async function loadJSON(url, optional) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(res.status);
      return await res.json();
    } catch (err) {
      if (!optional) console.error(`Could not load ${url}`, err);
      return null;
    }
  }
  const $ = (id) => document.getElementById(id);

  // ---------- Data ----------
  async function init() {
    const [photoData, villages, boundary] = await Promise.all([
      loadJSON('data/photos.json'),
      loadJSON('data/villages.geojson'),
      loadJSON('data/kibera-osm.geojson', true),
    ]);

    if (boundary) drawBoundary(boundary);
    if (villages) drawVillages(villages);

    state.photos = (photoData?.photos || []).filter((p) => isFinite(p.lat) && isFinite(p.lng));
    buildMarkers();
    buildChips();
    applyFilters();
    if (state.photos.length) map.fitBounds(L.latLngBounds(state.photos.map((p) => [p.lat, p.lng])).pad(0.15), { maxZoom: 17 });
    readHash();
  }

  function drawBoundary(gj) {
    L.geoJSON(gj, {
      filter: (f) => f.geometry && f.geometry.type !== 'Point',
      style: { color: '#b4532a', weight: 2, dashArray: '6 5', fill: true, fillOpacity: 0.04 },
      interactive: false,
    }).addTo(boundaryLayer);
  }

  function drawVillages(gj) {
    L.geoJSON(gj, {
      pointToLayer: (f, latlng) =>
        L.marker(latlng, { opacity: 0, interactive: false, keyboard: false })
          .bindTooltip(f.properties.name, { permanent: true, direction: 'center', className: 'village-label' }),
    }).addTo(villageLayer);
  }

  function markerIcon(p, active) {
    return L.divIcon({
      className: '',
      iconSize: [46, 46],
      iconAnchor: [23, 23],
      html: `<div class="photo-marker${active ? ' is-active' : ''}"><img src="${esc(p.thumb)}" alt=""></div>`,
    });
  }

  function buildMarkers() {
    state.photos.forEach((p) => {
      const m = L.marker([p.lat, p.lng], { icon: markerIcon(p), photo: p, title: p.title, alt: p.title });
      m.on('click', () => openLightbox(p.id));
      state.markers.set(p.id, m);
    });
  }

  // ---------- Filters ----------
  function buildChips() {
    const villages = [...new Set(state.photos.map((p) => p.village).filter(Boolean))].sort();
    const tags = [...new Set(state.photos.flatMap((p) => p.tags || []))].sort();

    const vWrap = $('village-chips');
    vWrap.innerHTML = '';
    ['All villages', ...villages].forEach((v, i) => {
      const b = chip(v, i === 0);
      b.addEventListener('click', () => {
        state.village = i === 0 ? null : v;
        vWrap.querySelectorAll('.chip').forEach((c) => c.setAttribute('aria-pressed', String(c === b)));
        applyFilters({ fit: true });
      });
      vWrap.appendChild(b);
    });

    const tWrap = $('tag-chips');
    tWrap.innerHTML = '';
    tags.forEach((t) => {
      const b = chip(t, false);
      b.classList.add('tag');
      b.addEventListener('click', () => {
        state.tags.has(t) ? state.tags.delete(t) : state.tags.add(t);
        b.setAttribute('aria-pressed', String(state.tags.has(t)));
        applyFilters({ fit: true });
      });
      tWrap.appendChild(b);
    });
  }

  function chip(label, pressed) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.textContent = label;
    b.setAttribute('aria-pressed', String(pressed));
    return b;
  }

  $('search').addEventListener('input', (e) => {
    state.query = e.target.value.trim().toLowerCase();
    applyFilters();
  });

  function matches(p) {
    if (state.village && p.village !== state.village) return false;
    for (const t of state.tags) if (!(p.tags || []).includes(t)) return false;
    if (state.query) {
      const hay = [p.title, p.caption, p.village, p.photographer, ...(p.tags || [])].join(' ').toLowerCase();
      if (!hay.includes(state.query)) return false;
    }
    return true;
  }

  function applyFilters({ fit = false } = {}) {
    state.visible = state.photos.filter(matches).sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    cluster.clearLayers();
    cluster.addLayers(state.visible.map((p) => state.markers.get(p.id)));
    renderList();
    if (fit && state.visible.length) {
      map.flyToBounds(L.latLngBounds(state.visible.map((p) => [p.lat, p.lng])).pad(0.3), { maxZoom: 17, duration: 0.6 });
    }
  }

  function renderList() {
    const list = $('photo-list');
    const n = state.visible.length;
    $('result-count').textContent = `${n} photo${n === 1 ? '' : 's'}${n !== state.photos.length ? ` of ${state.photos.length}` : ''}`;
    if (!n) {
      list.innerHTML = '<li class="empty">No photos match these filters.</li>';
      return;
    }
    list.innerHTML = state.visible.map((p) => `
      <li class="photo-card${p.id === state.activeId ? ' is-active' : ''}" data-id="${esc(p.id)}" tabindex="0">
        <img src="${esc(p.thumb)}" alt="" loading="lazy">
        <div>
          <h3>${esc(p.title)}</h3>
          <p class="meta">${esc(p.village || 'Kibera')}${p.date ? ' · ' + esc(fmtDate(p.date)) : ''}</p>
        </div>
      </li>`).join('');
  }

  const list = $('photo-list');
  list.addEventListener('click', (e) => {
    const card = e.target.closest('.photo-card');
    if (card) openLightbox(card.dataset.id);
  });
  list.addEventListener('keydown', (e) => {
    const card = e.target.closest('.photo-card');
    if (card && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openLightbox(card.dataset.id); }
  });
  list.addEventListener('mouseover', (e) => {
    const card = e.target.closest('.photo-card');
    if (card) highlight(card.dataset.id);
  });
  list.addEventListener('mouseleave', () => highlight(state.activeId));

  let highlighted = null;
  function highlight(id) {
    if (highlighted === id) return;
    const prev = state.markers.get(highlighted);
    if (prev) prev.setIcon(markerIcon(prev.options.photo, false));
    highlighted = id;
    const m = state.markers.get(id);
    if (m) {
      m.setIcon(markerIcon(m.options.photo, true));
      m.setZIndexOffset(1000);
    }
  }

  // ---------- Lightbox ----------
  const lb = $('lightbox');
  let lastFocus = null;

  function openLightbox(id) {
    const p = state.photos.find((x) => x.id === id);
    if (!p) return;
    state.activeId = id;
    lastFocus = lastFocus || document.activeElement;

    $('lb-img').src = p.src;
    $('lb-img').alt = p.alt || p.title;
    $('lb-village').textContent = p.village || 'Kibera';
    $('lb-title').textContent = p.title;
    $('lb-caption').textContent = p.caption || '';
    $('lb-byline').innerHTML = [
      p.photographer && `Photo: ${esc(p.photographer)}`,
      p.date && esc(fmtDate(p.date)),
      p.license && esc(p.license),
    ].filter(Boolean).join(' · ');
    $('lb-tags').innerHTML = (p.tags || []).map((t) => `<li>${esc(t)}</li>`).join('');

    lb.hidden = false;
    lb.querySelector('.lb-close').focus();
    highlight(id);
    renderList();
    history.replaceState(null, '', `#photo=${encodeURIComponent(id)}`);
  }

  function closeLightbox() {
    lb.hidden = true;
    history.replaceState(null, '', location.pathname + location.search);
    if (lastFocus) lastFocus.focus();
    lastFocus = null;
  }

  function step(dir) {
    const pool = state.visible.length ? state.visible : state.photos;
    const i = pool.findIndex((p) => p.id === state.activeId);
    const next = pool[(i + dir + pool.length) % pool.length];
    if (next) openLightbox(next.id);
  }

  function locate(id) {
    const m = state.markers.get(id);
    if (!m) return;
    closeLightbox();
    cluster.zoomToShowLayer(m, () => map.panTo(m.getLatLng()));
    highlight(id);
  }

  lb.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) closeLightbox(); });
  lb.querySelector('.lb-prev').addEventListener('click', () => step(-1));
  lb.querySelector('.lb-next').addEventListener('click', () => step(1));
  $('lb-locate').addEventListener('click', () => locate(state.activeId));
  document.addEventListener('keydown', (e) => {
    if (lb.hidden) return;
    if (e.key === 'Escape') closeLightbox();
    if (e.key === 'ArrowLeft') step(-1);
    if (e.key === 'ArrowRight') step(1);
  });

  function readHash() {
    const m = location.hash.match(/photo=([^&]+)/);
    if (m) openLightbox(decodeURIComponent(m[1]));
  }
  window.addEventListener('hashchange', readHash);

  // ---------- Contribute ----------
  const drawer = $('contribute');
  const drafts = []; // { id, file, url, lat, lng, title, village, caption, photographer, date, marker }
  const draftLayer = L.layerGroup().addTo(map);
  let placing = null;

  $('contribute-btn').addEventListener('click', () => { drawer.hidden = false; });
  $('contrib-close').addEventListener('click', () => { drawer.hidden = true; stopPlacing(); });

  const dz = $('dropzone');
  ['dragenter', 'dragover'].forEach((t) => dz.addEventListener(t, (e) => { e.preventDefault(); dz.classList.add('is-over'); }));
  ['dragleave', 'drop'].forEach((t) => dz.addEventListener(t, (e) => { e.preventDefault(); dz.classList.remove('is-over'); }));
  dz.addEventListener('drop', (e) => addFiles(e.dataTransfer.files));
  $('file-input').addEventListener('change', (e) => addFiles(e.target.files));

  async function addFiles(files) {
    for (const file of files) {
      if (!file.type.startsWith('image/')) continue;
      let gps = null, meta = null;
      try {
        gps = await exifr.gps(file);
        meta = await exifr.parse(file, ['DateTimeOriginal', 'Artist']);
      } catch (_) { /* no EXIF */ }
      const d = {
        id: slug(file.name.replace(/\.[^.]+$/, '')),
        file: file.name,
        url: URL.createObjectURL(file),
        lat: gps?.latitude ?? null,
        lng: gps?.longitude ?? null,
        title: '',
        village: nearestVillage(gps),
        caption: '',
        photographer: meta?.Artist || '',
        date: meta?.DateTimeOriginal ? new Date(meta.DateTimeOriginal).toISOString().slice(0, 10) : '',
      };
      drafts.push(d);
      if (d.lat != null) placeDraft(d, [d.lat, d.lng]);
    }
    renderDrafts();
  }

  function slug(s) {
    return s.toLowerCase().normalize('NFKD').replace(/[^\w]+/g, '-').replace(/^-|-$/g, '');
  }

  let villagePoints = [];
  function nearestVillage(gps) {
    if (!gps || !villagePoints.length) return '';
    const here = L.latLng(gps.latitude, gps.longitude);
    let best = null, bestD = Infinity;
    villagePoints.forEach((v) => {
      const dist = here.distanceTo(v.latlng);
      if (dist < bestD) { bestD = dist; best = v.name; }
    });
    return bestD < 800 ? best : '';
  }
  loadJSON('data/villages.geojson').then((gj) => {
    villagePoints = (gj?.features || []).map((f) => ({
      name: f.properties.name,
      latlng: L.latLng(f.geometry.coordinates[1], f.geometry.coordinates[0]),
    }));
  });

  function placeDraft(d, latlng) {
    d.lat = +latlng[0].toFixed(6);
    d.lng = +latlng[1].toFixed(6);
    if (!d.village) d.village = nearestVillage({ latitude: d.lat, longitude: d.lng });
    if (d.marker) d.marker.setLatLng(latlng);
    else {
      d.marker = L.marker(latlng, {
        draggable: true,
        icon: L.divIcon({ className: '', iconSize: [18, 18], html: '<div class="draft-pin"></div>' }),
      }).addTo(draftLayer);
      d.marker.on('dragend', () => { const ll = d.marker.getLatLng(); placeDraft(d, [ll.lat, ll.lng]); renderDrafts(); });
    }
  }

  function startPlacing(d) {
    placing = d;
    document.body.classList.add('placing-hint');
    renderDrafts();
  }
  function stopPlacing() {
    placing = null;
    document.body.classList.remove('placing-hint');
  }
  map.on('click', (e) => {
    if (!placing) return;
    placeDraft(placing, [e.latlng.lat, e.latlng.lng]);
    stopPlacing();
    renderDrafts();
  });

  function renderDrafts() {
    const ul = $('draft-list');
    const villageOptions = villagePoints.map((v) => v.name).sort();
    ul.innerHTML = drafts.map((d, i) => `
      <li class="draft${placing === d ? ' is-placing' : ''}" data-i="${i}">
        <img src="${d.url}" alt="">
        <div>
          <input data-k="title" placeholder="Title" value="${esc(d.title)}">
          <select data-k="village">
            <option value="">Village…</option>
            ${villageOptions.map((v) => `<option${v === d.village ? ' selected' : ''}>${esc(v)}</option>`).join('')}
          </select>
          <input data-k="caption" placeholder="Caption" value="${esc(d.caption)}">
          <input data-k="photographer" placeholder="Photographer" value="${esc(d.photographer)}">
          <p class="loc">${d.lat != null ? `${d.lat}, ${d.lng} · ` : 'No location · '}<button type="button" data-place>${placing === d ? 'Click the map…' : d.lat != null ? 'Move' : 'Place on map'}</button></p>
        </div>
      </li>`).join('');
    $('download-json').disabled = !drafts.some((d) => d.lat != null);
  }

  $('draft-list').addEventListener('input', (e) => {
    const li = e.target.closest('.draft');
    if (li && e.target.dataset.k) drafts[li.dataset.i][e.target.dataset.k] = e.target.value;
  });
  $('draft-list').addEventListener('click', (e) => {
    const li = e.target.closest('.draft');
    if (li && e.target.matches('[data-place]')) startPlacing(drafts[li.dataset.i]);
  });

  $('download-json').addEventListener('click', () => {
    const out = drafts.filter((d) => d.lat != null).map((d) => ({
      id: d.id,
      title: d.title || d.id,
      caption: d.caption,
      village: d.village,
      tags: [],
      lat: d.lat,
      lng: d.lng,
      date: d.date,
      photographer: d.photographer,
      license: 'CC BY-SA 4.0',
      consent: '',
      src: `photos/full/${d.id}.jpg`,
      thumb: `photos/thumbs/${d.id}.jpg`,
    }));
    const blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'new-photos.json';
    a.click();
  });

  init();
})();
