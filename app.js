'use strict';

// Modèles disponibles via l'API gratuite Open-Meteo (même liste que l'app iPhone).
const MODELS = [
  { id: 'meteofrance_arome_france_hd', name: 'AROME HD', short: 'AR. HD', color: '#0073d9', info: 'Météo-France · maille 1,5 km · ~2 jours · France' },
  { id: 'meteofrance_arome_france', name: 'AROME', short: 'AROME', color: '#4db3f2', info: 'Météo-France · maille 2,5 km · ~2 jours · France' },
  { id: 'meteofrance_arpege_europe', name: 'ARPEGE', short: 'ARPÈGE', color: '#8c59d9', info: 'Météo-France · maille 11 km · ~4 jours · Europe' },
  { id: 'icon_seamless', name: 'ICON', short: 'ICON', color: '#f28c1a', info: 'DWD (Allemagne) · 2 à 13 km · ~7 jours' },
  { id: 'ecmwf_ifs025', name: 'ECMWF', short: 'ECMWF', color: '#1aa666', info: 'Centre européen · 25 km · 7 jours et plus' },
  { id: 'gfs_seamless', name: 'GFS', short: 'GFS', color: '#d9404d', info: 'NOAA (USA) · 13 à 25 km · 7 jours et plus' },
];
const FALLBACK_MODEL = 'ecmwf_ifs025';
const modelById = id => MODELS.find(m => m.id === id) || MODELS[0];

const $ = (sel, el = document) => el.querySelector(sel);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const view = $('#view');

// ---------- Stockage local (les spots restent sur le téléphone) ----------

const store = {
  get spots() {
    try { return JSON.parse(localStorage.getItem('spots.v1')) || []; } catch { return []; }
  },
  set spots(value) {
    try { localStorage.setItem('spots.v1', JSON.stringify(value)); } catch { /* stockage indisponible */ }
    scheduleSpotSync();
  },
  get view() {
    try { return localStorage.getItem('view.v2') === 'compare' ? 'compare' : 'detail'; } catch { return 'detail'; }
  },
  set view(v) {
    try { localStorage.setItem('view.v2', v); } catch { /* ignore */ }
  },
  get theme() {
    try { const t = localStorage.getItem('theme'); return t === 'light' || t === 'dark' ? t : 'auto'; } catch { return 'auto'; }
  },
  set theme(t) {
    try { localStorage.setItem('theme', t); } catch { /* ignore */ }
  },
  get alertCode() {
    try { return localStorage.getItem('alertCode') || ''; } catch { return ''; }
  },
  set alertCode(code) {
    try { localStorage.setItem('alertCode', code); } catch { /* ignore */ }
  },
  get lastSync() {
    try { return Number(localStorage.getItem('alertSync')) || 0; } catch { return 0; }
  },
  set lastSync(time) {
    try { localStorage.setItem('alertSync', String(time)); } catch { /* ignore */ }
  },
  get model() {
    let id;
    try { id = localStorage.getItem('model'); } catch { /* ignore */ }
    return MODELS.some(m => m.id === id) ? id : MODELS[0].id;
  },
  set model(id) {
    try { localStorage.setItem('model', id); } catch { /* ignore */ }
  },
};

// ---------- Alertes vent : envoi de la liste des spots ----------
// Les alertes tournent chaque soir sur GitHub. Pour savoir quels spots surveiller, l'app publie
// sa liste sur le sujet ntfy privé « <code>-spots » à chaque changement et à chaque ouverture.

const ALERT_CODE_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
let syncTimer = null;

function scheduleSpotSync() {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => { syncSpots().catch(() => { /* réessai à la prochaine ouverture */ }); }, 1000);
}

async function syncSpots() {
  const code = store.alertCode;
  if (!ALERT_CODE_PATTERN.test(code)) return false;
  const spots = store.spots.map(s => ({ nom: s.name, lat: Math.round(s.lat * 1e4) / 1e4, lon: Math.round(s.lon * 1e4) / 1e4 }));
  const res = await fetch('https://ntfy.sh/', {
    method: 'POST',
    body: JSON.stringify({ topic: `${code}-spots`, message: JSON.stringify({ v: 1, spots }) }),
  });
  if (!res.ok) throw new Error(`Envoi impossible (${res.status})`);
  store.lastSync = Date.now();
  return true;
}

// ---------- API Open-Meteo ----------

async function getJSON(url) {
  const res = await fetch(url);
  const json = await res.json().catch(() => null);
  if (!res.ok || !json) throw new Error((json && json.reason) || `Erreur réseau (${res.status})`);
  return json;
}

const forecastCache = new Map();

