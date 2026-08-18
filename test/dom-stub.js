/**
 * ブラウザを起動せずに、実際の画面スクリプト（play.js / teacher.js）を動かすための
 * 最小限のDOM実装。
 *
 * なぜ必要か:
 *   このプロジェクトで生徒と先生が実際に触るのは public/js/play.js と teacher.js です。
 *   ここが動かなければ、サーバ側がいくら正しくてもゲームになりません。
 *   ブラウザ自動操作を持ち込まずに、その2つを本物のサーバ相手に動かして確認します。
 *
 * 対応しているのは、このアプリが実際に使っているAPIだけです（汎用のDOM実装ではありません）。
 */

import fs from 'node:fs';

const VOID_TAGS = new Set([
  'meta', 'link', 'br', 'hr', 'img', 'input', 'source', 'area', 'base', 'col', 'embed', 'param', 'track', 'wbr',
]);

/* ------------------------------------------------------------------ */

class ClassList {
  constructor(node) {
    this.node = node;
  }
  get _set() {
    return new Set(String(this.node.className).split(/\s+/).filter(Boolean));
  }
  _write(set) {
    this.node.className = [...set].join(' ');
  }
  add(...names) {
    const s = this._set;
    for (const n of names) s.add(n);
    this._write(s);
  }
  remove(...names) {
    const s = this._set;
    for (const n of names) s.delete(n);
    this._write(s);
  }
  contains(name) {
    return this._set.has(name);
  }
  toggle(name, force) {
    const has = this.contains(name);
    const want = force === undefined ? !has : !!force;
    if (want) this.add(name);
    else this.remove(name);
    return want;
  }

  // 本物の DOMTokenList は反復できる（[...el.classList] が使われる）
  *[Symbol.iterator]() {
    yield* this._set;
  }

  get length() {
    return this._set.size;
  }

  item(i) {
    return [...this._set][i] ?? null;
  }

  get value() {
    return this.node.className;
  }

  toString() {
    return this.node.className;
  }
}

/**
 * style は Object.assign() でも setProperty() でも書けるようにする。
 * （CSS変数 --bg-art の設定に setProperty を使うため）
 */
function makeStyle() {
  const style = {};
  Object.defineProperty(style, 'setProperty', {
    value: (k, v) => {
      style[k] = String(v);
    },
    enumerable: false,
  });
  Object.defineProperty(style, 'getPropertyValue', {
    value: (k) => style[k] ?? '',
    enumerable: false,
  });
  return style;
}

