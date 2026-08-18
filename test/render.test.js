/**
 * 画面部品のテスト。
 *
 * 本物のゲームを1回まわして得た状態を、そのまま画面部品に渡します。
 * サーバが配る形と画面が期待する形がズレたら、ここで落ちます。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { installDom } from './dom-stub.js';

installDom(); // components.js を読み込む前に必要

const { loadRuleset } = await import('../server/rules.js');
const { Room } = await import('../server/room.js');
const companies = JSON.parse(
  await import('node:fs').then((fs) => fs.readFileSync(new URL('../config/companies.json', import.meta.url), 'utf8'))
);
const {
  eventCard,
  playerList,
  roundResultTable,
  myResultBreakdown,
  rankingList,
  scoreBar,
  scoreLegend,
  roundSteps,
  marginSummary,
  decisionBadges,
  stat,
} = await import('../public/js/components.js');

/* ------------------------------------------------ 本物の1ゲームを用意する */

function playFullGame(ruleId = 'mvp') {
  const rules = loadRuleset(ruleId);
  const room = new Room({ code: '123456', rules, companies, seed: 'render-test' });
  const names = ['あおい', 'はると', 'ゆい', 'そうた'];
  const ids = names.map((n) => room.addPlayer({ name: n }).player.id);
  room.start();

  const plays = [
    { cacao: 'market', sugar: 'market', price: 'high', ad: 'none', give: 'none' },
    { cacao: 'fairtrade', sugar: 'fairtrade', price: 'high', ad: 'small', give: 'high' },
    { cacao: 'direct', sugar: 'direct', price: 'low', ad: 'large', give: 'mid' },
    { cacao: 'fairtrade', sugar: 'market', price: 'mid', ad: 'none', give: 'none' },
  ];

  for (let r = 1; r <= rules.game.rounds; r++) {
    ids.forEach((id, i) => room.submit(id, plays[i % plays.length]));
    room.next();
  }
  return { rules, room, ids };
}

const { rules, room, ids } = playFullGame();
const myId = ids[1];
const finalState = room.snapshot({ role: 'player', playerId: myId });
const teacherState = room.snapshot({ role: 'teacher' });

test('準備: ゲームが最終画面まで進んでいる', () => {
  assert.equal(finalState.phase, 'final');
  assert.equal(finalState.rounds.length, rules.game.rounds);
  assert.ok(finalState.standings);
});

/* ------------------------------------------------ 各部品 */

test('イベントカードが描ける（まめ知識つき・なし両方）', () => {
  const withLearn = eventCard(
    { id: 'cacao_shortage', name: 'カカオ不作', icon: '🌦', headline: '見出し', body: '本文', learn: '解説' },
    { showLearn: true }
  );
  assert.ok(withLearn.allText.includes('カカオ不作'));
  assert.ok(withLearn.allText.includes('解説'));

  const compact = eventCard({ id: 'quiet', name: 'おだやか', headline: 'h' }, { compact: true });
  assert.ok(compact.allText.includes('おだやか'));
  assert.equal(eventCard(null), null, 'イベントが無い場面でも落ちない');
});

test('参加者一覧が人数ぶん描ける', () => {
  const node = playerList(finalState, { myId });
  const rows = node.findAll((n) => String(n.className).startsWith('player'));
  assert.equal(rows.length, 4);
  assert.ok(node.allText.includes('あおい'));
  assert.ok(node.allText.includes('(あなた)'), '自分がわかる表示になっている');
});

test('参加者一覧に退出ボタンを出せる（先生用）', () => {
  let removed = null;
  const node = playerList(teacherState, { onRemove: (p) => (removed = p) });
  const buttons = node.findAll((n) => n.tagName === 'BUTTON');
  assert.equal(buttons.length, 4);
  buttons[0].listeners.click[0]();
  assert.ok(removed?.id, '押すとコールバックが呼ばれる');
});

test('ラウンド結果の表が全員ぶん描ける', () => {
  const entry = finalState.rounds[0];
  const table = roundResultTable(finalState, rules, entry, { myId });
  const bodyRows = table.findAll((n) => n.tagName === 'TR');
  assert.equal(bodyRows.length, 5, 'ヘッダ1行 + 参加者4行');
  const meRow = table.findAll((n) => n.className === 'me');
  assert.equal(meRow.length, 1, '自分の行が強調される');
});

