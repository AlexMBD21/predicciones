// Explicación en lenguaje natural con Gemini (capa gratuita). Opcional.

export async function explain(ctx, pred) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return null;
  const model = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
  const brief = {
    partido: `${ctx.home.name} (local) vs ${ctx.away.name} (visitante)`,
    estadio: ctx.venue,
    forma_local: ctx.home.form, forma_visitante: ctx.away.form,
    bajas_local: (ctx.home.injuries || []).map((i) => i.player),
    bajas_visitante: (ctx.away.injuries || []).map((i) => i.player),
    formacion_local: ctx.home.formation, formacion_visitante: ctx.away.formation,
    pronostico_modelo: pred,
  };
  const prompt =
    'Eres un analista de fútbol. Con estos datos y el resultado del modelo estadístico, escribe en español un análisis breve (máx. 120 palabras) ' +
    'explicando el pronóstico, citando localía, forma, bajas y alineaciones. No inventes datos que no estén en el JSON. ' +
    'Recuerda que es una estimación probabilística, no una certeza.\n' + JSON.stringify(brief);
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
