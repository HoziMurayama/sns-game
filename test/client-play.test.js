/**
 * 生徒用画面（public/js/play.html.js）を、本物のサーバ相手に最初から最後まで動かすテスト。
 *
 * ブラウザは使いませんが、
 *   ・実際の play.html を読み込み
 *   ・実際の play.js をそのまま実行し
 *   ・本物のWebSocketで本物のサーバに接続し
 *   ・フォーム送信やボタンのクリックを実際に発火させる
 * ので、「生徒が触ったときに動くか」をかなり近いところまで確認できます。
 *
 * play.js は読み込んだ時点で動き出す（1画面ぶんしか動かせない）ため、
 * このファイルでは生徒1人ぶんを動かし、他の参加者と先生は素のWebSocketで操作します。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { startServer, TestClient } from './helpers.js';
import { installDom, until } from './dom-stub.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 31745;

const server = await startServer(PORT);
const { document } = installDom({
  html: path.join(ROOT, 'public', 'play.html'),
  url: `http://127.0.0.1:${PORT}`,
});

// 先生役（素のWebSocket）でルームを用意してから、生徒画面を起動する
const teacher = await new TestClient(server.wsUrl, 'teacher').connect();
teacher.send({ t: 'createRoom', ruleset: 'mvp' });
await teacher.waitFor((m) => m.t === 'welcome');
const CODE = teacher.state.code;

// もう1人（素のWebSocket）。1人だけだと全員提出で即解決してしまうため。
const other = await new TestClient(server.wsUrl, 'other').connect();

// ここで実際の画面スクリプトを読み込む（読み込んだ瞬間に接続が始まる）
const play = await import('../public/js/play.html.js');

const $ = (sel) => document.querySelector(sel);
const activeScreen = () => document.querySelectorAll('.screen').find((s) => s.classList.contains('active'));
const screenName = () => activeScreen()?.dataset.screen;

test.after(async () => {
  play.net.disconnect(); // 画面スクリプトの再接続ループとpingを止める
  teacher.close();
  other.close();
  await server.stop();
});

/* ================================================================ */

test('起動直後は参加画面が表示される', async () => {
  await until(() => screenName() === 'join', { label: '参加画面' });
  assert.equal($('#codeInput').tagName, 'INPUT');
  assert.equal($('#resumeBox').hidden, true, '前回の続きが無いので復帰ボタンは出ない');
  assert.equal(document.body.classList.contains('screen-join'), true, '背景の切り替え用クラスが付く');
});

test('参加画面の見た目がそろっている', () => {
  assert.equal($('.join-title').textContent, 'ゲームに参加しよう！');
  assert.ok($('.join-lead').allText.includes('6けたの番号'), '入力するものが書いてある');

  // 入力欄はラベルと結びついている（読み上げ・タップ操作のため）
  for (const [labelText, id] of [['ルーム番号', 'codeInput'], ['あなたの名前', 'nameInput']]) {
    const label = document.querySelectorAll('.join-card LABEL').find((l) => l.allText.includes(labelText));
    assert.ok(label, `${labelText} のラベルがある`);
    assert.equal(label.getAttribute('for'), id, `${labelText} が入力欄に結びついている`);
  }

  const btn = $('.btn-join');
  assert.ok(btn.allText.includes('参加する'));
  assert.equal(btn.getAttribute('type'), 'submit', 'Enterキーでも送信できる');
});