test('自分の結果の内訳が描ける', () => {
  const entry = finalState.rounds.at(-1);
  const mine = entry.results.find((r) => r.playerId === myId);
  const me = finalState.players.find((p) => p.id === myId);
  const node = myResultBreakdown(rules, mine, me);
  const text = node.allText;
  assert.ok(text.includes('販売数'));
  assert.ok(text.includes('今年の利益'));
  assert.ok(text.includes('生産者への貢献'));
  assert.equal(myResultBreakdown(rules, null, me), null, '結果が無くても落ちない');
});

test('ランキングが順位つきで描ける', () => {
  const node = rankingList(finalState.standings.total, { unit: '点', myId, bar: true });
  const rows = node.findAll((n) => String(n.className).includes('rank-row'));
  assert.equal(rows.length, 4);
  assert.ok(rows[0].className.includes('r1'), '1位に専用のスタイルがつく');
  assert.ok(node.allText.includes('★'), '自分の会社に印がつく');
});

test('総合得点の内訳バーが3色ぶん描ける', () => {
  const row = finalState.standings.total[0];
  const bar = scoreBar(row);
  assert.equal(bar.children.length, 3);
  for (const span of bar.children) assert.ok(span.style.width.endsWith('%'));
});

test('凡例に重みが表示される', () => {
  const text = scoreLegend(rules).allText;
  assert.ok(text.includes('60%'));
  assert.ok(text.includes('25%'));
  assert.ok(text.includes('15%'));
});

test('進行ステップがラウンド数ぶん出る', () => {
  const node = roundSteps(finalState);
  const steps = node.findAll((n) => String(n.className).includes('step'));
  assert.equal(steps.length, rules.game.rounds + 1, '各ラウンド + 結果発表');
});

test('選択内容のバッジが描ける', () => {
  const decision = { cacao: 'fairtrade', sugar: 'market', price: 'high', ad: 'small', give: 'mid' };
  const text = decisionBadges(rules, decision).allText;
  assert.ok(text.includes('FLO認証'));
  assert.ok(text.includes('一般市場'));
  assert.equal(decisionBadges(rules, null).allText, '—', '未決定でも落ちない');
});

test('利幅の見積もりが描ける（販売数は見せない）', () => {
  const decision = { cacao: 'market', sugar: 'market', price: 'high', ad: 'large', give: 'high' };
  const node = marginSummary(rules, decision, null);
  const text = node.allText;
  assert.ok(text.includes('販売価格'));
  assert.ok(text.includes('1ロットの利益'));
  assert.ok(!text.includes('予想販売数'), '答えそのものは見せない');
});

test('原価割れのときは警告が出る', () => {
  const bad = { cacao: 'fairtrade', sugar: 'fairtrade', price: 'low', ad: 'none', give: 'none' };
  const text = marginSummary(rules, bad, null).allText;
  assert.ok(text.includes('赤字'), '売るほど赤字になる組み合わせを警告する');
});

test('イベント中は原料費の上昇が見積もりに反映される', () => {
  const decision = { cacao: 'market', sugar: 'market', price: 'high', ad: 'none', give: 'none' };
  const shortage = rules.events.list.find((e) => e.id === 'cacao_shortage');
  const normal = marginSummary(rules, decision, null).allText;
  const during = marginSummary(rules, decision, shortage).allText;
  assert.notEqual(normal, during);
  assert.ok(during.includes('イベントの影響'));
});

test('小学校版（項目が少ないルール）でも同じ部品で描ける', () => {
  const { rules: elRules, room: elRoom, ids: elIds } = playFullGame('elementary');
  const st = elRoom.snapshot({ role: 'player', playerId: elIds[0] });
  assert.equal(st.rounds.length, 3);
  assert.doesNotThrow(() => {
    roundResultTable(st, elRules, st.rounds[0], { myId: elIds[0] });
    rankingList(st.standings.total, { unit: '点' });
    marginSummary(elRules, st.you?.draft ?? {}, null);
    decisionBadges(elRules, st.rounds[0].results[0].decision);
  });
});

test('統計タイルの部品が描ける', () => {
  const node = stat('資金', '1,234', '前年比 +100');
  assert.ok(node.allText.includes('資金'));
  assert.ok(node.allText.includes('1,234'));
});