async function fetchForecast(spot, models = MODELS.map(m => m.id)) {
  const key = `${spot.lat},${spot.lon}|${models.join(',')}`;
  const hit = forecastCache.get(key);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.data;

  const common = { latitude: spot.lat, longitude: spot.lon, timeformat: 'unixtime', forecast_days: '7' };
  const windURL = 'https://api.open-meteo.com/v1/forecast?' + new URLSearchParams({
    ...common,
    hourly: 'wind_speed_10m,wind_gusts_10m,wind_direction_10m,temperature_2m,precipitation',
    models: models.join(','),
    wind_speed_unit: 'kn',
    timezone: 'auto',
  });
  const wavesURL = 'https://marine-api.open-meteo.com/v1/marine?' + new URLSearchParams({ ...common, hourly: 'wave_height' });

  // Les vagues sont un bonus : un spot à terre ne doit pas bloquer le vent.
  const [wind, marine] = await Promise.all([getJSON(windURL), getJSON(wavesURL).catch(() => null)]);

  const h = wind.hourly;
  // Avec plusieurs modèles, l'API suffixe chaque variable : "wind_speed_10m_ecmwf_ifs025".
  const values = (variable, model) => h[`${variable}_${model}`] || (models.length === 1 ? h[variable] : null) || [];

  const series = {};
  for (const model of models) {
    const speed = values('wind_speed_10m', model);
    const gusts = values('wind_gusts_10m', model);
    const dir = values('wind_direction_10m', model);
    const temp = values('temperature_2m', model);
    const rain = values('precipitation', model);
    series[model] = h.time
      .map((time, i) => speed[i] == null ? null : { time, speed: speed[i], gusts: gusts[i], dir: dir[i], temp: temp[i], rain: rain[i] })
      .filter(Boolean);
  }

  const waves = {};
  if (marine && marine.hourly) {
    marine.hourly.time.forEach((t, i) => {
      const height = marine.hourly.wave_height[i];
      if (height != null) waves[t] = height;
    });
  }

  const data = { series, waves, tz: wind.timezone, fetchedAt: Date.now() };
  forecastCache.set(key, { at: Date.now(), data });
  return data;
}

const hasData = (forecast, model) => (forecast.series[model] || []).length > 0;

function currentPoint(points) {
  if (!points || !points.length) return null;
  const now = Date.now() / 1000;
  let best = points[0];
  for (const p of points) if (p.time <= now) best = p;
  return best;
}

// ---------- Mise en forme ----------

function windColor(kn) {
  if (kn < 5) return '#b3d9fa';
  if (kn < 10) return '#66ccd9';
  if (kn < 15) return '#59c766';
  if (kn < 20) return '#fad940';
  if (kn < 25) return '#fa9933';
  if (kn < 30) return '#e64040';
  if (kn < 35) return '#bf268c';
  return '#731a8c';
}
const windText = kn => (kn >= 25 ? '#fff' : '#000');

// Rafales : même échelle que le vent moyen, en couleurs vives.
function gustColor(kn) {
  if (kn < 5) return '#1e6fd9';
  if (kn < 10) return '#0096c7';
  if (kn < 15) return '#1faa4a';
  if (kn < 20) return '#f2c200';
  if (kn < 25) return '#f57c00';
  if (kn < 30) return '#e02424';
  if (kn < 35) return '#c2185b';
  if (kn < 40) return '#8e24aa';
  return '#4a148c';
}
const gustText = kn => (kn >= 15 && kn < 25 ? '#000' : '#fff');

function cardinal(deg) {
  const dirs = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSO', 'SO', 'OSO', 'O', 'ONO', 'NO', 'NNO'];
  return dirs[((Math.round(deg / 22.5) % 16) + 16) % 16];
}

// Flèche dans le sens où souffle le vent (la direction météo indique d'où il vient).
const arrow = deg => deg == null ? '' :
  `<svg class="arrow" viewBox="0 0 24 24" style="transform:rotate(${deg + 180}deg)" aria-hidden="true"><path d="M12 2 19 21 12 16.5 5 21Z" fill="currentColor"/></svg>`;

function badge(p) {
  const gusts = p.gusts != null ? `<small>raf. ${Math.round(p.gusts)}</small>` : '';
  return `<span class="badge" style="background:${windColor(p.speed)};color:${windText(p.speed)}">${arrow(p.dir)}<span><b>${Math.round(p.speed)} kn</b>${gusts}</span></span>`;
}

