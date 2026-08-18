/**
 * CPU プレイヤー（練習用AI）。
 *
 * 目的:
 *  1. 開発者・先生が1台のPCだけで4〜6人ぶんの動作確認をできるようにする。
 *  2. 生徒が奇数人・欠席が出たときに人数を埋める。
 *  3. バランス検証（tools/simulate.js）で戦略ごとの勝率を測る。
 *
 * 実装のポイント:
 *  AIはルールJSONの数値を直接見ずに、本物のゲームエンジンで全パターンを試算し、
 *  自分の「価値観」に沿って一番よい手を選びます。
 *  → ルールの数値を変えても、AIの強さが自動的に追従します（作り直し不要）。
 */

import { resolveRound, activeDecisions, defaultOptionId, findOption } from '../public/js/engine.js';

export const STRATEGIES = {
  profit: {
    id: 'profit',
    label: '利益重視AI',
    hint: '利益がいちばん大きくなる手を選びます。生産者への還元はしません。',
    score: (est) => est.profit,
  },
  balanced: {
    id: 'balanced',
    label: 'バランスAI',
    hint: '利益と社会への貢献の両方を狙います。',
    score: (est, ctx) => est.profit + ctx.pointValue * (est.producerGain + est.societyGain),
  },
  ethical: {
    id: 'ethical',
    label: 'フェアトレード重視AI',
    hint: '生産者への貢献を最優先します。そのぶん利益では不利になります。',
    score: (est, ctx) =>
      (est.producerGain + est.societyGain) * 1000 + Math.min(est.profit, 0) * 10 + est.profit * 0.01,
  },
  random: {
    id: 'random',
    label: '気まぐれAI',
    hint: 'ランダムに選びます。',
    score: () => 0,
  },
};

export const STRATEGY_IDS = Object.keys(STRATEGIES);

/** ルームに追加する順番（毎回同じ顔ぶれにならないようにローテーション） */
export const BOT_ROTATION = ['profit', 'ethical', 'balanced', 'random', 'balanced', 'profit'];

/** 有効な決定項目の全組み合わせを列挙する */
function enumerateDecisions(rules) {
  const groups = activeDecisions(rules);
  const fixed = {};
  for (const g of rules.decisions) {
    if (g.enabled === false) fixed[g.key] = defaultOptionId(g);
  }
  let combos = [{ ...fixed }];
  for (const g of groups) {
    const next = [];
    for (const base of combos) {
      for (const opt of g.options) next.push({ ...base, [g.key]: opt.id });
    }
    combos = next;
  }
  return combos;
}

/**
 * 「社会貢献1点は、利益いくらぶんの価値があるか」を、総合得点の重みから逆算する。
 *
 * 総合得点は各項目を 0〜100 に正規化してから重みをかけるので、
 * 「1ラウンドで動きうる利益の幅」と「1ラウンドで取りうる点数の幅」の比が交換レートになります。
 * ここを固定値にすると、ルールの数値を変えたときにAIが極端な打ち方をするようになるため、
 * 必ずルールから計算します。
 */
export function pointValueOf(rules) {
  const w = rules.scoring.weights;
  const priceGroup = rules.decisions.find((d) => d.kind === 'price');
  const maxPrice = Math.max(...priceGroup.options.map((o) => o.unitPrice || 0));
  const minCost = rules.decisions
    .filter((d) => d.kind === 'material')
    .reduce((sum, g) => sum + Math.min(...g.options.map((o) => o.unitCost || 0)), 0);

  const profitSpan = Math.max(1, rules.demand.base * (maxPrice - minCost));
  const pointSpan = Math.max(
    1,
    rules.decisions.reduce(
      (sum, g) => sum + Math.max(...g.options.map((o) => (o.producer || 0) + (o.society || 0))),
      0
    )
  );
  return ((w.producer + w.society) / Math.max(w.profit, 0.01)) * (profitSpan / pointSpan);
}

/**
 * 1手ぶんの試算。全候補で同じ seed / playerId を使うので、
 * 「運」の値が揃った状態で公平に比較できます。
 */
function estimate({ rules, roundIndex, eventId, decision }) {
  const [r] = resolveRound({
    rules,
    roundIndex,
    eventId,
    submissions: [{ playerId: 'botsim', decision }],
    seed: 'botsim-seed',
  });
  return r;
}

/**
 * AIの決定を返す。
 * @param {{ rules: object, roundIndex: number, eventId: string, strategy: string, rng: () => number }} p
 */
export function decideForBot({ rules, roundIndex, eventId, strategy, rng }) {
  const strat = STRATEGIES[strategy] || STRATEGIES.balanced;
  const combos = enumerateDecisions(rules);

  if (strat.id === 'random') {
    return combos[Math.floor((rng ? rng() : Math.random()) * combos.length) % combos.length];
  }

  const ctx = { pointValue: pointValueOf(rules) };

  const scored = combos
    .map((decision) => ({ decision, score: strat.score(estimate({ rules, roundIndex, eventId, decision }), ctx) }))
    .sort((a, b) => b.score - a.score);

  // 毎回「最善手」を打つと、AIが強すぎて生徒が勝てなくなります。
  // 上位のいくつかから選ぶことで、人間らしい（そして倒せる）相手にします。
  const roll = rng ? rng() : Math.random();
  const pickIndex = roll < 0.45 ? 0 : roll < 0.75 ? 1 : roll < 0.92 ? 2 : 3;
  const chosen = scored[Math.min(pickIndex, scored.length - 1)].decision;

  // ときどき、まったく別の選択も混ぜる（授業中の見た目に変化をつけるため）
  if (rng && rng() < 0.12) {
    const groups = activeDecisions(rules);
    const g = groups[Math.floor(rng() * groups.length) % groups.length];
    const opt = g.options[Math.floor(rng() * g.options.length) % g.options.length];
    if (findOption(g, opt.id)) return { ...chosen, [g.key]: opt.id };
  }
  return chosen;
}

/** AIらしい「考えている時間」。全員AIのときでも授業が止まらない程度に。 */
export function botThinkDelay(rng) {
  return 1200 + Math.floor((rng ? rng() : Math.random()) * 2600);
}
