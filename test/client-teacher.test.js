/**
 * 先生用コンソール（public/js/teacher.js）を、本物のサーバ相手に動かすテスト。
 *
 * 授業中に先生が実際に押すボタンを、そのままの順番でクリックしていきます。
 *   ルームを作成 → AIを追加 → 開始 → 次へ → …… → 結果発表 → CSV出力
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { startServer, TestClient } from './helpers.js';
import { installDom, until } from './dom-stub.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 31746;

const server = await startServer(PORT);
const { document } = installDom({
  html: path.join(ROOT, 'public', 'teacher.html'),
  url: `http://127.0.0.1:${PORT}`,
});

// CSV出力の確認用に、生成された Blob を横取りする（Blob 自体は本物を使う）
let lastBlob = null;
URL.createObjectURL = (blob) => {
  lastBlob = blob;
  return 'blob:test';
};
URL.revokeObjectURL = () => {};

const teacherPage = await import('../public/js/teacher.js');

const live = () => globalThis.document;
const $ = (sel) => live().querySelector(sel);
const activeScreen = () => document.querySelectorAll('.screen').find((s) => s.classList.contains('active'));
const screenName = () => activeScreen()?.dataset.screen;

const students = [];

test.after(async () => {
  teacherPage.net.disconnect();
  for (const s of students) s.close();
  await server.stop();
});

/* ================================================================ */

test('起動直後はルーム作成画面で、ルールセットが読み込まれている', async () => {
  await until(() => screenName() === 'setup', { label: 'ルーム作成画面' });
  await until(() => $('#rulesetSel').children.length > 0, { label: 'ルールセットの一覧' });

  const options = $('#rulesetSel').children;
  const labels = options.map((o) => o.allText);
  assert.ok(labels.some((l) => l.includes('中学・高校版')), '既定ルールが選べる');
  assert.ok(labels.some((l) => l.includes('小学校版')), '小学校版も選べる');
  assert.ok($('#rulesetNote').textContent.length > 0, '説明文が出る');
});

test('ルーム作成画面の3つのまとまりがそろっている', () => {
  // 左: ゲームの流れ
  const steps = document.querySelectorAll('[data-screen="setup"] .flow-rail .flow-list LI');
  assert.equal(steps.length, 6);
  assert.ok(steps.map((s) => s.allText).join(' ').includes('チョコレート会社'));

  // 中央: 作成フォーム
  assert.equal($('.setup-title').textContent, 'ゲームルームを作る');
  assert.ok($('.setup-sub').allText.includes('あとから変えられます'));
  for (const id of ['rulesetSel', 'maxPlayers', 'timerSec', 'demandMode']) {
    const label = document.querySelectorAll('.setup-card LABEL').find((l) => l.getAttribute('for') === id);
    assert.ok(label, `${id} にラベルがある`);
  }
  assert.ok($('.btn-create').allText.includes('ルームを作成する'));

  // 右: 設定のポイント
  const tips = document.querySelectorAll('.tips .tip');
  assert.equal(tips.length, 3, '定員・制限時間・市場モデルの3つ');
  const text = $('.tips').allText;
  assert.ok(text.includes('3〜6人がおすすめ'));
  assert.ok(text.includes('授業時間に合わせて'));
  assert.ok(text.includes('初めての授業に最適'));
});

test('ルーム作成画面の背景画像が使われる', async () => {
  const used = await teacherPage.artReady;
  assert.ok(used, 'public/img に room-make-bg が置かれている');
  assert.match(used, /^\/img\/room-make-bg\./);
  assert.equal(live().body.classList.contains('has-setup-art'), true);

  const css = fs.readFileSync(path.join(ROOT, 'public', 'css', 'app.css'), 'utf8');
  assert.match(css, /body\.screen-setup\.has-setup-art::before/, '背景を敷く指定がある');

  // いまの絵には文字が入っていないので、ぼかしは 0。
  // 文字入りの絵に差し替えたときに戻せるよう、変数だけは残してある。
  assert.match(css, /filter:\s*blur\(var\(--setup-art-blur, 0px\)\)/, 'ぼかしは0（変数で調整できる）');
  assert.match(css, /--setup-art-pos, center/, '背景の寄せ具合も変数になっている');
});

