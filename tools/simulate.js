/**
 * ゲームバランス検証ツール。
 *
 *   node tools/simulate.js                    … 既定ルールで1000ゲーム
 *   node tools/simulate.js --games 5000
 *   node tools/simulate.js --rules spec       … 発注仕様どおりの数値で検証
 *   node tools/simulate.js --players 6 --mode share
 *
 * 発注時にご懸念のあった
 *   「どの戦略でも勝てる可能性があるか」
 *   「特定の選択だけが圧倒的に有利になっていないか」
 * を、実際に何千回も対戦させて数字で確認します。
 *
 * 表は2つに分けています。
 *   ① 固定戦略どうし … 5年間ずっと同じ方針。数値バランスそのものを見る。
 *   ② AIどうし       … 毎年イベントを見て手を変える。人間の上手なプレイに近い。
 * ①と②を混ぜて比べると、AIが有利なのは当然なので、判定は①で行います。
 */

import { loadRuleset } from '../server/rules.js';
import { buildArchetypes, runSimulation, balanceScore } from './sim-core.js';

function parseArgs(argv) {
  const out = { games: 1000, players: 5, rules: 'mvp', mode: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--games') out.games = Number(argv[++i]);
    else if (a === '--players') out.players = Number(argv[++i]);
    else if (a === '--rules') out.rules = argv[++i];
    else if (a === '--mode') out.mode = argv[++i];
    else if (a === '--report') out.games = Math.max(out.games, 2000);
  }
  return out;
}

const args = parseArgs(process.argv);
let rules = loadRuleset(args.rules);
if (args.mode) rules = { ...rules, demand: { ...rules.demand, mode: args.mode } };

const pct = (n) => (n * 100).toFixed(1) + '%';
// 金額は円で保持しているので、表示は設定の単位（既定は万円）にそろえる
const MONEY_UNIT = rules.game.currency?.unit ?? 1;
const MONEY_LABEL = rules.game.currency?.unitLabel ?? '';
const num = (n) => Math.round(n / MONEY_UNIT).toLocaleString('ja-JP');
/** 点数など、お金ではない値はそのまま出す */
const plain = (n) => Math.round(n).toLocaleString('ja-JP');
const pad = (s, w) => String(s).padEnd(w, ' ');
const padL = (s, w) => String(s).padStart(w, ' ');
const W = 34;

function printTable(title, rows, playerCount) {
  console.log(`\n■ ${title}（公平なら各戦略 ${((1 / playerCount) * 100).toFixed(0)}% 前後）\n`);
  console.log(
    pad('戦略', W) +
      padL('総合1位', 9) +
      padL('利益1位', 9) +
      padL('最下位', 8) +
      padL(`平均資金(${MONEY_LABEL})`, 14) +
      padL('生産者', 8) +
      padL('社会', 7)
  );
  console.log('─'.repeat(W + 51));
  for (const r of rows) {
    console.log(
      pad(r.label.slice(0, W - 1), W) +
        padL(pct(r.totalWinRate), 9) +
        padL(pct(r.profitWinRate), 9) +
        padL(pct(r.lastRate), 8) +
        padL(num(r.avgFunds), 14) +
        padL(plain(r.avgProducer), 8) +
        padL(plain(r.avgSociety), 7)
    );
  }
}

console.log(`\nルール: ${rules.label}（${rules.sourceFile}） / 需要モデル: ${rules.demand.mode}`);
console.log(`${args.games} ゲームずつ対戦させます...`);
const started = Date.now();

/* ① 固定戦略どうし */
const fixedArchetypes = buildArchetypes(rules, { includeAi: false });
const fixedRun = runSimulation({
  rules,
  games: args.games,
  players: args.players,
  archetypes: fixedArchetypes,
  seedPrefix: 'fix',
});
printTable('固定戦略どうし（5年間ずっと同じ方針）', fixedRun.rows, fixedRun.playerCount);

/* ② AIどうし */
const aiArchetypes = buildArchetypes(rules).filter((a) => a.kind === 'ai');
const aiRun = runSimulation({
  rules,
  games: Math.min(args.games, 600),
  players: Math.min(args.players, aiArchetypes.length),
  archetypes: aiArchetypes,
  seedPrefix: 'ai',
});
printTable('AIどうし（毎年イベントを見て手を変える）', aiRun.rows, aiRun.playerCount);

/* イベント別の利益 */
console.log('\n■ イベント別の平均利益（1ラウンドあたり・固定戦略）\n');
const eventIds = rules.events.list.map((e) => e.id);
const nameOf = (id) => rules.events.list.find((e) => e.id === id)?.name ?? id;
console.log(pad('戦略', W) + eventIds.map((e) => padL(nameOf(e).slice(0, 7), 9)).join(''));
console.log('─'.repeat(W + eventIds.length * 9));
for (const r of fixedRun.rows) {
  const cells = eventIds.map((id) => {
    const e = r.byEvent.get(id);
    return padL(e ? num(e.sum / e.n) : '-', 9);
  });
  console.log(pad(r.label.slice(0, W - 1), W) + cells.join(''));
}

/* 判定 */
console.log('\n■ 判定（固定戦略どうしの結果で見ます）');
const problems = [];
for (const r of fixedRun.rows) {
  if (r.totalWinRate > 0.45) problems.push(`「${r.label}」の総合1位率が ${pct(r.totalWinRate)}。強すぎます`);
  if (r.totalWinRate < 0.03) problems.push(`「${r.label}」の総合1位率が ${pct(r.totalWinRate)}。選ぶ意味がありません`);
}
const ft = fixedRun.rows.find((r) => r.id === 'ft-premium');
const cheap = fixedRun.rows.find((r) => r.id === 'cost-cutter');
if (ft && ft.totalWinRate < 0.05)
  problems.push('認証を選ぶ戦略がほとんど勝てません（フェアトレードを選ぶ意味が伝わりません）');
if (cheap && cheap.totalWinRate < 0.05)
  problems.push('利益追求の戦略がほとんど勝てません（「認証を選べば必ず勝つ」ゲームになっています）');

console.log(`  バランススコア: ${balanceScore(fixedRun.rows, fixedRun.playerCount)}（小さいほど良い）`);
if (problems.length) {
  console.log('  ⚠ 調整をおすすめします:');
  for (const p of problems) console.log(`    - ${p}`);
  console.log('    → node tools/tune.js で、良い数値の組み合わせを探せます。');
} else {
  console.log('  ✅ どの戦略にも勝ち筋があり、支配的な戦略は見つかりませんでした。');
}
console.log(`\n（${Math.round((Date.now() - started) / 1000)}秒）\n`);
