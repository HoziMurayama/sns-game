/**
 * 背景イラストの読み込み（トップページと生徒用ページで共用）。
 *
 * public/img/ に画像が置かれていればそれを使い、無ければ配色だけで表示します。
 * どちらの場合でも画面は壊れません。
 */

/** 画面全体の背景 */
export const BG_ART_CANDIDATES = ['/img/hero.webp', '/img/hero.jpg', '/img/hero.jpeg', '/img/hero.png'];

/**
 * 生徒の参加画面の背景。
 * join-bg.* を置けばそれを使い、無ければトップページと同じ hero.* を使います。
 * （画面ごとに違う絵にしたいとき用。用意しなくても動きます）
 */
export const JOIN_ART_CANDIDATES = [
  '/img/join-bg.webp',
  '/img/join-bg.jpg',
  '/img/join-bg.jpeg',
  '/img/join-bg.png',
  ...BG_ART_CANDIDATES,
];

/** 先生のルーム作成画面の背景。無ければ配色のみ（画像は必須ではありません）。 */
export const SETUP_ART_CANDIDATES = [
  '/img/room-make-bg.webp',
  '/img/room-make-bg.jpg',
  '/img/room-make-bg.jpeg',
  '/img/room-make-bg.png',
];

export async function applySetupArt(candidates = SETUP_ART_CANDIDATES) {
  const src = await findFirstExisting(candidates);
  if (!src) return null;
  document.documentElement.style.setProperty('--setup-art', `url("${src}")`);
  document.body.classList.add('has-setup-art');
  return src;
}

/** モーダル上部の絵（タイトル・リボン・✕ が描き込まれている前提） */
export const MODAL_ART_CANDIDATES = [
  '/img/modal-bg.webp',
  '/img/modal-bg.jpg',
  '/img/modal-bg.jpeg',
  '/img/modal-bg.png',
];

/** 置かれている画像を先頭から探す（HEAD なら本体を落とさずに有無だけ分かる） */
export async function findFirstExisting(candidates) {
  for (const src of candidates) {
    try {
      const res = await fetch(src, { method: 'HEAD' });
      if (res.ok) return src;
    } catch {
      /* 次の候補へ */
    }
  }
  return null;
}

export async function applyBackgroundArt(candidates = BG_ART_CANDIDATES) {
  const src = await findFirstExisting(candidates);
  if (!src) return null;
  document.documentElement.style.setProperty('--bg-art', `url("${src}")`);
  document.body.classList.add('has-bg-art');
  return src;
}

export async function applyModalArt(candidates = MODAL_ART_CANDIDATES) {
  const src = await findFirstExisting(candidates);
  if (!src) return null;
  document.documentElement.style.setProperty('--modal-art', `url("${src}")`);
  document.body.classList.add('has-modal-art');

  // 実際の縦横比を測って反映する。
  // 絵に描かれた✕と、その上に重ねる操作ボタンの位置がずれないようにするため。
  measureRatio(src).then((ratio) => {
    if (ratio) document.documentElement.style.setProperty('--modal-art-ratio', ratio);
  });
  return src;
}

function measureRatio(src) {
  return new Promise((resolve) => {
    if (typeof Image !== 'function') return resolve(null);
    const img = new Image();
    img.onload = () =>
      resolve(img.naturalWidth && img.naturalHeight ? `${img.naturalWidth} / ${img.naturalHeight}` : null);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}
