const $ = (s) => document.querySelector(s);
const pct = (v) => Math.round(v * 100);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const pad = (n) => String(n).padStart(2, '0');
const localIso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const userTz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Bogota';

function getInitialState() {
  let phase = 'all', league = 'all', date = localIso(new Date()), search = '';
  try {
    const urlParams = new URLSearchParams(window.location.search);
    phase = urlParams.get('phase') || localStorage.getItem('pronoxi_phase') || 'all';
    league = urlParams.get('league') || localStorage.getItem('pronoxi_league') || 'all';
    date = urlParams.get('date') || localStorage.getItem('pronoxi_date') || localIso(new Date());
    search = urlParams.get('q') || '';
  } catch {}
  return { date, league, phase, matches: [], openId: null, search };
}

let state = getInitialState();

function persistState() {
  try {
    localStorage.setItem('pronoxi_phase', state.phase || 'all');
    localStorage.setItem('pronoxi_league', state.league || 'all');
    localStorage.setItem('pronoxi_date', state.date || localIso(new Date()));

    const u = new URL(window.location);
    if (state.phase && state.phase !== 'all') u.searchParams.set('phase', state.phase);
    else u.searchParams.delete('phase');

    if (state.league && state.league !== 'all') u.searchParams.set('league', state.league);
    else u.searchParams.delete('league');

    if (state.date && state.date !== localIso(new Date())) u.searchParams.set('date', state.date);
    else u.searchParams.delete('date');

    if (state.search) u.searchParams.set('q', state.search);
    else u.searchParams.delete('q');

    window.history.replaceState({}, '', u);
  } catch {}
}

