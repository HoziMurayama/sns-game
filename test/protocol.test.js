/**
 * 自前WebSocket実装とルール読み込みの検証。
 * （ライブラリを使わない選択をした以上、プロトコル部分こそテストしておく）
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer, TestClient, sleep } from './helpers.js';
import { encodeFrame, computeAccept, OP } from '../server/ws.js';
import { loadRuleset, validateRules, listRulesets } from '../server/rules.js';

const PORT = 31742;
let server;

test.before(async () => {
  server = await startServer(PORT);
});
test.after(async () => {
  await server?.stop();
});

/* ------------------------------------------------ ハンドシェイク */

test('Sec-WebSocket-Accept が RFC 6455 の例と一致する', () => {
  // 仕様書 §1.3 の例。ここがずれると全ブラウザで接続できなくなるので、必ず固定値で検証する。
  assert.equal(computeAccept('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
});

test('WebSocket以外のリクエストは400で断る', async () => {
  const res = await fetch(`${server.url}/ws`);
  assert.ok(res.status >= 400, `status=${res.status}`);
});

/* ------------------------------------------------ フレーム生成 */

test('フレームの長さ表現が payload サイズで切り替わる', () => {
  assert.equal(encodeFrame(OP.TEXT, Buffer.alloc(10)).length, 2 + 10);
  assert.equal(encodeFrame(OP.TEXT, Buffer.alloc(125)).length, 2 + 125);
  assert.equal(encodeFrame(OP.TEXT, Buffer.alloc(126)).length, 4 + 126, '126〜は16bit長');
  assert.equal(encodeFrame(OP.TEXT, Buffer.alloc(70000)).length, 10 + 70000, '65536〜は64bit長');
  const f = encodeFrame(OP.TEXT, Buffer.from('x'));
  assert.equal(f[0], 0x81, 'FIN=1 / opcode=text');
});

/* ------------------------------------------------ 実通信 */

test('ping に pong が返る', async () => {
  const c = await new TestClient(server.wsUrl, 'ping').connect();
  c.send({ t: 'ping' });
  const pong = await c.waitFor((m) => m.t === 'pong');
  assert.ok(pong.at > 0);
  c.close();
});

test('壊れたJSONを送ってもサーバは落ちず、エラーを返す', async () => {
  const c = await new TestClient(server.wsUrl, 'badjson').connect();
  c.ws.send('{ this is not json');
  const err = await c.waitFor((m) => m.t === 'error');
  assert.equal(err.code, 'badJson');

  // 接続は生きたまま、続けて操作できる
  c.send({ t: 'ping' });
  await c.waitFor((m) => m.t === 'pong');
  const health = await (await fetch(`${server.url}/api/health`)).json();
  assert.equal(health.ok, true);
  c.close();
});

test('16bit長のメッセージ（126バイト以上）を正しく受信できる', async () => {
  const c = await new TestClient(server.wsUrl, 'big').connect();
  c.send({ t: 'joinRoom', code: '000000', name: 'あ'.repeat(2000) });
  const err = await c.waitFor((m) => m.t === 'error');
  assert.equal(err.code, 'noRoom', '大きいメッセージも解析できている');
  c.close();
});

test('上限を超えるメッセージは接続を閉じる（メモリを守る）', async () => {
  const c = await new TestClient(server.wsUrl, 'huge').connect();
  const closed = new Promise((r) => c.ws.addEventListener('close', r, { once: true }));
  c.ws.send('x'.repeat(200 * 1024)); // maxPayload = 64KB
  await closed;
  assert.equal(c.ws.readyState, WebSocket.CLOSED);
  // サーバは生きている
  const health = await (await fetch(`${server.url}/api/health`)).json();
  assert.equal(health.ok, true);
});

test('入室していない接続は操作を拒否される', async () => {
  const c = await new TestClient(server.wsUrl, 'noroom').connect();
  c.send({ t: 'submit', decision: {} });
  const err = await c.waitFor((m) => m.t === 'error');
  assert.equal(err.code, 'notInRoom');
  c.close();
});

test('未知の操作は無視されエラーになる', async () => {
  const c = await new TestClient(server.wsUrl, 'unknown').connect();
  c.send({ t: 'createRoom' });
  await c.waitFor((m) => m.t === 'welcome');
  c.send({ t: 'DROP_TABLE' });
  const err = await c.waitFor((m) => m.t === 'error');
  assert.equal(err.code, 'badRequest');
  c.close();
});

test('連打しすぎると一時的に遮断される', async () => {
  const c = await new TestClient(server.wsUrl, 'flood').connect();
  const closed = new Promise((r) => c.ws.addEventListener('close', r, { once: true }));
  for (let i = 0; i < 120; i++) c.send({ t: 'ping' });
  await closed;
  const err = c.messages.find((m) => m.code === 'rateLimited');
  assert.ok(err, 'レート制限のエラーが返る');
});

test('同じ端末で開き直すと、古い接続が置き換わる', async () => {
  const t1 = await new TestClient(server.wsUrl, 't1').connect();
  t1.send({ t: 'createRoom' });
  await t1.waitFor((m) => m.t === 'welcome');
  const { token } = t1.welcome;
  const code = t1.state.code;

  const t2 = await new TestClient(server.wsUrl, 't2').connect();
  t2.send({ t: 'resume', code, token });
  await t2.waitFor((m) => m.t === 'welcome');

  const replaced = await t1.waitFor((m) => m.t === 'replaced');
  assert.match(replaced.message, /先生用コンソール/);
  t1.close();
  t2.close();
});

/* ------------------------------------------------ HTTP */

test('参加用の短縮URLが参加画面へ転送する', async () => {
  const res = await fetch(`${server.url}/j/123456`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/play?code=123456');
});

test('親ディレクトリへの参照を拒否する', async () => {
  for (const p of ['/../package.json', '/..%2fpackage.json', '/css/../../package.json']) {
    const res = await fetch(`${server.url}${p}`);
    assert.ok(res.status === 404 || res.status === 400, `${p} → ${res.status}`);
  }
});

test('ルームの存在確認APIが動く', async () => {
  const c = await new TestClient(server.wsUrl, 'api').connect();
  c.send({ t: 'createRoom' });
  await c.waitFor((m) => m.t === 'welcome');
  const code = c.state.code;

  const ok = await (await fetch(`${server.url}/api/room/exists?code=${code}`)).json();
  assert.equal(ok.exists, true);
  assert.equal(ok.joinable, true);

  const ng = await (await fetch(`${server.url}/api/room/exists?code=999999`)).json();
  assert.equal(ng.exists, false);
  c.close();
});

/* ------------------------------------------------ ルールの検証 */

test('同梱のルールセットはすべて妥当', () => {
  const list = listRulesets();
  assert.ok(list.length >= 3);
  for (const r of list) assert.doesNotThrow(() => loadRuleset(r.file), `${r.file} が読めない`);
});

test('extends で親ルールを継承し、指定した値だけ上書きされる', () => {
  const mvp = loadRuleset('mvp');
  const el = loadRuleset('elementary');
  assert.equal(el.game.rounds, 3);
  assert.equal(el.game.startingFunds, mvp.game.startingFunds, '指定していない値は親のまま');
  // decisions は key で照合してマージされる（配列まるごと消えない）
  assert.equal(el.decisions.length, mvp.decisions.length);
  const cacao = el.decisions.find((d) => d.key === 'cacao');
  assert.equal(cacao.options.length, 3, '選択肢は親から引き継がれる');
  assert.notEqual(cacao.label, mvp.decisions.find((d) => d.key === 'cacao').label, 'ラベルは上書きされる');
});

test('壊れたルールは理由つきで弾かれる', () => {
  const base = loadRuleset('mvp');

  assert.throws(
    () => validateRules({ ...base, scoring: { ...base.scoring, weights: { profit: 0.5, producer: 0.2, society: 0.1 } } }),
    /weights の合計/
  );
  assert.throws(() => validateRules({ ...base, game: { ...base.game, rounds: 0 } }), /rounds/);
  assert.throws(
    () => validateRules({ ...base, demand: { ...base.demand, randomness: 1.5 } }),
    /randomness/
  );
  assert.throws(
    () => validateRules({ ...base, decisions: base.decisions.filter((d) => d.kind !== 'price') }),
    /price/
  );
});

test('存在しないルールセットを指定するとエラーになる', () => {
  assert.throws(() => loadRuleset('nope'), /見つかりません/);
});
