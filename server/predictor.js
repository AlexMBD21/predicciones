// Motor de pronóstico: Poisson bivariante + corrección Dixon-Coles
// ajustado por localía, forma reciente, bajas, alineación y H2H.

const MAX_GOALS = 8;

const fact = (n) => (n <= 1 ? 1 : n * fact(n - 1));
const poisson = (k, l) => (Math.exp(-l) * Math.pow(l, k)) / fact(k);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

function formPoints(form = '') {
  const last = form.slice(-5).split('');
  if (!last.length) return null;
  const pts = last.reduce((s, c) => s + (c === 'W' ? 3 : c === 'D' ? 1 : 0), 0);
  return pts / (last.length * 3); // 0..1
}

// Contrae la estadística hacia la media de la liga si hay pocos partidos
const shrink = (value, avg, n, k = 6) => (value * n + avg * k) / (n + k);

function dcTau(i, j, lh, la, rho) {
  if (i === 0 && j === 0) return 1 - lh * la * rho;
  if (i === 0 && j === 1) return 1 + lh * rho;
  if (i === 1 && j === 0) return 1 + la * rho;
  if (i === 1 && j === 1) return 1 - rho;
  return 1;
}

export function predict(ctx) {
  const { home, away, league = {}, h2h = [], venue } = ctx;
  const avgH = league.avgHome ?? 1.45;
  const avgA = league.avgAway ?? 1.15;
  const factors = [];

  // 1) Fuerza ofensiva/defensiva (local en casa, visitante fuera)
  const nH = home.playedHome ?? home.played ?? 0;
  const nA = away.playedAway ?? away.played ?? 0;
  const atkH = shrink(home.gfHome ?? avgH, avgH, nH) / avgH;
  const defH = shrink(home.gaHome ?? avgA, avgA, nH) / avgA;
  const atkA = shrink(away.gfAway ?? avgA, avgA, nA) / avgA;
  const defA = shrink(away.gaAway ?? avgH, avgH, nA) / avgH;

  let lh = avgH * atkH * defA;
  let la = avgA * atkA * defH;
  factors.push({
    key: 'strength',
    label: 'Fuerza ofensiva y defensiva',
    detail: `${home.name} ataca a ${(atkH * 100).toFixed(0)}% de la media en casa; ${away.name} a ${(atkA * 100).toFixed(0)}% fuera.`,
    impact: clamp((atkH * defA - atkA * defH) / 2, -1, 1),
  });

  // 2) Forma reciente (últimos 5)
  const fH = formPoints(home.form);
  const fA = formPoints(away.form);
  if (fH !== null && fA !== null) {
    const mH = 0.9 + 0.2 * fH;
    const mA = 0.9 + 0.2 * fA;
    lh *= mH;
    la *= mA;
    factors.push({
      key: 'form',
      label: 'Estado de forma (últimos 5)',
      detail: `${home.name}: ${home.form.slice(-5)} · ${away.name}: ${away.form.slice(-5)}`,
      impact: clamp((fH - fA) * 1.5, -1, 1),
    });
  }

  // 3) Bajas (lesionados/sancionados)
  const inj = (t) => (t.injuries || []).length;
  const penal = (n) => clamp(1 - 0.03 * n, 0.82, 1);
  const iH = inj(home);
  const iA = inj(away);
  if (iH || iA) {
    lh *= penal(iH);
    la *= penal(iA);
    // las bajas del rival tambien debilitan su defensa un poco
    lh *= 1 + Math.min(iA, 4) * 0.01;
    la *= 1 + Math.min(iH, 4) * 0.01;
    factors.push({
      key: 'injuries',
      label: 'Bajas confirmadas',
      detail: `${home.name}: ${iH} baja(s) · ${away.name}: ${iA} baja(s).`,
      impact: clamp((iA - iH) / 6, -1, 1),
    });
  }

  // 4) Once titular confirmado
  const lineupsOk = !!(home.lineup?.length && away.lineup?.length);
  if (lineupsOk) {
    factors.push({
      key: 'lineup',
      label: 'Alineaciones confirmadas',
      detail: `${home.formation || '—'} vs ${away.formation || '—'}. Datos de titulares incorporados.`,
      impact: 0,
    });
  } else {
    factors.push({
      key: 'lineup',
      label: 'Alineaciones',
      detail: 'Aún no confirmadas (normalmente salen ~1h antes). La confianza se reduce.',
      impact: 0,
    });
  }

  // 5) Historial directo (H2H)
  if (h2h.length >= 2) {
    let diff = 0;
    for (const m of h2h) {
      const hg = m.homeIsCurrentHome ? m.homeGoals : m.awayGoals;
      const ag = m.homeIsCurrentHome ? m.awayGoals : m.homeGoals;
      diff += Math.sign(hg - ag);
    }
    const tilt = clamp(diff / h2h.length, -1, 1) * 0.04;
    lh *= 1 + tilt;
    la *= 1 - tilt;
    factors.push({
      key: 'h2h',
      label: 'Historial directo',
      detail: `Últimos ${h2h.length} cruces: saldo ${diff > 0 ? 'favorable al local' : diff < 0 ? 'favorable al visitante' : 'equilibrado'}.`,
      impact: clamp(diff / h2h.length, -1, 1),
    });
  }

  // 6) Localía / sede
  factors.push({
    key: 'venue',
    label: 'Localía y sede',
    detail: `${venue || 'Estadio del local'}: ventaja de local incluida (media de liga ${avgH.toFixed(2)} vs ${avgA.toFixed(2)} goles).`,
    impact: 0.3,
  });

  lh = clamp(lh, 0.2, 4.5);
  la = clamp(la, 0.2, 4.5);

  // En vivo: solo quedan goles por jugarse; se suman al marcador actual
  const live = ctx.live || null;
  let cH = 0, cA = 0, progress = 0;
  if (live) {
    cH = live.home || 0; cA = live.away || 0;
    const minute = clamp(live.minute ?? 0, 0, 90);
    progress = minute / 90;
    const rf = Math.max(0.03, (90 - minute) / 90);
    // Con roja, el equipo ataca menos y el rival más
    const rH = live.redsHome || 0, rA = live.redsAway || 0;
    lh *= rf * Math.pow(0.75, rH) * Math.pow(1.15, rA);
    la *= rf * Math.pow(0.75, rA) * Math.pow(1.15, rH);
    // El que va perdiendo arriesga un poco más
    if (cH < cA) lh *= 1.08; else if (cA < cH) la *= 1.08;
    factors.unshift({
      key: 'live',
      label: 'Marcador y minuto actuales',
      detail: `${home.name} ${cH}-${cA} ${away.name} al minuto ${minute}. Quedan ${Math.round(90 - minute)} min: el pronóstico parte del marcador real.` +
        (rH || rA ? ` Expulsiones: ${rH ? home.name + ' ' + rH : ''}${rH && rA ? ', ' : ''}${rA ? away.name + ' ' + rA : ''}.` : ''),
      impact: clamp((cH - cA) / 2, -1, 1),
    });
  }

  // Matriz de marcadores (goles restantes si es en vivo)
  const rho = live ? 0 : -0.08;
  const matrix = [];
  let total = 0;
  for (let i = 0; i <= MAX_GOALS; i++) {
    matrix[i] = [];
    for (let j = 0; j <= MAX_GOALS; j++) {
      const p = poisson(i, lh) * poisson(j, la) * dcTau(i, j, lh, la, rho);
      matrix[i][j] = p;
      total += p;
    }
  }
  let pH = 0, pD = 0, pA = 0, over25 = 0, btts = 0, over15 = 0;
  const scores = [];
  for (let i = 0; i <= MAX_GOALS; i++) {
    for (let j = 0; j <= MAX_GOALS; j++) {
      const p = matrix[i][j] / total;
      matrix[i][j] = p;
      const fi = i + cH, fj = j + cA; // marcador final
      if (fi > fj) pH += p; else if (fi === fj) pD += p; else pA += p;
      if (fi + fj > 2.5) over25 += p;
      if (fi + fj > 1.5) over15 += p;
      if (fi > 0 && fj > 0) btts += p;
      scores.push({ score: `${fi}-${fj}`, p });
    }
  }
  scores.sort((a, b) => b.p - a.p);

  const probs = { home: pH, draw: pD, away: pA };
  const sorted = Object.entries(probs).sort((a, b) => b[1] - a[1]);
  const pick = sorted[0][0];
  const margin = sorted[0][1] - sorted[1][1];

  // Confianza: datos disponibles + claridad de la ventaja
  let dataScore = 0.35;
  if (nH >= 5 && nA >= 5) dataScore += 0.25;
  if (fH !== null && fA !== null) dataScore += 0.1;
  if (lineupsOk) dataScore += 0.15;
  if (h2h.length >= 2) dataScore += 0.05;
  if (iH || iA) dataScore += 0.05;
  let confidence = clamp(dataScore * 0.6 + margin * 1.2 + sorted[0][1] * 0.2, 0.15, 0.92);
  if (live) confidence = clamp(confidence * (1 - progress) + 0.95 * progress * Math.min(1, margin * 2.2 + 0.3), 0.15, 0.97);

  const pickLabel = pick === 'home' ? home.name : pick === 'away' ? away.name : 'Empate';
  const dc = pick === 'home' ? '1X' : pick === 'away' ? 'X2' : 'X';

  // Mejor apuesta recomendada
  const mk = (type, label, p, group) => ({ type, label, p: +p.toFixed(4), fairOdds: +(1 / p).toFixed(2), group });
  const markets1 = [
    mk('1', `Victoria de ${home.name} (1)`, pH, 'result'),
    mk('X', 'Empate (X)', pD, 'result'),
    mk('2', `Victoria de ${away.name} (2)`, pA, 'result'),
    mk('1X', `${home.name} o empate (1X)`, pH + pD, 'double'),
    mk('X2', `${away.name} o empate (X2)`, pD + pA, 'double'),
    mk('12', 'Gana alguno, sin empate (12)', pH + pA, 'double'),
    mk('O1.5', 'Más de 1.5 goles', over15, 'goals'),
    mk('O2.5', 'Más de 2.5 goles', over25, 'goals'),
    mk('U2.5', 'Menos de 2.5 goles', 1 - over25, 'goals'),
    mk('BTTS', 'Ambos equipos marcan', btts, 'goals'),
    mk('NBTTS', 'Ambos NO marcan', 1 - btts, 'goals'),
  ];
  const best = (group, min) =>
    markets1.filter((m) => m.group === group && m.p >= min && m.p < 0.985).sort((a, b) => b.p - a.p)[0];
  let primary = best('result', 0.5);
  let reason = 'Resultado directo con probabilidad alta: mejor relación entre riesgo y cuota.';
  if (!primary) {
    primary = best('double', 0.72);
    reason = 'Ningún resultado único es claro; la doble oportunidad reduce el riesgo.';
  }
  if (!primary) {
    primary = best('goals', 0.62);
    reason = 'El resultado está parejo; el mercado de goles ofrece más seguridad.';
  }
  const noClearBet = !primary;
  if (noClearBet) {
    primary = markets1.filter((m) => m.group === 'double').sort((a, b) => b.p - a.p)[0];
    reason = 'Partido muy parejo y sin ventaja clara. Lo más prudente es no apostar; si lo haces, esta es la opción menos arriesgada.';
  }
  const alternatives = markets1
    .filter((m) => m.type !== primary.type && m.p >= 0.55 && m.p < 0.985)
    .sort((a, b) => b.p - a.p)
    .slice(0, 3);
  const bestBet = {
    ...primary,
    reason,
    noClearBet,
    risk: primary.p >= 0.7 ? 'Bajo' : primary.p >= 0.55 ? 'Medio' : 'Alto',
    alternatives,
  };

  return {
    lambda: { home: +lh.toFixed(2), away: +la.toFixed(2) },
    probabilities: {
      home: +pH.toFixed(4), draw: +pD.toFixed(4), away: +pA.toFixed(4),
    },
    markets: {
      over15: +over15.toFixed(4),
      over25: +over25.toFixed(4),
      under25: +(1 - over25).toFixed(4),
      btts: +btts.toFixed(4),
      doubleChance: {
        '1X': +(pH + pD).toFixed(4),
        'X2': +(pD + pA).toFixed(4),
        '12': +(pH + pA).toFixed(4),
      },
    },
    pick: { outcome: pick, label: pickLabel, doubleChance: dc },
    live: !!live,
    bestBet,
    topScores: scores.slice(0, 5).map((s) => ({ score: s.score, p: +s.p.toFixed(4) })),
    expectedScore: scores[0].score,
    confidence: +confidence.toFixed(2),
    lineupsConfirmed: lineupsOk,
    factors,
  };
}