test('「ゲームの流れ」が参加画面に6段階そろっている', () => {
  // 参加画面と待機画面の両方に置いてあるので、参加画面のほうだけを見る
  const steps = document.querySelectorAll('[data-screen="join"] .flow-rail .flow-list LI');
  assert.equal(steps.length, 6);
  const joined = steps.map((li) => li.allText).join(' ');
  for (const name of ['カカオ農家', '協同組合', '輸出', 'チョコレート会社', 'お店', '消費者']) {
    assert.ok(joined.includes(name), `${name} がある`);
  }
  assert.equal($('.flow-ribbon').textContent, 'ゲームの流れ');
  assert.ok($('.flow-note').allText.includes('みんなの未来をつくります'));

  // 6段それぞれに色分けされた丸アイコンが付いている
  const icons = document.querySelectorAll('[data-screen="join"] .flow-rail .flow-ic');
  assert.equal(icons.length, 6);
  assert.equal(new Set(icons.map((i) => i.className)).size, 6, '色は6種類とも別');
});

test('アイコンは絵文字ではなくSVG（端末で見た目が変わらないように）', async () => {
  const { SPRITE } = await import('../public/js/icons.js');

  // 使っている記号がすべて定義されている
  const used = new Set(
    document.querySelectorAll('USE').map((u) => u.getAttribute('href')).filter(Boolean)
  );
  assert.ok(used.size >= 8, `画面で使うアイコンがある（${used.size}種類）`);
  for (const href of used) {
    assert.ok(SPRITE.includes(`id="${href.slice(1)}"`), `${href} の定義がある`);
  }

  // HTMLに絵文字が残っていないこと
  // （favicon はタブに出すアイコンで、SVGの記号を参照できないため対象外）
  // favicon の href は data URI の中に > を含むため、行ごと除外する
  const html = fs
    .readFileSync(path.join(ROOT, 'public', 'play.html'), 'utf8')
    .split('\n')
    .filter((line) => !line.includes('rel="icon"'))
    .join('\n');
  const emoji = html.match(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu) || [];
  assert.deepEqual(emoji, [], `絵文字が残っています: ${emoji.join(' ')}`);

  // 色付きの丸の上に置くので、SVG側で色を固定していないこと
  assert.ok(!/fill="#(?!fff)[0-9a-f]{3,6}"/i.test(SPRITE.replace(/stroke="#fff"/g, '')),
    'アイコンの色は置いた場所の文字色に従う（currentColor）');
});

test('参加画面の背景は、絵の人物とカードが重ならないよう寄せてある', () => {
  const css = fs.readFileSync(path.join(ROOT, 'public', 'css', 'app.css'), 'utf8');

  // 背景の位置は変数で調整できるようにしてある（絵を差し替えたときのため）
  assert.match(css, /--join-art-pos, 64% center/, '背景の寄せ具合が変数になっている');
  // カードの下から人物がのぞく部分をやわらげる影
  assert.match(css, /body\.screen-join\.has-bg-art::after/, 'カード下を落ち着かせる影がある');
  // 役割の札が読めるよう、カードの高さに上限がある
  assert.match(css, /min-height:\s*min\(700px, calc\(100vh - 205px\)\)/, 'カードは伸びすぎない');
});

test('入力が足りないときは、フォームの中に理由が出る', () => {
  const err = $('#joinError');
  assert.equal(err.hidden, true, 'はじめは出ていない');

  // 番号が空のまま送信
  $('#codeInput').value = '';
  $('#nameInput').value = 'あおい';
  $('#joinForm').dispatch('submit');
  assert.equal(err.hidden, false, 'エラーが出る');
  assert.ok(err.textContent.includes('ルーム番号'), '何を入れればよいか書いてある');
  assert.equal(err.getAttribute('role'), 'alert', '読み上げソフトにも伝わる');

  // 名前が空のまま送信
  $('#codeInput').value = '123456';
  $('#nameInput').value = '';
  $('#joinForm').dispatch('submit');
  assert.ok(err.textContent.includes('名前'));

  // 入力し直すと消える
  $('#nameInput').dispatch('input');
  assert.equal(err.hidden, true, '打ち直したらエラーは消える');
});

