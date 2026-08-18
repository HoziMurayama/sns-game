/**
 * トップページ（ハブ）のテスト。
 *
 * 「先生用と生徒用が1つのページから互いに行き来できること」が要件なので、
 * リンクの張られ方と、ダイアログ・お知らせの読み込みを実際に動かして確認します。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

import { startServer } from './helpers.js';
import { installDom, until } from './dom-stub.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 31747;

const server = await startServer(PORT);
const { document } = installDom({
  html: path.join(ROOT, 'public', 'index.html'),
  url: `http://127.0.0.1:${PORT}`,
});

// <dialog> は stub に無いので、showModal/close を最低限つける
for (const dlg of document.querySelectorAll('DIALOG')) {
  dlg.open = false;
  dlg.showModal = function () {
    this.open = true;
  };
  dlg.close = function () {
    this.open = false;
  };
}

const home = await import('../public/js/home.js');

// 途中で DOM を作り直すテストがあるので、常に「いまの document」を見る
const live = () => globalThis.document;
const $ = (sel) => live().querySelector(sel);
const IMG_DIR = path.join(ROOT, 'public', 'img');

/** DOM を作り直したあとに読み込み直した home.js（途中のテストで入る） */
let reloadedHome = null;

test.after(async () => {
  await server.stop();
});

/* ================================================================ */

/* ---- タイトル画面 → メニュー ---- */

test('起動直後はメニューが閉じていて、背景の絵だけが見えている', () => {
  assert.equal($('#menuVeil').hidden, true, 'メニューは出ていない');
  assert.equal(live().body.classList.contains('menu-open'), false);
  assert.ok($('#startLayer'), '画面全体が押せるようになっている');
  assert.ok($('#startLayer').getAttribute('aria-label').includes('メニュー'), '読み上げ用の説明がある');
});

test('画面のどこかを押すとメニューが開く', () => {
  $('#startLayer').click();
  assert.equal($('#menuVeil').hidden, false, 'メニューが出る');
  assert.equal(live().body.classList.contains('menu-open'), true, 'タイトル画面は隠れる');
});

test('タイトルと副題がメニューに出ている', () => {
  assert.equal($('.menu-title .t1').textContent, 'チョコレートの旅');
  assert.equal($('.menu-title .t2').textContent, 'フェアトレード・チャレンジ');
  assert.equal($('.ribbon').textContent, '～おいしさの裏にある、やさしい選択～');
});

test('✕ で閉じると、またタイトル画面に戻る', () => {
  $('#menuClose').click();
  assert.equal($('#menuVeil').hidden, true);
  assert.equal(live().body.classList.contains('menu-open'), false);

  // もう一度開ける
  $('#startLayer').click();
  assert.equal($('#menuVeil').hidden, false);
});

test('メニューの外側を押しても閉じる', () => {
  const veil = $('#menuVeil');
  assert.equal(veil.hidden, false, '開いている状態から始める');

  // カードの内側を押しても閉じない
  veil.dispatch('click', { target: $('#menuCard') });
  assert.equal(veil.hidden, false);

  // 外側（暗い部分）なら閉じる
  veil.dispatch('click', { target: veil });
  assert.equal(veil.hidden, true);

  $('#startLayer').click(); // 以降のテストのために開け直す
});

test('フッターの文言と著作権表示がある', () => {
  const foot = $('.menu-foot').allText;
  assert.ok(foot.includes('未来のやさしい選択につなげていきましょう'));
  assert.ok(foot.includes('© Fair Trade × Education'));
});

test('「ゲームの流れ」が6段階そろっている', () => {
  const steps = document.querySelectorAll('.flow-list LI').map((li) => li.allText);
  assert.equal(steps.length, 6);
  const joined = steps.join(' ');
  for (const name of ['カカオ農家', '協同組合', '輸出', 'チョコレート会社', 'お店', '消費者']) {
    assert.ok(joined.includes(name), `${name} が流れに入っている`);
  }
});