const formatters = new Map();
function fmt(tz, opts) {
  const key = tz + JSON.stringify(opts);
  if (!formatters.has(key)) {
    let f;
    try { f = new Intl.DateTimeFormat('fr-FR', { timeZone: tz, ...opts }); } catch { f = new Intl.DateTimeFormat('fr-FR', opts); }
    formatters.set(key, f);
  }
  return formatters.get(key);
}
const hourOf = (unix, tz) => Number(fmt(tz, { hour: 'numeric', hourCycle: 'h23' }).formatToParts(unix * 1000).find(p => p.type === 'hour').value);
const dayKey = (unix, tz) => fmt(tz, { year: 'numeric', month: '2-digit', day: '2-digit' }).format(unix * 1000);
const dayTitle = (unix, tz) => {
  const s = fmt(tz, { weekday: 'long', day: 'numeric', month: 'long' }).format(unix * 1000);
  return s.charAt(0).toUpperCase() + s.slice(1);
};
const coordText = s => `${s.lat.toFixed(3)}°, ${s.lon.toFixed(3)}°`;

// ---------- Navigation ----------

let cleanup = [];
let renderToken = 0;

function teardown() {
  renderToken++;
  cleanup.forEach(fn => { try { fn(); } catch { /* ignore */ } });
  cleanup = [];
  window.scrollTo(0, 0);
}

function setHeader({ title, left, extra, right }) {
  $('#title').textContent = title;
  for (const [el, cfg] of [[$('#left'), left], [$('#extra'), extra], [$('#right'), right]]) {
    el.hidden = !cfg;
    el.className = 'hbtn' + (cfg && cfg.big ? ' big' : '') + (cfg && cfg.cls ? ' ' + cfg.cls : '');
    if (!cfg) continue;
    el.textContent = cfg.label;
    el.setAttribute('aria-label', cfg.aria || cfg.label);
    el.disabled = !!cfg.disabled;
    el.onclick = cfg.onClick;
  }
}

function route() {
  const path = location.hash.slice(1) || '/';
  if (path.startsWith('/spot/')) renderDetail(decodeURIComponent(path.slice(6)));
  else if (path === '/add') renderAdd();
  else if (path === '/alertes') renderAlerts();
  else if (path === '/reglages') renderSettings();
  else renderList();
}
window.addEventListener('hashchange', route);

// ---------- Liste des spots ----------

let editing = false;

function renderList() {
  teardown();
  const spots = store.spots;
  if (!spots.length) editing = false;

  setHeader({
    title: 'Mes spots',
    left: spots.length ? { label: editing ? 'OK' : 'Modifier', onClick: () => { editing = !editing; renderList(); } } : null,
    extra: { label: '⚙︎', aria: 'Paramètres', cls: 'gear', onClick: () => { location.hash = '#/reglages'; } },
    right: { label: '+', aria: 'Ajouter un spot', big: true, onClick: () => { location.hash = '#/add'; } },
  });

  if (!spots.length) {
    view.innerHTML = `
      <div class="empty">
        <div class="boat">⛵</div>
        <h2>Aucun spot</h2>
        <p>Ajoute tes spots de navigation préférés pour suivre le vent heure par heure.</p>
        <a class="btn" href="#/add">Ajouter un spot</a>
      </div>
      ${alertsLink()}`;
    return;
  }

  view.innerHTML = `
    <ul class="list">
      ${spots.map((s, i) => {
        const inner = `
          <div><div class="name">${esc(s.name)}</div><div class="sub" data-sub>${coordText(s)}</div></div>
          <div data-badge>${editing ? '' : '<span class="spinner"></span>'}</div>`;
        return `
          <li class="row" data-id="${esc(s.id)}">
            ${editing ? '<button class="del" data-act="del" aria-label="Supprimer">−</button>' : ''}
            ${editing
              ? `<button class="row-main rename" data-act="rename" aria-label="Renommer ${esc(s.name)}">
                   <div><div class="name">${esc(s.name)} <span class="pencil">✏️</span></div><div class="sub">Touche pour renommer</div></div>
                 </button>`
              : `<a class="row-main" href="#/spot/${encodeURIComponent(s.id)}">${inner}</a>`}
            ${editing ? '<span class="grip" aria-label="Faire glisser pour déplacer">≡</span>' : ''}
          </li>`;
      }).join('')}
    </ul>
    ${alertsLink()}
    <p class="foot">Données <a href="https://open-meteo.com" target="_blank" rel="noopener">Open-Meteo</a> · Météo-France, DWD, ECMWF, NOAA</p>`;

  view.querySelectorAll('[data-act]').forEach(btn => {
    btn.onclick = () => {
      const id = btn.closest('.row').dataset.id;
      const list = store.spots;
      const i = list.findIndex(s => s.id === id);
      if (i < 0) return;
      if (btn.dataset.act === 'del') {
        if (!confirm(`Supprimer « ${list[i].name} » ?`)) return;
        list.splice(i, 1);
      } else if (btn.dataset.act === 'rename') {
        const name = (prompt('Nouveau nom du spot', list[i].name) || '').trim().slice(0, 60);
        if (!name || name === list[i].name) return;
        list[i].name = name;
      }
      store.spots = list;
      renderList();
    };
  });

  if (editing) enableDragSort($('.list', view));

  if (!editing) {
    view.querySelectorAll('.row').forEach(row => {
      const spot = spots.find(s => s.id === row.dataset.id);
      if (spot) loadBadge(spot, row);
    });
  }
}

