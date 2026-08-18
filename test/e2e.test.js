/**
 * 通しテスト（実際の授業と同じ流れを、本物のサーバとWebSocketで再現する）。
 *
 * ここで確認したいのは、発注時に挙がった「MVPで検証したいこと」そのものです。
 *   ① 4〜6人が同じルームに入れる
 *   ② 先生がゲームを開始できる
 *   ③ 全員が同じゲーム状態を共有できる
 *   ④ 各プレイヤーが意思決定できる
 *   ⑥ ラウンドごとの結果が同期される
 *   ⑦ 最終的にランキングが表示される
 * ＋ 通信が切れた場合の復帰
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer, TestClient, sleep } from './helpers.js';

const PORT = 31741;
let server;

test.before(async () => {
  server = await startServer(PORT);
});
test.after(async () => {
  await server?.stop();
});

async function makeRoom(options = {}) {
  const teacher = await new TestClient(server.wsUrl, 'teacher').connect();
  teacher.send({ t: 'createRoom', ruleset: 'mvp', options });
  await teacher.waitFor((m) => m.t === 'welcome');
  return teacher;
}

async function joinPlayers(code, names) {
  const players = [];
  for (const name of names) {
    const c = await new TestClient(server.wsUrl, name).connect();
    c.send({ t: 'joinRoom', code, name });
    await c.waitFor((m) => m.t === 'welcome' || m.t === 'error');
    assert.ok(c.welcome, `${name} が参加できませんでした`);
    players.push(c);
  }
  return players;
}

const PLAYS = [
  { cacao: 'market', sugar: 'market', price: 'high', ad: 'none', give: 'none' },
  { cacao: 'fairtrade', sugar: 'fairtrade', price: 'high', ad: 'small', give: 'high' },
  { cacao: 'direct', sugar: 'direct', price: 'mid', ad: 'large', give: 'mid' },
  { cacao: 'fairtrade', sugar: 'market', price: 'low', ad: 'none', give: 'none' },
];

/* ================================================================ */

test('4人で5ラウンドを最後まで対戦できる', async () => {
  const teacher = await makeRoom();
  const code = teacher.state.code;
  assert.match(code, /^\d{6}$/, 'ルーム番号は6桁');

  const players = await joinPlayers(code, ['あおい', 'はると', 'ゆい', 'そうた']);

  // ① 全員が同じ状態を共有している
  await teacher.waitFor((m) => m.t === 'state' && m.state.playerCount === 4);
  assert.equal(teacher.state.playerCount, 4);
  for (const p of players) {
    await p.waitFor((m) => m.t === 'state' && m.state.playerCount === 4);
    assert.equal(p.state.playerCount, 4);
    assert.ok(p.state.you, '自分の情報が配られている');
    assert.equal(p.state.you.score.funds, p.rules.game.startingFunds);
  }
  // 会社は全員ちがう
  const companies = new Set(teacher.state.players.map((p) => p.company));
  assert.equal(companies.size, 4);

  // ② 先生が開始
  teacher.send({ t: 'start' });
  await teacher.waitPhase('decision');
  for (const p of players) await p.waitPhase('decision');
  assert.equal(teacher.state.round, 1);
  assert.ok(teacher.state.event, '1ラウンド目のイベントが配られている');

  // ③〜⑦ 5ラウンド
  const totalRounds = teacher.rules.game.rounds;
  for (let round = 1; round <= totalRounds; round++) {
    for (const p of players) await p.waitPhase('decision', (s) => s.round === round);

    players.forEach((p, i) => p.send({ t: 'submit', decision: PLAYS[i % PLAYS.length] }));

    // 全員が提出したら自動で解決される
    await teacher.waitPhase('result', (s) => s.round === round);
    for (const p of players) await p.waitPhase('result', (s) => s.round === round);

    const entry = teacher.state.rounds.at(-1);
    assert.equal(entry.round, round);
    assert.equal(entry.results.length, 4, '全員ぶんの結果がある');

    // 全員が同じ結果を見ている（結果の食い違いがない）
    for (const p of players) {
      const mine = p.state.rounds.at(-1);
      assert.deepEqual(mine.results, entry.results, '全端末で同じ結果');
    }

    // 資金 = 前の資金 + 利益
    for (const r of entry.results) {
      const pub = teacher.state.players.find((x) => x.id === r.playerId);
      const before = round === 1
        ? teacher.rules.game.startingFunds
        : teacher.state.rounds
            .slice(0, round - 1)
            .reduce((a, rd) => a + rd.results.find((x) => x.playerId === r.playerId).profit,
              teacher.rules.game.startingFunds);
      assert.equal(pub.funds, before + r.profit);
    }

    teacher.send({ t: 'next' });
    if (round < totalRounds) {
      await teacher.waitPhase('decision', (s) => s.round === round + 1);
    } else {
      await teacher.waitPhase('final');
    }
  }

  // ⑦ 最終ランキング
  const s = teacher.state.standings;
  assert.ok(s, '順位が計算されている');
  assert.equal(s.profit.length, 4);
  assert.equal(s.total.length, 4);
  assert.equal(s.profit[0].rank, 1);
  for (let i = 1; i < s.profit.length; i++) {
    assert.ok(s.profit[i - 1].value >= s.profit[i].value, '利益ランキングは降順');
    assert.ok(s.total[i - 1].value >= s.total[i].value, '総合ランキングは降順');
  }
  // 生徒側にも同じ順位が届いている
  for (const p of players) {
    await p.waitPhase('final');
    assert.deepEqual(p.state.standings.total.map((r) => r.id), s.total.map((r) => r.id));
  }

  // 3段階の発表
  assert.equal(teacher.state.finalStage, 'profit');
  teacher.send({ t: 'next' });
  await teacher.waitFor((m) => m.t === 'state' && m.state.finalStage === 'total', { fresh: true });
  teacher.send({ t: 'next' });
  await teacher.waitFor((m) => m.t === 'state' && m.state.finalStage === 'reflect', { fresh: true });

  teacher.close();
  players.forEach((p) => p.close());
});

