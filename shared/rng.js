/**
 * 決定論的な擬似乱数。
 *
 * ゲームの「運」の部分をシード固定にすることで、
 *  - 同じ入力なら必ず同じ結果になる（テスト・バランス検証が可能）
 *  - 再接続やサーバ再起動があっても結果が変わらない
 * という2点を満たします。Math.random() はゲーム計算では使いません。
 */

/** 文字列 → 32bit シード（xmur3） */
export function hashSeed(str) {
  let h = 1779033703 ^ String(str).length;
  for (let i = 0; i < String(str).length; i++) {
    h = Math.imul(h ^ String(str).charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return (h ^= h >>> 16) >>> 0;
  };
}

/** 32bit シード → [0,1) を返す関数（mulberry32） */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), 1 | t);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 任意個の値からRNGを作る。
 * 例) rngFor(seed, 'round', 3, playerId) — プレイヤーごと・ラウンドごとに独立した乱数列。
 * 計算順序に依存しないので、Object のキー順が変わっても結果は同じです。
 */
export function rngFor(...parts) {
  return mulberry32(hashSeed(parts.join(''))());
}

/** -spread 〜 +spread の一様乱数（例: spread=0.06 → ±6%） */
export function jitter(rng, spread) {
  if (!spread) return 0;
  return (rng() * 2 - 1) * spread;
}

/** 配列から1つ選ぶ */
export function pick(rng, arr) {
  if (!arr.length) return undefined;
  return arr[Math.floor(rng() * arr.length) % arr.length];
}

/** Fisher–Yates シャッフル（非破壊） */
export function shuffled(rng, arr) {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** 6桁のルームコード（紛らわしい 0/O/1/I を避けた数字のみ） */
export function roomCode(rng) {
  let s = '';
  for (let i = 0; i < 6; i++) s += Math.floor(rng() * 10);
  return s;
}

/** URL安全なトークン */
export function token(rng, len = 22) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  let s = '';
  for (let i = 0; i < len; i++) s += alphabet[Math.floor(rng() * alphabet.length)];
  return s;
}