test('見つからないルーム番号は、フォームの中にエラーが残る', async () => {
  $('#codeInput').value = '999999';
  $('#nameInput').value = 'テスト';
  $('#joinForm').dispatch('submit');

  await until(() => $('#joinError').hidden === false && $('#joinError').textContent.includes('見つかり'), {
    label: 'サーバからのエラー表示',
  });
  assert.equal($('#joinBtn').disabled, false, 'もう一度押せる状態に戻る');
});

test('ルーム番号は数字6けたに矯正される', () => {
  const input = $('#codeInput');
  input.value = 'あ12ab34-56789';
  input.dispatch('input', { target: input });
  assert.equal(input.value, '123456', '数字以外を除き、6けたに切りつめる');
});

test('全角で入力しても受け付ける（日本語入力のままでも困らない）', () => {
  const input = $('#codeInput');
  input.value = '４８２９１３';
  input.dispatch('input', { target: input });
  assert.equal(input.value, '482913', '全角の数字は半角に直す');

  // 貼り付け（スペースやラベルが混ざっていても拾う）
  input.value = 'ルーム番号 48-29 13';
  input.dispatch('input', { target: input });
  assert.equal(input.value, '482913');
});

test('6けた入ると、名前の欄へ自動で進む', () => {
  const input = $('#codeInput');
  input.focus(); // 直前のテストの続きにならないよう、番号欄から始める

  input.value = '48291';
  input.dispatch('input', { target: input });
  assert.notEqual(document.activeElement, $('#nameInput'), '5けたではまだ進まない');

  input.value = '482913';
  input.dispatch('input', { target: input });
  assert.equal(document.activeElement, $('#nameInput'), '6けたで名前欄へ');
});

test('番号と名前を入れて参加すると、待機画面に切り替わる', async () => {
  $('#codeInput').value = CODE;
  $('#nameInput').value = 'あおい';
  $('#joinForm').dispatch('submit');

  await until(() => screenName() === 'lobby', { label: '待機画面' });

  // 会社が割り当てられ、ヘッダに表示されている
  await until(() => !$('#chipCompany').hidden, { label: '会社名の表示' });
  assert.match($('#chipRoom').textContent, new RegExp(CODE));
  assert.ok($('#myCard').allText.includes('あおい'));
  assert.ok($('#lobbyPlayers').allText.includes('あおい'));
  assert.ok($('#howto').children.length > 0, 'ゲームの進め方が出ている');

  // 資金は円で表示される（10,000,000円 ＝ 1,000万円）
  assert.ok($('#myCard').allText.includes('1,000万円'), `資金の表示: ${$('#myCard').allText}`);
});

test('金額はすべて円で表示される（ptは残っていない）', () => {
  const texts = [$('#myCard').allText, $('#roomSettings').allText].join(' ');
  assert.ok(texts.includes('円'), '円で表示されている');
  assert.ok(!/\dpt/.test(texts), 'pt の表記が残っていない');
});

test('待機画面に、ルーム番号とそのすぐ下の参加人数が出る', () => {
  assert.equal($('#lobbyCode').textContent, CODE, 'ルーム番号');
  assert.equal($('#lobbyCount').textContent, '1 / 6', 'ルーム番号の下に「いま何人 / 定員」');

  // 見出し（ルーム番号）→ 人数 の順に並んでいること
  const head = $('.lobby-head');
  assert.equal(head.children[0].className, 'lobby-room');
  assert.equal(head.children[1].className, 'lobby-count');
});

test('待機画面に、ルーム設定と参加者一覧が出る', () => {
  const settings = $('#roomSettings').allText;
  assert.ok(settings.includes('ラウンド数'));
  assert.ok(settings.includes('5ラウンド'));
  assert.ok(settings.includes('制限時間'));
  assert.ok(settings.includes('はじめの資金'));

  // 参加者一覧は「定員ぶんの枠」で、空きは参加待ち表示
  const roster = $('#rosterList').children;
  assert.equal(roster.length, 6, '定員ぶんの枠が並ぶ');
  assert.ok(roster[0].allText.includes('あおい'));
  assert.ok(roster[0].allText.includes('（あなた）'));
  assert.equal(roster.filter((li) => li.classList.contains('empty')).length, 5, '空きは参加待ち');
  assert.ok(roster[5].allText.includes('参加待ち'));
});

