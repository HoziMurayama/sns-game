/**
 * ゲームバランスの自動調整（パラメータ探索）。
 *
 *   node tools/tune.js               … 既定の探索範囲で総当たり
 *   node tools/tune.js --games 400   … 1組み合わせあたりのゲーム数
 *   node tools/tune.js --apply       … いちばん良かった値を config に書き戻す
 *
 * 何をしているか:
 *   「価格の効きかた」「認証原料の人気」「還元の点数」を少しずつ変えながら
 *   何百ゲームも対戦させ、どの戦略にも勝ち筋がある組み合わせを探します。
 *
 * 授業でプレイした結果を見て数値を変えたくなったときも、
 * このツールを回せば「壊れていないか」をすぐ確認できます。
 */

import fs from 'node:fs';
import path from 'node:path';
import { loadRuleset, CONFIG_DIR, validateRules } from '../server/rules.js';
import { buildArchetypes, runSimulation, balanceScore } from './sim-core.js';

const args = process.argv.slice(2);
const getArg = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : def;
};
const GAMES = Number(getArg('--games', 300));
const PLAYERS = Number(getArg('--players', 5));
const RULE_ID = getArg('--rules', 'mvp');
const APPLY = args.includes('--apply');

const base = loadRuleset(RULE_ID);

/* ------------------------------------------------ 探索する値 */

const GRID = {
  priceLow: [0.85, 1.0],
  priceHigh: [-0.25],
  // 認証原料の「常時の人気」。小さくすると、認証が有利になるのは
  // 消費者の関心が高まったイベントの年だけ、というモデルに近づく。
  ftDemand: [0.06, 0.09, 0.12],
  directRatio: [0.4, 0.6, 0.8], // 直接取引の人気を、認証の何倍にするか
  giveProducer: [8, 12, 16], // 上限の還元でもらえる生産者点（中間はこの半分）
  profitWeight: [0.6], // 総合得点における利益の比率（発注仕様の60%を維持）
  randomness: [0.1], // 運の幅
  eventPower: [2, 2.5, 3], // 市場イベントの効きかた
};

/** ルールのコピーにパラメータを当てる */
function withParams(rules, p) {
  const next = structuredClone(rules);
  const set = (key, id, patch) => {
    const g = next.decisions.find((d) => d.key === key);
    const o = g?.options.find((x) => x.id === id);
    if (o) Object.assign(o, patch);
  };
  const priceGroup = next.decisions.find((d) => d.kind === 'price');
  const sorted = priceGroup.options.slice().sort((a, b) => a.unitPrice - b.unitPrice);
  sorted[0].demand = p.priceLow;
  sorted[sorted.length - 1].demand = p.priceHigh;

  for (const key of ['cacao', 'sugar']) {
    const g = next.decisions.find((d) => d.key === key);
    for (const o of g?.options ?? []) {
      if (o.tier === 'fairtrade') o.demand = p.ftDemand;
      if (o.tier === 'direct') o.demand = Math.round(p.ftDemand * (p.directRatio ?? 0.4) * 1000) / 1000;
    }
  }

  const give = next.decisions.find((d) => d.key === 'give');
  if (give) {
    const opts = give.options.slice().sort((a, b) => a.cost - b.cost);
    if (opts.length >= 3) {
      opts[1].producer = Math.round(p.giveProducer / 2);
      opts[1].society = Math.round((p.giveProducer / 2) * 0.6);
      opts[2].producer = p.giveProducer;
      opts[2].society = Math.round(p.giveProducer * 0.6);
    }
  }

  if (p.randomness != null) next.demand = { ...next.demand, randomness: p.randomness };

  // イベントの効きかたを一律に強く／弱くする（1.0 でそのまま、2.0 で効果2倍）
  if (p.eventPower != null && p.eventPower !== 1) {
    for (const e of next.events.list) {
      for (const eff of e.effects ?? []) eff.mul = 1 + (eff.mul - 1) * p.eventPower;
    }
  }

  if (p.profitWeight != null) {
    const rest = 1 - p.profitWeight;
    next.scoring.weights = {
      profit: p.profitWeight,
      producer: Math.round(rest * (25 / 40) * 1000) / 1000,
      society: Math.round(rest * (15 / 40) * 1000) / 1000,
    };
    // 端数で合計が1からずれないよう調整
    const sum = next.scoring.weights.profit + next.scoring.weights.producer + next.scoring.weights.society;
    next.scoring.weights.society = Math.round((next.scoring.weights.society + (1 - sum)) * 1000) / 1000;
  }
  return next;
}

