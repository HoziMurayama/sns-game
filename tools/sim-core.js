/**
 * シミュレーションの中身（simulate.js と tune.js が共用する）。
 * ここもゲームエンジン本体をそのまま使うので、ルールを変えれば結果も自動的に変わります。
 */

import {
  planEvents,
  resolveRound,
  initialPlayerScore,
  applyResult,
  computeStandings,
  findDecision,
} from '../shared/engine.js';
import { decideForBot } from '../server/bots.js';
import { rngFor } from '../shared/rng.js';

/** ルールに実在する選択肢だけを使う（数値を変えても壊れないように） */
function optIdByTier(rules, key, tier) {
  const g = findDecision(rules, key);
  return g?.options.find((o) => o.tier === tier)?.id ?? g?.options[0]?.id;
}
function optIdByRank(rules, key, field, which) {
  const g = findDecision(rules, key);
  if (!g) return undefined;
  const sorted = g.options.slice().sort((a, b) => (a[field] ?? 0) - (b[field] ?? 0));
  if (which === 'max') return sorted.at(-1).id;
  if (which === 'min') return sorted[0].id;
  return sorted[Math.floor(sorted.length / 2)].id;
}

/** 検証用の「典型的な戦略」一覧をルールから組み立てる */
export function buildArchetypes(rules, { includeAi = true } = {}) {
  const P = {
    low: optIdByRank(rules, 'price', 'unitPrice', 'min'),
    mid: optIdByRank(rules, 'price', 'unitPrice', 'mid'),
    high: optIdByRank(rules, 'price', 'unitPrice', 'max'),
  };
  const A = {
    none: optIdByRank(rules, 'ad', 'cost', 'min'),
    mid: optIdByRank(rules, 'ad', 'cost', 'mid'),
    max: optIdByRank(rules, 'ad', 'cost', 'max'),
  };
  const G = {
    none: optIdByRank(rules, 'give', 'cost', 'min'),
    mid: optIdByRank(rules, 'give', 'cost', 'mid'),
    max: optIdByRank(rules, 'give', 'cost', 'max'),
  };
  const fixed = (cacao, sugar, price, ad, give) => () => ({
    cacao: optIdByTier(rules, 'cacao', cacao),
    sugar: optIdByTier(rules, 'sugar', sugar),
    price,
    ad,
    give,
  });

  // それぞれの戦略が「その戦略なりに理にかなった価格」を選ぶようにする。
  // （高い原料を安く売る、のような明らかな悪手を混ぜるとバランス判定が歪むため）
  const list = [
    { id: 'cost-cutter', kind: 'fixed', label: '徹底コスト削減（一般市場・高価格）', decide: fixed('market', 'market', P.high, A.mid, G.none) },
    { id: 'mass-market', kind: 'fixed', label: '薄利多売（一般市場・安価格・広告最大）', decide: fixed('market', 'market', P.low, A.max, G.none) },
    { id: 'steady', kind: 'fixed', label: '無難な経営（一般市場・標準価格）', decide: fixed('market', 'market', P.mid, A.none, G.none) },
    { id: 'direct-trade', kind: 'fixed', label: '直接取引・高価格', decide: fixed('direct', 'direct', P.high, A.mid, G.none) },
    { id: 'give-heavy', kind: 'fixed', label: '一般市場だが還元は最大', decide: fixed('market', 'market', P.high, A.mid, G.max) },
    { id: 'ft-premium', kind: 'fixed', label: '全部認証・高価格（高級路線）', decide: fixed('fairtrade', 'fairtrade', P.high, A.mid, G.none) },
    { id: 'ft-max', kind: 'fixed', label: '全部認証・高価格・還元最大', decide: fixed('fairtrade', 'fairtrade', P.high, A.max, G.max) },
    { id: 'hybrid', kind: 'fixed', label: 'カカオだけ認証・高価格', decide: fixed('fairtrade', 'market', P.high, A.mid, G.mid) },
  ];
  if (includeAi) {
    list.push(
      { id: 'ai-profit', kind: 'ai', ai: 'profit', label: 'AI（利益重視・状況で変える）' },
      { id: 'ai-balanced', kind: 'ai', ai: 'balanced', label: 'AI（バランス・状況で変える）' },
      { id: 'ai-ethical', kind: 'ai', ai: 'ethical', label: 'AI（フェアトレード重視）' }
    );
  }
  return list;
}

function decideFor(rules, arch, ctx) {
  if (arch.kind === 'ai') {
    return decideForBot({
      rules,
      roundIndex: ctx.roundIndex,
      eventId: ctx.eventId,
      strategy: arch.ai,
      rng: rngFor(ctx.seed, ctx.playerId, ctx.roundIndex),
    });
  }
  return arch.decide();
}

