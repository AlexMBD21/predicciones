// Persistencia en base de datos local SQLite (nativa en Node.js 22)
// Almacena predicciones, contextos y análisis de IA para ahorrar cuota de API y evitar recargas.

import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '..', 'data.sqlite');

const db = new DatabaseSync(DB_PATH);

// Configuración de concurrencia y tablas
try {
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = NORMAL;');
} catch {}

db.exec(`
  CREATE TABLE IF NOT EXISTS predictions (
    fixture_id TEXT PRIMARY KEY,
    date TEXT,
    status TEXT,
    payload TEXT,
    created_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_predictions_date ON predictions(date);
`);

export function getCachedPrediction(fixtureId, currentStatus) {
  try {
    const stmt = db.prepare('SELECT payload, status, created_at FROM predictions WHERE fixture_id = ?');
    const row = stmt.get(String(fixtureId));
    if (!row) return null;

    // Si el partido ya finalizó, la predicción guardada es válida indefinidamente
    if (['FT', 'AET', 'PEN'].includes(row.status)) {
      return JSON.parse(row.payload);
    }

    // Si el partido está programado (NS), guardamos por 12 horas o hasta que comience
    if (row.status === 'NS' && (!currentStatus || currentStatus === 'NS')) {
      const TWELVE_HOURS = 12 * 60 * 60 * 1000;
      if (Date.now() - row.created_at < TWELVE_HOURS) {
        return JSON.parse(row.payload);
      }
    }

    // Si está en vivo, cacheamos por 5 minutos para evitar sobrecargar APIs y Gemini
    if (['1H', '2H', 'HT', 'LIVE', 'ET'].includes(row.status)) {
      const FIVE_MINUTES = 5 * 60 * 1000;
      if (Date.now() - row.created_at < FIVE_MINUTES) {
        return JSON.parse(row.payload);
      }
    }

    return null;
  } catch (err) {
    console.error('Error leyendo SQLite:', err.message);
    return null;
  }
}

export function savePrediction(fixtureId, date, status, payload) {
  try {
    const stmt = db.prepare(`
      INSERT INTO predictions (fixture_id, date, status, payload, created_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(fixture_id) DO UPDATE SET
        status = excluded.status,
        payload = excluded.payload,
        created_at = excluded.created_at
    `);
    stmt.run(String(fixtureId), String(date || ''), String(status || ''), JSON.stringify(payload), Date.now());
  } catch (err) {
    console.error('Error guardando en SQLite:', err.message);
  }
}
