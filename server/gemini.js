// Explicación en lenguaje natural con Gemini (capa gratuita). Opcional.

export async function explain(ctx, pred) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return null;
  const model = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
  const brief = {
    partido: `${ctx.home.name} (local) vs ${ctx.away.name} (visitante)`,
    liga: ctx.league?.name,
    pais: ctx.league?.country,
    estadio: ctx.venue,
    forma_local_ultimos_5: ctx.home.form,
    forma_visitante_ultimos_5: ctx.away.form,
    bajas_local: (ctx.home.injuries || []).map((i) => i.player),
    bajas_visitante: (ctx.away.injuries || []).map((i) => i.player),
    formacion_local: ctx.home.formation,
    formacion_visitante: ctx.away.formation,
    pronostico: {
      probabilidades: {
        local: `${Math.round(pred.probabilities.home * 100)}%`,
        empate: `${Math.round(pred.probabilities.draw * 100)}%`,
        visitante: `${Math.round(pred.probabilities.away * 100)}%`,
      },
      seleccion_recomendada: pred.bestBet.label,
      cuota_justa: pred.bestBet.fairOdds,
      nivel_riesgo: pred.bestBet.risk,
      alerta_sin_ventaja_clara: pred.bestBet.noClearBet,
      marcador_mas_probable: pred.expectedScore,
      confianza_modelo: `${Math.round(pred.confidence * 100)}%`,
    },
  };
  const prompt =
    'Eres un analista cuantitativo de apuestas deportivas. Con base ESTRICTA en este JSON:\n' +
    '1. Sintetiza la clave del partido (localía, bajas relevantes y momento de forma reciente ponderada).\n' +
    '2. Justifica el pronóstico del modelo y explica el nivel de riesgo.\n' +
    '3. Si hay alerta de partido parejo o sin ventaja clara, advierte prudencia explícita y explica por qué se sugiere doble oportunidad o abstenerse.\n' +
    'Reglas estrictas: Máximo 100 palabras. Español neutro. Prohibido inventar bajas o jugadores. No asegures certezas absolutas.\n' +
    JSON.stringify(brief);
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
        signal: AbortSignal.timeout(8000),
      }
    );
    const json = await res.json();
    return json.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || null;
  } catch {
    return null;
  }
}
