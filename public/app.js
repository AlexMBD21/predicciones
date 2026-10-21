const $ = (s) => document.querySelector(s);
const pct = (v) => Math.round(v * 100);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const pad = (n) => String(n).padStart(2, '0');
const localIso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const userTz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Bogota';

let state = { date: localIso(new Date()), league: 'all', phase: 'all', matches: [], openId: null };

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
  const [label, k] = PHASES[m.status] || ['Programado', 'ns'];
  const clock = ['1H', '2H', 'ET'].includes(m.status) && m.minute ? `${m.minute}${m.extra ? '+' + m.extra : ''}'` : '';
  const time = new Date(m.date).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
  return {
    k, label, clock, time,
    started: ['live', 'ht', 'ft'].includes(k),
    chip: k === 'ns' ? time : k === 'live' ? (clock ? `${clock} · En vivo` : label) : label,
  };
}

const chipHtml = (m) => {
  const i = info(m);
  return `<span class="st st-${i.k}">${i.k === 'live' ? '<i class="pulse-dot"></i>' : ''}${esc(i.chip)}</span>`;
};

function badge(t, size = '') {
  const initials = t.name.split(/\s+/).map((w) => w[0]).join('').slice(0, 3).toUpperCase();
  return `<div class="badge ${size}">${t.logo ? `<img src="${esc(t.logo)}" alt="Escudo ${esc(t.name)}" loading="lazy" onerror="this.replaceWith(document.createTextNode('${initials}'))">` : initials}</div>`;
}

async function loadStatus() {
  const s = await (await fetch('/api/status')).json();
  const el = $('#status');
  el.className = 'status-pill live';
  el.textContent = `En vivo · ${s.provider}${s.gemini ? ' + Gemini' : ''}`;
}

function renderDates() {
  const wrap = $('#dates');
  wrap.innerHTML = '';
  for (let i = -2; i <= 5; i++) {
    const d = new Date();
    d.setDate(d.getDate() + i);
    const dateStr = localIso(d);
    const b = document.createElement('button');
    b.className = 'date-btn' + (dateStr === state.date ? ' active' : '');
    b.innerHTML = `<small>${i === 0 ? 'Hoy' : d.toLocaleDateString('es', { weekday: 'short' })}</small><strong>${d.getDate()}</strong>`;
    b.onclick = () => { state.date = dateStr; state.league = 'all'; state.phase = 'all'; renderDates(); loadMatches(); };
    wrap.appendChild(b);
  }
}

async function fetchMatches() {
  const r = await (await fetch(`/api/matches?date=${state.date}&tz=${encodeURIComponent(userTz)}`)).json();
  if (r.error) throw new Error(r.error);
  state.matches = r.matches || [];
  state.warning = r.warning || null;
}

