/**
 * ゲームエンジンの単体テスト。
 * ルールJSONの数値を変えても壊れないよう、値そのものではなく「関係」を検証します。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { loadRuleset } from '../server/rules.js';
import {
  planEvents,
  resolveRound,
  sanitizeDecision,
  isDecisionComplete,
  defaultDecision,
  computeStandings,
  normalizeValues,
  initialPlayerScore,
  applyResult,
  activeDecisions,
  buildInsights,
} from '../shared/engine.js';

const rules = loadRuleset('mvp');
const D = (over = {}) => ({ cacao: 'market', sugar: 'market', price: 'mid', ad: 'none', give: 'none', ...over });

const one = (decision, { eventId = 'quiet', seed = 'test', roundIndex = 0 } = {}) =>
  resolveRound({ rules, roundIndex, eventId, seed, submissions: [{ playerId: 'p', decision }] })[0];

/* ------------------------------------------------ 入力の正規化 */

test('不正な選択はすべて既定値に落ちる（サーバは例外を投げない）', () => {
  const dirty = { cacao: 'GOLD', price: 999, ad: null, extra: 'x' };
  const clean = sanitizeDecision(rules, dirty);
  assert.deepEqual(clean, defaultDecision(rules));
  assert.equal(clean.extra, undefined);
});

test('null / undefined を渡しても既定値になる', () => {
  assert.deepEqual(sanitizeDecision(rules, null), defaultDecision(rules));
  assert.deepEqual(sanitizeDecision(rules, undefined), defaultDecision(rules));
});

test('必要な項目がそろっているかを判定できる', () => {
  assert.equal(isDecisionComplete(rules, D()), true);
  assert.equal(isDecisionComplete(rules, { cacao: 'market' }), false);
  assert.equal(isDecisionComplete(rules, null), false);
});

/* ------------------------------------------------ 計算 */

test('売上・原料費・利益の関係が式どおりになる', () => {
  const r = one(D({ price: 'high', ad: 'small', give: 'mid' }));
  assert.equal(r.revenue, Math.round(r.unitPrice * r.quantity));
  assert.equal(r.profit, r.revenue - r.materialCost - r.adCost - r.giveCost);
  assert.equal(r.adCost, 500_000);
  assert.equal(r.giveCost, 300_000);
});

test('価格を上げると販売数は減り、下げると増える', () => {
  const low = one(D({ price: 'low' })).quantity;
  const mid = one(D({ price: 'mid' })).quantity;
  const high = one(D({ price: 'high' })).quantity;
  assert.ok(low > mid, `low(${low}) > mid(${mid})`);
  assert.ok(mid > high, `mid(${mid}) > high(${high})`);
});

test('広告を増やすと販売数が増える', () => {
  const none = one(D({ ad: 'none' })).quantity;
  const small = one(D({ ad: 'small' })).quantity;
  const large = one(D({ ad: 'large' })).quantity;
  assert.ok(small > none && large > small);
});

test('認証原料は仕入が高く、貢献点が高い', () => {
  const market = one(D());
  const ft = one(D({ cacao: 'fairtrade', sugar: 'fairtrade' }));
  assert.ok(ft.unitCost > market.unitCost);
  assert.ok(ft.producerGain > market.producerGain);
  assert.ok(ft.societyGain > market.societyGain);
  assert.equal(market.producerGain, 0);
});

test('カカオと砂糖は別々に選べる（点数も別々に積まれる）', () => {
  const mixed = one(D({ cacao: 'fairtrade', sugar: 'market' }));
  const both = one(D({ cacao: 'fairtrade', sugar: 'fairtrade' }));
  assert.ok(both.producerGain > mixed.producerGain);
  assert.ok(mixed.producerGain > 0);
});

test('追加還元は利益から引かれ、貢献点になる', () => {
  const none = one(D({ give: 'none' }));
  const high = one(D({ give: 'high' }));
  assert.equal(high.giveCost, 600_000);
  assert.equal(high.profit, none.profit - 600_000);
  assert.ok(high.producerGain > none.producerGain);
});

/* ------------------------------------------------ イベント */

test('カカオ不作: 一般市場だけが大きく値上がりし、認証は影響を受けない', () => {
  const marketBefore = one(D(), { eventId: 'quiet' }).unitCost;
  const marketAfter = one(D(), { eventId: 'cacao_shortage' }).unitCost;
  const ftBefore = one(D({ cacao: 'fairtrade' }), { eventId: 'quiet' }).unitCost;
  const ftAfter = one(D({ cacao: 'fairtrade' }), { eventId: 'cacao_shortage' }).unitCost;

  assert.ok(marketAfter > marketBefore, '一般市場は値上がりする');
  assert.equal(ftAfter, ftBefore, 'フェアトレード認証は最低価格の仕組みで変わらない');
});

