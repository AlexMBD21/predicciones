// Limpieza y validación de datos. Ninguna entrada externa llega al modelo sin pasar por aquí.

const STATUSES = new Set(['TBD', 'NS', '1H', 'HT', '2H', 'ET', 'BT', 'P', 'SUSP', 'INT', 'FT', 'AET', 'PEN', 'PST', 'CANC', 'ABD', 'AWD', 'WO', 'LIVE']);
const LOGO_HOSTS = new Set(['media.api-sports.io', 'media-1.api-sports.io', 'media-2.api-sports.io', 'media-3.api-sports.io']);

export class ValidationError extends Error {
  constructor(message) { super(message); this.status = 400; }
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const int = (v) => { if (v === null || v === undefined || v === '') return null; const n = Number(v); return Number.isInteger(n) ? n : null; };
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const text = (v, max = 80) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, max) : '');

// ---------- Parámetros de entrada ----------
export function parseDate(raw) {
  if (!raw) return new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) throw new ValidationError('Fecha inválida. Usa el formato AAAA-MM-DD.');
  const d = new Date(raw + 'T00:00:00Z');
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== raw) throw new ValidationError('La fecha no existe.');
  const diffDays = Math.abs(d.getTime() - Date.now()) / 86400000;
  if (diffDays > 400) throw new ValidationError('Fecha fuera de rango (máx. ±1 año).');
  return raw;
}

export function parseId(raw) {
  if (!/^\d{1,12}$/.test(raw || '')) throw new ValidationError('Identificador de partido inválido.');
  return raw;
}

// ---------- Logos ----------
export const teamLogo = (id) => (int(id) ? `https://media.api-sports.io/football/teams/${id}.png` : null);
export const leagueLogo = (id) => (int(id) ? `https://media.api-sports.io/football/leagues/${id}.png` : null);

function safeLogo(url, fallback) {
  try {
    const u = new URL(url);
    if (u.protocol === 'https:' && LOGO_HOSTS.has(u.hostname)) return u.href;
  } catch {}
  return fallback;
}

// ---------- Partidos ----------
export function cleanFixtures(list) {
  const seen = new Set();
  const out = [];
  let dropped = 0;
  for (const f of Array.isArray(list) ? list : []) {
    const id = int(f?.id);
    const date = new Date(f?.date);
    const home = { id: int(f?.home?.id), name: text(f?.home?.name) };
    const away = { id: int(f?.away?.id), name: text(f?.away?.name) };
    const lid = int(f?.league?.id);
    const bad =
      !id || seen.has(id) || Number.isNaN(date.getTime()) ||
      !home.id || !away.id || !home.name || !away.name ||
      home.id === away.id || home.name.toLowerCase() === away.name.toLowerCase() ||
      !lid || !text(f?.league?.name);
    if (bad) { dropped++; continue; }
    seen.add(id);
    const g = (v) => { const n = int(v); return n !== null && n >= 0 && n < 30 ? n : null; };
    out.push({
      id,
      date: date.toISOString(),
      status: STATUSES.has(f.status) ? f.status : 'NS',
      statusLong: text(f.statusLong, 40) || null,
      minute: int(f.minute),
      extra: int(f.extra),
      referee: text(f.referee, 60) || null,
      halftime: f.halftime && int(f.halftime.home) !== null ? { home: int(f.halftime.home), away: int(f.halftime.away) } : null,
      penalty: f.penalty && int(f.penalty.home) !== null ? { home: int(f.penalty.home), away: int(f.penalty.away) } : null,
      venue: text(f.venue, 120) || null,
      league: {
        id: lid, name: text(f.league.name), country: text(f.league.country) || '—',
        season: int(f.league.season) || new Date().getFullYear(),
        logo: safeLogo(f.league.logo, leagueLogo(lid)),
      },
      home: { ...home, logo: safeLogo(f.home.logo, teamLogo(home.id)) },
      away: { ...away, logo: safeLogo(f.away.logo, teamLogo(away.id)) },
      goals: { home: g(f.goals?.home), away: g(f.goals?.away) },
    });
  }
  out.sort((a, b) => a.date.localeCompare(b.date));
  return { fixtures: out, dropped };
}