test('生徒用と先生用、両方への入口がある（ここが今回の要件）', () => {
  const student = $('.hbtn-student');
  const teacher = $('.hbtn-teacher');

  assert.equal(student.getAttribute('href'), '/play.html', '生徒は参加画面へ');
  assert.ok(student.allText.includes('ゲームに参加する'));
  assert.ok(student.allText.includes('生徒'));

  assert.equal(teacher.getAttribute('href'), '/teacher.html', '先生はコンソールへ');
  assert.ok(teacher.allText.includes('ルームを作成'));
});

const ghostButton = (label) =>
  live()
    .querySelectorAll('.hbtn-ghost')
    .find((b) => b.allText.includes(label));

test('「遊び方」「お知らせ」のボタンがある', () => {
  assert.ok(ghostButton('遊び方'), '遊び方ボタン');
  assert.ok(ghostButton('お知らせ'), 'お知らせボタン');
});

test('挿絵が埋め込まれている（外部画像を読みに行かない）', () => {
  const svg = $('.hero-svg');
  assert.ok(svg, 'インラインSVGがある');
  assert.equal(svg.getAttribute('role'), 'img');
  assert.ok(svg.getAttribute('aria-label').length > 10, '読み上げ用の説明がある');

  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  assert.ok(!/<img\s/i.test(html), '外部画像ファイルを使っていない');
  assert.ok(!/https?:\/\/(?!www\.w3\.org)/i.test(html), '外部サイトへの参照がない');
});

test('背景画像が無いときの代わりの挿絵が入っている', () => {
  const svg = $('.hero-svg');
  assert.ok(svg, 'メニューの中にSVGの挿絵がある');
  assert.equal(svg.getAttribute('role'), 'img');

  // 画像ファイルが無くても絵になるだけの要素が入っていること
  assert.ok(svg.querySelectorAll('PATH').length >= 5, '風景が描かれている');
  assert.ok(svg.querySelector('LINEARGRADIENT'), '空や海のグラデーションがある');
});

test('「遊び方」を押すとダイアログが開き、3つの仕入れ先が説明される', () => {
  ghostButton('遊び方').click();

  const dlg = $('#dlgHowto');
  assert.equal(dlg.open, true, 'ダイアログが開く');

  const text = dlg.allText;
  assert.ok(text.includes('一般市場'));
  assert.ok(text.includes('直接取引'));
  assert.ok(text.includes('国際フェアトレード認証'));
  assert.ok(text.includes('第三者機関の監査'), '認証との違いが説明されている');
  assert.ok(text.includes('必ず勝てるわけではありません'), '教材としての要点が書かれている');
  assert.ok(text.includes('60%') && text.includes('25%') && text.includes('15%'), '総合得点の内訳が出る');

  dlg.close();
});

test('「お知らせ」は config/news.json から読み込まれる', async () => {
  ghostButton('お知らせ').click();
  assert.equal($('#dlgNews').open, true);

  await until(() => $('#newsList').querySelectorAll('.news-item').length > 0, { label: 'お知らせの読み込み' });

  const source = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'news.json'), 'utf8'));
  const items = $('#newsList').querySelectorAll('.news-item');
  assert.equal(items.length, source.items.length, 'JSONの件数どおりに表示される');
  assert.ok(items[0].allText.includes(source.items[0].title));
  assert.ok(items[0].allText.includes(source.items[0].date));
});

test('前回の続きがあれば、メニューに戻る導線が出る', async () => {
  // いったん保存しておいて、ページを読み直したのと同じ状態を作る
  localStorage.setItem('ftc.session.player', JSON.stringify({ code: '482913', token: 'x', role: 'player' }));

  const { document: doc2 } = reinstall();
  reloadedHome = await import(`../public/js/home.js?reload=${Date.now()}`);

  const resume = doc2.querySelectorAll('.home-actions A').find((a) => a.allText.includes('前回の続き'));
  assert.ok(resume, '続きに戻るリンクが出る');
  assert.equal(resume.getAttribute('href'), '/play.html?code=482913', 'ルーム番号つきで参加画面へ戻る');
});

/** localStorage を保ったまま DOM だけ作り直す */
function reinstall() {
  const saved = localStorage.getItem('ftc.session.player');
  delete globalThis.document;
  const r = installDom({ html: path.join(ROOT, 'public', 'index.html'), url: `http://127.0.0.1:${PORT}` });
  localStorage.setItem('ftc.session.player', saved);
  for (const dlg of r.document.querySelectorAll('DIALOG')) {
    dlg.open = false;
    dlg.showModal = function () {
      this.open = true;
    };
    dlg.close = function () {
      this.open = false;
    };
  }
  return r;
}