export function templateExplanation(ctx, pred) {
  const { home, away } = ctx;
  const parts = [];
  if (ctx.live) {
    const l = ctx.live;
    const lead = l.home === l.away ? 'El partido está empatado' : `${l.home > l.away ? home.name : away.name} gana ${Math.max(l.home, l.away)}-${Math.min(l.home, l.away)}`;
    parts.push(`${lead} al minuto ${l.minute}${l.redsHome || l.redsAway ? ', con expulsiones que cambian el ritmo' : ''}. El marcador actual pesa más que el análisis previo a medida que se acaba el tiempo.`);
  }
  const lean = pred.probabilities.home - pred.probabilities.away;
  const who = ctx.live ? 'Antes del inicio' : Math.abs(lean) < 0.05 ? 'No hay un claro favorito' : `${lean > 0 ? home.name : away.name} parte con ventaja`;
  const strong = [...pred.factors]
    .filter((f) => f.key !== 'lineup' && f.key !== 'venue' && f.key !== 'live' && Math.abs(f.impact) > 0.05)
    .sort((a, b) => Math.abs(b.impact) - Math.abs(a.impact))
    .slice(0, 2);
  parts.push(`${who}${strong.length ? ', sobre todo por ' + strong.map((f) => f.label.toLowerCase()).join(' y ') : ''}.`);
  for (const f of strong) parts.push(f.detail);
  parts.push(
    `Se esperan ${(pred.lambda.home + pred.lambda.away).toFixed(1)} goles ${ctx.live ? 'más hasta el final' : 'en total'}` +
    (pred.lineupsConfirmed ? ', con alineaciones ya confirmadas.' : '; las alineaciones aún no están confirmadas, vuelve a consultar cerca del inicio.')
  );
  return parts.join(' ');

}