export class StubNode {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parent = null;
    this.attributes = {};
    this.dataset = {};
    this.style = makeStyle();
    this.listeners = {};
    this.className = '';
    this.id = '';
    this.hidden = false;
    this.disabled = false;
    this.value = undefined;
    this.classList = new ClassList(this);
    this._text = '';
    this._html = '';
    this._value = undefined;
  }

  /** <select> は、明示的に設定されていなければ選択中（または先頭）の option を返す */
  get value() {
    if (this._value !== undefined) return this._value;
    if (this.tagName === 'SELECT') {
      const opts = this.querySelectorAll('OPTION');
      const chosen = opts.find((o) => o.attributes.selected !== undefined) || opts[0];
      return chosen?.attributes.value ?? chosen?.textContent;
    }
    return undefined;
  }

  set value(v) {
    this._value = v;
  }

  /* ---- ツリー ---- */

  get firstChild() {
    return this.children[0] ?? null;
  }

  appendChild(node) {
    if (node.parent) node.parent.removeChild(node);
    node.parent = this;
    this.children.push(node);
    return node;
  }

  removeChild(node) {
    const i = this.children.indexOf(node);
    if (i >= 0) {
      this.children.splice(i, 1);
      node.parent = null;
    }
    return node;
  }

  remove() {
    this.parent?.removeChild(this);
  }

  /* ---- 属性 ---- */

  setAttribute(k, v) {
    this.attributes[k] = String(v);
    if (k === 'class') this.className = String(v);
    else if (k === 'id') this.id = String(v);
    else if (k === 'hidden') this.hidden = true;
    else if (k === 'disabled') this.disabled = true;
    else if (k === 'value' && this.tagName !== 'OPTION') this.value = String(v);
    else if (k.startsWith('data-')) {
      const key = k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      this.dataset[key] = String(v);
    }
  }

  getAttribute(k) {
    if (k === 'class') return this.className;
    if (k === 'id') return this.id;
    return this.attributes[k] ?? null;
  }

  /* ---- 内容 ---- */

  set innerHTML(v) {
    this._html = String(v);
    for (const c of this.children) c.parent = null;
    this.children = [];
  }
  get innerHTML() {
    return this._html;
  }

  set textContent(v) {
    this._text = String(v);
    for (const c of this.children) c.parent = null;
    this.children = [];
  }
  get textContent() {
    if (this._text) return this._text;
    return this.children.map((c) => c.textContent).join('');
  }

  /** 検証用: 配下のテキストをすべて連結する */
  get allText() {
    return (this._text || '') + this._html + this.children.map((c) => c.allText).join('');
  }

  /* ---- イベント ---- */

  addEventListener(type, fn) {
    (this.listeners[type] ||= []).push(fn);
  }

  removeEventListener(type, fn) {
    this.listeners[type] = (this.listeners[type] || []).filter((f) => f !== fn);
  }

  /** クリックや submit を実際に発火させる */
  dispatch(type, extra = {}) {
    const event = {
      type,
      target: this,
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
      stopPropagation() {},
      ...extra,
    };
    const inline = this[`on${type}`];
    if (typeof inline === 'function') inline.call(this, event);
    for (const fn of (this.listeners[type] || []).slice()) fn.call(this, event);
    return event;
  }

  click() {
    return this.dispatch('click');
  }

  focus() {
    if (globalThis.document) globalThis.document.activeElement = this;
    this.dispatch('focus');
  }

  blur() {
    if (globalThis.document?.activeElement === this) globalThis.document.activeElement = null;
  }

  /* ---- 検索 ---- */

  matches(selector) {
    const sel = selector.trim();
    if (sel.startsWith('#')) return this.id === sel.slice(1);
    if (sel.startsWith('.')) return this.classList.contains(sel.slice(1));
    if (sel.startsWith('[') && sel.endsWith(']')) {
      const [k, v] = sel.slice(1, -1).split('=');
      const want = v?.replace(/^["']|["']$/g, '');
      const have = this.getAttribute(k) ?? this.dataset[k.replace(/^data-/, '')];
      return want === undefined ? have != null : have === want;
    }
    return this.tagName === sel.toUpperCase();
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  /** 「.a .b」のような子孫セレクタにも対応する（カンマ区切りは未対応） */
  querySelectorAll(selector) {
    const parts = String(selector).trim().split(/\s+/).filter(Boolean);
    let current = [this];
    for (const part of parts) {
      const next = [];
      for (const node of current) node._collect(part, next);
      current = [...new Set(next)];
    }
    return current;
  }

  _collect(simpleSelector, acc) {
    for (const c of this.children) {
      if (c.matches(simpleSelector)) acc.push(c);
      c._collect(simpleSelector, acc);
    }
    return acc;
  }

  findAll(predicate, acc = []) {
    for (const c of this.children) {
      if (predicate(c)) acc.push(c);
      c.findAll(predicate, acc);
    }
    return acc;
  }

  countTag(tag) {
    return this.findAll((n) => n.tagName === tag.toUpperCase()).length;
  }
}

export class StubText extends StubNode {
  constructor(text) {
    super('#text');
    this._text = String(text);
  }
  get allText() {
    return this._text;
  }
  get textContent() {
    return this._text;
  }
}

/* ------------------------------------------------------------------ *
 * ごく小さなHTMLパーサ
 * このプロジェクトのHTMLを読めれば十分なので、汎用性は追求していません。
 * （属性値の中に < > が入る favicon の data URI だけは正しく扱う必要があります）
 * ------------------------------------------------------------------ */

export function parseHtml(src) {
  const root = new StubNode('#document');
  const stack = [root];
  const addText = (t) => {
    if (t.trim()) stack.at(-1).appendChild(new StubText(t.trim()));
  };

  let i = 0;
  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt < 0) {
      addText(src.slice(i));
      break;
    }
    if (lt > i) addText(src.slice(i, lt));

    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt);
      i = end < 0 ? src.length : end + 3;
      continue;
    }
    if (src.startsWith('<!', lt)) {
      const end = src.indexOf('>', lt);
      i = end < 0 ? src.length : end + 1;
      continue;
    }

    // タグの終わりを探す（引用符の中の > は無視する）
    let j = lt + 1;
    let quote = null;
    while (j < src.length) {
      const ch = src[j];
      if (quote) {
        if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === '>') {
        break;
      }
      j++;
    }
    const raw = src.slice(lt + 1, j);
    i = j + 1;

    if (raw.startsWith('/')) {
      const name = raw.slice(1).trim().toLowerCase();
      for (let k = stack.length - 1; k > 0; k--) {
        if (stack[k].tagName.toLowerCase() === name) {
          stack.length = k;
          break;
        }
      }
      continue;
    }

    const selfClose = raw.trimEnd().endsWith('/');
    const body = selfClose ? raw.trimEnd().slice(0, -1) : raw;
    const nameMatch = body.match(/^([a-zA-Z0-9-]+)/);
    if (!nameMatch) continue;
    const tag = nameMatch[1];
    const node = new StubNode(tag);

    const attrRe = /([a-zA-Z_:@.-][a-zA-Z0-9_:.-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
    const attrStr = body.slice(nameMatch[0].length);
    let am;
    while ((am = attrRe.exec(attrStr))) {
      node.setAttribute(am[1], am[2] ?? am[3] ?? am[4] ?? '');
    }

    stack.at(-1).appendChild(node);

    const lower = tag.toLowerCase();
    if (lower === 'script' || lower === 'style') {
      const end = src.toLowerCase().indexOf(`</${lower}`, i);
      if (end >= 0) i = src.indexOf('>', end) + 1;
      continue;
    }
    if (!selfClose && !VOID_TAGS.has(lower)) stack.push(node);
  }
  return root;
}