// Réorganiser les spots en les faisant glisser par leur poignée ≡ (doigt ou souris).
function enableDragSort(list) {
  list.querySelectorAll('.grip').forEach(grip => {
    grip.addEventListener('pointerdown', e => {
      e.preventDefault();
      const row = grip.closest('.row');
      const rows = [...list.children];
      const from = rows.indexOf(row);
      const rects = rows.map(r => r.getBoundingClientRect());
      const height = rects[from].height;
      const startY = e.clientY;
      let to = from;

      grip.setPointerCapture(e.pointerId);
      row.classList.add('dragging');
      rows.forEach(r => { if (r !== row) r.classList.add('shifting'); });

      const onMove = ev => {
        const dy = Math.max(rects[0].top - rects[from].top, Math.min(rects[rects.length - 1].top - rects[from].top, ev.clientY - startY));
        row.style.transform = `translateY(${dy}px)`;
        const center = rects[from].top + height / 2 + dy;
        // Nouvelle place = nombre d'autres spots dont le milieu est au-dessus du spot déplacé
        to = rects.filter((r, k) => k !== from && r.top + r.height / 2 < center).length;
        rows.forEach((r, k) => {
          if (k === from) return;
          let shift = 0;
          if (from < to && k > from && k <= to) shift = -height;
          if (from > to && k >= to && k < from) shift = height;
          r.style.transform = shift ? `translateY(${shift}px)` : '';
        });
      };

      const onEnd = () => {
        grip.removeEventListener('pointermove', onMove);
        grip.removeEventListener('pointerup', onEnd);
        grip.removeEventListener('pointercancel', onEnd);
        if (to !== from) {
          const spots = store.spots;
          const [moved] = spots.splice(from, 1);
          spots.splice(to, 0, moved);
          store.spots = spots;
        }
        renderList();
      };

      grip.addEventListener('pointermove', onMove);
      grip.addEventListener('pointerup', onEnd);
      grip.addEventListener('pointercancel', onEnd);
    });
  });
}

function alertsLink() {
  const on = ALERT_CODE_PATTERN.test(store.alertCode);
  return `
    <ul class="list alerts-link">
      <li class="row"><a class="row-main" href="#/alertes">
        <div><div class="name">🔔 Alertes vent</div><div class="sub">${on ? 'Activées pour tous tes spots' : 'Être prévenu la veille quand il y a du vent'}</div></div>
        <span class="chevron">›</span>
      </a></li>
    </ul>`;
}

async function loadBadge(spot, row) {
  const preferred = store.model;
  // ECMWF sert de repli si le modèle préféré ne couvre pas le spot.
  const models = preferred === FALLBACK_MODEL ? [preferred] : [preferred, FALLBACK_MODEL];
  const slot = $('[data-badge]', row);
  try {
    const forecast = await fetchForecast(spot, models);
    if (!row.isConnected) return;
    const model = models.find(m => hasData(forecast, m));
    const point = model && currentPoint(forecast.series[model]);
    slot.innerHTML = point ? badge(point) : '<span class="muted">—</span>';
    if (model) $('[data-sub]', row).textContent = `${modelById(model).name} · maintenant`;
  } catch {
    if (row.isConnected) slot.innerHTML = '<span class="muted">hors ligne</span>';
  }
}

// ---------- Ajout d'un spot ----------