test('待機画面では、開始ボタンではなく待機中の表示になる（開始は先生の操作）', () => {
  const wait = $('#lobbyWait');
  assert.ok(wait, '待機中の表示がある');
  assert.equal(wait.getAttribute('role'), 'status', '読み上げソフトにも状況が伝わる');
  assert.ok(wait.allText.includes('待っています'));
  assert.equal(wait.tagName, 'DIV', '押せてしまうボタンにはしない');
});

test('あとから入った人も待機画面に反映される', async () => {
  other.send({ t: 'joinRoom', code: CODE, name: 'はると' });
  await other.waitFor((m) => m.t === 'welcome');
  await until(() => $('#lobbyPlayers').allText.includes('はると'), { label: '2人目の表示' });
  assert.equal($('#lobbyCount').textContent, '2 / 6', '人数の表示が増える');
  assert.equal($('#rosterList').children.filter((li) => li.classList.contains('empty')).length, 4);
});

test('先生が開始すると決定画面になり、選択肢が並ぶ', async () => {
  teacher.send({ t: 'start' });
  await until(() => screenName() === 'decision', { label: '決定画面' });

  // ルールの決定項目ぶんのブロックが生成されている
  const groups = $('#decGroups').querySelectorAll('.decision');
  assert.equal(groups.length, 5, 'カカオ・砂糖・価格・広告・還元の5項目');

  const options = $('#decGroups').querySelectorAll('.opt');
  assert.equal(options.length, 15, '各項目3択で計15個');

  // 原料の選択肢には区分（一般市場／直接取引／認証）が色分け用に付いている
  const tiers = new Set(options.map((o) => o.dataset.tier).filter(Boolean));
  assert.deepEqual([...tiers].sort(), ['direct', 'fairtrade', 'market']);

  // イベントが表示されている
  assert.ok($('#decEvent').allText.includes('市場ニュース'));
});

test('選択肢を押すと、その項目だけが選ばれた状態になる', async () => {
  const opts = $('#decGroups').querySelectorAll('.opt');
  const ftCacao = opts.find((o) => o.dataset.tier === 'fairtrade');

  ftCacao.click();
  await until(() => ftCacao.getAttribute('aria-pressed') === 'true', { label: '選択の反映' });

  // 同じグループ内の他の選択肢は外れている
  const group = ftCacao.parent;
  const pressed = group.children.filter((o) => o.getAttribute('aria-pressed') === 'true');
  assert.equal(pressed.length, 1, '1グループにつき選べるのは1つ');
});

test('利幅の見積もりが選択に追従して変わる', async () => {
  const before = $('#decMargin').allText;
  const priceOpts = $('#decGroups').querySelectorAll('.decision')[2].querySelectorAll('.opt');
  priceOpts.at(-1).click(); // 「高い」を選ぶ
  await until(() => $('#decMargin').allText !== before, { label: '見積もりの更新' });
  assert.ok($('#decMargin').allText.includes('1ロットの利益'));
});

test('決定を押すと「決定しました」に変わり、選び直しもできる', async () => {
  const submitBtn = $('#decSubmit').querySelectorAll('BUTTON').at(-1);
  submitBtn.click();

  await until(() => $('#decSubmit').allText.includes('決定しました'), { label: '提出の反映' });
  assert.match($('#decSubmit').allText, /1\/2/, '提出人数が出る');

  // 「選び直す」で取り消せる
  $('#decSubmit').querySelectorAll('BUTTON')[0].click();
  await until(() => !$('#decSubmit').allText.includes('決定しました'), { label: '取り消しの反映' });

  submitBtn.click();
  await until(() => $('#decSubmit').allText.includes('決定しました'), { label: '再提出' });
});

