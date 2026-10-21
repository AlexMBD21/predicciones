# PronoXI – Pronósticos de fútbol con IA

## Uso
```
npm start        # http://localhost:3000  (sin dependencias, Node ≥ 18)
```
Sin claves funciona en **modo DEMO** (datos simulados). Para datos reales copia `.env.example` a `.env`.

## APIs gratuitas
| Necesidad | Servicio | Límite gratis |
|---|---|---|
| Partidos, estadísticas, bajas, alineaciones, H2H | [API-Football](https://dashboard.api-football.com/register) | 100 req/día |
| Análisis en texto (opcional) | [Gemini API](https://aistudio.google.com/apikey) | capa gratuita |
| Alternativa (sin alineaciones) | football-data.org | 10 req/min, 12 ligas |

Cache en memoria para ahorrar cuota (≈5 peticiones por pronóstico, cacheadas 2–24 h).

## Arquitectura
- `server/predictor.js`: Poisson + Dixon-Coles, ajustado por localía, forma, bajas, titulares y H2H.
- `server/providers/`: `apiFootball.js` (real) y `demo.js`.
- `server/gemini.js`: explicación opcional con LLM.
- `public/`: interfaz.