test('「ルームを作成する」で6けたの番号とQRコードが出る', async () => {
  $('#createBtn').click();
  await until(() => screenName() === 'lobby', { label: '待機画面' });

  const code = $('#roomCode').textContent;
  assert.match(code, /^\d{6}$/, `ルーム番号は6けた（実際: ${code}）`);
  assert.ok($('#joinUrl').textContent.endsWith(`/j/${code}`), '参加用URLが出る');

  // QRコードがSVGとして描かれている
  assert.match($('#qrBox').innerHTML, /^<svg /, 'QRコードが描画される');
  assert.ok($('#qrBox').innerHTML.includes('<path d="M'), 'QRの模様が入っている');

  assert.equal($('#startBtn').disabled, true, '参加者がいないので開始できない');
  assert.match($('#startHint').textContent, /あと\d+人/);
});

test('AIを追加すると参加者一覧に出て、開始できるようになる', async () => {
  for (let i = 0; i < 3; i++) $('#addBotBtn').click();
  await until(() => $('#lobbyPlayers').querySelectorAll('.player').length === 3, { label: 'AIの参加' });

  assert.match($('#lobbyCount').textContent, /3 \/ 6人/);
  assert.equal($('#startBtn').disabled, false);
  assert.ok($('#lobbyPlayers').allText.includes('🤖'), 'AIだと分かる表示');
  assert.ok($('#chipPlayers').textContent.includes('3人'));
});

test('本物の生徒も同じルームに参加できる', async () => {
  const code = $('#roomCode').textContent;
  const s = await new TestClient(server.wsUrl, 'ゆい').connect();
  s.send({ t: 'joinRoom', code, name: 'ゆい' });
  await s.waitFor((m) => m.t === 'welcome');
  students.push(s);

  await until(() => $('#lobbyPlayers').allText.includes('ゆい'), { label: '生徒の表示' });
  assert.equal($('#lobbyPlayers').querySelectorAll('.player').length, 4);
});

test('開始すると進行画面になり、イベントと提出状況が出る', async () => {
  $('#startBtn').click();
  await until(() => screenName() === 'running', { label: '進行画面' });

  assert.ok($('#runHead').allText.includes('1年目'));
  assert.ok($('#runEvent').allText.includes('市場ニュース'));
  assert.ok($('#runBody').allText.includes('決定の状況'));
  assert.equal($('#forceBtn').hidden, false, '締め切りボタンが押せる');
  assert.equal($('#nextBtn').hidden, true, '結果が出るまで「次へ」は隠れている');
});

test('未提出の生徒がいても「締め切って結果を出す」で進める', async () => {
  // AIは自分で提出するが、生徒（ゆい）は提出しないまま締め切る
  await until(() => $('#runBody').allText.includes('3 / 4'), { label: 'AI3人の提出', timeout: 15000 });

  $('#forceBtn').click();
  await until(() => $('#runBody').allText.includes('1年目の結果'), { label: '結果表示' });

  const rows = $('#runBody').querySelectorAll('TR');
  assert.ok(rows.length >= 5, 'ヘッダ + 4人ぶんの結果');
  assert.ok($('#runBody').allText.includes('話し合いのヒント'), '先生向けの問いかけが出る');
  assert.equal($('#nextBtn').hidden, false);
  assert.equal($('#forceBtn').hidden, true);
});

