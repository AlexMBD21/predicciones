// Proveedor API-Football (api-sports.io) - plan gratuito: 100 peticiones/día.
// Cache en memoria para ahorrar cuota.

const BASE = 'https://v3.football.api-sports.io';
const cache = new Map();

async function api(path, ttlMs) {
  const hit = cache.get(path);
  if (hit && Date.now() - hit.t < ttlMs) return hit.data;
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(BASE + path, {
        headers: { 'x-apisports-key': process.env.API_FOOTBALL_KEY },
        signal: AbortSignal.timeout(8000),
      });
      if (res.status === 429) throw new Error('Límite de peticiones de API-Football alcanzado');
      if (!res.ok) throw new Error(`API-Football HTTP ${res.status}`);
      const json = await res.json();
      const errs = json.errors && (Array.isArray(json.errors) ? json.errors : Object.values(json.errors));
      if (errs && errs.length) throw Object.assign(new Error('API-Football: ' + errs.join(' | ')), { fatal: true });
      if (!json || !Array.isArray(json.response) && typeof json.response !== 'object') throw new Error('Respuesta con formato inesperado');
      cache.set(path, { t: Date.now(), data: json.response });
      return json.response;
    } catch (e) {
      lastErr = e;
      if (e.fatal || /Límite/.test(e.message)) break;
      await new Promise((r) => setTimeout(r, 400));
    }
  }
  // Si hay datos viejos en caché, es mejor usarlos que fallar
  if (hit) return hit.data;
  throw lastErr;
}

const MIN = 60 * 1000;
const HOUR = 60 * MIN;

export const name = 'API-Football';

const LIVE_SET = new Set(['1H', 'HT', '2H', 'ET', 'BT', 'P', 'INT', 'LIVE']);

function mapFixture(f) {
  return {
    id: f.fixture.id,
    date: f.fixture.date,
    status: f.fixture.status.short,
    statusLong: f.fixture.status.long,
    minute: f.fixture.status.elapsed,
    extra: f.fixture.status.extra ?? null,
    referee: f.fixture.referee || null,
    venue: f.fixture.venue?.name ? `${f.fixture.venue.name}${f.fixture.venue.city ? ', ' + f.fixture.venue.city : ''}` : null,
    league: { id: f.league.id, name: f.league.name, country: f.league.country, logo: f.league.logo, season: f.league.season, round: f.league.round },
    home: { id: f.teams.home.id, name: f.teams.home.name, logo: f.teams.home.logo, winner: f.teams.home.winner },
    away: { id: f.teams.away.id, name: f.teams.away.name, logo: f.teams.away.logo, winner: f.teams.away.winner },
    goals: f.goals,
    halftime: f.score?.halftime ?? null,
    penalty: f.score?.penalty ?? null,
  };
}

export async function getFixtures(date, timezone = 'America/Bogota') {
  const tzParam = timezone ? `&timezone=${encodeURIComponent(timezone)}` : '';
  const path = `/fixtures?date=${date}${tzParam}`;

  // Si hay partidos en juego, refrescamos más seguido (cuida la cuota de 100/día)
  const cached = cache.get(path);
  const hasLive = Array.isArray(cached?.data) && cached.data.some((f) => LIVE_SET.has(f.fixture.status.short));
  const [list, liveRaw] = await Promise.all([
    api(path, hasLive ? 2 * MIN : 10 * MIN),
    api('/fixtures?live=all', 60 * 1000).catch(() => []),
  ]);

  const map = new Map();
  // Primero cargamos los partidos del día
  for (const f of list || []) {
    map.set(f.fixture.id, mapFixture(f));
  }
  // Luego incorporamos / actualizamos con los que estén en vivo ahora mismo
  for (const f of liveRaw || []) {
    map.set(f.fixture.id, mapFixture(f));
  }

  return Array.from(map.values());
}