test('フェアトレード関心上昇: 認証原料を使っている会社だけ販売数が伸びる', () => {
  const plainQuiet = one(D(), { eventId: 'quiet' }).quantity;
  const plainBoom = one(D(), { eventId: 'fairtrade_boom' }).quantity;
  const ftQuiet = one(D({ cacao: 'fairtrade' }), { eventId: 'quiet' }).quantity;
  const ftBoom = one(D({ cacao: 'fairtrade' }), { eventId: 'fairtrade_boom' }).quantity;

  assert.equal(plainBoom, plainQuiet);
  assert.ok(ftBoom > ftQuiet);
});

test('節約志向: 高価格の会社だけ販売数が減る', () => {
  const midQuiet = one(D({ price: 'mid' }), { eventId: 'quiet' }).quantity;
  const midFrugal = one(D({ price: 'mid' }), { eventId: 'frugal' }).quantity;
  const highQuiet = one(D({ price: 'high' }), { eventId: 'quiet' }).quantity;
  const highFrugal = one(D({ price: 'high' }), { eventId: 'frugal' }).quantity;

  assert.equal(midFrugal, midQuiet);
  assert.ok(highFrugal < highQuiet);
});

test('SNSで話題: 広告を上限まで使った会社だけ伸びる', () => {
  const small = one(D({ ad: 'small' }), { eventId: 'sns_buzz' }).quantity;
  const smallQuiet = one(D({ ad: 'small' }), { eventId: 'quiet' }).quantity;
  const large = one(D({ ad: 'large' }), { eventId: 'sns_buzz' }).quantity;
  const largeQuiet = one(D({ ad: 'large' }), { eventId: 'quiet' }).quantity;

  assert.equal(small, smallQuiet, '広告を少しだけ出した会社は条件を満たさない');
  assert.ok(large > largeQuiet);
});

test('イベントの条件は金額ではなく選択肢のidで書く（通貨を変えても壊れないように）', () => {
  const sns = rules.events.list.find((e) => e.id === 'sns_buzz');
  const when = sns.effects[0].when;
  assert.deepEqual(when.adIn, ['large']);
  assert.equal(when.adCostAtLeast, undefined, '金額での指定は残っていない');
});

/* ------------------------------------------------ 乱数と決定性 */

test('同じ入力なら必ず同じ結果になる（再接続・再起動しても結果が変わらない）', () => {
  const a = one(D({ price: 'high' }), { seed: 'seed-A' });
  const b = one(D({ price: 'high' }), { seed: 'seed-A' });
  assert.deepEqual(a, b);
});

test('プレイヤーの並び順が変わっても各自の結果は変わらない', () => {
  const subs = [
    { playerId: 'zzz', decision: D({ price: 'low' }) },
    { playerId: 'aaa', decision: D({ price: 'high' }) },
  ];
  const r1 = resolveRound({ rules, roundIndex: 0, eventId: 'quiet', seed: 's', submissions: subs });
  const r2 = resolveRound({ rules, roundIndex: 0, eventId: 'quiet', seed: 's', submissions: subs.slice().reverse() });
  const pick = (rs, id) => rs.find((r) => r.playerId === id);
  assert.deepEqual(pick(r1, 'aaa'), pick(r2, 'aaa'));
  assert.deepEqual(pick(r1, 'zzz'), pick(r2, 'zzz'));
});

test('運の幅は設定値の範囲内に収まる', () => {
  const spread = rules.demand.randomness;
  for (let i = 0; i < 300; i++) {
    const r = one(D(), { seed: `s${i}` });
    assert.ok(r.factors.luck >= 1 - spread - 0.01 && r.factors.luck <= 1 + spread + 0.01);
  }
});

/* ------------------------------------------------ イベント計画 */

test('1ラウンド目は静かな年で、以降は必ず実在するイベントになる', () => {
  const plan = planEvents(rules, 'plan-seed');
  assert.equal(plan.length, rules.game.rounds);
  assert.equal(plan[0], 'quiet');
  for (const id of plan) assert.ok(rules.events.list.some((e) => e.id === id));
});

test('noRepeat:true にすると同じイベントは2回出ない', () => {
  const noRepeat = { ...rules, events: { ...rules.events, noRepeat: true } };
  const rest = planEvents(noRepeat, 'plan-seed').slice(1);
  assert.equal(new Set(rest).size, rest.length);
});

test('mode:"fixed" のときは指定した順にイベントが出る', () => {
  const fixed = {
    ...rules,
    events: { ...rules.events, mode: 'fixed', fixedOrder: ['quiet', 'frugal', 'sns_buzz', 'quiet', 'frugal'] },
  };
  assert.deepEqual(planEvents(fixed, 'any'), ['quiet', 'frugal', 'sns_buzz', 'quiet', 'frugal']);
});

test('イベント計画はシードで決まる', () => {
  assert.deepEqual(planEvents(rules, 'x'), planEvents(rules, 'x'));
});

/* ------------------------------------------------ 集計 */

test('正規化は0〜100に収まり、全員同じ値なら全員100', () => {
  assert.deepEqual(normalizeValues([0, 50, 100]), [0, 50, 100]);
  assert.deepEqual(normalizeValues([7, 7, 7]), [100, 100, 100]);
  const withNegative = normalizeValues([-100, 0, 100]);
  assert.equal(withNegative[0], 0);
  assert.equal(withNegative[2], 100);
});

