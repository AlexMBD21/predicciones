import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { predict, templateExplanation } from './predictor.js';
import { explain } from './gemini.js';
import { parseDate, parseId, cleanFixtures, cleanContext, validatePrediction, ValidationError } from './validate.js';
import { getCachedPrediction, savePrediction, getPredictionsForFixtures, isSupabaseConnected } from './db.js';


const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

// Carga mínima de .env (sin dependencias)
try {
  for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch {}

import * as provider from './providers/apiFootball.js';
const PORT = process.env.PORT || 3000;

const fixturesById = new Map();
const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png' };

// Rate limit simple por IP: 60 peticiones/min
const hits = new Map();
setInterval(() => hits.clear(), 60_000).unref();
const limited = (ip) => { const n = (hits.get(ip) || 0) + 1; hits.set(ip, n); return n > 60; };

const send = (res, code, body) => {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(JSON.stringify(body));
};

export async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    return res.end();
  }

  const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost';
  const proto = req.headers['x-forwarded-proto'] || 'http';
  let url;
  try {
    url = new URL(req.url, `${proto}://${host}`);
  } catch {
    url = new URL('/', `http://${host}`);
  }

  // Resolver pathname compatible con Vercel rewrites y Serverless Functions
  let pathname = url.pathname;
  if (req.headers['x-matched-path']) {
    try {
      pathname = new URL(req.headers['x-matched-path'], 'http://localhost').pathname;
    } catch {}
  } else if (pathname.startsWith('/api/index')) {
    const sub = url.searchParams.get('path');
    if (sub) pathname = `/api/${sub}`;
  }

  try {
    if (req.method !== 'GET') return send(res, 405, { error: 'Método no permitido' });
    const clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress;
    if (pathname.startsWith('/api/') && clientIp && limited(clientIp)) {
      return send(res, 429, { error: 'Demasiadas peticiones. Espera un minuto.' });
    }
    if (pathname === '/api/status') {
      return send(res, 200, { provider: provider.name, gemini: !!process.env.GEMINI_API_KEY, supabase: isSupabaseConnected() });
    }
    if (pathname === '/api/matches') {
      const date = parseDate(url.searchParams.get('date'));
      const tz = url.searchParams.get('tz') || 'America/Bogota';
      try {
        const { fixtures, dropped } = cleanFixtures(await provider.getFixtures(date, tz));
        const now = Date.now();
        fixtures.forEach((f) => {
          if ((f.status === 'NS' || f.status === 'TBD') && f.date) {
            const matchTime = new Date(f.date).getTime();
            const elapsed = Math.floor((now - matchTime) / 60000);
            if (elapsed >= 0) {
              if (elapsed <= 45) {
                f.status = '1H';
                f.statusLong = 'Primer tiempo';
                f.minute = Math.max(1, elapsed);
              } else if (elapsed <= 60) {
                f.status = 'HT';
                f.statusLong = 'Medio tiempo';
                f.minute = 45;
              } else if (elapsed <= 115) {
                f.status = '2H';
                f.statusLong = 'Segundo tiempo';
                f.minute = Math.min(45 + (elapsed - 60), 90);
              } else if (elapsed <= 140) {
                f.status = '2H';
                f.statusLong = 'Tiempo cumplido';
                f.minute = 90;
                f.extra = Math.min(elapsed - 115, 10);
              }
            }
          }
          fixturesById.set(String(f.id), f);
        });
        const predMap = await getPredictionsForFixtures(fixtures.map((f) => f.id));
        fixtures.forEach((f) => {
          f.prediction = predMap[String(f.id)] || null;
        });
        return send(res, 200, { date, matches: fixtures, dropped });
      } catch (err) {
        if (/limit|cuota|peticiones/i.test(err.message)) {
          return send(res, 200, {
            date,
            matches: [],
            warning: 'Has alcanzado el límite diario de 100 peticiones de API-Football. La cuota gratuita se reinicia a las 00:00 UTC.',
          });
        }
        throw err;
      }
    }
    if (pathname === '/api/match') {
      const id = parseId(url.searchParams.get('id'));
      let fx = fixturesById.get(id);
      if (!fx) {
        try {
          fx = await provider.getFixtureById(id);
          if (fx) fixturesById.set(id, fx);
        } catch {}
      }
      if (!fx) return send(res, 404, { error: 'Partido no encontrado. Recarga la lista.' });
      let detail = { events: [], stats: [] };
      if (fx.status !== 'NS' && fx.status !== 'TBD') {
        try { detail = await provider.getLive(fx); } catch (e) { console.error('getLive', e.message); }
      }
      const cachedPrediction = await getCachedPrediction(id, fx.status);
      return send(res, 200, { fixture: fx, events: detail.events, stats: detail.stats, cachedPrediction });
    }
    if (pathname === '/api/predict') {
      const id = parseId(url.searchParams.get('id'));
      let fx = fixturesById.get(id);
      if (!fx) {
        try {
          fx = await provider.getFixtureById(id);
          if (fx) fixturesById.set(id, fx);
        } catch {}
      }
      if (!fx) return send(res, 404, { error: 'Partido no encontrado. Recarga la lista.' });

      const force = url.searchParams.get('force') === '1';
      const cached = await getCachedPrediction(id, fx.status);

      // Si ya está en caché y no se pide forzar recálculo, responder inmediatamente sin gastar API
      if (!force && cached) {
        return send(res, 200, cached);
      }

      if (['FT', 'AET', 'PEN', 'CANC', 'ABD', 'AWD', 'WO'].includes(fx.status)) {
        if (cached) return send(res, 200, cached);
        return send(res, 409, { error: 'Este partido ya terminó o fue cancelado; no se genera pronóstico.' });
      }

      const { ctx, report } = cleanContext(await provider.getContext(fx));
      if (['1H', 'HT', '2H', 'ET', 'LIVE'].includes(fx.status)) {
        let reds = [];
        try { reds = (await provider.getLive(fx)).events.filter((e) => e.type === 'Card' && /Red/.test(e.detail || '')); } catch {}
        ctx.live = {
          minute: fx.status === 'HT' ? 45 : fx.minute ?? 0,
          home: fx.goals?.home ?? 0,
          away: fx.goals?.away ?? 0,
          redsHome: reds.filter((e) => e.team === 'home').length,
          redsAway: reds.filter((e) => e.team === 'away').length,
        };
      }
      const prediction = validatePrediction(predict(ctx));
      prediction.confidence = +(prediction.confidence * (ctx.live ? 1 : 0.6 + 0.4 * (report.score / 100))).toFixed(2);
      prediction.dataQuality = report;
      const ai = await explain(ctx, prediction);
      const payload = {
        fixture: fx,
        context: {
          home: { form: ctx.home.form, injuries: ctx.home.injuries, formation: ctx.home.formation, lineup: ctx.home.lineup },
          away: { form: ctx.away.form, injuries: ctx.away.injuries, formation: ctx.away.formation, lineup: ctx.away.lineup },
        },
        prediction,
        analysis: ai || templateExplanation(ctx, prediction),
        analysisSource: ai ? 'gemini' : 'modelo',
      };
      await savePrediction(id, fx.date, fx.status, payload);
      return send(res, 200, payload);
    }
    // Archivos estáticos (modo local)
    const file = pathname === '/' ? '/index.html' : decodeURIComponent(pathname);
    const base = path.join(ROOT, 'public');
    const full = path.normalize(path.join(base, file));
    if (!full.startsWith(base)) return send(res, 403, { error: 'forbidden' });
    fs.readFile(full, (err, data) => {
      if (err) return send(res, 404, { error: 'not found' });
      res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff' });
      res.end(data);
    });
  } catch (e) {
    if (e instanceof ValidationError) return send(res, 400, { error: e.message });
    console.error(e);
    send(res, 502, { error: 'No se pudieron obtener o procesar los datos: ' + e.message });
  }
}

export const server = http.createServer(handler);

// Iniciar servidor local solo si no estamos dentro del entorno serverless de Vercel
if (!process.env.VERCEL && !process.env.AWS_LAMBDA_FUNCTION_NAME) {
  server.listen(PORT, () => {
    const supa = isSupabaseConnected() ? ' + Supabase ☁️' : '';
    console.log(`⚽ Pronósticos en http://localhost:${PORT} [${provider.name}${supa}]`);
  });
}

export default handler;