async function loadMatches(silent = false) {
  if (!silent) $('#matches').innerHTML = Array(6).fill('<div class="skeleton"></div>').join('');
  try {
    await fetchMatches();
    renderFilters();
    if (state.warning && state.matches.length === 0) {
      $('#matches').innerHTML = `
        <div class="quota-warning-card">
          <div class="quota-icon">⏳</div>
          <h3>Límite diario de API-Football alcanzado (100/día)</h3>
          <p>${esc(state.warning)}</p>
          <small>La cuota se renueva a las 00:00 UTC. Todos los partidos y pronósticos analizados previamente continúan disponibles en la base de datos local SQLite.</small>
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
  const count = (g) => state.matches.filter((m) => phaseGroup(m) === g).length;
  const phases = [['all', 'Todos', state.matches.length], ['live', 'En vivo', count('live')], ['ns', 'Pr\u00f3ximos', count('ns')], ['ft', 'Finalizados', count('ft')]];
  const ph = $('#statuses');
  ph.innerHTML = phases.map(([k, l, n]) => `<button class="chip ${state.phase === k ? 'active' : ''} ${k === 'live' && n ? 'hot' : ''}" data-p="${k}">${l} <b>${n}</b></button>`).join('');
  ph.onclick = (e) => { const p = e.target.closest('[data-p]')?.dataset.p; if (p) { state.phase = p; renderFilters(); renderMatches(); } };

  const names = [...new Set(state.matches.map((m) => m.league.name))].slice(0, 30);
  const wrap = $('#leagues');
  wrap.innerHTML = ['all', ...names].map((n) => `<button class="chip ${state.league === n ? 'active' : ''}" data-l="${esc(n)}">${n === 'all' ? 'Todas las ligas' : esc(n)}</button>`).join('');
  wrap.onclick = (e) => { const l = e.target.dataset.l; if (l) { state.league = l; renderFilters(); renderMatches(); } };
}

function renderMatches() {
  const order = { live: 0, ns: 1, ft: 2, bad: 3 };
  const list = state.matches
    .filter((m) => (state.league === 'all' || m.league.name === state.league) && (state.phase === 'all' || phaseGroup(m) === state.phase))
    .sort((a, b) => (state.phase === 'all' ? order[phaseGroup(a)] - order[phaseGroup(b)] : 0) || a.date.localeCompare(b.date));
  if (!list.length) { $('#matches').innerHTML = '<div class="empty">No hay partidos con este filtro.</div>'; return; }
  $('#matches').innerHTML = list.map((m, i) => {
    const s = info(m);
    const g = m.goals || {};
    const hw = s.k === 'ft' && g.home > g.away, aw = s.k === 'ft' && g.away > g.home;
    const mid = s.started
      ? `<div class="vs score">${g.home ?? 0} - ${g.away ?? 0}${m.halftime && s.k !== 'ht' ? `<small>MT ${m.halftime.home}-${m.halftime.away}</small>` : ''}</div>`
      : '<div class="vs">VS</div>';
    const cta = s.k === 'live' || s.k === 'ht' ? 'Ver en vivo y pron\u00f3stico \u2192' : s.k === 'ft' ? 'Ver resumen del partido \u2192' : s.k === 'bad' ? 'Ver detalles \u2192' : 'Ver pron\u00f3stico IA \u2192';
    return `<article class="card ${s.k}" style="animation-delay:${Math.min(i, 12) * 40}ms" data-id="${m.id}" tabindex="0">
      <div class="card-top"><span class="lgname">${m.league.logo ? `<img src="${esc(m.league.logo)}" alt="" loading="lazy" onerror="this.remove()">` : ''}${esc(m.league.name)}</span>${chipHtml(m)}</div>
      <div class="teams">
        <div class="team ${hw ? 'win' : ''}">${badge(m.home)}<span>${esc(m.home.name)}</span></div>
        ${mid}
        <div class="team ${aw ? 'win' : ''}">${badge(m.away)}<span>${esc(m.away.name)}</span></div>
      </div>
      <div class="card-cta">${cta}</div></article>`;
  }).join('');
  document.querySelectorAll('.card').forEach((c) => {
    c.onclick = () => openMatch(c.dataset.id);
    c.onkeydown = (e) => e.key === 'Enter' && openMatch(c.dataset.id);
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
  let icon = '\u2022', text = esc(e.player || '');
  if (e.type === 'Goal') {
    icon = '\u26BD';
    const tag = e.detail === 'Own Goal' ? ' (autogol)' : e.detail === 'Penalty' ? ' (penal)' : e.detail === 'Missed Penalty' ? ' (penal fallado)' : '';
    if (e.detail === 'Missed Penalty') icon = '\u274C';
    text = `<b>${esc(e.player)}</b>${tag}${e.assist ? `<small>Asist. ${esc(e.assist)}</small>` : ''}`;
  } else if (e.type === 'Card') {
    icon = e.detail === 'Red Card' ? '\u{1F7E5}' : '\u{1F7E8}';
    text = `${esc(e.player)}`;
  } else if (e.type === 'subst') {
    icon = '\u{1F504}';
    text = `${esc(e.assist || '')}<small>Sale ${esc(e.player)}</small>`;
  } else if (e.type === 'Var') {
    icon = 'VAR';
    text = `${esc(e.detail)}`;
  }
  return `<div class="ev ${e.team}"><span class="ev-min">${min}</span><span class="ev-ic">${icon}</span><span class="ev-tx">${text}</span></div>`;
}

const num = (v) => { const n = parseFloat(String(v ?? '0').replace('%', '')); return Number.isFinite(n) ? n : 0; };

function statBar(s) {
  const a = num(s.home), b = num(s.away), t = a + b || 1;
  return `<div class="stat"><div class="stat-row"><b>${esc(s.home ?? 0)}</b><span>${esc(s.label)}</span><b>${esc(s.away ?? 0)}</b></div>
    <div class="stat-bars"><i class="sh" style="width:${(a / t) * 100}%"></i><i class="sa" style="width:${(b / t) * 100}%"></i></div></div>`;
}

function matchCenter(m, events, stats) {
  const s = info(m), g = m.goals || {};
  const notes = {
    ht: 'Descanso. El segundo tiempo comienza en breve.',
    ft: 'El partido ha terminado.',
    bad: m.statusLong ? `Estado: ${m.statusLong}.` : 'El partido no se juega en la fecha prevista.',
    live: 'Partido en juego. Se actualiza cada minuto.',
  };
  const score = s.started ? `${g.home ?? 0} - ${g.away ?? 0}` : '\u2014';
  const showEvents = events.filter((e) => e.type !== 'subst');
  const subs = events.filter((e) => e.type === 'subst');
  return `<div class="mc mc-${s.k}">
    <div class="mc-top">${chipHtml(m)}${m.referee ? `<small>\u00c1rbitro: ${esc(m.referee)}</small>` : ''}</div>
    <div class="mc-score"><span>${esc(m.home.name)}</span><b>${score}</b><span>${esc(m.away.name)}</span></div>
    <div class="mc-sub">${m.halftime && s.started ? `Medio tiempo ${m.halftime.home}-${m.halftime.away}` : ''}${m.penalty && m.penalty.home !== null ? ` \u00b7 Penales ${m.penalty.home}-${m.penalty.away}` : ''}</div>
    <p class="mc-note">${notes[s.k] || ''}</p>
    ${showEvents.length ? `<div class="sec">Cronolog\u00eda</div><div class="events">${showEvents.map((e) => eventRow(e, m)).join('')}</div>` : (s.started ? '<p class="mc-note">Sin eventos registrados todav\u00eda.</p>' : '')}
    ${stats.length ? `<div class="sec">Estad\u00edsticas del partido</div><div class="stats">${stats.map(statBar).join('')}</div>` : ''}
    ${subs.length ? `<details class="more"><summary>Cambios (${subs.length})</summary><div class="events">${subs.map((e) => eventRow(e, m)).join('')}</div></details>` : ''}
  </div>`;
}

function headBlock(f) {
  return `
    <button class="hub-close-circle" data-close aria-label="Cerrar">✕</button>
    <div class="hub-header-bar">
      <small class="hub-meta-title">${esc(f.league.name)}${f.league.round ? ' · ' + esc(f.league.round) : ''}${f.venue ? ' · ' + esc(f.venue) : ''}</small>
    </div>
    <div class="p-head">
      <div class="p-teams">${badge(f.home, 'lg')}<span class="vs">VS</span>${badge(f.away, 'lg')}</div>
      <h2>${esc(f.home.name)} vs ${esc(f.away.name)}</h2>
      <small>${new Date(f.date).toLocaleString('es', { dateStyle: 'medium', timeStyle: 'short' })}</small>
    </div>`;
}


function preMatchCenter(f) {
  return `<div class="mc mc-ns">
    <div class="mc-top"><span class="st st-ns">Programado</span>${f.referee ? `<small>Árbitro: ${esc(f.referee)}</small>` : ''}</div>
    <div class="mc-score"><span>${esc(f.home.name)}</span><b>VS</b><span>${esc(f.away.name)}</span></div>
    <div class="mc-sub">${f.venue ? `Estadio: ${esc(f.venue)}` : ''}</div>
    <p class="mc-note" style="margin-top:10px;">Partido programado. Las alineaciones oficiales se confirman típicamente 45-60 minutos antes del saque inicial.</p>
    <div class="sec">Detalles del encuentro</div>
    <div class="kpis" style="margin-top:8px;">
      <div class="kpi"><div class="num" style="font-size:1.05rem;">${esc(f.league.country || 'Internacional')}</div><small>País</small></div>
      <div class="kpi"><div class="num" style="font-size:1.05rem;">${esc(f.league.round || 'Jornada regular')}</div><small>Ronda</small></div>
      <div class="kpi"><div class="num" style="font-size:1.05rem;">${new Date(f.date).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' })}</div><small>Hora local</small></div>
    </div>
  </div>`;
}

function predictionBlocks(r, pre) {
  const { fixture: f, prediction: p, context: c } = r;
  const inj = (t) => (t.injuries || []).length ? t.injuries.map((i) => `<li>🩹 ${esc(i.player)}</li>`).join('') : '<li>Sin bajas</li>';
  const xi = (t) => (t.lineup || []).length ? t.lineup.map((x) => `<li>${esc(x.number)}. ${esc(x.name)}</li>`).join('') : '<li>No confirmado</li>';
  return `${verdictBlock(f, p, pre)}
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
  document.body.classList.add('modal-open');
  drawer.classList.add('open');
  drawer.setAttribute('aria-hidden', 'false');
  const scroll = panel.scrollTop;
  if (!silent) panel.innerHTML = '<div class="hub-container"><div class="loading"><div class="spin"></div>Cargando datos del partido…</div></div>';
  try {
    const m = await (await fetch(`/api/match?id=${id}`)).json();
    if (m.error) throw new Error(m.error);
    const f = m.fixture, s = info(f);

    const leftCol = s.k !== 'ns' ? matchCenter(f, m.events, m.stats) : preMatchCenter(f);

    let rightCol = '';
    if (m.cachedPrediction) {
      const pre = s.k !== 'ns';
      rightCol = `<div class="pred-section" id="pred-section">
        <div class="db-cached-bar">
          <span class="db-pill">💾 Guardado en base de datos</span>
          <button class="btn-reanalyze" onclick="generatePrediction('${f.id}', true)">🔄 Recalcular con IA</button>
        </div>
        ${pre ? '<div class="sec pre-note">Pronóstico en vivo · actualizado con el marcador y el minuto</div>' : ''}
        ${predictionBlocks(m.cachedPrediction, pre)}
      </div>`;
    } else if (s.k === 'ns' || s.k === 'live' || s.k === 'ht') {
      rightCol = `<div class="pred-section" id="pred-section">
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
      rightCol = '<div class="pred-section"><p class="hint center" style="margin:24px 0 12px">Este partido ya finalizó: no hay pronóstico nuevo disponible.</p></div>';
    }

    const html = `
      <div class="hub-container">
        ${headBlock(f)}
        <div class="hub-tabs-mobile" id="hub-tabs">
          <button class="hub-tab active" onclick="switchHubTab('live')">⚽ Partido y Estadísticas</button>
          <button class="hub-tab" onclick="switchHubTab('ai')">✨ Pronóstico IA</button>
        </div>
        <div class="match-hub-grid" id="hub-grid" data-active="live">
          <div class="hub-col hub-live-col">
            ${leftCol}
          </div>
          <div class="hub-col hub-ai-col">
            ${rightCol}
          </div>
        </div>
      </div>
    `;

    panel.innerHTML = html;
    if (silent) panel.scrollTop = scroll;
    requestAnimationFrame(() => panel.querySelectorAll('[data-w]').forEach((el) => (el.style.width = el.dataset.w + '%')));
  } catch (e) {
    panel.innerHTML = `<div class="hub-container"><div class="hub-navbar"><button class="hub-back-btn" data-close>← Volver</button><button class="hub-close-circle" data-close>✕</button></div><div class="loading">Error: ${esc(e.message)}</div></div>`;
  }
}

window.switchHubTab = function(tab) {
  const grid = $('#hub-grid');
  if (grid) grid.dataset.active = tab;
  document.querySelectorAll('.hub-tab').forEach(b => {
    b.classList.toggle('active', (tab === 'live' && b.innerText.includes('Partido')) || (tab === 'ai' && b.innerText.includes('Pronóstico')));
  });
};

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
    const mcEl = $('.mc');
    if (mcEl) {
      const temp = document.createElement('div');
      temp.innerHTML = matchCenter(m.fixture, m.events, m.stats);
      mcEl.replaceWith(temp.firstElementChild);
    }
  } catch {}
}

const closeDrawer = () => { state.openId = null; $('#drawer').classList.remove('open'); $('#drawer').setAttribute('aria-hidden', 'true'); };
$('#drawer').addEventListener('click', (e) => { if (e.target.closest('[data-close]')) closeDrawer(); });
document.addEventListener('keydown', (e) => e.key === 'Escape' && closeDrawer());

loadStatus();
renderDates();
loadMatches();

// Actualización automática inteligente: cuida la cuota de 100 peticiones/día
let tick = 0;
setInterval(async () => {
  if (document.hidden) return; // Si la pestaña está minimizada u oculta, 0 peticiones
  tick++;
  const anyLive = state.matches.some((m) => phaseGroup(m) === 'live');
  // Sin partidos en vivo: cada 10 minutos. Con partidos en vivo: cada 2.5 minutos.
  if (!anyLive && tick % 10 !== 0) return;
  if (anyLive && tick % 3 !== 0) return;
  await loadMatches(true);
  const open = state.matches.find((m) => String(m.id) === String(state.openId));
  if (open && phaseGroup(open) === 'live') {
    updateLiveMatchCenter(state.openId);
  }
}, 50 * 1000);