/* ---- 背景イラスト ---- */

test('背景画像が置かれていなくても、ページは壊れない', async () => {
  // 起動時の画像さがしが終わるのを待ってから調べる（待たないと結果が混ざる）
  await (reloadedHome ?? home).ready;
  live().body.classList.remove('has-bg-art');

  // 存在しないファイルだけを候補にして呼ぶ
  const used = await home.applyBackgroundArt(['/img/__none__.png']);
  assert.equal(used, null, '見つからなければ null を返す');
  assert.equal(live().body.classList.contains('has-bg-art'), false, '背景用のクラスは付かない');
});

test('public/img に画像を置くと、背景として使われる', async () => {
  // 1x1 の本物のPNGを一時的に置く
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
    'base64'
  );
  const file = path.join(IMG_DIR, 'hero.png');
  const existed = fs.existsSync(file);
  if (existed) return; // 本番の画像が既にある場合は触らない

  fs.mkdirSync(IMG_DIR, { recursive: true });
  fs.writeFileSync(file, png);
  try {
    // サーバが画像として配信できること（MIMEの確認）
    const res = await fetch(`${server.url}/img/hero.png`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/png');

    const used = await home.applyBackgroundArt();
    assert.equal(used, '/img/hero.png', '拡張子の優先順で見つける');
    assert.equal(live().body.classList.contains('has-bg-art'), true, '背景用のクラスが付く');
    assert.equal(
      live().documentElement.style.getPropertyValue('--bg-art'),
      'url("/img/hero.png")',
      'CSS変数にURLが入る'
    );
  } finally {
    fs.rmSync(file, { force: true });
    live().body.classList.remove('has-bg-art');
  }
});

/* ---- モーダルの背景画像 ---- */