function renderAdd() {
  teardown();
  let pin = null;

  const save = () => {
    const name = $('#name').value.trim();
    if (!pin || !name) return;
    const id = (crypto.randomUUID && crypto.randomUUID()) || String(Date.now());
    store.spots = [...store.spots, { id, name, lat: pin.lat, lon: pin.lon }];
    location.hash = '#/';
  };

  setHeader({
    title: 'Nouveau spot',
    left: { label: 'Annuler', onClick: () => { location.hash = '#/'; } },
    right: { label: 'Ajouter', onClick: save, disabled: true },
  });

  view.innerHTML = `
    <input id="q" type="search" placeholder="Rechercher un lieu" autocomplete="off" enterkeyhint="search">
    <ul id="results" class="list results" hidden></ul>
    <div id="map" class="map"><div class="map-hint">Touche la carte pour placer le spot</div></div>
    <div class="card">
      <label class="field"><span>Nom du spot</span><input id="name" placeholder="Ex. : Baie de La Baule" maxlength="60" autocomplete="off"></label>
      <p id="pos" class="muted">Recherche un lieu ou touche la carte pour placer le spot, idéalement sur l'eau.</p>
    </div>`;

  const update = () => { $('#right').disabled = !(pin && $('#name').value.trim()); };
  $('#name').addEventListener('input', update);

  let marker = null;
  let map = null;
  const setPin = (lat, lon) => {
    pin = { lat, lon };
    if (map) {
      if (marker) marker.setLatLng([lat, lon]);
      else marker = L.marker([lat, lon], { icon: L.divIcon({ className: 'pin', html: '⛵', iconSize: [32, 32], iconAnchor: [16, 30] }) }).addTo(map);
    }
    $('#pos').textContent = `Position : ${lat.toFixed(4)}°, ${lon.toFixed(4)}°`;
    update();
  };

  if (window.L) {
    map = L.map('map', { attributionControl: true }).setView([46.6, 1.9], 5);
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      maxZoom: 18,
      attribution: 'Imagerie © Esri',
    }).addTo(map);
    map.on('click', e => setPin(e.latlng.lat, e.latlng.lng));
    cleanup.push(() => map.remove());
  } else {
    $('#map').innerHTML = '<p class="error">Carte indisponible hors connexion.</p>';
  }

  // Recherche de lieux (géocodage Open-Meteo)
  const results = $('#results');
  let timer = null;
  let seq = 0;
  $('#q').addEventListener('input', () => {
    clearTimeout(timer);
    const q = $('#q').value.trim();
    if (q.length < 2) { results.hidden = true; return; }
    timer = setTimeout(async () => {
      const mine = ++seq;
      try {
        const json = await getJSON('https://geocoding-api.open-meteo.com/v1/search?' + new URLSearchParams({ name: q, count: '8', language: 'fr' }));
        if (mine !== seq || !results.isConnected) return;
        const places = json.results || [];
        results.hidden = false;
        results.innerHTML = places.length
          ? places.map((p, i) => `<li><button data-i="${i}"><div>${esc(p.name)}</div><div class="sub">${esc([p.admin1, p.country].filter(Boolean).join(', '))}</div></button></li>`).join('')
          : '<li><button disabled><span class="muted">Aucun résultat</span></button></li>';
        results.querySelectorAll('button[data-i]').forEach(btn => {
          btn.onclick = () => {
            const p = places[Number(btn.dataset.i)];
            if (!$('#name').value.trim()) $('#name').value = p.name;
            setPin(p.latitude, p.longitude);
            if (map) map.setView([p.latitude, p.longitude], 12);
            results.hidden = true;
            $('#q').value = '';
            $('#q').blur();
          };
        });
      } catch {
        /* réseau indisponible : on laisse la carte */
      }
    }, 350);
  });
  cleanup.push(() => clearTimeout(timer));
}

// ---------- Paramètres ----------