/* ================================================================ */

test('ブラウザを更新しても、同じ会社に戻れる（再接続）', async () => {
  const teacher = await makeRoom();
  const code = teacher.state.code;
  const players = await joinPlayers(code, ['あかり', 'けんた']);

  teacher.send({ t: 'start' });
  await teacher.waitPhase('decision');

  // 1人が選択の途中で切断する
  players[0].send({ t: 'draft', decision: { cacao: 'fairtrade', price: 'high' } });
  await sleep(150);
  const token = players[0].welcome.token;
  const playerId = players[0].welcome.playerId;
  players[0].close();

  await teacher.waitFor(
    (m) => m.t === 'state' && m.state.players.some((p) => p.id === playerId && !p.connected),
    { fresh: true }
  );

  // 更新して復帰
  const back = await new TestClient(server.wsUrl, 'あかり(復帰)').connect();
  back.send({ t: 'resume', code, token });
  await back.waitFor((m) => m.t === 'welcome');

  assert.equal(back.welcome.playerId, playerId, '同じプレイヤーとして戻る');
  assert.equal(back.state.you.draft.cacao, 'fairtrade', '選びかけの内容が残っている');
  assert.equal(back.state.you.draft.price, 'high');
  assert.equal(back.state.phase, 'decision');
  assert.equal(back.state.round, 1);

  teacher.close();
  back.close();
  players[1].close();
});

test('不正なトークンでは復帰できない', async () => {
  const teacher = await makeRoom();
  const c = await new TestClient(server.wsUrl, 'にせもの').connect();
  c.send({ t: 'resume', code: teacher.state.code, token: 'THIS-IS-NOT-A-TOKEN' });
  const err = await c.waitFor((m) => m.t === 'error');
  assert.equal(err.code, 'noSession');
  teacher.close();
  c.close();
});

/* ================================================================ */

test('決めていない人がいても、先生が締め切って進められる', async () => {
  const teacher = await makeRoom();
  const players = await joinPlayers(teacher.state.code, ['ひな', 'りく', 'めい']);
  teacher.send({ t: 'start' });
  await teacher.waitPhase('decision');

  players[0].send({ t: 'submit', decision: PLAYS[0] });
  await teacher.waitFor((m) => m.t === 'state' && m.state.submittedCount === 1, { fresh: true });

  teacher.send({ t: 'forceResolve' });
  await teacher.waitPhase('result');

  const entry = teacher.state.rounds.at(-1);
  assert.equal(entry.results.length, 3, '未提出の人も既定の選択で計算される');
  assert.equal(entry.results.filter((r) => r.auto).length, 2);
  assert.equal(entry.closedBy, 'teacher');

  teacher.close();
  players.forEach((p) => p.close());
});

test('締め切り前なら何度でも選び直せる', async () => {
  const teacher = await makeRoom();
  const [p] = await joinPlayers(teacher.state.code, ['さくら']);
  const [, p2] = [null, ...(await joinPlayers(teacher.state.code, ['たけし']))];
  teacher.send({ t: 'start' });
  await p.waitPhase('decision');

  p.send({ t: 'submit', decision: PLAYS[0] });
  await p.waitFor((m) => m.t === 'state' && m.state.you.submitted === true, { fresh: true });

  p.send({ t: 'draft', decision: { price: 'low' } });
  await p.waitFor((m) => m.t === 'state' && m.state.you.submitted === false, { fresh: true });
  assert.equal(p.state.you.draft.price, 'low', '選び直しが反映される');

  p.send({ t: 'submit' });
  await p.waitFor((m) => m.t === 'state' && m.state.you.submitted === true, { fresh: true });
  assert.equal(p.state.you.draft.price, 'low');

  teacher.close();
  p.close();
  p2.close();
});

/* ================================================================ */

