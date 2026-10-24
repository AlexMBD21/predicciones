// Persistencia 100% en la nube: Supabase (PostgreSQL)
// Almacena predicciones, contextos y caché de API en la nube para sincronizar entre dispositivos y ahorrar cuota.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

function loadEnvIfNeeded() {
  if (process.env.SUPABASE_URL) return;
  try {
    const envPath = path.join(ROOT, '.env');
    if (fs.existsSync(envPath)) {
      for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
        const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
        if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
      }
    }
  } catch {}
}

// Cliente de Supabase lazy (se inicializa una vez que .env está cargado)
let _supabaseClient = undefined;

export function getSupabase() {
  if (_supabaseClient !== undefined) return _supabaseClient;
  loadEnvIfNeeded();
  const SUPABASE_URL = process.env.SUPABASE_URL?.trim();
  const SUPABASE_KEY = (process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY)?.trim();

  if (SUPABASE_URL && SUPABASE_KEY) {
    try {
      _supabaseClient = createClient(SUPABASE_URL, SUPABASE_KEY, {
        auth: { persistSession: false },
      });
      console.log(`☁️ Supabase conectado correctamente (${SUPABASE_URL})`);
    } catch (err) {
      console.error('⚠️ Error al inicializar cliente Supabase:', err.message);
      _supabaseClient = null;
    }
  } else {
    _supabaseClient = null;
  }
  return _supabaseClient;
}

export function isSupabaseConnected() {
  return !!getSupabase();
}

function isFresh(status, createdAt, currentStatus) {
  if (['FT', 'AET', 'PEN'].includes(status)) return true;

  if (status === 'NS' && (!currentStatus || currentStatus === 'NS')) {
    const TWELVE_HOURS = 12 * 60 * 60 * 1000;
    return Date.now() - createdAt < TWELVE_HOURS;
  }

  if (['1H', '2H', 'HT', 'LIVE', 'ET'].includes(status)) {
    const FIVE_MINUTES = 5 * 60 * 1000;
    return Date.now() - createdAt < FIVE_MINUTES;
  }

  return false;
}

export async function getCachedPrediction(fixtureId, currentStatus) {
  const supabase = getSupabase();
  if (!supabase) return null;

  const fId = String(fixtureId);
  try {
    const { data, error } = await supabase
      .from('predictions')
      .select('payload, status, created_at')
      .eq('fixture_id', fId)
      .maybeSingle();

    if (error || !data || !data.payload) return null;

    const createdAt = Number(data.created_at) || Date.now();
    if (isFresh(data.status, createdAt, currentStatus)) {
      return typeof data.payload === 'string' ? JSON.parse(data.payload) : data.payload;
    }
  } catch (err) {
    console.error('⚠️ Error consultando predicción en Supabase:', err.message);
  }

  return null;
}

export async function savePrediction(fixtureId, date, status, payload) {
  const supabase = getSupabase();
  if (!supabase) return;

  const fId = String(fixtureId);
  const now = Date.now();

  try {
    const { error } = await supabase
      .from('predictions')
      .upsert({
        fixture_id: fId,
        date: String(date || ''),
        status: String(status || ''),
        payload,
        created_at: now,
      });

    if (error) {
      console.error('⚠️ Error guardando predicción en Supabase:', error.message);
    } else {
      console.log(`☁️ Predicción ${fId} guardada en Supabase`);
    }
  } catch (e) {
    console.error('⚠️ Excepción guardando en Supabase:', e.message);
  }
}

export async function getApiCache(path, maxAgeMs) {
  const supabase = getSupabase();
  if (!supabase) return null;

  try {
    const { data, error } = await supabase
      .from('api_cache')
      .select('payload, updated_at')
      .eq('path', path)
      .maybeSingle();

    if (error || !data || !data.payload) return null;

    const updatedAt = Number(data.updated_at) || 0;
    if (maxAgeMs && Date.now() - updatedAt > maxAgeMs) return null;

    return typeof data.payload === 'string' ? JSON.parse(data.payload) : data.payload;
  } catch (err) {
    return null;
  }
}

export async function saveApiCache(path, data) {
  const supabase = getSupabase();
  if (!supabase) return;

  const now = Date.now();
  try {
    await supabase
      .from('api_cache')
      .upsert({
        path,
        payload: data,
        updated_at: now,
      });
  } catch (err) {
    console.error('⚠️ Error guardando api_cache en Supabase:', err.message);
  }
}

export async function getPredictionsForFixtures(ids) {
  if (!ids || !ids.length) return {};
  const supabase = getSupabase();
  if (!supabase) return {};

  const result = {};
  try {
    const { data, error } = await supabase
      .from('predictions')
      .select('fixture_id, payload')
      .in('fixture_id', ids.map(String));

    if (data && !error) {
      for (const r of data) {
        try {
          const parsed = typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload;
          result[r.fixture_id] = {
            probabilities: parsed.probabilities,
            odds: parsed.odds,
            pick: parsed.bestBet?.selection || parsed.verdict?.label || null,
          };
        } catch {}
      }
    }
  } catch (e) {
    console.error('⚠️ Error cargando predicciones batch de Supabase:', e.message);
  }

  return result;
}