function applyTheme() {
  const t = store.theme;
  if (t === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
}

function renderSettings() {
  teardown();
  setHeader({ title: 'Paramètres', left: { label: '‹ Spots', onClick: () => { location.hash = '#/'; } } });

  const draw = () => {
    const model = store.model;
    const theme = store.theme;
    const systemDark = window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches;
    const isDark = theme === 'dark' || (theme === 'auto' && systemDark);
    const option = (attrs, dot, title, sub, on) => `
      <li><button class="option" ${attrs}>
        ${dot ? `<span class="dot" style="background:${dot}"></span>` : ''}
        <span class="txt"><span>${title}</span>${sub ? `<span class="sub muted">${sub}</span>` : ''}</span>
        <span class="check">${on ? '✓' : ''}</span>
      </button></li>`;

    view.innerHTML = `
      <div class="card">
        <div class="card-title">Modèle météo de référence</div>
        <ul class="settings-list">
          ${MODELS.map(m => option(`data-model="${m.id}"`, m.color, esc(m.name), esc(m.info), m.id === model)).join('')}
        </ul>
        <p class="muted">Utilisé pour le vent affiché dans ta liste de spots et ouvert en premier dans le détail d'un spot. S'il ne couvre pas un spot (AROME hors de France), ECMWF est utilisé à la place.</p>
      </div>
      <div class="card">
        <div class="card-title">Apparence</div>
        <ul class="settings-list">
          <li><label class="switch-row">
            <span class="txt"><span>Automatique</span><span class="sub muted">Suit le réglage clair / sombre de ton iPhone</span></span>
            <input type="checkbox" class="switch" id="theme-auto" ${theme === 'auto' ? 'checked' : ''}>
          </label></li>
          <li><label class="switch-row${theme === 'auto' ? ' disabled' : ''}">
            <span class="txt"><span>Mode sombre</span></span>
            <input type="checkbox" class="switch" id="theme-dark" ${isDark ? 'checked' : ''} ${theme === 'auto' ? 'disabled' : ''}>
          </label></li>
        </ul>
      </div>
      <p class="foot">VoileMétéo · données <a href="https://open-meteo.com" target="_blank" rel="noopener">Open-Meteo</a> (Météo-France, DWD, ECMWF, NOAA)</p>`;

    view.querySelectorAll('[data-model]').forEach(btn => {
      btn.onclick = () => { store.model = btn.dataset.model; draw(); };
    });
    $('#theme-auto').onchange = e => {
      // En désactivant « Automatique », on garde l'apparence actuelle.
      store.theme = e.target.checked ? 'auto' : (isDark ? 'dark' : 'light');
      applyTheme();
      draw();
    };
    $('#theme-dark').onchange = e => {
      store.theme = e.target.checked ? 'dark' : 'light';
      applyTheme();
      draw();
    };
  };
  draw();
}

// ---------- Réglage des alertes ----------

function renderAlerts() {
  teardown();
  setHeader({ title: 'Alertes vent', left: { label: '‹ Spots', onClick: () => { location.hash = '#/'; } } });

  const spots = store.spots;
  view.innerHTML = `
    <div class="card">
      <p>Chaque soir à 18 h, tu reçois une notification dans l'app <b>ntfy</b> si demain il y a entre <b>15 et 30 nœuds</b> pendant la journée sur un de tes spots.</p>
      <label class="field"><span>Code d'alerte (le même que dans l'app ntfy)</span>
        <input id="code" value="${esc(store.alertCode)}" placeholder="voilemeteo-…" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false">
      </label>
      <button class="btn" id="save">Enregistrer</button>
      <p id="status" class="muted"></p>
    </div>
    <div class="card">
      <div class="card-title">Spots surveillés</div>
      ${spots.length ? spots.map(s => `<div>⛵ ${esc(s.name)}</div>`).join('') : '<p class="muted">Aucun spot pour l\'instant : ajoute des spots dans ta liste.</p>'}
      <p class="muted">Tous tes spots sont surveillés automatiquement. Un spot ajouté ou supprimé est pris en compte dans les 3 heures.</p>
    </div>`;

  const status = $('#status');
  const showStatus = () => {
    if (!ALERT_CODE_PATTERN.test(store.alertCode)) { status.textContent = 'Alertes pas encore activées.'; return; }
    const last = store.lastSync;
    status.textContent = last
      ? `✅ Alertes activées · liste envoyée à ${new Date(last).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`
      : '⏳ Alertes activées · liste pas encore envoyée';
  };
  showStatus();

  $('#save').onclick = async () => {
    const code = $('#code').value.trim();
    if (!ALERT_CODE_PATTERN.test(code)) {
      status.textContent = '❌ Code invalide : recopie exactement le code de l\'app ntfy.';
      return;
    }
    store.alertCode = code;
    status.textContent = 'Envoi de ta liste de spots…';
    try {
      await syncSpots();
      showStatus();
    } catch {
      status.textContent = '⚠️ Code enregistré, mais la liste n\'a pas pu être envoyée (réseau ?). Nouvel essai à la prochaine ouverture.';
    }
  };
}

// ---------- Détail d'un spot ----------

async function renderDetail(id) {
  teardown();
  const token = renderToken;
  const spot = store.spots.find(s => s.id === id);
  if (!spot) { location.hash = '#/'; return; }

  setHeader({
    title: spot.name,
    left: { label: '‹ Spots', onClick: () => { location.hash = '#/'; } },
    right: { label: '↻', aria: 'Actualiser', big: true, onClick: () => { forecastCache.clear(); renderDetail(id); } },
  });

  view.innerHTML = `
    <div class="seg" id="seg">
      <button data-view="detail">Détail par modèle</button>
      <button data-view="compare">Comparer les modèles</button>
    </div>
    <div id="body"><div class="loading"><span class="spinner"></span> Chargement des modèles…</div></div>`;

  let forecast;
  try {
    forecast = await fetchForecast(spot);
  } catch (e) {
    if (token !== renderToken) return;
    $('#body').innerHTML = `<div class="error"><p>Prévisions indisponibles.<br>${esc(e.message)}</p><button class="btn" id="retry">Réessayer</button></div>`;
    $('#retry').onclick = () => renderDetail(id);
    return;
  }
  if (token !== renderToken) return;

  const footer = `<p class="foot">Données <a href="https://open-meteo.com" target="_blank" rel="noopener">Open-Meteo</a> · mises à jour à ${new Date(forecast.fetchedAt).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}</p>`;

  const draw = () => {
    const mode = store.view;
    $('#seg').querySelectorAll('button').forEach(btn => {
      btn.classList.toggle('on', btn.dataset.view === mode);
      btn.onclick = () => { store.view = btn.dataset.view; draw(); };
    });
    $('#body').innerHTML = (mode === 'detail' ? detailView(forecast, draw) : compareView(forecast)) + footer;
    // Toucher ✓ ~ ! affiche l'écart entre les modèles à cette heure.
    $('#body').onclick = e => {
      const sign = e.target.closest('.agree[data-label]');
      if (sign && sign.dataset.label) alert(sign.dataset.label);
    };
    if (mode === 'detail') {
      $('#chips').querySelectorAll('.chip').forEach(btn => {
        btn.onclick = () => { store.model = btn.dataset.model; draw(); };
      });
      const current = $('#chips .chip.on');
      if (current) $('#chips').scrollLeft = current.offsetLeft - ($('#chips').clientWidth - current.offsetWidth) / 2;
    }
  };

  draw();
}

// Regroupe des instants (unix) par jour, dans le fuseau du spot.
function groupByDay(times, tz) {
  const days = [];
  for (const t of times) {
    const key = dayKey(t, tz);
    if (!days.length || days[days.length - 1].key !== key) days.push({ key, time: t, times: [] });
    days[days.length - 1].times.push(t);
  }
  return days;
}

// Accord entre modèles : dispersion (écart type) du vent moyen prévu à une même heure.
function agreement(speeds) {
  if (speeds.length < 2) return { sign: '', emoji: '', cls: '', label: '' };
  const mean = speeds.reduce((a, b) => a + b, 0) / speeds.length;
  const sd = Math.sqrt(speeds.reduce((a, v) => a + (v - mean) ** 2, 0) / speeds.length);
  const range = `${Math.round(Math.min(...speeds))} à ${Math.round(Math.max(...speeds))} nœuds selon les modèles`;
  if (sd <= 3) return { sign: '✓', emoji: '🟢', cls: 'ok', label: `Fiable, modèles d'accord : ${range}` };
  if (sd <= 5) return { sign: '~', emoji: '🟠', cls: 'mid', label: `Moyennement fiable, modèles à peu près d'accord : ${range}` };
  return { sign: '!', emoji: '🔴', cls: 'bad', label: `Peu fiable, modèles en désaccord : ${range}` };
}

const FIRST_HOUR = 6;
const LAST_HOUR = 22;

function compareView(forecast) {
  const tz = forecast.tz;
  const models = MODELS.filter(m => hasData(forecast, m.id));
  if (!models.length) return '<div class="card error">Aucune prévision disponible pour ce spot.</div>';

  const byTime = models.map(m => new Map(forecast.series[m.id].map(p => [p.time, p])));
  const since = Date.now() / 1000 - 3600;
  const times = [...new Set(models.flatMap(m => forecast.series[m.id].map(p => p.time)))]
    .filter(t => t >= since)
    .filter(t => { const h = hourOf(t, tz); return h >= FIRST_HOUR && h <= LAST_HOUR; })
    .sort((a, b) => a - b);

  const cols = `grid-template-columns:34px repeat(${models.length}, minmax(0, 1fr)) 18px`;
  const header = `
    <div class="chead" style="${cols}">
      <span></span>
      ${models.map(m => `<span style="color:${m.color}">${m.short}</span>`).join('')}
      <span title="Accord des modèles">⚖︎</span>
    </div>`;

  const days = groupByDay(times, tz).map(day => `
    <section class="day">
      <h3>${dayTitle(day.time, tz)}</h3>
      <div class="ctable">
        ${header}
        ${day.times.map(t => {
          const points = byTime.map(map => map.get(t));
          const acc = agreement(points.filter(Boolean).map(p => p.speed));
          return `
            <div class="crow" style="${cols}">
              <span class="h">${String(hourOf(t, tz)).padStart(2, '0')}h</span>
              ${points.map(p => p
                ? `<span class="cell" style="background:${windColor(p.speed)};color:${windText(p.speed)}">
                     <span class="top">${arrow(p.dir)}${Math.round(p.speed)}</span>
                     <small>${p.gusts != null ? Math.round(p.gusts) : ''}</small>
                   </span>`
                : '<span class="cell none">–</span>').join('')}
              <span class="agree ${acc.cls}" role="button" data-label="${esc(acc.label)}" aria-label="${esc(acc.label)}">${acc.sign}</span>
            </div>`;
        }).join('')}
      </div>
    </section>`).join('');

  return `
    <details class="card howto">
      <summary>Comment lire ce tableau ?</summary>
      <p>Chaque <b>colonne</b> est un modèle météo, chaque <b>ligne</b> une heure (de ${FIRST_HOUR} h à ${LAST_HOUR} h).</p>
      <p>Dans chaque case : la <b>flèche</b> montre où va le vent, le <b>gros chiffre</b> est le vent moyen et le <b>petit chiffre</b> les rafales, en nœuds. La couleur suit la force du vent.</p>
      <p>Colonne ⚖︎ : <span class="agree ok">✓</span> les modèles donnent des valeurs proches, <span class="agree mid">~</span> à peu près, <span class="agree bad">!</span> ils sont en désaccord : prévision incertaine. Touche le signe pour voir l'écart.</p>
      <p>AROME HD et AROME (Météo-France) sont les plus précis près des côtes françaises mais ne voient qu'à 2 jours. Au-delà, fie-toi à ARPEGE, ICON, ECMWF et GFS.</p>
    </details>
    ${days}`;
}

function detailView(forecast) {
  const selected = store.model;
  const model = modelById(selected);
  const tz = forecast.tz;
  const chips = MODELS.map(m => {
    const on = m.id === selected;
    return `<button class="chip${on ? ' on' : ''}${hasData(forecast, m.id) ? '' : ' off'}" data-model="${m.id}" style="${on ? `background:${m.color}` : ''}">${m.name}</button>`;
  }).join('');

  const since = Date.now() / 1000 - 3600;
  const points = new Map((forecast.series[selected] || []).filter(p => p.time >= since).map(p => [p.time, p]));
  const days = groupByDay([...points.keys()], tz);
  const allSpeeds = new Map();
  for (const m of MODELS) {
    for (const p of forecast.series[m.id] || []) {
      if (!allSpeeds.has(p.time)) allSpeeds.set(p.time, []);
      allSpeeds.get(p.time).push(p.speed);
    }
  }

  const table = days.length ? days.map(day => `
    <section class="day">
      <h3>${dayTitle(day.time, tz)}</h3>
      <div class="table">
        <div class="thead"><span>Heure</span><span>Dir.</span><span class="c">Vent</span><span class="c">Raf.</span><span class="c">Fiab.</span><span class="r">Houle</span><span class="r">T°</span><span></span></div>
        ${day.times.map(t => {
          const p = points.get(t);
          const wave = forecast.waves[p.time];
          const acc = agreement(allSpeeds.get(t) || []);
          return `
            <div class="trow">
              <span>${String(hourOf(p.time, tz)).padStart(2, '0')}h</span>
              <span class="dir">${p.dir != null ? arrow(p.dir) + cardinal(p.dir) : ''}</span>
              <span class="kn" style="background:${windColor(p.speed)};color:${windText(p.speed)}">${Math.round(p.speed)}</span>
              <span class="gust" style="${p.gusts != null ? `background:${gustColor(p.gusts)};color:${gustText(p.gusts)}` : ''}">${p.gusts != null ? Math.round(p.gusts) : '–'}</span>
              <span class="agree fiab" role="button" data-label="${esc(acc.label)}" aria-label="${esc(acc.label)}">${acc.emoji}</span>
              <span class="wave">${wave != null ? wave.toFixed(1).replace('.', ',') + ' m' : ''}</span>
              <span class="temp">${p.temp != null ? Math.round(p.temp) + '°' : ''}</span>
              <span class="rain">${p.rain >= 0.2 ? '💧' : ''}</span>
            </div>`;
        }).join('')}
      </div>
    </section>`).join('')
    : `<div class="card error"><p><b>Pas de données ${esc(model.name)}</b></p><p>Ce modèle ne couvre pas ce spot. AROME et AROME HD ne couvrent que la France et ses abords.</p></div>`;

  return `
    <div class="chips" id="chips">${chips}</div>
    <p class="model-info">${esc(model.info)}</p>
    <p class="model-info">Fiabilité (comparaison de tous les modèles) : 🟢 d'accord · 🟠 à peu près · 🔴 en désaccord. Touche l'émoji pour voir l'écart.</p>
    ${table}`;
}

// ---------- Démarrage ----------

applyTheme();
route();
// ntfy ne garde les messages que 12 h : on renvoie la liste à chaque ouverture de l'app.
scheduleSpotSync();

// Le service worker permet l'installation sur l'écran d'accueil et l'accès hors connexion.
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).catch(() => { /* facultatif */ });
  // Nouvelle version installée : on recharge une fois pour l'afficher tout de suite.
  const hadController = !!navigator.serviceWorker.controller;
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hadController && !reloaded) { reloaded = true; location.reload(); }
  });
}