test('定員を超えると参加できない', async () => {
  const teacher = await makeRoom({ maxPlayers: 4 });
  const code = teacher.state.code;
  await joinPlayers(code, ['1', '2', '3', '4']);

  const extra = await new TestClient(server.wsUrl, '5人目').connect();
  extra.send({ t: 'joinRoom', code, name: '5人目' });
  const err = await extra.waitFor((m) => m.t === 'error');
  assert.equal(err.code, 'cannotJoin');
  assert.match(err.message, /定員/);

  teacher.close();
  extra.close();
});

test('存在しないルーム番号ではエラーになる', async () => {
  const c = await new TestClient(server.wsUrl, 'まちがい').connect();
  c.send({ t: 'joinRoom', code: '000000', name: 'x' });
  const err = await c.waitFor((m) => m.t === 'error');
  assert.equal(err.code, 'noRoom');
  c.close();
});

test('開始後は途中参加できない', async () => {
  const teacher = await makeRoom();
  const code = teacher.state.code;
  await joinPlayers(code, ['a', 'b']);
  teacher.send({ t: 'start' });
  await teacher.waitPhase('decision');

  const late = await new TestClient(server.wsUrl, '遅刻').connect();
  late.send({ t: 'joinRoom', code, name: '遅刻' });
  const err = await late.waitFor((m) => m.t === 'error');
  assert.equal(err.code, 'cannotJoin');
  teacher.close();
  late.close();
});

/* ================================================================ */

test('生徒は先生の操作を実行できない（サーバ側で権限を確認する）', async () => {
  const teacher = await makeRoom();
  const [p] = await joinPlayers(teacher.state.code, ['いたずら']);

  p.send({ t: 'start' });
  const err = await p.waitFor((m) => m.t === 'error');
  assert.match(err.message, /できません|権限/);
  assert.equal(teacher.state.phase, 'lobby', 'ゲームは始まっていない');

  teacher.close();
  p.close();
});

test('ブラウザから不正な数値を送っても結果に影響しない', async () => {
  const teacher = await makeRoom();
  const [p] = await joinPlayers(teacher.state.code, ['ずる']);
  const [, p2] = [null, ...(await joinPlayers(teacher.state.code, ['ふつう']))];
  teacher.send({ t: 'start' });
  await p.waitPhase('decision');

  // 存在しない選択肢・巨大な数値・追加フィールドを送りつける
  p.send({
    t: 'submit',
    decision: { cacao: 'GOLD', sugar: 999, price: 'ultra', ad: 'none', give: 'none', profit: 999999, funds: 1e9 },
  });
  await sleep(200);
  p2.send({ t: 'submit', decision: PLAYS[0] });
  await teacher.waitPhase('result');

  const cheat = teacher.state.rounds.at(-1).results.find((r) => r.playerId === p.welcome.playerId);
  assert.equal(cheat.decision.cacao, 'market', '不正な選択は既定値に落ちる');
  assert.equal(cheat.decision.price, 'mid');
  const pub = teacher.state.players.find((x) => x.id === p.welcome.playerId);
  assert.ok(pub.funds < 1e9, '送りつけた資金は無視される');

  teacher.close();
  p.close();
  p2.close();
});

/* ================================================================ */

test('AIを足して1人でも動作確認ができる', async () => {
  const teacher = await makeRoom();
  for (let i = 0; i < 4; i++) teacher.send({ t: 'addBot' });
  await teacher.waitFor((m) => m.t === 'state' && m.state.playerCount === 4, { fresh: true });
  assert.ok(teacher.state.players.every((p) => p.isBot));

  teacher.send({ t: 'start' });
  // AIは自分で提出するので、そのまま結果まで進む
  await teacher.waitPhase('result', (s) => s.round === 1, { timeout: 15000 });
  const entry = teacher.state.rounds.at(-1);
  assert.equal(entry.results.length, 4);
  assert.ok(entry.results.every((r) => !r.auto), 'AIは時間切れではなく自分で提出している');
  // 戦略が違えば選ぶものも違う
  const uniqueChoices = new Set(entry.results.map((r) => JSON.stringify(r.decision)));
  assert.ok(uniqueChoices.size >= 2, 'AIの戦略ごとに選択が分かれる');

  teacher.close();
});

test('同じメンバーでもう一度あそべる', async () => {
  const teacher = await makeRoom();
  const players = await joinPlayers(teacher.state.code, ['a', 'b']);
  teacher.send({ t: 'start' });
  await teacher.waitPhase('decision');
  players.forEach((p) => p.send({ t: 'submit', decision: PLAYS[0] }));
  await teacher.waitPhase('result');

  teacher.send({ t: 'restart' });
  await teacher.waitPhase('lobby', () => true, { fresh: true });
  assert.equal(teacher.state.round, 0);
  assert.equal(teacher.state.rounds.length, 0);
  assert.equal(teacher.state.playerCount, 2, 'メンバーはそのまま');
  assert.ok(teacher.state.players.every((p) => p.funds === teacher.rules.game.startingFunds));

  teacher.close();
  players.forEach((p) => p.close());
});