/* ------------------------------------------------ 探索 */

/** GRID の全キーの直積を作る */
function cartesian(grid) {
  let out = [{}];
  for (const [key, values] of Object.entries(grid)) {
    const next = [];
    for (const base of out) for (const v of values) next.push({ ...base, [key]: v });
    out = next;
  }
  return out;
}
const combos = cartesian(GRID);
const describe = (p) =>
  `安+${p.priceLow} 高${p.priceHigh} 認証+${p.ftDemand} 直接×${p.directRatio} 還元点${p.giveProducer} 運±${Math.round(
    p.randomness * 100
  )}% イベント×${p.eventPower}`;

console.log(`\n${combos.length} 通り × ${GAMES}ゲーム を試します（${PLAYERS}人対戦）...\n`);
const started = Date.now();

const results = [];
let done = 0;
for (const p of combos) {
  const rules = withParams(base, p);
  // 固定戦略どうしで比べる（AIは「状況に合わせる」ぶん強いので、素の数値バランスが見えにくくなる）
  const archetypes = buildArchetypes(rules, { includeAi: false });
  const { rows, playerCount } = runSimulation({ rules, games: GAMES, players: PLAYERS, archetypes });
  const score = balanceScore(rows, playerCount);
  results.push({ params: p, score, rows });
  done++;
  if (done % 20 === 0) process.stdout.write(`  ${done}/${combos.length} 完了\r`);
}

results.sort((a, b) => a.score - b.score);
console.log(`\n探索終了（${Math.round((Date.now() - started) / 1000)}秒）\n`);

const pctFmt = (n) => (n * 100).toFixed(1) + '%';
console.log('■ 上位10件（スコアが小さいほどバランスが良い）\n');
for (const r of results.slice(0, 10)) {
  const spread = r.rows.map((x) => `${x.id}:${pctFmt(x.totalWinRate)}`).join('  ');
  console.log(`  score=${String(r.score).padStart(6)}  ${describe(r.params)}`);
  console.log(`          ${spread}`);
}

const best = results[0];
console.log('\n■ いちばんバランスが良かった値');
console.log(JSON.stringify(best.params, null, 2));
console.log('\n■ そのときの各戦略の成績');
for (const r of best.rows) {
  console.log(
    `  ${r.label.padEnd(34)} 総合1位 ${pctFmt(r.totalWinRate).padStart(6)}  利益1位 ${pctFmt(
      r.profitWinRate
    ).padStart(6)}  平均資金 ${Math.round(r.avgFunds).toLocaleString('ja-JP').padStart(7)}`
  );
}

/* ------------------------------------------------ 反映 */

if (APPLY) {
  const file = path.join(CONFIG_DIR, `rules.${RULE_ID}.json`);
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const p = best.params;

  const priceGroup = raw.decisions.find((d) => d.kind === 'price');
  const sorted = priceGroup.options.slice().sort((a, b) => a.unitPrice - b.unitPrice);
  sorted[0].demand = p.priceLow;
  sorted.at(-1).demand = p.priceHigh;

  for (const key of ['cacao', 'sugar']) {
    const g = raw.decisions.find((d) => d.key === key);
    for (const o of g?.options ?? []) {
      if (o.tier === 'fairtrade') o.demand = p.ftDemand;
      if (o.tier === 'direct') o.demand = Math.round(p.ftDemand * (p.directRatio ?? 0.4) * 1000) / 1000;
    }
  }
  const give = raw.decisions.find((d) => d.key === 'give');
  const gopts = give.options.slice().sort((a, b) => a.cost - b.cost);
  gopts[1].producer = Math.round(p.giveProducer / 2);
  gopts[1].society = Math.round((p.giveProducer / 2) * 0.6);
  gopts[2].producer = p.giveProducer;
  gopts[2].society = Math.round(p.giveProducer * 0.6);

  validateRules({ ...raw, sourceFile: path.basename(file) });
  fs.writeFileSync(file, JSON.stringify(raw, null, 2) + '\n', 'utf8');
  console.log(`\n✅ ${path.basename(file)} に反映しました。`);
  console.log('   ゲーム内の説明文（desc）は自動更新されないので、必要なら手で直してください。\n');
} else {
  console.log('\n（--apply を付けて実行すると、この値を config に書き戻します）\n');
}
