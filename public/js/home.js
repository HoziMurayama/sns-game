/**
 * トップページのふるまい。
 *
 *  1. 起動直後は背景の絵だけを見せる（タイトル画面）
 *  2. 画面のどこかを押す／キーを押すとメニューを開く
 *  3. ✕ ・Escape ・メニューの外側で閉じて、またタイトル画面に戻る
 *  4. 「遊び方」「お知らせ」のダイアログ
 *
 * お知らせは config/news.json から読むので、HTMLを触らずに更新できます。
 */

import {
  applyBackgroundArt,
  applyModalArt,
  BG_ART_CANDIDATES,
  MODAL_ART_CANDIDATES,
} from './art.js';

import { injectSprite } from './icons.js';

// 生徒用ページ（play.js）とも共用しているため、ここから再公開しておく
export { applyBackgroundArt, applyModalArt, BG_ART_CANDIDATES, MODAL_ART_CANDIDATES };

injectSprite();

const $ = (sel) => document.querySelector(sel);

/** 「タップしてはじめる」を出すまでの時間（ミリ秒）。0 にすると出さない。 */
const SHOW_HINT_AFTER_MS = 1800;

/**
 * 起動時の画像さがしが終わったことを知るための Promise。
 * 画面の動作には不要ですが、テストが「読み込み完了後」を待てるようにしています。
 */
export const ready = Promise.all([applyBackgroundArt(), applyModalArt()]);

/* ================================================================
 * タイトル画面 → メニュー
 * ================================================================ */

const startLayer = $('#startLayer');
const menuVeil = $('#menuVeil');
const menuCard = $('#menuCard');

export function openMenu() {
  if (!menuVeil || menuVeil.hidden === false) return false; // すでに開いている
  menuVeil.hidden = false;
  document.body.classList.add('menu-open');
  // 最初の入口（生徒用ボタン）に合わせておく。キーボードだけでも進めるように。
  menuCard?.querySelector('.hbtn')?.focus?.();
  return true;
}

export function closeMenu() {
  if (!menuVeil || menuVeil.hidden) return false;
  menuVeil.hidden = true;
  document.body.classList.remove('menu-open');
  startLayer?.focus?.();
  return true;
}

startLayer?.addEventListener('click', openMenu);
$('#menuClose')?.addEventListener('click', closeMenu);

// メニューの外側（暗い部分）を押したら閉じる
menuVeil?.addEventListener('click', (ev) => {
  if (ev.target === menuVeil) closeMenu();
});

// キーボード操作: 何かキーを押せば開く／Escapeで閉じる
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape') {
    // 「遊び方」などが開いているときは、そちらを優先して閉じる
    const openDialog = [...document.querySelectorAll('dialog')].find((d) => d.open);
    if (openDialog) return;
    closeMenu();
    return;
  }
  if (menuVeil && menuVeil.hidden && !ev.metaKey && !ev.ctrlKey && !ev.altKey) {
    if (ev.key === 'Tab') return; // Tab はフォーカス移動として扱う
    openMenu();
  }
});

// しばらく操作がなければ、押せることを知らせる
if (SHOW_HINT_AFTER_MS > 0 && startLayer) {
  setTimeout(() => {
    if (menuVeil?.hidden) startLayer.classList.add('hint-on');
  }, SHOW_HINT_AFTER_MS);
}

/* ================================================================
 * 「遊び方」「お知らせ」
 * ================================================================ */

for (const btn of document.querySelectorAll('[data-dialog]')) {
  btn.addEventListener('click', () => {
    const dlg = document.getElementById(btn.dataset.dialog);
    if (!dlg) return;
    if (typeof dlg.showModal === 'function') dlg.showModal();
    else dlg.setAttribute('open', '');
    if (btn.dataset.dialog === 'dlgNews') loadNews();
  });
}

// 背景（バックドロップ）をクリックしたら閉じる。
// dialog の内側の余白を押しても target は dialog 自身になるため、
// 実際に枠の外を押したときだけ閉じる。
for (const dlg of document.querySelectorAll('dialog')) {
  dlg.addEventListener('click', (ev) => {
    if (ev.target !== dlg || typeof dlg.getBoundingClientRect !== 'function') return;
    const r = dlg.getBoundingClientRect();
    const outside =
      ev.clientX < r.left || ev.clientX > r.right || ev.clientY < r.top || ev.clientY > r.bottom;
    if (outside) dlg.close();
  });
}

/* ---------------------------------------------- お知らせ */

let newsLoaded = false;

export async function loadNews() {
  if (newsLoaded) return;
  const box = $('#newsList');
  if (!box) return;
  try {
    const res = await fetch('/api/news');
    const data = await res.json();
    const items = data.items || [];
    box.textContent = '';

    if (!items.length) {
      box.appendChild(el('p', { class: 'dlg-p muted' }, ['お知らせはありません。']));
    }
    for (const item of items) {
      box.appendChild(
        el('article', { class: 'news-item' }, [
          el('div', { class: 'news-head' }, [
            el('span', { class: `news-tag tag-${item.tag || 'info'}` }, [tagLabel(item.tag)]),
            el('span', { class: 'news-date' }, [item.date || '']),
            el('span', { class: 'news-title' }, [item.title || '']),
          ]),
          el('p', { class: 'news-body' }, [item.body || '']),
        ])
      );
    }
    newsLoaded = true;
  } catch {
    box.textContent = '';
    box.appendChild(el('p', { class: 'dlg-p muted' }, ['お知らせを読み込めませんでした。']));
  }
}

const tagLabel = (tag) => ({ new: 'NEW', update: '更新', info: 'お知らせ' })[tag] || 'お知らせ';

/* ---------------------------------------------- 続きに戻る導線 */

/**
 * 前回ゲームの途中だった場合、メニューに案内を出す。
 * （タブを閉じてしまった生徒が、トップからでも戻れるようにするため）
 */
function showResumeHint() {
  let session = null;
  let role = null;
  for (const r of ['player', 'teacher']) {
    try {
      const raw = localStorage.getItem(`ftc.session.${r}`);
      if (raw) {
        session = JSON.parse(raw);
        role = r;
        break;
      }
    } catch {
      /* 保存が読めなくても、トップページは普通に使えるようにする */
    }
  }
  if (!session?.code) return;

  const isTeacher = role === 'teacher';
  const link = el(
    'a',
    {
      class: 'hbtn hbtn-ghost',
      href: isTeacher ? '/teacher' : `/play?code=${session.code}`,
      style: 'grid-column:1/-1',
    },
    [
      el('span', { class: 'hbtn-ic' }, ['↩']),
      el('span', { class: 'hbtn-tx' }, [`前回の続き（ルーム ${session.code}${isTeacher ? ' / 先生' : ''}）に戻る`]),
    ]
  );
  $('.home-actions')?.appendChild(link);
}

showResumeHint();

/* ---------------------------------------------- 小さな道具 */

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c === null || c === undefined || c === false) continue;
    node.appendChild(typeof c === 'object' ? c : document.createTextNode(String(c)));
  }
  return node;
}