test('全員が提出するとラウンド結果画面になり、自分の内訳が出る', async () => {
  other.send({ t: 'submit', decision: { cacao: 'market', sugar: 'market', price: 'high', ad: 'none', give: 'none' } });

  await until(() => screenName() === 'result', { label: '結果画面' });

  const mine = $('#resMine').allText;
  assert.ok(mine.includes('販売数'));
  assert.ok(mine.includes('今年の利益'));
  assert.ok(mine.includes('会社の資金'));

  // クラス全体の表に2人ぶん出ている
  const rows = $('#resAll').querySelectorAll('TR');
  assert.equal(rows.length, 3, 'ヘッダ1行 + 2人');
  assert.ok($('#resAll').allText.includes('あおい') === false, '表に出るのは会社名');
});

test('残りのラウンドも最後まで進み、最終結果が表示される', async () => {
  const rounds = 5;
  for (let round = 2; round <= rounds; round++) {
    teacher.send({ t: 'next' });
    await until(() => screenName() === 'decision', { label: `${round}年目の決定画面` });

    // 生徒は画面のボタンから提出する
    const submitBtn = $('#decSubmit').querySelectorAll('BUTTON').at(-1);
    submitBtn.click();
    other.send({ t: 'submit', decision: { cacao: 'fairtrade', sugar: 'market', price: 'mid', ad: 'small', give: 'mid' } });

    await until(() => screenName() === 'result', { label: `${round}年目の結果` });
  }

  teacher.send({ t: 'next' });
  await until(() => screenName() === 'final', { label: '最終結果' });

  // ① 利益ランキング
  await until(() => $('#finalBody').allText.includes('利益ランキング'), { label: '利益ランキング' });
  const rankRows = $('#finalBody').querySelectorAll('.rank-row');
  assert.equal(rankRows.length, 2);

  // ② 総合ランキング
  teacher.send({ t: 'next' });
  await until(() => $('#finalBody').allText.includes('総合ランキング'), { label: '総合ランキング' });
  assert.ok($('#finalBody').allText.includes('生産者への貢献'));

  // ③ ふりかえり
  teacher.send({ t: 'next' });
  await until(() => $('#finalBody').allText.includes('ふりかえり'), { label: 'ふりかえり' });
  assert.ok($('#finalBody').allText.includes('あなたの会社の5年間'));
});

test('通信が切れても、自動で再接続して同じ会社に戻る', async () => {
  const conn = $('#conn');
  // 直前のラウンド処理の直後は、まだ再接続中のことがある。
  // 「いま online か」を決めつけず、online になるのを待ってから始める。
  await until(() => conn.textContent === 'オンライン', { label: '接続の安定' });
  assert.equal(conn.classList.contains('off'), false);

  const companyBefore = $('#chipCompany').textContent;
  const screenBefore = screenName();

  // Wi-Fiが切れた状況を再現する（サーバは生きたまま、接続だけが落ちる）
  play.net.ws.close();

  await until(() => conn.classList.contains('off'), { label: '切断の表示' });
  assert.match(conn.textContent, /再接続/, '生徒に状況が伝わる表示になっている');

  // net.js のバックオフで自動的に張り直され、resume で復帰する
  await until(() => conn.textContent === 'オンライン', { label: '自動再接続', timeout: 15000 });

  assert.equal($('#chipCompany').textContent, companyBefore, '同じ会社に戻っている');
  assert.equal(screenName(), screenBefore, '画面も元の場所に戻っている');
  assert.ok($('#finalBody').allText.includes('ふりかえり'), '結果も復元されている');
});

test('先生がルームを終了すると、生徒側にも伝わる', async () => {
  teacher.send({ t: 'closeRoom' });
  await until(() => location.reloaded > 0, { label: '終了後の画面リセット', timeout: 15000 });
  assert.equal(sessionStorage.getItem('ftc.session.player'), null, '保存された参加情報は消える');
});