/* ------------------------------------------------------------------ *
 * ブラウザ環境の用意
 * ------------------------------------------------------------------ */

function makeStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    clear: () => map.clear(),
    get length() {
      return map.size;
    },
  };
}

/**
 * globalThis に document / location / storage などを用意する。
 *
 * @param {{ html?: string, url?: string, search?: string }} opts
 *   html … 読み込むHTMLファイルのパス（省略時は空のドキュメント）
 *   url  … location の元にするURL（例: http://127.0.0.1:31745）
 */
export function installDom({ html, url = 'http://localhost:3000', search = '' } = {}) {
  const doc = html ? parseHtml(fs.readFileSync(html, 'utf8')) : new StubNode('#document');
  const body = doc.querySelector('body') || doc.appendChild(new StubNode('body'));
  const documentElement = doc.querySelector('html') || doc.appendChild(new StubNode('html'));
  const base = new URL(url);
  globalThis.__docListeners = {};

  const document = {
    _root: doc,
    body,
    documentElement,
    createElement: (tag) => new StubNode(tag),
    createElementNS: (_ns, tag) => new StubNode(tag), // SVG要素の生成に使われる
    createTextNode: (t) => new StubText(t),
    querySelector: (s) => doc.querySelector(s),
    querySelectorAll: (s) => doc.querySelectorAll(s),
    getElementById: (id) => doc.querySelector(`#${id}`),
    // document 全体に付けたハンドラ（キーボード操作など）をテストから呼べるようにする
    addEventListener: (type, fn) => {
      (globalThis.__docListeners[type] ||= []).push(fn);
    },
    removeEventListener: (type, fn) => {
      globalThis.__docListeners[type] = (globalThis.__docListeners[type] || []).filter((f) => f !== fn);
    },
  };

  globalThis.document = document;
  globalThis.location = {
    href: base.href,
    origin: base.origin,
    protocol: base.protocol,
    host: base.host,
    hostname: base.hostname,
    port: base.port,
    pathname: base.pathname,
    search,
    reloaded: 0,
    reload() {
      this.reloaded++;
    },
    assign() {},
  };
  globalThis.localStorage = makeStorage();
  globalThis.sessionStorage = makeStorage();

  // ブラウザの fetch は相対URLを解決できるが、Node の fetch はできない。
  // 画面のコードを書き換えずに済むよう、ここで補う。
  if (!globalThis.__fetchPatched) {
    const nativeFetch = globalThis.fetch;
    globalThis.fetch = (input, init) =>
      nativeFetch(typeof input === 'string' && input.startsWith('/') ? base.origin + input : input, init);
    globalThis.__fetchPatched = true;
  }
  globalThis.confirm = () => true;
  globalThis.alert = () => {};
  if (!globalThis.URL.createObjectURL) {
    globalThis.URL.createObjectURL = () => 'blob:stub';
    globalThis.URL.revokeObjectURL = () => {};
  }

  return { document, root: doc, body };
}

/** 条件が満たされるまで待つ（画面の描き替えを待つのに使う） */
export async function until(fn, { timeout = 10000, label = '条件' } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`待機タイムアウト: ${label}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}