// ---------- Contexto de un equipo ----------
function cleanTeam(t, issues, label) {
  const o = { id: t.id, name: text(t.name), logo: t.logo };

  // Forma: solo W/D/L, máximo 5
  const form = typeof t.form === 'string' ? t.form.toUpperCase().replace(/[^WDL]/g, '').slice(-5) : '';
  o.form = form;
  if (form.length < 5) issues.push({ level: form ? 'info' : 'warn', msg: `${label}: forma reciente incompleta (${form.length}/5).` });

  // Partidos jugados coherentes
  let played = int(t.played), ph = int(t.playedHome), pa = int(t.playedAway);
  if (played !== null && played < 0) played = null;
  if (ph !== null && ph < 0) ph = null;
  if (pa !== null && pa < 0) pa = null;
  if (played !== null && ph !== null && pa !== null && ph + pa !== played) {
    issues.push({ level: 'warn', msg: `${label}: partidos local+visitante no suman el total; se recalcula.` });
    played = ph + pa;
  }
  o.played = played ?? undefined; o.playedHome = ph ?? undefined; o.playedAway = pa ?? undefined;
  if (!played) issues.push({ level: 'warn', msg: `${label}: sin estadísticas de temporada; se usa la media de liga.` });

  // Promedios de goles: finitos y en rango razonable (0–6)
  for (const k of ['gfHome', 'gaHome', 'gfAway', 'gaAway']) {
    const v = num(t[k]);
    if (v === null) { o[k] = undefined; continue; }
    if (v < 0 || v > 6) {
      issues.push({ level: 'warn', msg: `${label}: ${k}=${v.toFixed(2)} fuera de rango; se ajusta.` });
      o[k] = clamp(v, 0, 6);
    } else o[k] = v;
  }

  // Bajas: sin duplicados, nombres válidos
  const seen = new Set();
  o.injuries = (Array.isArray(t.injuries) ? t.injuries : [])
    .map((i) => ({ player: text(i?.player, 60), reason: text(i?.reason, 60) || 'No especificado' }))
    .filter((i) => i.player && !seen.has(i.player.toLowerCase()) && seen.add(i.player.toLowerCase()))
    .slice(0, 15);

  // Alineación: exactamente 11 jugadores únicos, si no se descarta
  if (Array.isArray(t.lineup) && t.lineup.length) {
    const names = new Set();
    const lineup = t.lineup
      .map((p) => ({ name: text(p?.name, 60), number: int(p?.number), pos: ['G', 'D', 'M', 'F'].includes(p?.pos) ? p.pos : '' }))
      .filter((p) => p.name && !names.has(p.name.toLowerCase()) && names.add(p.name.toLowerCase()));
    if (lineup.length === 11) {
      o.lineup = lineup;
      o.formation = /^\d(-\d){1,4}$/.test(t.formation || '') ? t.formation : undefined;
      o.coach = text(t.coach, 60) || undefined;
    } else {
      issues.push({ level: 'warn', msg: `${label}: alineación inválida (${lineup.length} jugadores únicos); se ignora.` });
    }
  }
  return o;
}

export function cleanContext(raw) {
  const issues = [];
  const home = cleanTeam(raw.home, issues, 'Local');
  const away = cleanTeam(raw.away, issues, 'Visitante');

  // H2H: marcadores enteros plausibles
  const h2h = (raw.h2h || []).filter((m) => {
    const a = int(m.homeGoals), b = int(m.awayGoals);
    return a !== null && b !== null && a >= 0 && b >= 0 && a <= 15 && b <= 15;
  });
  if ((raw.h2h || []).length - h2h.length) issues.push({ level: 'info', msg: 'Se descartaron cruces históricos con marcadores inválidos.' });
  if (h2h.length < 2) issues.push({ level: 'info', msg: 'Historial directo insuficiente (<2 cruces).' });

  const league = {
    avgHome: clamp(num(raw.league?.avgHome) ?? 1.45, 0.8, 2.2),
    avgAway: clamp(num(raw.league?.avgAway) ?? 1.15, 0.6, 1.8),
  };
  const venue = text(raw.venue, 120) || null;
  if (!venue) issues.push({ level: 'info', msg: 'Estadio no informado.' });

  // Puntaje de calidad 0–100
  let score = 100;
  for (const i of issues) score -= i.level === 'warn' ? 12 : 4;
  if (!home.lineup || !away.lineup) score -= 6;
  score = clamp(score, 10, 100);

  return {
    ctx: { home, away, h2h, league, venue },
    report: { score, level: score >= 80 ? 'Alta' : score >= 55 ? 'Media' : 'Baja', issues },
  };
}

// ---------- Salida del modelo ----------
export function validatePrediction(p) {
  const { home, draw, away } = p.probabilities;
  const vals = [home, draw, away, p.lambda.home, p.lambda.away, p.confidence];
  if (vals.some((v) => !Number.isFinite(v))) throw new Error('El modelo produjo valores no numéricos.');
  const sum = home + draw + away;
  if (Math.abs(sum - 1) > 0.01) throw new Error(`Probabilidades inconsistentes (suma ${sum.toFixed(3)}).`);
  return p;
}
