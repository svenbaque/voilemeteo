'use strict';

// Modèles disponibles via l'API gratuite Open-Meteo (même liste que l'app iPhone).
const MODELS = [
  { id: 'meteofrance_arome_france_hd', name: 'AROME HD', color: '#0073d9', info: 'Météo-France · maille 1,5 km · ~2 jours · France' },
  { id: 'meteofrance_arome_france', name: 'AROME', color: '#4db3f2', info: 'Météo-France · maille 2,5 km · ~2 jours · France' },
  { id: 'meteofrance_arpege_europe', name: 'ARPEGE', color: '#8c59d9', info: 'Météo-France · maille 11 km · ~4 jours · Europe' },
  { id: 'icon_seamless', name: 'ICON', color: '#f28c1a', info: 'DWD (Allemagne) · 2 à 13 km · ~7 jours' },
  { id: 'ecmwf_ifs025', name: 'ECMWF', color: '#1aa666', info: 'Centre européen · 25 km · 7 jours et plus' },
  { id: 'gfs_seamless', name: 'GFS', color: '#d9404d', info: 'NOAA (USA) · 13 à 25 km · 7 jours et plus' },
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

function setHeader({ title, left, right }) {
  $('#title').textContent = title;
  for (const [el, cfg] of [[$('#left'), left], [$('#right'), right]]) {
    el.hidden = !cfg;
    el.className = 'hbtn' + (cfg && cfg.big ? ' big' : '');
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
    right: { label: '+', aria: 'Ajouter un spot', big: true, onClick: () => { location.hash = '#/add'; } },
  });

  if (!spots.length) {
    view.innerHTML = `
      <div class="empty">
        <div class="boat">⛵</div>
        <h2>Aucun spot</h2>
        <p>Ajoute tes spots de navigation préférés pour suivre le vent heure par heure.</p>
        <a class="btn" href="#/add">Ajouter un spot</a>
      </div>`;
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
            ${editing ? `<div class="row-main">${inner}</div>` : `<a class="row-main" href="#/spot/${encodeURIComponent(s.id)}">${inner}</a>`}
            ${editing ? `
              <button class="mv" data-act="up" aria-label="Monter" ${i === 0 ? 'disabled' : ''}>↑</button>
              <button class="mv" data-act="down" aria-label="Descendre" ${i === spots.length - 1 ? 'disabled' : ''}>↓</button>` : ''}
          </li>`;
      }).join('')}
    </ul>
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
      } else {
        const j = btn.dataset.act === 'up' ? i - 1 : i + 1;
        [list[i], list[j]] = [list[j], list[i]];
      }
      store.spots = list;
      renderList();
    };
  });

  if (!editing) {
    view.querySelectorAll('.row').forEach(row => {
      const spot = spots.find(s => s.id === row.dataset.id);
      if (spot) loadBadge(spot, row);
    });
  }
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
    <div class="chips" id="chips"></div>
    <p class="model-info" id="minfo"></p>
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

  const draw = () => {
    const selected = store.model;
    const model = modelById(selected);

    $('#chips').innerHTML = MODELS.map(m => {
      const on = m.id === selected;
      return `<button class="chip${on ? ' on' : ''}${hasData(forecast, m.id) ? '' : ' off'}" data-model="${m.id}" style="${on ? `background:${m.color}` : ''}">${m.name}</button>`;
    }).join('');
    $('#chips').querySelectorAll('.chip').forEach(btn => {
      btn.onclick = () => { store.model = btn.dataset.model; draw(); };
    });
    $('#minfo').textContent = model.info;

    const since = Date.now() / 1000 - 3600;
    const points = (forecast.series[selected] || []).filter(p => p.time >= since);

    // Tableau heure par heure, groupé par jour
    const days = [];
    for (const p of points) {
      const key = dayKey(p.time, forecast.tz);
      if (!days.length || days[days.length - 1].key !== key) days.push({ key, time: p.time, points: [] });
      days[days.length - 1].points.push(p);
    }

    const table = days.length ? days.map(day => `
      <section class="day">
        <h3>${dayTitle(day.time, forecast.tz)}</h3>
        <div class="table">
          <div class="thead"><span>Heure</span><span>Dir.</span><span class="c">Vent</span><span class="c">Raf.</span><span class="r">Houle</span><span class="r">T°</span><span></span></div>
          ${day.points.map(p => {
            const wave = forecast.waves[p.time];
            return `
              <div class="trow">
                <span>${String(hourOf(p.time, forecast.tz)).padStart(2, '0')}h</span>
                <span class="dir">${p.dir != null ? arrow(p.dir) + cardinal(p.dir) : ''}</span>
                <span class="kn" style="background:${windColor(p.speed)};color:${windText(p.speed)}">${Math.round(p.speed)}</span>
                <span class="gust" style="${p.gusts != null ? `background:${windColor(p.gusts)}59` : ''}">${p.gusts != null ? Math.round(p.gusts) : '–'}</span>
                <span class="wave">${wave != null ? wave.toFixed(1).replace('.', ',') + ' m' : ''}</span>
                <span class="temp">${p.temp != null ? Math.round(p.temp) + '°' : ''}</span>
                <span class="rain">${p.rain >= 0.2 ? '💧' : ''}</span>
              </div>`;
          }).join('')}
        </div>
      </section>`).join('')
      : `<div class="card error"><p><b>Pas de données ${esc(model.name)}</b></p><p>Ce modèle ne couvre pas ce spot. AROME et AROME HD ne couvrent que la France et ses abords.</p></div>`;

    const available = MODELS.filter(m => hasData(forecast, m.id));
    $('#body').innerHTML = `
      <div class="card">
        <div class="card-title">Comparaison des modèles · vent en nœuds</div>
        <div class="chart-scroll"><div class="chart-box"><canvas id="chart"></canvas></div></div>
        <div class="legend">
          ${available.map(m => `<span style="${m.id === selected ? 'font-weight:700' : ''}"><i style="background:${m.color}"></i>${m.name}</span>`).join('')}
          <span><i class="dash" style="border-color:${model.color}"></i>Rafales ${esc(model.name)}</span>
        </div>
      </div>
      ${table}
      <p class="foot">Données <a href="https://open-meteo.com" target="_blank" rel="noopener">Open-Meteo</a> · mises à jour à ${new Date(forecast.fetchedAt).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}</p>`;

    drawChart(forecast, selected, available);
  };

  draw();
}

let chart = null;

function drawChart(forecast, selected, available) {
  if (chart) { chart.destroy(); chart = null; }
  if (!window.Chart || !available.length) { $('.chart-scroll').innerHTML = '<p class="muted">Graphique indisponible.</p>'; return; }

  const start = (Date.now() / 1000 - 3600) * 1000;
  let end = start;
  const datasets = [];
  const push = (points, extra) => {
    const data = points.filter(p => p.time * 1000 >= start).map(p => ({ x: p.time * 1000, y: extra.gusts ? p.gusts : p.speed })).filter(d => d.y != null);
    if (data.length) end = Math.max(end, data[data.length - 1].x);
    datasets.push({ data, pointRadius: 0, pointHitRadius: 6, tension: 0.35, fill: false, ...extra.style });
  };
  for (const m of available) {
    const on = m.id === selected;
    push(forecast.series[m.id], { style: { label: m.name, borderColor: on ? m.color : m.color + '8c', borderWidth: on ? 3 : 1.5, order: on ? 0 : 2 } });
  }
  const sel = modelById(selected);
  if (hasData(forecast, selected)) {
    push(forecast.series[selected], { gusts: true, style: { label: `Rafales ${sel.name}`, borderColor: sel.color, borderWidth: 1.5, borderDash: [4, 3], order: 1 } });
  }

  // 48 h visibles, défilement horizontal pour la suite
  const scroll = $('.chart-scroll');
  const box = $('.chart-box');
  const hours = (end - start) / 3600e3;
  box.style.width = Math.max(scroll.clientWidth, (hours * scroll.clientWidth) / 48) + 'px';

  const css = getComputedStyle(document.documentElement);
  const muted = css.getPropertyValue('--muted').trim();
  const line = css.getPropertyValue('--line').trim();
  const tz = forecast.tz;

  const nowLine = {
    id: 'now',
    afterDatasetsDraw(c) {
      const x = c.scales.x.getPixelForValue(Date.now());
      const { top, bottom } = c.chartArea;
      const ctx = c.ctx;
      ctx.save();
      ctx.strokeStyle = muted;
      ctx.setLineDash([2, 2]);
      ctx.beginPath();
      ctx.moveTo(x, top);
      ctx.lineTo(x, bottom);
      ctx.stroke();
      ctx.restore();
    },
  };

  chart = new Chart($('#chart'), {
    type: 'line',
    data: { datasets },
    plugins: [nowLine],
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: 'nearest', axis: 'x', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: items => {
              const t = items[0].parsed.x / 1000;
              return `${dayTitle(t, tz)} · ${String(hourOf(t, tz)).padStart(2, '0')}h`;
            },
            label: item => `${item.dataset.label} : ${Math.round(item.parsed.y)} kn`,
          },
        },
      },
      scales: {
        x: {
          type: 'linear',
          min: start,
          max: end,
          grid: { color: line },
          ticks: {
            color: muted,
            maxRotation: 0,
            autoSkip: false,
            callback: v => {
              const h = hourOf(v / 1000, tz);
              return h === 0 ? fmt(tz, { weekday: 'short' }).format(v) : `${h}h`;
            },
          },
          // Graduations toutes les 6 h en heure locale du spot
          afterBuildTicks: axis => {
            const ticks = [];
            for (let t = Math.ceil(start / 3600e3) * 3600e3; t <= end; t += 3600e3) {
              if (hourOf(t / 1000, tz) % 6 === 0) ticks.push({ value: t });
            }
            axis.ticks = ticks;
          },
        },
        y: { beginAtZero: true, grid: { color: line }, ticks: { color: muted } },
      },
    },
  });
  cleanup.push(() => { if (chart) { chart.destroy(); chart = null; } });
}

// ---------- Démarrage ----------

route();

// Le service worker permet l'installation sur l'écran d'accueil et l'accès hors connexion.
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('sw.js').catch(() => { /* facultatif */ });
}