/** 1ゲーム分を最後まで進める */
export function playGame(rules, lineup, seed) {
  const plan = planEvents(rules, seed);
  const players = lineup.map((arch, i) => ({
    id: `p${i}`,
    name: arch.id,
    company: arch.label,
    arch,
    score: initialPlayerScore(rules),
  }));
  const perEvent = [];

  for (let r = 0; r < rules.game.rounds; r++) {
    const eventId = plan[r];
    const submissions = players.map((p) => ({
      playerId: p.id,
      decision: decideFor(rules, p.arch, { roundIndex: r, eventId, seed, playerId: p.id }),
    }));
    const results = resolveRound({ rules, roundIndex: r, eventId, submissions, seed });
    for (const res of results) {
      const p = players.find((x) => x.id === res.playerId);
      p.score = applyResult(p.score, res);
      perEvent.push({ eventId, arch: p.arch.id, profit: res.profit, quantity: res.quantity });
    }
  }
  return { players, standings: computeStandings(rules, players), perEvent };
}

/**
 * 多数のゲームを回して、戦略ごとの成績を集計する。
 * 対戦相手の組み合わせが偏らないように、毎ゲーム顔ぶれをずらします。
 */
export function runSimulation({ rules, games = 1000, players = 5, archetypes, seedPrefix = 'sim' }) {
  const archs = archetypes ?? buildArchetypes(rules);
  const playerCount = Math.min(players, archs.length);
  const stats = new Map(
    archs.map((a) => [
      a.id,
      {
        id: a.id,
        label: a.label,
        kind: a.kind,
        games: 0,
        profitWins: 0,
        totalWins: 0,
        totalLast: 0,
        fundsSum: 0,
        producerSum: 0,
        societySum: 0,
        lossRounds: 0,
        byEvent: new Map(),
      },
    ])
  );

  for (let g = 0; g < games; g++) {
    const lineup = [];
    const used = new Set();
    for (let k = 0; k < playerCount; k++) {
      let idx = (g + k * (1 + (g % (archs.length - 1)))) % archs.length;
      while (used.has(idx)) idx = (idx + 1) % archs.length;
      used.add(idx);
      lineup.push(archs[idx]);
    }

    const { players: ps, standings, perEvent } = playGame(rules, lineup, `${seedPrefix}-${g}`);
    const profitTop = standings.profit[0];
    const totalTop = standings.total[0];
    const totalBottom = standings.total.at(-1);

    for (const p of ps) {
      const s = stats.get(p.arch.id);
      s.games++;
      s.fundsSum += p.score.funds;
      s.producerSum += p.score.producer;
      s.societySum += p.score.society;
      if (profitTop.id === p.id) s.profitWins++;
      if (totalTop.id === p.id) s.totalWins++;
      if (totalBottom.id === p.id) s.totalLast++;
    }
    for (const row of perEvent) {
      const s = stats.get(row.arch);
      if (row.profit < 0) s.lossRounds++;
      if (!s.byEvent.has(row.eventId)) s.byEvent.set(row.eventId, { n: 0, sum: 0 });
      const e = s.byEvent.get(row.eventId);
      e.n++;
      e.sum += row.profit;
    }
  }

  const rows = [...stats.values()].filter((s) => s.games > 0);
  for (const r of rows) {
    r.totalWinRate = r.totalWins / r.games;
    r.profitWinRate = r.profitWins / r.games;
    r.lastRate = r.totalLast / r.games;
    r.avgFunds = r.fundsSum / r.games;
    r.avgProducer = r.producerSum / r.games;
    r.avgSociety = r.societySum / r.games;
  }
  rows.sort((a, b) => b.totalWinRate - a.totalWinRate);
  return { rows, playerCount, games };
}

/**
 * バランスの良さを1つの数値にする（小さいほど良い）。
 * ねらい: どの戦略にも勝ち筋があり、突出した戦略も死に戦略もない状態。
 */
export function balanceScore(rows, playerCount) {
  const fair = 1 / playerCount;
  let score = 0;
  for (const r of rows) {
    score += Math.pow((r.totalWinRate - fair) * 100, 2);
    // 一度も勝てない戦略は「選ぶ意味がない」ので強めの減点
    if (r.totalWinRate < 0.03) score += 4000;
    // 半分以上勝つ戦略は支配的なので強めの減点
    if (r.totalWinRate > 0.45) score += 4000;
  }
  return Math.round(score / rows.length);
}