test('「次へ」を押していくと5年目まで進み、最終結果になる', async () => {
  for (let round = 2; round <= 5; round++) {
    $('#nextBtn').click();
    await until(() => $('#runHead').allText.includes(`${round}年目`), { label: `${round}年目` });
    await until(() => $('#forceBtn').hidden === false, { label: `${round}年目の決定画面` });

    $('#forceBtn').click();
    await until(() => $('#runBody').allText.includes(`${round}年目の結果`), { label: `${round}年目の結果` });
  }

  assert.match($('#nextBtn').textContent, /最終結果/, '最後は「最終結果を発表する」になる');
  $('#nextBtn').click();
  await until(() => screenName() === 'final', { label: '最終結果画面' });
});

test('結果発表は 利益 → 総合 → ふりかえり の3段階', async () => {
  // ① 利益
  assert.ok($('#finalBody').allText.includes('① 利益ランキング'));
  assert.ok($('#finalBody').allText.includes('では、社会全体ではどうだったでしょう？'), '次への問いかけが出る');
  assert.equal($('#backBtn').disabled, true, '最初の段階では戻れない');

  const rows = $('#finalBody').querySelectorAll('.rank-row');
  assert.equal(rows.length, 4);
  assert.ok(rows[0].classList.contains('r1'), '1位が強調される');

  // ② 総合
  $('#nextBtn2').click();
  await until(() => $('#finalBody').allText.includes('総合ランキング'), { label: '総合ランキング' });
  assert.ok($('#finalBody').allText.includes('生産者への貢献'));
  assert.ok($('#finalBody').allText.includes('社会・環境への貢献'));
  assert.equal($('#backBtn').disabled, false);

  // ③ ふりかえり
  $('#nextBtn2').click();
  await until(() => $('#finalBody').allText.includes('ふりかえりの問い'), { label: 'ふりかえり' });
  assert.ok($('#finalBody').allText.includes('全ラウンドの記録'), '全ラウンドの記録が出る');
  assert.equal($('#nextBtn2').disabled, true, 'これ以上は進めない');

  // 戻れる
  $('#backBtn').click();
  await until(() => $('#finalBody').allText.includes('総合ランキング'), { label: '戻る' });
  $('#nextBtn2').click();
  await until(() => $('#finalBody').allText.includes('ふりかえりの問い'), { label: '再度ふりかえり' });
});

test('結果をCSVで書き出せる', async () => {
  $('#exportBtn').click();
  assert.ok(lastBlob, 'CSVが生成された');
  // Blob.text() は先頭のBOMを取り除くので、バイト列で確認する
  const bytes = new Uint8Array(await lastBlob.arrayBuffer());
  assert.deepEqual([...bytes.slice(0, 3)], [0xef, 0xbb, 0xbf], 'ExcelがUTF-8と判別できるようBOMが付いている');

  const csv = await lastBlob.text();
  assert.ok(csv.includes('ラウンド'), 'ヘッダ行がある');
  assert.ok(csv.includes('カカオの仕入れ先'), '決定項目が列になっている');
  assert.ok(csv.includes('最終結果'), '最終順位も含まれる');

  const lines = csv.split('\r\n').filter(Boolean);
  assert.ok(lines.length >= 5 * 4 + 5, '5ラウンド×4人 + 最終結果の行数がある');
});

test('拡大表示（プロジェクタ用）を切り替えられる', () => {
  assert.equal(document.body.classList.contains('projector'), false);
  $('#projBtn').click();
  assert.equal(document.body.classList.contains('projector'), true);
  assert.equal(localStorage.getItem('ftc.projector'), '1');
  $('#projBtn').click();
  assert.equal(document.body.classList.contains('projector'), false);
});

test('同じメンバーでもう一度あそべる', async () => {
  $('#restartBtn').click(); // confirm は常に true
  await until(() => screenName() === 'lobby', { label: '待機画面に戻る' });
  assert.equal($('#lobbyPlayers').querySelectorAll('.player').length, 4, 'メンバーはそのまま');
  assert.equal($('#startBtn').disabled, false);
});
