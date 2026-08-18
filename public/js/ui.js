/** 画面づくりの小さな道具箱（フレームワークは使いません）。 */

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** el('div', {class:'x', onclick:fn}, ['text', el('b',{},['!')]]) */
export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    node.appendChild(typeof child === 'object' ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

export function mount(node, children) {
  clear(node);
  for (const c of [].concat(children)) if (c) node.appendChild(c);
  return node;
}

/* ------------------------------------------------ 数値の書式 */

export const fmt = (n) => Number(n ?? 0).toLocaleString('ja-JP');

export function fmtSigned(n) {
  const v = Number(n ?? 0);
  return (v > 0 ? '+' : '') + v.toLocaleString('ja-JP');
}

export function signClass(n) {
  const v = Number(n ?? 0);
  return v > 0 ? 'pos' : v < 0 ? 'neg' : '';
}

/** 販売数量を「4.8ロット（4,800個）」の形にする */
export function fmtQty(q, rules) {
  const conf = rules?.game?.quantity;
  const digits = conf?.decimals ?? 1;
  const num = Number(q ?? 0).toFixed(digits);
  if (!conf?.unitLabel) return num;
  const pieces = conf.unitSize ? `（${fmt(Math.round(q * conf.unitSize))}個）` : '';
  return `${num}${conf.unitLabel}${pieces}`;
}

/* ------------------------------------------------ お金の表示

   金額は「円」で保持し、表示だけ設定に従って変えます。
   config の game.currency で切り替えられます。
     { unit: 10000, unitLabel: "万円" } … 1,000万円  （既定・読みやすい）
     { unit: 1,     unitLabel: "円"   } … 10,000,000円（円そのまま）
   ------------------------------------------------------------- */

const currencyOf = (rules) => rules?.game?.currency ?? { unit: 1, unitLabel: '円' };

/** 表示用の数値だけを返す（単位は付けない。表の中などで使う） */
export function moneyValue(yen, rules) {
  const { unit } = currencyOf(rules);
  const v = Number(yen ?? 0) / (unit || 1);
  // 万円表示のときに端数が出たら小数1桁まで見せる
  return Number.isInteger(v) ? fmt(v) : v.toLocaleString('ja-JP', { maximumFractionDigits: 1 });
}

/** 単位つき（例: 1,000万円） */
export function money(yen, rules) {
  return `${moneyValue(yen, rules)}${currencyOf(rules).unitLabel}`;
}

/** 増減つき（例: +528万円 / -160万円） */
export function moneySigned(yen, rules) {
  const v = Number(yen ?? 0);
  return `${v > 0 ? '+' : ''}${money(v, rules)}`;
}

/** 表の見出しに付ける単位（例: 売上（万円）） */
export const moneyUnit = (rules) => currencyOf(rules).unitLabel;

export const pt = (n, rules) => money(n, rules);

/* ------------------------------------------------ 通知 */

let bannerNode = null;
let bannerTimer = null;

export function toast(message, kind = '', ms = 3200) {
  if (!bannerNode) {
    bannerNode = el('div', { class: 'banner', role: 'status', 'aria-live': 'polite' });
    document.body.appendChild(bannerNode);
  }
  bannerNode.className = `banner show ${kind}`;
  bannerNode.textContent = message;
  clearTimeout(bannerTimer);
  if (ms > 0) bannerTimer = setTimeout(() => bannerNode.classList.remove('show'), ms);
}

export function hideToast() {
  clearTimeout(bannerTimer);
  bannerNode?.classList.remove('show');
}

/* ------------------------------------------------ 画面切替 */

export function showScreen(name) {
  for (const s of $$('.screen')) s.classList.toggle('active', s.dataset.screen === name);
  // どの画面を出しているかを body にも持たせる。
  // （参加画面のときだけ背景の絵を出す、といった切り替えをCSS側でできるようにするため）
  const body = document.body;
  for (const cls of [...body.classList]) {
    if (cls.startsWith('screen-')) body.classList.remove(cls);
  }
  body.classList.add(`screen-${name}`);
}

/* ------------------------------------------------ その他 */

export function ordinal(rank) {
  return `${rank}位`;
}

export const medal = (rank) => (rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : '');

/** 残り時間の表示（mm:ss） */
export function countdownText(deadline) {
  const left = Math.max(0, Math.round((deadline - Date.now()) / 1000));
  const m = Math.floor(left / 60);
  const s = left % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** 会社の識別ドット */
export function dot(color) {
  return el('span', { class: 'dot', style: { background: color || '#ccc' } });
}