// Eventos (goles, tarjetas, cambios, VAR) y estadísticas del partido
export async function getLive(fx) {
  const live = LIVE_SET.has(fx.status);
  const ttl = live ? 60 * 1000 : 6 * HOUR;
  const [ev, st] = await Promise.all([
    api(`/fixtures/events?fixture=${fx.id}`, ttl).catch(() => []),
    api(`/fixtures/statistics?fixture=${fx.id}`, ttl).catch(() => []),
  ]);
  const events = (ev || []).map((e) => ({
    minute: e.time?.elapsed, extra: e.time?.extra ?? null,
    team: e.team?.id === fx.home.id ? 'home' : 'away',
    type: e.type, detail: e.detail, player: e.player?.name, assist: e.assist?.name || null,
  }));
  const byTeam = (id) => (st || []).find((s) => s.team?.id === id)?.statistics || [];
  const h = byTeam(fx.home.id), a = byTeam(fx.away.id);
  const LABELS = {
    'Ball Possession': 'Posesión', 'Total Shots': 'Tiros', 'Shots on Goal': 'Tiros a puerta', 'Corner Kicks': 'Tiros de esquina',
    'Fouls': 'Faltas', 'Yellow Cards': 'Amarillas', 'Red Cards': 'Rojas', 'Offsides': 'Fueras de juego',
    'Passes %': 'Precisión de pases', 'expected_goals': 'xG (goles esperados)', 'Goalkeeper Saves': 'Atajadas',
  };
  const stats = Object.entries(LABELS).map(([k, label]) => ({
    label,
    home: h.find((x) => x.type === k)?.value ?? null,
    away: a.find((x) => x.type === k)?.value ?? null,
  })).filter((s) => s.home !== null || s.away !== null);
  return { events, stats };
}

async function teamStats(league, season, teamId) {
  const s = await api(`/teams/statistics?league=${league}&season=${season}&team=${teamId}`, 6 * HOUR);
  if (!s || Array.isArray(s)) return {};
  const g = s.goals;
  const pl = s.fixtures.played;
  return {
    form: (s.form || '').replace(/[^WDL]/g, ''),
    played: pl.total, playedHome: pl.home, playedAway: pl.away,
    gfHome: pl.home ? g.for.total.home / pl.home : undefined,
    gaHome: pl.home ? g.against.total.home / pl.home : undefined,
    gfAway: pl.away ? g.for.total.away / pl.away : undefined,
    gaAway: pl.away ? g.against.total.away / pl.away : undefined,
  };
}

export async function getContext(fx) {
  const L = fx.league;
  const home = { ...fx.home, injuries: [] };
  const away = { ...fx.away, injuries: [] };

  // Intentamos obtener estadísticas de equipos con timeout rápido de 3.5 segundos
  const withTimeout = (promise, ms = 3500) =>
    Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))
    ]).catch(() => null);

  const [hs, as, inj, lineups, h2hRaw] = await Promise.all([
    L?.id && L?.season ? withTimeout(teamStats(L.id, L.season, fx.home.id)) : Promise.resolve(null),
    L?.id && L?.season ? withTimeout(teamStats(L.id, L.season, fx.away.id)) : Promise.resolve(null),
    withTimeout(api(`/injuries?fixture=${fx.id}`, 2 * HOUR)),
    withTimeout(api(`/fixtures/lineups?fixture=${fx.id}`, 10 * MIN)),
    withTimeout(api(`/fixtures/headtohead?h2h=${fx.home.id}-${fx.away.id}&last=6`, 24 * HOUR)),
  ]);

  Object.assign(home, hs || {});
  Object.assign(away, as || {});
  for (const i of inj || []) {
    const entry = { player: i.player.name, reason: i.player.reason || i.player.type };
    (i.team.id === fx.home.id ? home : away).injuries.push(entry);
  }
  for (const l of lineups || []) {
    const t = l.team.id === fx.home.id ? home : away;
    t.formation = l.formation;
    t.coach = l.coach?.name;
    t.lineup = (l.startXI || []).map((p) => ({ name: p.player.name, number: p.player.number, pos: p.player.pos }));
  }
  const h2h = (h2hRaw || [])
    .filter((m) => m.goals.home !== null)
    .map((m) => ({
      homeGoals: m.goals.home, awayGoals: m.goals.away,
      homeIsCurrentHome: m.teams.home.id === fx.home.id,
    }));

  return { home, away, h2h, venue: fx.venue, league: { avgHome: 1.45, avgAway: 1.15 } };
}