test('modal-bg 画像があれば、モーダル上部の絵として使われる', async () => {
  const used = await home.applyModalArt();
  assert.ok(used, 'public/img に modal-bg 画像が置かれている');
  assert.match(used, /^\/img\/modal-bg\.(webp|jpg|jpeg|png)$/);
  assert.equal(used, '/img/modal-bg.jpg', '軽いJPEGが優先して使われる');

  assert.equal(live().body.classList.contains('has-modal-art'), true);
  assert.equal(
    live().documentElement.style.getPropertyValue('--modal-art'),
    `url("${used}")`,
    'CSS変数にURLが入る'
  );

  // 実際に配信できること
  const res = await fetch(`${server.url}${used}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/jpeg');
});

test('絵に文字が入っているので、CSSのタイトルは読み上げ用に残しつつ隠す', () => {
  const css = fs.readFileSync(path.join(ROOT, 'public', 'css', 'home.css'), 'utf8');
  assert.match(css, /body\.has-modal-art \.hero-copy/, 'タイトルを隠す指定がある');
  assert.match(css, /clip-path:\s*inset\(50%\)/, '要素は残すので読み上げには出る');

  // DOM からは消さない（スクリーンリーダーと検索のため）
  assert.equal($('.menu-title .t1').textContent, 'チョコレートの旅');
  assert.equal($('.menu-title .t2').textContent, 'フェアトレード・チャレンジ');
});

test('閉じるボタンは、絵に描かれた✕の上に重なる位置にある', () => {
  const closeBtn = $('#menuClose');
  assert.ok(closeBtn, '操作できる本物のボタンがある');
  assert.equal(closeBtn.parent.className.includes('menu-hero'), true, '絵と同じ枠の中に置かれている');
  assert.ok(closeBtn.getAttribute('aria-label').includes('閉じる'), '読み上げ用の名前がある');

  const css = fs.readFileSync(path.join(ROOT, 'public', 'css', 'home.css'), 'utf8');
  assert.match(css, /body\.has-modal-art \.menu-close/, '画像に合わせた位置指定がある');

  // モーダルの絵は、全体背景の絵より優先されなければならない。
  // 同じ強さだと後勝ちになり、背景の絵（✕が描かれていない）が出て
  // 「透明な閉じるボタンだけが残る」状態になってしまう。
  assert.match(
    css,
    /body\.home\.has-modal-art \.menu-hero/,
    'モーダルの絵は詳細度で背景の絵に勝たせる'
  );
  assert.match(css, /--close-top/, '位置は変数で調整できる');
  assert.match(css, /min-width:\s*40px/, '小さい画面でも押せる大きさを確保している');
  assert.match(css, /aspect-ratio:\s*var\(--modal-art-ratio/, '画像の比率に合わせて枠を作る');
});

test('画像を使っていても、閉じるボタンはちゃんと動く', () => {
  $('#startLayer').click();
  assert.equal($('#menuVeil').hidden, false, 'まず開く');

  $('#menuClose').click();
  assert.equal($('#menuVeil').hidden, true, '✕ で閉じられる');

  $('#startLayer').click(); // 以降のテストのために開け直す
});

test('背景があるときの見せ方がCSSに定義されている', () => {
  const css = fs.readFileSync(path.join(ROOT, 'public', 'css', 'home.css'), 'utf8');
  assert.match(css, /body\.home\.has-bg-art::before/, '画像を敷く指定がある');
  assert.match(css, /body\.home\.menu-open\.has-bg-art::after/, 'メニューを開いたときだけ暗くする');
  assert.match(css, /has-bg-art \.menu-hero \.hero-svg\s*\{\s*display:\s*none/, '画像があるときは代替の挿絵を出さない');
  assert.match(css, /body\.menu-open \.start-layer\s*\{\s*display:\s*none/, '開いている間はタイトル層を隠す');
  assert.match(css, /-webkit-backdrop-filter/, 'Safari向けの指定もある');
  assert.match(css, /position:\s*fixed/, 'iOSで崩れにくいfixed擬似要素で敷いている');
});

test('キーボードだけでもメニューを開閉できる', () => {
  // いったん閉じる
  $('#menuClose').click();
  assert.equal($('#menuVeil').hidden, true);

  // 何かキーを押すと開く（タブレットに外付けキーボードがある場合など）
  const keydown = documentListeners('keydown');
  keydown({ key: 'Enter' });
  assert.equal($('#menuVeil').hidden, false, 'キー入力で開く');

  keydown({ key: 'Escape' });
  assert.equal($('#menuVeil').hidden, true, 'Escapeで閉じる');

  keydown({ key: 'a' });
  assert.equal($('#menuVeil').hidden, false);
});

/** document に登録された keydown ハンドラをまとめて呼ぶ */
function documentListeners(type) {
  const handlers = globalThis.__docListeners?.[type] || [];
  return (ev) => {
    for (const fn of handlers) fn({ preventDefault() {}, ...ev });
  };
}

/* ---- 相互リンク ---- */

test('生徒用ページから、トップと先生用へ行ける', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'play.html'), 'utf8');
  assert.match(html, /class="brand brand-link" href="\/"/, 'ヘッダのロゴがトップへのリンク');
  assert.match(html, /href="\/teacher.html"/, '先生用への案内がある');
});

test('先生用ページから、トップと生徒用へ行ける', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'teacher.html'), 'utf8');
  assert.match(html, /class="brand brand-link" href="\/"/, 'ヘッダのロゴがトップへのリンク');
  assert.match(html, /href="\/play.html"/, '生徒用への案内がある');
});

test('サーバが3つの入口をすべて配信する', async () => {
  for (const [p, needle] of [
    ['/', 'ゲームの流れ'],
    ['/play.html', 'ゲームに参加しよう'],
    ['/teacher.html', 'ゲームルームを作る'],
  ]) {
    const res = await fetch(`${server.url}${p}`);
    assert.equal(res.status, 200, `${p} が配信される`);
    const body = await res.text();
    assert.ok(body.includes(needle), `${p} の中身が正しい`);
  }
});

test('お知らせAPIが動く', async () => {
  const res = await fetch(`${server.url}/api/news`);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(Array.isArray(data.items) && data.items.length > 0);
  for (const item of data.items) {
    assert.ok(item.date && item.title, 'date と title は必須');
  }
});
