/* Kibera News: renders data/news.json (written by scraper/collect.py) with
 * filters, day grouping and configurable date/time formatting. Filters live in
 * the URL query string so any view can be shared.
 */
(function () {
  'use strict';

  const DATA_URL = 'data/news.json';
  const POLL_MS = 5 * 60 * 1000;
  const PAGE = 60;

  const CATEGORY_COLORS = {
    'Fire & Emergencies': '--c-fire',
    'Crime & Security': '--c-crime',
    'Housing & Land': '--c-housing',
    'Health': '--c-health',
    'Water & Sanitation': '--c-water',
    'Education': '--c-education',
    'Politics & Governance': '--c-politics',
    'Business & Jobs': '--c-business',
    'Sports': '--c-sports',
    'Arts & Culture': '--c-arts',
    'Infrastructure & Transport': '--c-infra',
    'Community & Development': '--c-community',
    'General': '--c-general',
  };

  const DEFAULTS = { q: '', period: '7d', from: '', to: '', cats: [], source: '', sort: 'new', tz: 'Africa/Nairobi', clock: '24', datefmt: 'long' };
  const state = { ...DEFAULTS, items: [], generatedAt: null, sources: [], shown: PAGE, newIds: new Set(), pending: null };
  const $ = (id) => document.getElementById(id);

  // ---------- Date & time formatting ----------
  function tzOpt() { return state.tz === 'local' ? undefined : state.tz; }

  function zoneLabel() {
    if (state.tz === 'Africa/Nairobi') return 'EAT';
    if (state.tz === 'UTC') return 'UTC';
    const part = new Intl.DateTimeFormat(undefined, { timeZoneName: 'short' }).formatToParts(new Date()).find((p) => p.type === 'timeZoneName');
    return part ? part.value : '';
  }

  function fmtTime(d, withSeconds) {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: tzOpt(), hour: state.clock === '12' ? 'numeric' : '2-digit', minute: '2-digit',
      second: withSeconds ? '2-digit' : undefined, hour12: state.clock === '12',
    }).format(d);
  }

  function dayKey(d) {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: tzOpt(), year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(d).map((x) => [x.type, x.value]));
    return `${p.year}-${p.month}-${p.day}`;
  }

  function fmtDate(d) {
    if (state.datefmt === 'iso') return dayKey(d);
    const opts = state.datefmt === 'short'
      ? { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }
      : { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' };
    return new Intl.DateTimeFormat('en-GB', { timeZone: tzOpt(), ...opts }).format(d);
  }

  function fmtDateTime(d) { return `${fmtDate(d)}, ${fmtTime(d)} ${zoneLabel()}`; }

  function ago(d, now = new Date()) {
    const s = Math.round((now - d) / 1000);
    if (s < 60) return 'just now';
    const m = Math.round(s / 60);
    if (m < 60) return `${m} min ago`;
    const h = Math.round(m / 60);
    if (h < 24) return `${h} hr${h === 1 ? '' : 's'} ago`;
    const days = Math.round(h / 24);
    if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`;
    const mo = Math.round(days / 30.4);
    return mo < 12 ? `${mo} month${mo === 1 ? '' : 's'} ago` : `${Math.round(mo / 12)} yr ago`;
  }

  function relDay(key, now = new Date()) {
    const today = dayKey(now);
    const yesterday = dayKey(new Date(now - 864e5));
    return key === today ? 'Today' : key === yesterday ? 'Yesterday' : '';
  }

  // Sample labels in the format dropdown always show today's date.
  function refreshFormatLabels() {
    const now = new Date();
    const saved = state.datefmt;
    $('datefmt').querySelectorAll('option').forEach((o) => { state.datefmt = o.value; o.textContent = fmtDate(now); });
    state.datefmt = saved;
    const savedClock = state.clock;
    $('clock').querySelectorAll('option').forEach((o) => {
      state.clock = o.value;
      o.textContent = `${o.value}-hour (${fmtTime(now)})`;
    });
    state.clock = savedClock;
  }

  // ---------- Clock ----------
  function tick() {
    const now = new Date();
    $('clock-date').textContent = fmtDate(now);
    $('clock-time').textContent = `${fmtTime(now, true)} ${zoneLabel()}`;
    if (state.generatedAt) {
      $('updated').textContent = `Updated ${ago(state.generatedAt, now)} · ${fmtDateTime(state.generatedAt)}`;
    } else {
      $('updated').textContent = 'Waiting for the first collection run';
    }
  }

  // ---------- URL state ----------
  function readURL() {
    const p = new URLSearchParams(location.search);
    for (const k of Object.keys(DEFAULTS)) {
      if (!p.has(k)) continue;
      state[k] = k === 'cats' ? p.get(k).split('|').filter(Boolean) : p.get(k);
    }
  }

  function writeURL() {
    const p = new URLSearchParams();
    for (const [k, def] of Object.entries(DEFAULTS)) {
      const v = k === 'cats' ? state.cats.join('|') : state[k];
      if (v !== (k === 'cats' ? '' : def)) p.set(k, v);
    }
    const qs = p.toString();
    history.replaceState(null, '', qs ? `?${qs}` : location.pathname);
  }

  // ---------- Data ----------
  async function load({ initial = false } = {}) {
    let data;
    try {
      const res = await fetch(`${DATA_URL}?t=${Date.now()}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(res.status);
      data = await res.json();
    } catch (err) {
      if (initial) $('feed').innerHTML = `<div class="empty"><h2>Couldn't load the news</h2><p>${esc(String(err))}. If you opened the file directly, serve the folder over HTTP instead.</p></div>`;
      return;
    }

    const items = (data.items || [])
      .map((it) => ({ ...it, date: new Date(it.published) }))
      .filter((it) => !isNaN(it.date));

    if (initial) {
      apply(data, items);
      return;
    }
    const known = new Set(state.items.map((i) => i.id));
    const fresh = items.filter((i) => !known.has(i.id));
    if (fresh.length) {
      state.pending = { data, items, fresh };
      $('show-new').textContent = `${fresh.length} new stor${fresh.length === 1 ? 'y' : 'ies'}: show`;
      $('new-banner').hidden = false;
    } else {
      state.generatedAt = data.generated_at ? new Date(data.generated_at) : state.generatedAt;
      state.sources = data.sources || [];
      renderSources();
      tick();
    }
  }

  function apply(data, items, fresh = []) {
    state.items = items;
    state.generatedAt = data.generated_at ? new Date(data.generated_at) : null;
    state.sources = data.sources || [];
    state.newIds = new Set(fresh.map((i) => i.id));
    buildSourceOptions();
    renderSources();
    render();
    tick();
  }

  $('show-new').addEventListener('click', () => {
    const { data, items, fresh } = state.pending;
    state.pending = null;
    $('new-banner').hidden = true;
    apply(data, items, fresh);
    window.scrollTo({ top: $('feed').offsetTop - 20, behavior: 'smooth' });
  });
  $('refresh').addEventListener('click', async (e) => {
    e.target.textContent = 'Checking…';
    await load();
    e.target.textContent = state.pending ? '↻ New stories found' : '↻ Up to date. Check again';
  });

  // ---------- Filtering ----------
  function inPeriod(it, now) {
    switch (state.period) {
      case 'today': return dayKey(it.date) === dayKey(now);
      case '24h': return now - it.date <= 864e5;
      case '7d': return now - it.date <= 7 * 864e5;
      case '30d': return now - it.date <= 30 * 864e5;
      case 'custom': {
        const k = dayKey(it.date);
        return (!state.from || k >= state.from) && (!state.to || k <= state.to);
      }
      default: return true;
    }
  }

  function matchesText(it) {
    if (!state.q) return true;
    const hay = `${it.title} ${it.summary || ''} ${it.source} ${it.category}`.toLowerCase();
    return state.q.toLowerCase().split(/\s+/).every((w) => hay.includes(w));
  }

  function filtered({ ignoreCats = false } = {}) {
    const now = new Date();
    return state.items.filter((it) =>
      inPeriod(it, now) && matchesText(it) &&
      (!state.source || it.source === state.source) &&
      (ignoreCats || !state.cats.length || state.cats.includes(it.category)));
  }

  // ---------- Rendering ----------
  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function color(cat) { return `var(${CATEGORY_COLORS[cat] || '--c-general'})`; }
  function safeUrl(u) { return /^https?:\/\//i.test(u) ? u : '#'; }

  function render() {
    writeURL();
    syncControls();
    renderCats();
    renderStats();

    const list = filtered().sort((a, b) => state.sort === 'old' ? a.date - b.date : b.date - a.date);
    const n = list.length;
    $('result-count').textContent = state.items.length ? `${n} stor${n === 1 ? 'y' : 'ies'} match${n === 1 ? 'es' : ''} your filters` : '';
    const active = activeFilterCount();
    $('active-count').textContent = active ? `(${active} active)` : '';

    const feed = $('feed');
    if (!state.items.length) {
      feed.innerHTML = '<div class="empty"><h2>No stories yet</h2><p>The collector runs every 3 hours. Stories will appear here after its first run.</p></div>';
      return;
    }
    if (!n) {
      feed.innerHTML = '<div class="empty"><h2>Nothing matches</h2><p>Try a longer period, or clear the search or topic filters.</p><button class="btn-link" type="button" data-reset>Reset filters</button></div>';
      return;
    }

    const now = new Date();
    const groups = [];
    for (const it of list.slice(0, state.shown)) {
      const k = dayKey(it.date);
      if (!groups.length || groups[groups.length - 1].key !== k) groups.push({ key: k, date: it.date, items: [] });
      groups[groups.length - 1].items.push(it);
    }
    const zone = zoneLabel();

    feed.innerHTML = groups.map((g) => {
      const rel = relDay(g.key, now);
      const count = list.filter((i) => dayKey(i.date) === g.key).length;
      return `
      <section class="day" aria-label="${esc(fmtDate(g.date))}">
        <h2 class="day-head">${rel ? `<span class="rel">${rel}</span> ` : ''}${esc(fmtDate(g.date))}
          <small>${count} stor${count === 1 ? 'y' : 'ies'}</small></h2>
        ${g.items.map((it) => `
          <article class="story${state.newIds.has(it.id) ? ' is-new' : ''}">
            <div class="when">
              <time datetime="${esc(it.published)}" title="${esc(fmtDateTime(it.date))}">${esc(fmtTime(it.date))} <span class="zone">${esc(zone)}</span></time>
              <span class="ago">${esc(ago(it.date, now))}</span>
              ${it.date_estimated ? '<span class="est">time approximate</span>' : ''}
            </div>
            <div>
              <div class="meta">
                <button type="button" class="pill" style="background:${color(it.category)}" data-cat="${esc(it.category)}" title="Show only ${esc(it.category)}">${esc(it.category)}</button>
              </div>
              <h3><a href="${esc(safeUrl(it.url))}" target="_blank" rel="noopener noreferrer">${esc(it.title)}</a></h3>
              ${it.summary ? `<p class="summary">${esc(it.summary)}</p>` : ''}
              <div class="meta">
                <span class="source">${esc(it.source)}</span>
                ${it.via && it.via !== it.source ? `<span>via ${esc(it.via)}</span>` : ''}
              </div>
            </div>
          </article>`).join('')}
      </section>`;
    }).join('') + (n > state.shown ? `<button class="more" type="button" data-more>Show more (${n - state.shown} left)</button>` : '');
  }

  function renderStats() {
    const now = new Date();
    const today = dayKey(now);
    const t = state.items.filter((i) => dayKey(i.date) === today).length;
    const w = state.items.filter((i) => now - i.date <= 7 * 864e5).length;
    $('stats').innerHTML = `
      <div class="stat"><b>${t}</b><span>stories today</span></div>
      <div class="stat"><b>${w}</b><span>in the last 7 days</span></div>
      <div class="stat"><b>${state.items.length}</b><span>in the archive</span></div>`;
  }

  function renderCats() {
    const counts = {};
    filtered({ ignoreCats: true }).forEach((i) => { counts[i.category] = (counts[i.category] || 0) + 1; });
    const cats = Object.keys(CATEGORY_COLORS).filter((c) => counts[c] || state.cats.includes(c) || state.items.some((i) => i.category === c));
    $('cats').innerHTML = cats.length ? cats.map((c) => `
      <label class="cat${counts[c] ? '' : ' is-empty'}">
        <input type="checkbox" value="${esc(c)}"${state.cats.includes(c) ? ' checked' : ''}>
        <span class="dot" style="background:${color(c)}"></span>${esc(c)}
        <span class="n">${counts[c] || 0}</span>
      </label>`).join('') : '<p class="result-count">Topics appear once stories arrive.</p>';
  }

  function buildSourceOptions() {
    const counts = {};
    state.items.forEach((i) => { counts[i.source] = (counts[i.source] || 0) + 1; });
    const names = Object.keys(counts).sort((a, b) => counts[b] - counts[a] || a.localeCompare(b));
    $('source').innerHTML = '<option value="">All sources</option>' +
      names.map((s) => `<option value="${esc(s)}">${esc(s)} (${counts[s]})</option>`).join('');
    $('source').value = state.source;
  }

  function renderSources() {
    $('source-status').innerHTML = state.sources.length
      ? state.sources.map((s) => `<li><span class="${s.ok ? 'ok' : 'err'}">${s.ok ? '●' : '✕'}</span> ${esc(s.name)}: ${s.ok ? `${s.found} found` : esc(s.error || 'failed')}</li>`).join('')
      : '<li>No collection run yet.</li>';
  }

  function syncControls() {
    $('q').value = state.q;
    $('period').querySelectorAll('button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.v === state.period)));
    $('range').hidden = state.period !== 'custom';
    $('from').value = state.from;
    $('to').value = state.to;
    $('sort').value = state.sort;
    $('tz').value = state.tz;
    $('clock').value = state.clock;
    $('datefmt').value = state.datefmt;
    if ([...$('source').options].some((o) => o.value === state.source)) $('source').value = state.source;
  }

  function activeFilterCount() {
    return [state.q, state.period !== DEFAULTS.period, state.cats.length, state.source].filter(Boolean).length;
  }

  // ---------- Events ----------
  function update(patch) {
    Object.assign(state, patch, { shown: PAGE });
    render();
  }

  let qTimer;
  $('q').addEventListener('input', (e) => { clearTimeout(qTimer); qTimer = setTimeout(() => update({ q: e.target.value.trim() }), 150); });
  $('period').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) update({ period: b.dataset.v }); });
  $('from').addEventListener('change', (e) => update({ from: e.target.value }));
  $('to').addEventListener('change', (e) => update({ to: e.target.value }));
  $('cats').addEventListener('change', () => update({ cats: [...$('cats').querySelectorAll('input:checked')].map((i) => i.value) }));
  $('source').addEventListener('change', (e) => update({ source: e.target.value }));
  $('sort').addEventListener('change', (e) => update({ sort: e.target.value }));
  ['tz', 'clock', 'datefmt'].forEach((k) => $(k).addEventListener('change', (e) => {
    update({ [k]: e.target.value });
    refreshFormatLabels();
    tick();
  }));
  function reset() { update({ q: '', period: DEFAULTS.period, from: '', to: '', cats: [], source: '', sort: 'new' }); }
  $('reset').addEventListener('click', reset);
  $('feed').addEventListener('click', (e) => {
    if (e.target.matches('[data-reset]')) reset();
    if (e.target.matches('[data-more]')) { state.shown += PAGE; render(); }
    const pill = e.target.closest('[data-cat]');
    if (pill) update({ cats: [pill.dataset.cat] });
  });
  $('filters-toggle').addEventListener('click', (e) => {
    const open = e.currentTarget.parentElement.classList.toggle('is-open');
    e.currentTarget.setAttribute('aria-expanded', String(open));
  });

  // ---------- Start ----------
  readURL();
  syncControls();
  refreshFormatLabels();
  tick();
  setInterval(tick, 1000);
  load({ initial: true });
  setInterval(load, POLL_MS);
  // Keep "x min ago" labels fresh without refetching.
  setInterval(() => { if (state.items.length) render(); }, 60 * 1000);
})();