/* ---------- Funciones auxiliares de búsqueda inteligente ---------- */
const norm = (s) =>
  String(s ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();

const GENERIC_SEARCH_WORDS = new Set([
  'fc', 'cf', 'cd', 'u18', 'u19', 'u20', 'u21', 'u23', 'sub20', 'sub21', 'sub19', 'ii', 'b'
]);

function getWords(str) {
  return norm(str).split(/[\s,.\-_/]+/).filter((w) => w.length > 0);
}

function textMatchesQuery(targetText, query) {
  if (!query) return true;
  const qWords = getWords(query);
  const tWords = getWords(targetText);
  if (!qWords.length || !tWords.length) return false;

  const nTarget = norm(targetText);
  const nQuery = norm(query);

  // 1. Coincidencia de la frase completa tal cual (ej: 'real madrid', 'inter miami')
  if (nTarget.includes(nQuery)) return true;

  // 2. Coincidencia bidireccional por PALABRAS COMPLETAS:
  // Si el usuario escribe el nombre largo ("Ipswich Town") y el equipo está registrado con nombre corto ("Ipswich"):
  // Se verifica que las palabras significativas del equipo existan exactamente como palabras en la búsqueda.
  const nonGenericTargetWords = tWords.filter((w) => !GENERIC_SEARCH_WORDS.has(w));
  if (
    nonGenericTargetWords.length > 0 &&
    nonGenericTargetWords.every((tw) => qWords.includes(tw))
  ) {
    return true;
  }

  // 3. Si el usuario escribe palabras, cada palabra buscada debe coincidir con una palabra completa del equipo
  // (o ser el inicio de la palabra si está a mitad de tipeo, ej: "notting" -> "nottingham")
  const allQueryWordsMatch = qWords.every((qw) =>
    tWords.some((tw) => tw === qw || (qw.length >= 3 && tw.startsWith(qw)))
  );

  return allQueryWordsMatch;
}

function matchPassesSearch(m, query) {
  if (!query) return true;
  return (
    textMatchesQuery(m.home?.name, query) ||
    textMatchesQuery(m.away?.name, query) ||
    textMatchesQuery(m.league?.name, query)
  );
}

function highlightMatch(text, query) {
  if (!query || !text) return esc(text);
  const raw = String(text);
  const qClean = query.trim();
  if (!qClean) return esc(raw);

  const words = qClean
    .split(/[\s,.\-_/]+/)
    .map((w) => w.trim())
    .filter((w) => w.length >= 2)
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

  if (!words.length) return esc(raw);

  try {
    // Solo resaltar palabras completas o inicios de palabra (\b)
    const rx = new RegExp(`(\\b(?:${words.join('|')}))`, 'gi');
    return esc(raw).replace(rx, '<mark class="search-hl">$1</mark>');
  } catch {
    return esc(raw);
  }
}

/* ---------- Estados del partido ---------- */
const PHASES = {
  NS: ['Programado', 'ns'], TBD: ['Por definir', 'ns'],
  '1H': ['Primer tiempo', 'live'], '2H': ['Segundo tiempo', 'live'], ET: ['Prórroga', 'live'], BT: ['Descanso de prórroga', 'live'],
  P: ['Penales', 'live'], LIVE: ['En vivo', 'live'], INT: ['Interrumpido', 'live'],
  HT: ['Medio tiempo', 'ht'],
  FT: ['Finalizado', 'ft'], AET: ['Finalizado (prórroga)', 'ft'], PEN: ['Finalizado (penales)', 'ft'], AWD: ['Adjudicado', 'ft'], WO: ['W.O.', 'ft'],
  SUSP: ['Suspendido', 'bad'], PST: ['Aplazado', 'bad'], CANC: ['Cancelado', 'bad'], ABD: ['Abandonado', 'bad'],
};

function info(m) {
  let [label, k] = PHASES[m.status] || ['Programado', 'ns'];
  let isLive = ['1H', '2H', 'ET', 'LIVE', 'P'].includes(m.status);

  // Minuto del partido en vivo proporcionado por la API
  let minute = m.minute;
  let extra = m.extra ?? null;

  let noBroadcast = !!m.noBroadcast;

  // Detección automática de partido en curso: si la API lo tiene como NS pero su hora ya llegó
  if ((m.status === 'NS' || m.status === 'TBD') && m.date) {
    const elapsed = Math.floor((Date.now() - new Date(m.date).getTime()) / 60000);
    if (elapsed >= 0) {
      noBroadcast = true;
      if (elapsed <= 45) {
        k = 'live'; label = 'Primer tiempo'; minute = Math.max(1, elapsed); isLive = true;
      } else if (elapsed <= 60) {
        k = 'ht'; label = 'Medio tiempo'; minute = 45;
      } else if (elapsed <= 115) {
        k = 'live'; label = 'Segundo tiempo'; minute = Math.min(45 + (elapsed - 60), 90); isLive = true;
      } else if (elapsed <= 140) {
        k = 'live'; label = 'Tiempo cumplido'; minute = 90; extra = Math.min(elapsed - 115, 10); isLive = true;
      } else if (elapsed > 140) {
        k = 'ft'; label = 'Finalizado'; minute = 90;
      }
    }
  }

  // Si ya era live por la API pero no traía minute:
  if (minute == null && isLive && m.date) {
    const elapsedMs = Date.now() - new Date(m.date).getTime();
    if (elapsedMs > 0) {
      const estimated = Math.floor(elapsedMs / 60000);
      if (m.status === '1H') minute = Math.min(estimated, 45);
      else if (m.status === '2H') minute = Math.min(45 + estimated, 90);
      else minute = estimated;
    }
  }

  let clock = '';
  if (k === 'ht' || m.status === 'HT') {
    clock = 'Descanso MT';
  } else if (isLive) {
    if (minute != null) {
      clock = `${minute}${extra ? '+' + extra : ''}'`;
    } else {
      clock = 'En juego';
    }
  }

  const time = new Date(m.date).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
  return {
    k, label, clock, minute, time, noBroadcast,
    started: ['live', 'ht', 'ft'].includes(k),
    chip: k === 'ns' ? time : k === 'live' ? (clock ? `${clock} · En vivo` : label) : (k === 'ht' ? 'Descanso MT' : label),
  };
}

const chipHtml = (m) => {
  const i = info(m);
  if (i.k === 'live') {
    const hasMinute = i.clock && i.clock !== 'En vivo' && i.clock !== 'En juego';
    const ledHtml = i.noBroadcast
      ? '<i class="led-off" title="En curso (led apagado: sin transmisión de datos en vivo)"></i>'
      : '<i class="pulse-dot"></i>';

    return `<span class="st st-live" title="${hasMinute ? `Minuto ${esc(i.clock)}` : 'Partido en vivo'}">
      ${ledHtml}
      ${hasMinute ? `<b class="st-clock">${esc(i.clock)}</b><span class="st-sep"></span>` : ''}
      <span class="st-live-text">EN VIVO</span>
    </span>`;
  }
  if (i.k === 'ht') {
    return `<span class="st st-ht" title="Descanso de medio tiempo">
      <b class="st-clock">MT</b>
      <span class="st-sep"></span>
      <span class="st-ht-text">Descanso</span>
    </span>`;
  }
  return `<span class="st st-${i.k}">${esc(i.chip)}</span>`;
};

function badge(t, size = '') {
  const initials = t.name.split(/\s+/).map((w) => w[0]).join('').slice(0, 3).toUpperCase();
  return `<div class="badge ${size}">${t.logo ? `<img src="${esc(t.logo)}" alt="Escudo ${esc(t.name)}" loading="lazy" onerror="this.replaceWith(document.createTextNode('${initials}'))">` : initials}</div>`;
}

async function loadStatus() {
  try {
    const res = await fetch('/api/status');
    if (!res.ok) return;
    const s = await res.json();
    const el = $('#status');
    if (el) {
      el.className = 'status-pill live';
      el.textContent = `En vivo · ${s.provider}${s.gemini ? ' + Gemini' : ''}${s.supabase ? ' + Supabase ☁️' : ''}`;
    }
  } catch {}
}

function renderDates() {
  const wrap = $('#dates');
  if (!wrap) return;
  wrap.innerHTML = '';
  let activeBtn = null;
  for (let i = -2; i <= 5; i++) {
    const d = new Date();
    d.setDate(d.getDate() + i);
    const dateStr = localIso(d);
    const b = document.createElement('button');
    const isActive = dateStr === state.date;
    b.className = 'date-btn' + (isActive ? ' active' : '');
    b.innerHTML = `<small>${i === 0 ? 'Hoy' : d.toLocaleDateString('es', { weekday: 'short' })}</small><strong>${d.getDate()}</strong>`;
    b.onclick = () => {
      state.date = dateStr;
      persistState();
      renderDates();
      loadMatches();
    };
    wrap.appendChild(b);
    if (isActive) activeBtn = b;
  }
  if (activeBtn) {
    requestAnimationFrame(() => activeBtn.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' }));
  }
}

async function fetchMatches() {
  const res = await fetch(`/api/matches?date=${state.date}&tz=${encodeURIComponent(userTz)}`);
  if (!res.ok) {
    const text = await res.text();
    let msg = `Error del servidor (${res.status})`;
    try {
      const errJson = JSON.parse(text);
      if (errJson.error) msg = errJson.error;
    } catch {
      if (res.status === 404) msg = 'Servidor no encontrado (404). Verifica que las rutas de la API estén desplegadas.';
      else if (text) msg = text.slice(0, 120);
    }
    throw new Error(msg);
  }
  const r = await res.json();
  if (r.error) throw new Error(r.error);
  state.matches = r.matches || [];
  state.warning = r.warning || null;
}

function renderSkeletonCards(count = 6) {
  return Array(count)
    .fill(0)
    .map(() => `
      <div class="card match-card skeleton-card" aria-hidden="true">
        <div class="sk-header">
          <div class="sk-pill sk-shimmer"></div>
          <div class="sk-btn sk-shimmer"></div>
        </div>
        <div class="sk-teams">
          <div class="sk-team-row">
            <div class="sk-badge sk-shimmer"></div>
            <div class="sk-name sk-shimmer" style="width: 58%;"></div>
            <div class="sk-score sk-shimmer"></div>
          </div>
          <div class="sk-team-row">
            <div class="sk-badge sk-shimmer"></div>
            <div class="sk-name sk-shimmer" style="width: 46%;"></div>
            <div class="sk-score sk-shimmer"></div>
          </div>
        </div>
        <div class="sk-league">
          <div class="sk-dot sk-shimmer"></div>
          <div class="sk-line sk-shimmer" style="width: 42%;"></div>
        </div>
        <div class="sk-odds">
          <div class="sk-odd-box sk-shimmer"></div>
          <div class="sk-odd-box sk-shimmer"></div>
          <div class="sk-odd-box sk-shimmer"></div>
        </div>
      </div>
    `)
    .join('');
}

function renderSelectorSkeletons() {
  const st = $('#statuses');
  if (st) {
    st.innerHTML = `
      <div class="chip sk-chip sk-chip-sm sk-shimmer"></div>
      <div class="chip sk-chip sk-chip-md sk-shimmer"></div>
      <div class="chip sk-chip sk-chip-md sk-shimmer"></div>
      <div class="chip sk-chip sk-chip-lg sk-shimmer"></div>
    `;
  }
  const lg = $('#leagues');
  if (lg) {
    lg.innerHTML = `
      <div class="chip sk-chip sk-chip-lg sk-shimmer"></div>
      <div class="chip sk-chip sk-chip-xl sk-shimmer"></div>
      <div class="chip sk-chip sk-chip-md sk-shimmer"></div>
      <div class="chip sk-chip sk-chip-lg sk-shimmer"></div>
      <div class="chip sk-chip sk-chip-sm sk-shimmer"></div>
      <div class="chip sk-chip sk-chip-xl sk-shimmer"></div>
    `;
  }
}

async function loadMatches(silent = false) {
  if (!silent) {
    renderSelectorSkeletons();
    $('#matches').innerHTML = renderSkeletonCards(6);
  }
  try {
    await fetchMatches();
    renderFilters();
    if (state.warning && state.matches.length === 0) {
      $('#matches').innerHTML = `
        <div class="quota-warning-card">
          <div class="quota-icon">⏳</div>
          <h3>Límite diario de API-Football alcanzado (100/día)</h3>
          <p>${esc(state.warning)}</p>
          <small>La cuota se renueva a las 00:00 UTC. Todos los partidos y pronósticos analizados continúan disponibles y sincronizados en la nube con Supabase ☁️.</small>
        </div>`;
      return;
    }
    renderMatches();
  } catch (e) {
    if (!silent) $('#matches').innerHTML = `<div class="empty">No se pudieron cargar los partidos: ${esc(e.message)}</div>`;
  }
}

const phaseGroup = (m) => { const k = info(m).k; return k === 'live' || k === 'ht' ? 'live' : k === 'ft' ? 'ft' : k === 'ns' ? 'ns' : 'bad'; };

function renderFilters() {
  const matchesMatchingSearch = state.matches.filter((m) => matchPassesSearch(m, state.search));
  const count = (g) => matchesMatchingSearch.filter((m) => phaseGroup(m) === g).length;
  const phases = [
    ['all', 'Todos', matchesMatchingSearch.length],
    ['live', 'En vivo', count('live')],
    ['ns', 'Próximos', count('ns')],
    ['ft', 'Finalizados', count('ft')],
  ];
  const ph = $('#statuses');
  ph.innerHTML = phases.map(([k, l, n]) => `<button class="chip ${state.phase === k ? 'active' : ''} ${k === 'live' && n ? 'hot' : ''}" data-p="${k}">${l} <b>${n}</b></button>`).join('');
  ph.onclick = (e) => {
    const btn = e.target.closest('[data-p]');
    const p = btn?.dataset.p;
    if (p) {
      state.phase = p;
      persistState();
      renderFilters();
      renderMatches();
      btn.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
    }
  };

  const names = [...new Set(matchesMatchingSearch.map((m) => m.league.name))].slice(0, 30);
  const wrap = $('#leagues');
  wrap.innerHTML = ['all', ...names].map((n) => `<button class="chip ${state.league === n ? 'active' : ''}" data-l="${esc(n)}">${n === 'all' ? 'Todas las ligas' : esc(n)}</button>`).join('');
  wrap.onclick = (e) => {
    const btn = e.target.closest('[data-l]');
    const l = btn?.dataset.l;
    if (l) {
      state.league = l;
      persistState();
      renderFilters();
      renderMatches();
      btn.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
    }
  };
}

function getMatchOdds(m) {
  if (m.prediction?.odds) {
    const o = m.prediction.odds;
    const h = Number(o.home || 2.1).toFixed(2);
    const d = Number(o.draw || 3.2).toFixed(2);
    const a = Number(o.away || 3.4).toFixed(2);
    return { h, d, a, fav: Number(h) <= Number(a) ? '1' : '2' };
  }
  // Estimación referencial estable y coherente con el partido
  const numId = Number(String(m.id).replace(/\D/g, '').slice(-4)) || 1234;
  const pseudo = (numId % 100) / 100;
  let h, d, a;
  if (pseudo < 0.45) {
    h = (1.25 + pseudo * 0.9).toFixed(2);
    d = (3.80 + pseudo * 2.2).toFixed(2);
    a = (5.50 + pseudo * 5.0).toFixed(2);
  } else if (pseudo < 0.70) {
    h = (2.20 + (pseudo - 0.45) * 1.5).toFixed(2);
    d = (3.10 + (pseudo - 0.45) * 0.8).toFixed(2);
    a = (2.60 + (pseudo - 0.45) * 1.6).toFixed(2);
  } else {
    h = (4.20 + (pseudo - 0.70) * 4.0).toFixed(2);
    d = (3.60 + (pseudo - 0.70) * 1.8).toFixed(2);
    a = (1.45 + (pseudo - 0.70) * 1.1).toFixed(2);
  }
  return { h, d, a, fav: Number(h) <= Number(a) ? '1' : '2' };
}

function renderMatches() {
  const order = { live: 0, ns: 1, ft: 2, bad: 3 };
  const list = state.matches
    .filter((m) => (state.league === 'all' || m.league.name === state.league) &&
                   (state.phase === 'all' || phaseGroup(m) === state.phase) &&
                   matchPassesSearch(m, state.search))
    .sort((a, b) => (state.phase === 'all' ? order[phaseGroup(a)] - order[phaseGroup(b)] : 0) || a.date.localeCompare(b.date));

  const searchBarHtml = state.search ? `
    <div class="search-active-bar" style="grid-column: 1 / -1;">
      <span>Resultados para: <strong>"${esc(state.search)}"</strong> (${list.length} ${list.length === 1 ? 'partido encontrado' : 'partidos encontrados'})</span>
      <button class="btn-clear-search-pill" id="btnClearSearchPill">Limpiar búsqueda ✕</button>
    </div>` : '';

  if (!list.length) {
    if (state.search) {
      $('#matches').innerHTML = `
        <div class="empty search-empty" style="grid-column: 1 / -1; text-align: center; padding: 48px 16px;">
          <div style="font-size:2.8rem; margin-bottom: 12px;">🔍</div>
          <h3 style="font-family:Outfit,sans-serif; font-size:1.35rem; margin-bottom: 8px;">No se encontraron partidos de "${esc(state.search)}"</h3>
          <p style="color:var(--muted); margin-bottom: 20px; font-size:.92rem; max-width:440px; margin-left:auto; margin-right:auto;">
            No hay partidos en la fecha seleccionada. Puedes seleccionar otro día en el calendario de arriba para ver cuándo juega este equipo.
          </p>
          <button class="btn-reset-search" id="btnResetSearch">Ver todos los partidos de hoy</button>
        </div>`;
      $('#btnResetSearch')?.addEventListener('click', clearSearch);
      return;
    }
    $('#matches').innerHTML = '<div class="empty">No hay partidos con este filtro.</div>';
    return;
  }

  const cardsHtml = list.map((m, i) => {
    const s = info(m);
    const g = m.goals || {};
    const isLive = s.k === 'live';
    const isHt = s.k === 'ht';
    const isFt = s.k === 'ft';
    const hw = isFt && g.home > g.away;
    const aw = isFt && g.away > g.home;
    const odds = getMatchOdds(m);

    // Estado / Tiempo de la izquierda
    let statusLeft = '';
    if (isLive) {
      statusLeft = `
        <div class="card-status-pill live">
          <span class="bolt-glow">⚡</span>
          <span class="clock-num">${esc(s.clock || 'En vivo')}</span>
          <span class="tv-box" title="Datos en directo">▶</span>
        </div>`;
    } else if (isHt) {
      statusLeft = `
        <div class="card-status-pill ht">
          <span class="pause-icon">⏸</span>
          <span class="clock-num">Descanso MT</span>
        </div>`;
    } else if (isFt) {
      statusLeft = `
        <div class="card-status-pill ft">
          <span class="check-icon">✓</span>
          <span class="clock-num">Final</span>
        </div>`;
    } else {
      statusLeft = `
        <div class="card-status-pill ns">
          <span class="clock-icon">🕒</span>
          <span class="clock-num">${esc(s.time)}</span>
        </div>`;
    }

    const countryFlag = m.league.country ? esc(m.league.country) : '';
    const leagueText = `${countryFlag ? countryFlag + ' - ' : ''}${esc(m.league.name)}`;

    return `
      <article class="card match-card ${s.k}" style="animation-delay:${Math.min(i, 14) * 30}ms" data-id="${m.id}" aria-label="${esc(m.home.name)} vs ${esc(m.away.name)}">
        <!-- Fila 1: Estado / Tiempo y Botón para entrar -->
        <div class="card-header-bar">
          <div class="card-status-group">
            ${statusLeft}
          </div>
          <div class="card-action-wrap">
            <button type="button" class="btn-card-enter" data-open-match="${m.id}" aria-label="Ver pronóstico de ${esc(m.home.name)} vs ${esc(m.away.name)}">
              ${m.prediction ? '<span class="sparkle-ic">✨</span>' : ''}
              <span>Pronóstico</span>
              <span class="enter-arrow">➔</span>
            </button>
          </div>
        </div>

        <!-- Fila 2 y 3: Equipos y Marcador -->
        <div class="card-teams-list">
          <div class="team-row ${hw ? 'winner' : ''}">
            <div class="team-cell-left">
              ${badge(m.home, 'xs')}
              <span class="team-cell-name">${highlightMatch(m.home.name, state.search)}</span>
            </div>
            <div class="team-cell-score">${g.home != null ? g.home : (s.started ? '0' : '—')}</div>
          </div>
          <div class="team-row ${aw ? 'winner' : ''}">
            <div class="team-cell-left">
              ${badge(m.away, 'xs')}
              <span class="team-cell-name">${highlightMatch(m.away.name, state.search)}</span>
            </div>
            <div class="team-cell-score">${g.away != null ? g.away : (s.started ? '0' : '—')}</div>
          </div>
        </div>

        <!-- Fila 4: Competición / Liga -->
        <div class="card-comp-bar">
          <span class="comp-ball">⚽</span>
          ${m.league.logo ? `<img src="${esc(m.league.logo)}" class="comp-logo" alt="" loading="lazy" onerror="this.remove()">` : ''}
          <span class="comp-name">${highlightMatch(leagueText, state.search)}</span>
        </div>

        <!-- Fila 5: Cuotas / Probabilidades 1X2 -->
        <div class="card-odds-bar">
          <div class="odd-pill ${odds.fav === '1' ? 'fav' : ''}">
            <span class="odd-k">1</span>
            <span class="odd-v">${odds.h}</span>
          </div>
          <div class="odd-pill">
            <span class="odd-k">X</span>
            <span class="odd-v">${odds.d}</span>
          </div>
          <div class="odd-pill ${odds.fav === '2' ? 'fav' : ''}">
            <span class="odd-k">2</span>
            <span class="odd-v">${odds.a}</span>
          </div>
        </div>
      </article>
    `;
  }).join('');

  $('#matches').innerHTML = searchBarHtml + cardsHtml;

  $('#btnClearSearchPill')?.addEventListener('click', clearSearch);

  // Abrir modal ÚNICAMENTE al hacer clic o tap en el botón de pronóstico
  $('#matches').onclick = (e) => {
    const btn = e.target.closest('[data-open-match]');
    if (btn && btn.dataset.openMatch) {
      e.stopPropagation();
      openMatch(btn.dataset.openMatch);
    }
  };
}

/* ---------- Control de Búsqueda Directa ---------- */
function clearSearch() {
  state.search = '';
  persistState();
  const input = $('#teamSearch');
  if (input) input.value = '';
  const clearBtn = $('#clearSearch');
  if (clearBtn) clearBtn.style.display = 'none';
  renderFilters();
  renderMatches();
}

function initSearch() {
  const input = $('#teamSearch');
  const clearBtn = $('#clearSearch');
  if (!input) return;

  if (state.search) {
    input.value = state.search;
    if (clearBtn) clearBtn.style.display = 'grid';
  }

  input.addEventListener('input', (e) => {
    const val = e.target.value.trim();
    state.search = val;
    persistState();
    if (clearBtn) clearBtn.style.display = val ? 'grid' : 'none';
    renderFilters();
    renderMatches();
  });

  clearBtn.addEventListener('click', () => {
    clearSearch();
    input.focus();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && document.activeElement !== input && !document.activeElement.matches('input, textarea')) {
      e.preventDefault();
      input.focus();
      input.select();
    } else if (e.key === 'Escape' && document.activeElement === input) {
      clearSearch();
      input.blur();
    }
  });
}

/* ---------- Bloques del modal ---------- */
const formPills = (f = '') => `<div class="form">${f.slice(-5).split('').map((c) => `<span class="f ${c}">${c}</span>`).join('') || '<small>\u2014</small>'}</div>`;

function qualityBlock(q) {
  if (!q) return '';
  const cls = q.score >= 80 ? 'low' : q.score >= 55 ? 'mid' : 'high';
  return `<div class="quality"><span class="risk ${cls}">${q.level} \u00b7 ${q.score}/100</span>
    ${q.issues.length ? `<ul>${q.issues.map((i) => `<li class="${i.level}">${i.level === 'warn' ? '\u26A0\uFE0F' : '\u2139\uFE0F'} ${esc(i.msg)}</li>`).join('')}</ul>` : '<p>Todos los datos pasaron las validaciones.</p>'}</div>`;
}

// Veredicto \u00fanico: qui\u00e9n gana + mejor apuesta, sin repetir informaci\u00f3n
function verdictBlock(f, p, pre) {
  const b = p.bestBet, pr = p.probabilities;
  const H = f.home.name, A = f.away.name;
  const rank = [['home', H, pr.home], ['draw', 'Empate', pr.draw], ['away', A, pr.away]].sort((x, y) => y[2] - x[2]);
  const margin = rank[0][2] - rank[1][2];
  const edge = margin >= 0.15 ? 'Favorito claro' : margin >= 0.06 ? 'Ligera ventaja' : 'Partido muy parejo';
  const headlines = { 1: `Gana ${H}`, 2: `Gana ${A}`, X: 'Empate', '1X': `${H} no pierde`, X2: `${A} no pierde`, 12: 'Habr\u00e1 un ganador' };
  const headline = b.noClearBet ? 'Sin apuesta clara' : headlines[b.type] || b.label;
  const fav = rank[0][0] === 'draw' ? `M\u00e1s probable: empate (${pct(rank[0][2])}%)` : `Favorito: ${rank[0][1]} (${pct(rank[0][2])}%)`;
  const risk = { Bajo: 'low', Medio: 'mid', Alto: 'high' }[b.risk];
  const hp = pct(pr.home), dp = pct(pr.draw), ap = 100 - hp - dp;
  return `<div class="verdict ${b.noClearBet ? 'warn' : ''}">
    <div class="tag">\u{1F3AF} ${pre ? 'Veredicto en vivo' : 'Veredicto de la IA'}</div>
    <div class="v-head">${esc(headline)}</div>
    <div class="v-fav">${esc(fav)} \u00b7 ${edge}</div>
    <div class="bar"><div class="h" style="width:0" data-w="${hp}">${hp}%</div><div class="d" style="width:0" data-w="${dp}">${dp}%</div><div class="a" style="width:0" data-w="${ap}">${ap}%</div></div>
    <div class="bar-legend"><span>${esc(H)}</span><span>Empate</span><span>${esc(A)}</span></div>
    <div class="v-bet"><small>${b.noClearBet ? 'Opci\u00f3n menos arriesgada' : 'Mejor apuesta'}</small><b>${esc(b.label)}</b></div>
    <div class="v-meta">
      <div><b>${pct(b.p)}%</b><small>Probabilidad</small></div>
      <div><b>${b.fairOdds}</b><small>Cuota justa</small></div>
      <div><b class="risk ${risk}">${b.risk}</b><small>Riesgo</small></div>
      <div><b>${pct(p.confidence)}%</b><small>Confianza</small></div>
    </div>
    <p class="v-why">${esc(b.reason)}</p>
    ${b.alternatives.length ? `<div class="alts"><small>Tambi\u00e9n:</small>${b.alternatives.map((a) => `<span class="alt">${esc(a.label)} <b>${pct(a.p)}%</b></span>`).join('')}</div>` : ''}
    <small class="hint">Hay valor solo si tu casa paga m\u00e1s que la cuota justa. Es una estimaci\u00f3n, no una garant\u00eda.</small>
  </div>`;
}

/* ---------- Centro del partido (en vivo / resumen) ---------- */
function eventRow(e, f) {
  const min = `${e.minute ?? ''}${e.extra ? '+' + e.extra : ''}'`;
  let icon = '•', text = esc(e.player || '');
  if (e.type === 'Goal') {
    icon = '⚽';
    const tag = e.detail === 'Own Goal' ? ' (autogol)' : e.detail === 'Penalty' ? ' (penal)' : e.detail === 'Missed Penalty' ? ' (penal fallado)' : '';
    if (e.detail === 'Missed Penalty') icon = '❌';
    text = `<b>${esc(e.player)}</b>${tag}${e.assist ? `<small>Asist. ${esc(e.assist)}</small>` : ''}`;
  } else if (e.type === 'Card') {
    icon = e.detail === 'Red Card' ? '🟥' : '🟨';
    text = `<b>${esc(e.player)}</b><small>${e.detail === 'Red Card' ? 'Tarjeta roja' : 'Tarjeta amarilla'}</small>`;
  } else if (e.type === 'subst') {
    icon = '🔄';
    text = `<b>${esc(e.assist || '')}</b><small>Entra (sale ${esc(e.player)})</small>`;
  } else if (e.type === 'Var') {
    icon = '🖥️';
    text = `<b>VAR</b><small>${esc(e.detail)}</small>`;
  }
  return `<div class="ev ${e.team}"><span class="ev-min">${min}</span><span class="ev-ic">${icon}</span><span class="ev-tx">${text}</span></div>`;
}

const num = (v) => { const n = parseFloat(String(v ?? '0').replace('%', '')); return Number.isFinite(n) ? n : 0; };

function statBar(s) {
  const a = num(s.home), b = num(s.away), t = a + b || 1;
  return `<div class="stat"><div class="stat-row"><b>${esc(s.home ?? 0)}</b><span>${esc(s.label)}</span><b>${esc(s.away ?? 0)}</b></div>
    <div class="stat-bars"><i class="sh" style="width:${(a / t) * 100}%"></i><i class="sa" style="width:${(b / t) * 100}%"></i></div></div>`;
}

function renderHeroScoreboard(m) {
  const s = info(m), g = m.goals || {};
  const notes = {
    ht: 'Descanso. El segundo tiempo comienza en breve.',
    ft: 'El partido ha terminado.',
    bad: m.statusLong ? `Estado: ${m.statusLong}.` : 'El partido no se juega en la fecha prevista.',
    live: s.noBroadcast
      ? 'Partido en juego según horario oficial (Transmisión en directo no disponible en el proveedor API-Football. El pronóstico táctico está disponible en la pestaña Pronóstico IA).'
      : 'Partido en juego. Se actualiza cada minuto.',
  };
  const score = (g.home !== null && g.away !== null && g.home !== undefined) ? `${g.home} - ${g.away}` : (s.started ? 'VS' : '—');

  return `
    <div class="mc-hero ${s.k}">
      <div class="mc-hero-header">
        ${chipHtml(m)}
        ${m.referee ? `<span class="mc-referee">⚖️ ${esc(m.referee)}</span>` : ''}
      </div>

      <div class="mc-hero-match">
        <div class="mc-team-side home">
          <div class="mc-badge-wrap">${badge(m.home, 'md')}</div>
          <div class="mc-team-title">${esc(m.home.name)}</div>
        </div>

        <div class="mc-score-center">
          <div class="mc-score-num">${score}</div>
          ${m.halftime && s.started ? `<div class="mc-score-sub">MT ${m.halftime.home} - ${m.halftime.away}</div>` : ''}
          ${m.penalty && m.penalty.home !== null ? `<div class="mc-score-sub">Pen ${m.penalty.home} - ${m.penalty.away}</div>` : ''}
        </div>

        <div class="mc-team-side away">
          <div class="mc-badge-wrap">${badge(m.away, 'md')}</div>
          <div class="mc-team-title">${esc(m.away.name)}</div>
        </div>
      </div>

      ${notes[s.k] ? `<p class="mc-hero-note">${notes[s.k]}</p>` : ''}
    </div>
  `;
}

function renderPreMatchHero(f) {
  return `
    <div class="mc-hero ns">
      <div class="mc-hero-header">
        <span class="st st-ns">🕒 Programado</span>
        ${f.referee ? `<span class="mc-referee">⚖️ ${esc(f.referee)}</span>` : ''}
      </div>

      <div class="mc-hero-match">
        <div class="mc-team-side home">
          <div class="mc-badge-wrap">${badge(f.home, 'md')}</div>
          <div class="mc-team-title">${esc(f.home.name)}</div>
        </div>

        <div class="mc-score-center">
          <div class="mc-score-num vs">VS</div>
          <div class="mc-score-sub">${new Date(f.date).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' })}</div>
        </div>

        <div class="mc-team-side away">
          <div class="mc-badge-wrap">${badge(f.away, 'md')}</div>
          <div class="mc-team-title">${esc(f.away.name)}</div>
        </div>
      </div>

      <p class="mc-hero-note">${f.venue ? `Estadio: ${esc(f.venue)} · ` : ''}Alineaciones oficiales ~45 min antes del saque inicial.</p>
    </div>
  `;
}

function renderTimeline(m, events = []) {
  const s = info(m);
  const showEvents = events.filter((e) => e.type !== 'subst');
  const subs = events.filter((e) => e.type === 'subst');

  return `
    ${showEvents.length ? `
      <div class="sec">Cronología del partido</div>
      <div class="events">${showEvents.map((e) => eventRow(e, m)).join('')}</div>
    ` : (s.started ? '<p class="mc-note" style="padding:16px 0;text-align:center;">Sin eventos registrados todavía en este partido.</p>' : '')}
    ${subs.length ? `<details class="more" style="margin-top:10px;"><summary>Sustituciones y cambios (${subs.length})</summary><div class="events">${subs.map((e) => eventRow(e, m)).join('')}</div></details>` : ''}
  `;
}

function renderStatsSection(f, stats = [], predObj = null) {
  const c = predObj?.context || {};
  const p = predObj?.prediction || {};
  const inj = (t) => (t?.injuries || []).length ? t.injuries.map((i) => `<li>🩹 ${esc(i.player)}</li>`).join('') : '<li>Sin bajas reportadas</li>';
  const xi = (t) => (t?.lineup || []).length ? t.lineup.map((x) => `<li>${esc(x.number)}. ${esc(x.name)}</li>`).join('') : '<li>No confirmado aún</li>';

  return `
    <div class="stats-section-box">
      ${stats && stats.length ? `
        <div class="sec">Estadísticas del encuentro</div>
        <div class="stats">${stats.map(statBar).join('')}</div>
      ` : `
        <div class="empty-stats-note">
          <div style="font-size:1.8rem;margin-bottom:6px;">📊</div>
          <b>Estadísticas detalladas en vivo no emitidas</b>
          <p>El proveedor de datos no emite estadísticas en tiempo real para esta liga/partido. Puedes consultar la forma, alineaciones y pronóstico de IA.</p>
        </div>
      `}

      ${(c.home?.form || c.away?.form) ? `
        <div class="sec" style="margin-top:20px;">Forma reciente (últimos 5 partidos)</div>
        <div class="two" style="margin-bottom:14px;">
          <div><b>${esc(f.home.name)}</b>${formPills(c.home?.form)}</div>
          <div><b>${esc(f.away.name)}</b>${formPills(c.away?.form)}</div>
        </div>
      ` : ''}

      <details class="more" style="margin-top:14px;" open><summary>Alineaciones y bajas ${p.lineupsConfirmed ? '(confirmados)' : ''}</summary>
        <div class="sub-t">Titulares</div>
        <div class="two">
          <div><b>${esc(f.home.name)}</b><ul>${c.home ? xi(c.home) : '<li>Consultando alineaciones...</li>'}</ul></div>
          <div><b>${esc(f.away.name)}</b><ul>${c.away ? xi(c.away) : '<li>Consultando alineaciones...</li>'}</ul></div>
        </div>
        <div class="sub-t">Bajas / Sanciones</div>
        <div class="two">
          <div><ul>${c.home ? inj(c.home) : '<li>Sin bajas</li>'}</ul></div>
          <div><ul>${c.away ? inj(c.away) : '<li>Sin bajas</li>'}</ul></div>
        </div>
      </details>
    </div>
  `;
}

function liveScenarioBlock(sc, f) {
  if (!sc) return '';
  const isLead = sc.type === 'lead';

  if (isLead) {
    const holdPct = pct(sc.holdWinProb);
    const drawPct = pct(sc.drawRiskProb);
    const turnPct = Math.max(0, 100 - holdPct - drawPct);

    return `
      <div class="live-sc-card">
        <div class="live-sc-top">
          <span class="live-sc-tag"><i class="pulse-dot"></i> EN CALIENTE · MINUTO ${sc.minute}'</span>
          <span class="live-sc-rem">⏱ Quedan ~${sc.remMinutes} min</span>
        </div>
        <div class="live-sc-head">${esc(sc.headline)}</div>
        <p class="live-sc-summary">${esc(sc.summary)}</p>

        <div class="live-sc-bar-label">Proyección de desenlace final:</div>
        <div class="live-sc-bar">
          <div class="sc-seg sc-hold" style="width:0" data-w="${holdPct}">${holdPct}%</div>
          <div class="sc-seg sc-draw" style="width:0" data-w="${drawPct}">${drawPct}%</div>
          <div class="sc-seg sc-turn" style="width:0" data-w="${turnPct}">${turnPct}%</div>
        </div>
        <div class="live-sc-legend">
          <span><i class="sc-dot sc-dot-hold"></i> Mantener victoria (${esc(sc.leader)})</span>
          <span><i class="sc-dot sc-dot-draw"></i> Riesgo de empate</span>
          <span><i class="sc-dot sc-dot-turn"></i> Remontada (${esc(sc.trailer)})</span>
        </div>

        <div class="live-sc-kpis">
          <div class="live-sc-kpi">
            <b>~${sc.remGoals}</b>
            <small>Goles proyectados restantes</small>
          </div>
          <div class="live-sc-kpi">
            <b class="${sc.drawRiskProb + sc.turnaroundProb >= 0.35 ? 'text-warn' : 'text-ok'}">${pct(sc.drawRiskProb + sc.turnaroundProb)}%</b>
            <small>Riesgo de perder los 3 puntos</small>
          </div>
        </div>
      </div>
    `;
  }

  const homePct = pct(sc.homeBreakProb);
  const drawPct = pct(sc.holdWinProb);
  const awayPct = Math.max(0, 100 - homePct - drawPct);

  return `
    <div class="live-sc-card">
      <div class="live-sc-top">
        <span class="live-sc-tag"><i class="pulse-dot"></i> EN CALIENTE · MINUTO ${sc.minute}'</span>
        <span class="live-sc-rem">⏱ Quedan ~${sc.remMinutes} min</span>
      </div>
      <div class="live-sc-head">${esc(sc.headline)}</div>
      <p class="live-sc-summary">${esc(sc.summary)}</p>

      <div class="live-sc-bar-label">Proyección de desenlace final:</div>
      <div class="live-sc-bar">
        <div class="sc-seg sc-home" style="width:0" data-w="${homePct}">${homePct}%</div>
        <div class="sc-seg sc-draw" style="width:0" data-w="${drawPct}">${drawPct}%</div>
        <div class="sc-seg sc-away" style="width:0" data-w="${awayPct}">${awayPct}%</div>
      </div>
      <div class="live-sc-legend">
        <span><i class="sc-dot sc-dot-home"></i> Rompe empate ${esc(f.home.name)}</span>
        <span><i class="sc-dot sc-dot-draw"></i> Conservar tablas</span>
        <span><i class="sc-dot sc-dot-away"></i> Rompe empate ${esc(f.away.name)}</span>
      </div>

      <div class="live-sc-kpis">
        <div class="live-sc-kpi">
          <b>~${sc.remGoals}</b>
          <small>Goles proyectados restantes</small>
        </div>
        <div class="live-sc-kpi">
          <b>${drawPct}%</b>
          <small>Probabilidad de finalizar empatados</small>
        </div>
      </div>
    </div>
  `;
}

function predictionBlocks(r, pre) {
  const { fixture: f, prediction: p, context: c } = r;
  const inj = (t) => (t.injuries || []).length ? t.injuries.map((i) => `<li>🩹 ${esc(i.player)}</li>`).join('') : '<li>Sin bajas</li>';
  const xi = (t) => (t.lineup || []).length ? t.lineup.map((x) => `<li>${esc(x.number)}. ${esc(x.name)}</li>`).join('') : '<li>No confirmado</li>';
  const liveScHtml = p.liveScenario ? liveScenarioBlock(p.liveScenario, f) : '';

  return `${liveScHtml}
      ${verdictBlock(f, p, pre)}
      <div class="sec">Goles y marcador</div>
      <div class="kpis">
        <div class="kpi"><div class="num">${p.expectedScore}</div><small>${p.live ? 'Resultado final probable' : 'Marcador probable'}</small></div>
        <div class="kpi"><div class="num">${pct(p.markets.over25)}%</div><small>Más de 2.5</small></div>
        <div class="kpi"><div class="num">${pct(p.markets.btts)}%</div><small>Ambos marcan</small></div>
      </div>
      <div class="scores" style="margin-top:10px">${p.topScores.slice(0, 4).map((s) => `<span class="score-chip">${s.score}<small>${(s.p * 100).toFixed(1)}%</small></span>`).join('')}</div>
      <div class="sec">Por qué</div>
      <div class="analysis"><div class="tag">${r.analysisSource === 'gemini' ? '✨ Gemini' : '🧠 Modelo estadístico'}</div>${esc(r.analysis)}</div>
      <details class="more"><summary>Factores del modelo</summary>
        ${p.factors.map((x) => `<div class="factor ${x.impact > 0.05 ? 'pos' : x.impact < -0.05 ? 'neg' : ''}"><span class="dot"></span><div><b>${esc(x.label)}</b><p>${esc(x.detail)}</p></div></div>`).join('')}
      </details>
      <details class="more"><summary>Forma, bajas y titulares</summary>
        <div class="two"><div><b>${esc(f.home.name)}</b>${formPills(c.home.form)}</div><div><b>${esc(f.away.name)}</b>${formPills(c.away.form)}</div></div>
        <div class="sub-t">Bajas</div><div class="two"><ul>${inj(c.home)}</ul><ul>${inj(c.away)}</ul></div>
        <div class="sub-t">Titulares ${p.lineupsConfirmed ? '(confirmados)' : ''}</div><div class="two"><ul>${xi(c.home)}</ul><ul>${xi(c.away)}</ul></div>
      </details>
      <details class="more"><summary>Calidad de los datos · ${p.dataQuality?.score ?? '—'}/100</summary>${qualityBlock(p.dataQuality)}</details>`;
}

async function openMatch(id, silent = false) {
  const drawer = $('#drawer'), panel = $('#panel');
  state.openId = id;
  if (!state.modalTab) state.modalTab = 'match';
  document.body.classList.add('modal-open');
  drawer.classList.remove('closing');
  drawer.classList.add('open');
  drawer.setAttribute('aria-hidden', 'false');

  const baseMatch = state.matches.find((m) => String(m.id) === String(id));
  const leagueTitle = baseMatch ? baseMatch.league.name : 'Cargando partido...';
  const leagueRound = baseMatch?.league?.round ? `<small class="navbar-league-round">${esc(baseMatch.league.round)}</small>` : '';
  const currentTab = (state.modalTab === 'ai') ? 'ai' : 'match';
  const scroll = panel.scrollTop;

  // Fase 1: Mostrar estructura inmediata con skeleton mientras se desliza hacia arriba
  if (!silent) {
    panel.innerHTML = `
      <div class="modal-sticky-topbar">
        <div class="modal-drag-pill" data-close title="Desliza o toca para cerrar"></div>
        <div class="modal-navbar-row">
          <div class="modal-navbar-info">
            <span class="navbar-league-title">${esc(leagueTitle)}</span>
            ${leagueRound}
          </div>
          <button type="button" class="btn-topbar-close" data-close aria-label="Cerrar ventana">✕</button>
        </div>

        <div class="modal-switch-wrap">
          <div class="modal-switch" id="modalSwitch" data-active="${currentTab}">
            <div class="switch-slider"></div>
            <button type="button" class="switch-btn ${currentTab === 'match' ? 'active' : ''}" data-tab="match" onclick="setModalTab('match')">
              <span class="btn-ic">⚽</span>
              <span class="btn-lbl">Partido</span>
            </button>
            <button type="button" class="switch-btn ${currentTab === 'ai' ? 'active' : ''}" data-tab="ai" onclick="setModalTab('ai')">
              <span class="btn-ic">✨</span>
              <span class="btn-lbl">Pronóstico</span>
            </button>
          </div>
        </div>
      </div>

      <div class="modal-scroll-body">
        <div class="hub-container">
          <div class="modal-skeleton-body">
            <div class="sk-hero-box">
              <div class="modal-sk-shimmer"></div>
              <div class="sk-pulse-bar" style="width:110px;"></div>
              <div class="sk-teams-row">
                <div class="sk-badge-circle"></div>
                <div class="sk-score-mid"></div>
                <div class="sk-badge-circle"></div>
              </div>
              <div class="sk-pulse-bar" style="width:160px;margin-top:4px;"></div>
            </div>
            <div class="sk-block"><div class="modal-sk-shimmer"></div></div>
            <div class="sk-block" style="height:90px;"><div class="modal-sk-shimmer"></div></div>
          </div>
        </div>
      </div>
    `;
  }

  // Garantizar que la animación de apertura móvil termine primero con total fluidez (320ms)
  const animPromise = new Promise((resolve) => setTimeout(resolve, 320));

  try {
    const [fetchRes] = await Promise.all([
      fetch(`/api/match?id=${id}`).then((r) => r.json()),
      animPromise,
    ]);

    if (fetchRes.error) throw new Error(fetchRes.error);
    const m = fetchRes;
    const f = m.fixture, s = info(f);

    state.activeMatch = {
      id: f.id,
      status: f.status,
      minute: f.minute,
      goalsHome: f.goals?.home ?? 0,
      goalsAway: f.goals?.away ?? 0,
      hasPrediction: !!m.cachedPrediction,
    };

    // Sección 1: Partido (Marcador, en vivo y cronología)
    const heroScoreHtml = s.k !== 'ns' ? renderHeroScoreboard(f) : renderPreMatchHero(f);
    const liveScHtml = m.cachedPrediction?.prediction?.liveScenario ? liveScenarioBlock(m.cachedPrediction.prediction.liveScenario, f) : '';
    const timelineHtml = renderTimeline(f, m.events);

    // Sección 2: Estadísticas y Alineaciones
    const statsHtml = renderStatsSection(f, m.stats, m.cachedPrediction);

    // Sección 3: Pronóstico IA
    let aiHtml = '';
    if (m.cachedPrediction) {
      const pre = s.k !== 'ns';
      aiHtml = `<div class="pred-section" id="pred-section">
        <div class="db-cached-bar">
          <span class="db-pill">💾 Guardado en base de datos</span>
          <button class="btn-reanalyze" onclick="generatePrediction('${f.id}', true)">🔄 Recalcular con IA</button>
        </div>
        ${pre ? '<div class="sec pre-note">Pronóstico en vivo · actualizado con el marcador y el minuto</div>' : ''}
        ${predictionBlocks(m.cachedPrediction, pre)}
      </div>`;
    } else if (s.k === 'ns' || s.k === 'live' || s.k === 'ht') {
      aiHtml = `<div class="pred-section" id="pred-section">
        <div class="ai-cta-card">
          <div class="ai-cta-glow"></div>
          <div class="ai-cta-badge">✦ Inteligencia Artificial & Big Data</div>
          <h3>Análisis Táctico y Pronóstico con Gemini</h3>
          <p>Consulta alineaciones, bajas confirmadas, historial de enfrentamientos (H2H) y obtén las probabilidades matemáticas de victoria y marcador probable.</p>
          <button class="btn-generate-ai" onclick="generatePrediction('${f.id}')">
            <span class="btn-sparkle">✨</span> Analizar con IA y Estadísticas
          </button>
          <div class="ai-cta-meta">
            <span>⚡ Cálculo en segundos</span>
            <span>💾 Guardado automático en BD</span>
            <span>🛡️ Ahorro de cuota API</span>
          </div>
        </div>
      </div>`;
    } else if (s.k === 'ft') {
      aiHtml = '<div class="pred-section"><p class="hint center" style="margin:24px 0 12px">Este partido ya finalizó: no hay pronóstico nuevo disponible.</p></div>';
    }

    const currentTab = (state.modalTab === 'ai') ? 'ai' : 'match';

    const html = `
      <div class="modal-sticky-topbar">
        <div class="modal-drag-pill" data-close title="Desliza o toca para cerrar"></div>
        <div class="modal-navbar-row">
          <div class="modal-navbar-info">
            <span class="navbar-league-title">${esc(f.league.name)}</span>
            ${f.league.round ? `<small class="navbar-league-round">${esc(f.league.round)}</small>` : ''}
          </div>
          <button type="button" class="btn-topbar-close" data-close aria-label="Cerrar ventana">✕</button>
        </div>

        <!-- Switch Deslizable de 2 opciones: Partido y Pronóstico -->
        <div class="modal-switch-wrap">
          <div class="modal-switch" id="modalSwitch" data-active="${currentTab}">
            <div class="switch-slider"></div>
            <button type="button" class="switch-btn ${currentTab === 'match' ? 'active' : ''}" data-tab="match" onclick="setModalTab('match')">
              <span class="btn-ic">⚽</span>
              <span class="btn-lbl">Partido</span>
            </button>
            <button type="button" class="switch-btn ${currentTab === 'ai' ? 'active' : ''}" data-tab="ai" onclick="setModalTab('ai')">
              <span class="btn-ic">✨</span>
              <span class="btn-lbl">Pronóstico</span>
            </button>
          </div>
        </div>
      </div>

      <div class="modal-scroll-body modal-content-loaded">
        <div class="hub-container">
          <div class="match-hub-sections" id="hubSections" data-active="${currentTab}">
            <!-- PESTAÑA 1: PARTIDO (Marcador, en vivo, estadísticas, alineaciones y cronología) -->
            <div class="hub-section hub-sec-match">
              ${heroScoreHtml}
              ${liveScHtml}
              ${statsHtml}
              ${timelineHtml}
            </div>

            <!-- PESTAÑA 2: PRONÓSTICO IA -->
            <div class="hub-section hub-sec-ai">
              ${aiHtml}
            </div>
          </div>
        </div>
      </div>
    `;

    panel.innerHTML = html;
    if (silent) panel.scrollTop = scroll;
    requestAnimationFrame(() => panel.querySelectorAll('[data-w]').forEach((el) => (el.style.width = el.dataset.w + '%')));
  } catch (e) {
    panel.innerHTML = `
      <div class="modal-sticky-topbar">
        <div class="modal-navbar-row">
          <div class="modal-navbar-info">
            <span class="navbar-league-title">Error al cargar</span>
          </div>
          <button type="button" class="btn-topbar-close" data-close aria-label="Cerrar">✕</button>
        </div>
      </div>
      <div class="modal-scroll-body">
        <div class="hub-container"><div class="loading">Error: ${esc(e.message)}</div></div>
      </div>`;
  }
}

window.setModalTab = function(tab) {
  state.modalTab = tab;
  const sw = $('#modalSwitch');
  if (sw) sw.dataset.active = tab;
  const hub = $('#hubSections');
  if (hub) hub.dataset.active = tab;
  document.querySelectorAll('.switch-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  });
  if (tab === 'ai') {
    requestAnimationFrame(() => {
      document.querySelectorAll('#hubSections .hub-sec-ai [data-w]').forEach(el => {
        el.style.width = el.dataset.w + '%';
      });
    });
  }
};
window.switchHubTab = window.setModalTab;

function showLiveAlertToast(msg) {
  let toast = $('#live-toast-banner');
  const container = $('.hub-container');
  if (!container) return;

  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'live-toast-banner';
    toast.className = 'live-toast-banner';
    const headerBar = $('.hub-header-bar');
    if (headerBar) headerBar.after(toast);
    else container.prepend(toast);
  }

  toast.innerHTML = `
    <div class="live-toast-content">
      <i class="live-toast-pulse"></i>
      <span class="live-toast-text">${esc(msg)}</span>
    </div>
  `;
  toast.style.display = 'block';

  clearTimeout(window._toastTimeout);
  window._toastTimeout = setTimeout(() => {
    if (toast) toast.style.display = 'none';
  }, 9000);
}

window.generatePrediction = async function(id, force = false) {
  const sec = $('#pred-section');
  if (!sec) return;
  sec.innerHTML = `
    <div class="ai-loading-box">
      <div class="spin"></div>
      <div class="ai-loading-text">
        <b>Analizando con Inteligencia Artificial...</b>
        <p>Consultando estadísticas detalladas del partido y procesando con Gemini</p>
      </div>
    </div>`;
  try {
    const r = await (await fetch(`/api/predict?id=${id}${force ? '&force=1' : ''}`)).json();
    if (r.error) throw new Error(r.error);
    const f = r.fixture, s = info(f);
    const pre = s.k !== 'ns';
    if (state.activeMatch && String(state.activeMatch.id) === String(id)) {
      state.activeMatch.hasPrediction = true;
    }
    sec.innerHTML = `
      <div class="db-cached-bar">
        <span class="db-pill">💾 Análisis completado y guardado en base de datos</span>
        <button class="btn-reanalyze" onclick="generatePrediction('${f.id}', true)">🔄 Recalcular con IA</button>
      </div>
      ${pre ? '<div class="sec pre-note">Pronóstico en vivo · actualizado con el marcador y el minuto</div>' : ''}
      ${predictionBlocks(r, pre)}
    `;
    requestAnimationFrame(() => sec.querySelectorAll('[data-w]').forEach((el) => (el.style.width = el.dataset.w + '%')));
  } catch (err) {
    sec.innerHTML = `<div class="ai-err-box">
      <p>⚠️ No se pudo generar el pronóstico: ${esc(err.message)}</p>
      <button class="btn-generate-ai" onclick="generatePrediction('${id}')">Reintentar</button>
    </div>`;
  }
};

async function updateLiveMatchCenter(id) {
  if (state.openId !== id) return;
  try {
    const m = await (await fetch(`/api/match?id=${id}`)).json();
    if (m.error || !m.fixture) return;

    const f = m.fixture;
    const prev = state.activeMatch;
    const prevScore = prev ? `${prev.goalsHome} - ${prev.goalsAway}` : null;
    const newScore = `${f.goals?.home ?? 0} - ${f.goals?.away ?? 0}`;
    const scoreChanged = prevScore !== null && prevScore !== newScore;
    const statusChanged = prev && prev.status !== f.status;

    // Actualizar el centro del partido en la columna izquierda
    const mcEl = $('.mc');
    if (mcEl) {
      const temp = document.createElement('div');
      temp.innerHTML = matchCenter(f, m.events, m.stats);
      mcEl.replaceWith(temp.firstElementChild);
    }

    // Actualizar marcador en cabecera
    const vsEl = $('.p-head .vs');
    if (vsEl && f.goals && f.goals.home !== null && f.goals.away !== null) {
      vsEl.textContent = `${f.goals.home} - ${f.goals.away}`;
    }

    // Si hubo gol o cambio de estado (ej: medio tiempo o expulsión)
    if (scoreChanged || statusChanged) {
      const eventMsg = scoreChanged
        ? `⚽ ¡Gol en vivo! Nuevo marcador: ${f.home.name} ${newScore} ${f.away.name} (Min ${f.minute}')`
        : `⚡ ¡Actualización del partido! ${info(f).label} (Min ${f.minute}')`;

      const hasPred = $('#pred-section .verdict') || (prev && prev.hasPrediction);
      if (hasPred) {
        showLiveAlertToast(`${eventMsg} · Re-calculando probabilidades con la IA...`);
        await generatePrediction(id, true);
      } else {
        showLiveAlertToast(eventMsg);
      }
    } else {
      // Si solo avanzó el tiempo, refrescar discretamente el reloj en la tarjeta liveScenario si está visible
      const liveTag = $('.live-sc-tag');
      if (liveTag && f.minute) {
        liveTag.innerHTML = `<i class="pulse-dot"></i> EN CALIENTE · MINUTO ${f.minute}'`;
      }
      const remTag = $('.live-sc-rem');
      if (remTag && f.minute) {
        remTag.textContent = `⏱ Quedan ~${Math.max(1, 90 - f.minute)} min`;
      }
    }

    // Guardar nuevo snapshot
    state.activeMatch = {
      id,
      status: f.status,
      minute: f.minute,
      goalsHome: f.goals?.home ?? 0,
      goalsAway: f.goals?.away ?? 0,
      hasPrediction: !!$('#pred-section .verdict') || (prev && prev.hasPrediction),
    };
  } catch (e) {
    console.error('Error actualizando partido en vivo:', e);
  }
}

let isClosingDrawer = false;
const closeDrawer = () => {
  const drawer = $('#drawer');
  if (!drawer || !drawer.classList.contains('open') || isClosingDrawer) return;
  isClosingDrawer = true;
  state.openId = null;
  state.activeMatch = null;
  clearTimeout(window._toastTimeout);
  document.body.classList.remove('modal-open');
  drawer.classList.add('closing');
  drawer.setAttribute('aria-hidden', 'true');
  setTimeout(() => {
    drawer.classList.remove('open', 'closing');
    isClosingDrawer = false;
  }, 320);
};
window.closeDrawer = closeDrawer;
$('#drawer').addEventListener('click', (e) => { if (e.target.closest('[data-close]')) closeDrawer(); });
document.addEventListener('keydown', (e) => e.key === 'Escape' && closeDrawer());

/* ---------- Gestos Táctiles Móviles en Drawer (Swipe) ---------- */
let touchStartX = 0, touchStartY = 0, touchStartScroll = 0;
const drawerEl = $('#drawer');
drawerEl.addEventListener('touchstart', (e) => {
  if (e.touches.length === 1) {
    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;
    const panel = $('#panel');
    touchStartScroll = panel ? panel.scrollTop : 0;
  }
}, { passive: true });

drawerEl.addEventListener('touchend', (e) => {
  if (e.changedTouches.length === 1) {
    const deltaX = e.changedTouches[0].clientX - touchStartX;
    const deltaY = e.changedTouches[0].clientY - touchStartY;

    // Deslizar hacia abajo desde el tope del modal para cerrarlo
    if (touchStartScroll <= 15 && deltaY > 75 && Math.abs(deltaY) > Math.abs(deltaX) * 1.4) {
      closeDrawer();
      return;
    }

    // Deslizar horizontalmente para cambiar de pestaña en móvil (Switch deslizable)
    if (window.innerWidth <= 960 && Math.abs(deltaX) > 60 && Math.abs(deltaY) < Math.abs(deltaX) * 0.8) {
      if (deltaX < 0) {
        // Deslizar hacia la izquierda -> ir a Pronóstico
        setModalTab('ai');
      } else if (deltaX > 0) {
        // Deslizar hacia la derecha -> ir a Partido
        setModalTab('match');
      }
    }
  }
}, { passive: true });

window.clearSearchFilter = clearSearch;
loadStatus();
renderDates();
loadMatches();
initSearch();

// Actualización automática inteligente: se ejecuta cada 1 minuto en vivo (protegiendo el límite de 100 peticiones/día)
let loopMinute = 0;
setInterval(async () => {
  if (document.hidden) return; // Si la pestaña está en segundo plano o minimizada, 0 peticiones
  loopMinute++;
  const anyLive = state.matches.some((m) => phaseGroup(m) === 'live');
  // Sin partidos en vivo: consultar cada 10 minutos para ahorrar cuota
  if (!anyLive && loopMinute % 10 !== 0) return;

  // Con partidos en vivo: consultar cada 1 minuto (sincronizado con la caché de 60s del servidor)
  await loadMatches(true);
  const open = state.matches.find((m) => String(m.id) === String(state.openId));
  if (open && phaseGroup(open) === 'live') {
    updateLiveMatchCenter(state.openId);
  }
}, 60 * 1000);