test('総合得点は重みどおりに合成される', () => {
  const players = [
    { id: 'a', name: 'A', company: 'A社', score: { funds: 2000, producer: 0, society: 0 } },
    { id: 'b', name: 'B', company: 'B社', score: { funds: 1000, producer: 100, society: 100 } },
  ];
  const s = computeStandings(rules, players);
  const a = s.total.find((r) => r.id === 'a');
  const b = s.total.find((r) => r.id === 'b');
  const w = rules.scoring.weights;
  assert.equal(a.total, Math.round(w.profit * 100 * 10) / 10);
  assert.equal(b.total, Math.round((w.producer + w.society) * 100 * 10) / 10);
  // 利益60% < 生産者25%+社会15%=40% なので、利益だけの会社が総合1位
  assert.equal(s.total[0].id, 'a');
});

test('利益1位と総合1位が入れ替わることがある（教材としての要）', () => {
  const players = [
    { id: 'a', name: 'A', company: '利益重視社', score: { funds: 2200, producer: 0, society: 0 } },
    { id: 'b', name: 'B', company: 'バランス社', score: { funds: 2000, producer: 200, society: 120 } },
    { id: 'c', name: 'C', company: '安売り社', score: { funds: 1200, producer: 0, society: 0 } },
  ];
  const s = computeStandings(rules, players);
  assert.equal(s.profit[0].id, 'a');
  assert.equal(s.total[0].id, 'b');
  const insights = buildInsights(rules, s);
  assert.ok(insights.some((i) => i.type === 'flip'));
});

test('同点は同順位になる', () => {
  const players = [
    { id: 'a', name: 'A', company: 'A社', score: { funds: 1000, producer: 10, society: 10 } },
    { id: 'b', name: 'B', company: 'B社', score: { funds: 1000, producer: 10, society: 10 } },
    { id: 'c', name: 'C', company: 'C社', score: { funds: 500, producer: 0, society: 0 } },
  ];
  const s = computeStandings(rules, players);
  assert.equal(s.profit[0].rank, 1);
  assert.equal(s.profit[1].rank, 1);
  assert.equal(s.profit[2].rank, 3);
});

test('資金の累積が各ラウンドの利益の合計と一致する', () => {
  let score = initialPlayerScore(rules);
  let sum = 0;
  for (let i = 0; i < rules.game.rounds; i++) {
    const r = one(D({ price: 'high' }), { roundIndex: i, seed: 'acc' });
    score = applyResult(score, r);
    sum += r.profit;
  }
  assert.equal(score.funds, rules.game.startingFunds + sum);
});

/* ------------------------------------------------ 需要モデル */

test('競争モードでは全員の販売数の合計が一定になる', () => {
  const shareRules = { ...rules, demand: { ...rules.demand, mode: 'share' } };
  const subs = [
    { playerId: 'a', decision: D({ price: 'low' }) },
    { playerId: 'b', decision: D({ price: 'high' }) },
    { playerId: 'c', decision: D({ price: 'mid' }) },
  ];
  const rs = resolveRound({ rules: shareRules, roundIndex: 0, eventId: 'quiet', seed: 's', submissions: subs });
  const total = rs.reduce((a, r) => a + r.quantity, 0);
  const expected = (shareRules.demand.share.perPlayer ?? shareRules.demand.base) * subs.length;
  assert.ok(Math.abs(total - expected) < 0.5, `合計 ${total} ≒ ${expected}`);
  // 安く売った会社のほうがシェアは大きい
  const a = rs.find((r) => r.playerId === 'a');
  const b = rs.find((r) => r.playerId === 'b');
  assert.ok(a.quantity > b.quantity);
});

/* ------------------------------------------------ 別ルールセット */

test('小学校版はラウンド数と決定項目が減っている', () => {
  const el = loadRuleset('elementary');
  assert.equal(el.game.rounds, 3);
  const keys = activeDecisions(el).map((d) => d.key);
  assert.deepEqual(keys.sort(), ['cacao', 'price']);
  // 無効化した項目も既定値として計算に入る（砂糖代は発生する）
  const r = resolveRound({
    rules: el,
    roundIndex: 0,
    eventId: 'quiet',
    seed: 's',
    submissions: [{ playerId: 'p', decision: { cacao: 'market', price: 'mid' } }],
  })[0];
  assert.ok(r.unitCost > 0);
  assert.equal(r.adCost, 0);
});

test('発注仕様どおりのルールセットも動く', () => {
  const spec = loadRuleset('spec');
  assert.equal(spec.demand.base, 100);
  const r = resolveRound({
    rules: spec,
    roundIndex: 0,
    eventId: 'quiet',
    seed: 's',
    submissions: [{ playerId: 'p', decision: D() }],
  })[0];
  assert.ok(r.quantity > 80 && r.quantity < 120);
});
