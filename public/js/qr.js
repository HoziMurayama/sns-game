/**
 * QRコード生成（バイトモード / 誤り訂正レベルM / バージョン1〜10）。
 *
 * 外部ライブラリを使わない方針のため自前実装しています。
 * 用途は「http://192.168.x.x:3000/j/123456」程度の短いURLなので、
 * バージョン10（213バイト）まで対応していれば十分です。
 *
 * 参考: ISO/IEC 18004（QRコードの規格）
 */

/* ---------------------------------------------- バージョン別のブロック構成（レベルM） */
// [総コード語数, 1ブロックあたりのEC語数, G1ブロック数, G1データ語数, G2ブロック数, G2データ語数]
const EC_TABLE_M = {
  1: [26, 10, 1, 16, 0, 0],
  2: [44, 16, 1, 28, 0, 0],
  3: [70, 26, 1, 44, 0, 0],
  4: [100, 18, 2, 32, 0, 0],
  5: [134, 24, 2, 43, 0, 0],
  6: [172, 16, 4, 27, 0, 0],
  7: [196, 18, 4, 31, 0, 0],
  8: [242, 22, 2, 38, 2, 39],
  9: [292, 22, 3, 36, 2, 37],
  10: [346, 26, 4, 43, 1, 44],
};

const ALIGN_POS = {
  1: [],
  2: [6, 18],
  3: [6, 22],
  4: [6, 26],
  5: [6, 30],
  6: [6, 34],
  7: [6, 22, 38],
  8: [6, 24, 42],
  9: [6, 26, 46],
  10: [6, 28, 50],
};

const EC_LEVEL_BITS_M = 0b00;

/* ---------------------------------------------- GF(256) 演算 */

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
(function initGf() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d; // 原始多項式
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
})();

const gfMul = (a, b) => (a === 0 || b === 0 ? 0 : GF_EXP[GF_LOG[a] + GF_LOG[b]]);

function rsGeneratorPoly(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= gfMul(poly[j], GF_EXP[i]);
      next[j + 1] ^= poly[j];
    }
    poly = next;
  }
  return poly;
}

function rsEncode(data, ecLen) {
  const gen = rsGeneratorPoly(ecLen);
  const res = new Uint8Array(ecLen);
  for (const byte of data) {
    const factor = byte ^ res[0];
    res.copyWithin(0, 1);
    res[ecLen - 1] = 0;
    for (let i = 0; i < ecLen; i++) res[i] ^= gfMul(gen[i + 1], factor);
  }
  return res;
}

/* ---------------------------------------------- ビット列の組み立て */

function pickVersion(byteLen) {
  for (let v = 1; v <= 10; v++) {
    const [, ecLen, g1, d1, g2, d2] = EC_TABLE_M[v];
    const dataCodewords = g1 * d1 + g2 * d2;
    const countBits = v <= 9 ? 8 : 16;
    const capacity = Math.floor((dataCodewords * 8 - 4 - countBits) / 8);
    if (byteLen <= capacity) return v;
  }
  throw new Error('QRコードにするには文字列が長すぎます');
}

function buildBitStream(bytes, version) {
  const [, ecLen, g1, d1, g2, d2] = EC_TABLE_M[version];
  const dataCodewords = g1 * d1 + g2 * d2;
  const bits = [];
  const push = (value, len) => {
    for (let i = len - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };

  push(0b0100, 4); // バイトモード
  push(bytes.length, version <= 9 ? 8 : 16);
  for (const b of bytes) push(b, 8);

  // 終端 + バイト境界そろえ
  const capacityBits = dataCodewords * 8;
  for (let i = 0; i < 4 && bits.length < capacityBits; i++) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);

  // 埋め草
  const padBytes = [0xec, 0x11];
  let pi = 0;
  while (bits.length < capacityBits) {
    push(padBytes[pi++ % 2], 8);
  }

  const codewords = new Uint8Array(dataCodewords);
  for (let i = 0; i < dataCodewords; i++) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i * 8 + j];
    codewords[i] = byte;
  }
  return { codewords, ecLen, g1, d1, g2, d2 };
}

function interleave({ codewords, ecLen, g1, d1, g2, d2 }) {
  const blocks = [];
  let offset = 0;
  for (let i = 0; i < g1; i++) {
    blocks.push(codewords.subarray(offset, offset + d1));
    offset += d1;
  }
  for (let i = 0; i < g2; i++) {
    blocks.push(codewords.subarray(offset, offset + d2));
    offset += d2;
  }
  const ecBlocks = blocks.map((b) => rsEncode(b, ecLen));

  const out = [];
  const maxData = Math.max(...blocks.map((b) => b.length));
  for (let i = 0; i < maxData; i++) {
    for (const b of blocks) if (i < b.length) out.push(b[i]);
  }
  for (let i = 0; i < ecLen; i++) {
    for (const b of ecBlocks) out.push(b[i]);
  }
  return Uint8Array.from(out);
}

/* ---------------------------------------------- 行列の組み立て */

export function formatInfoBits(mask) {
  const data = (EC_LEVEL_BITS_M << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}

export function versionInfoBits(version) {
  let rem = version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  return (version << 12) | rem;
}

function buildMatrix(version, data) {
  const size = version * 4 + 17;
  const modules = Array.from({ length: size }, () => new Int8Array(size).fill(-1)); // -1 = 未設定

  const setF = (r, c, v) => {
    if (r >= 0 && r < size && c >= 0 && c < size) modules[r][c] = v ? 1 : 0;
  };

  // 位置検出パターン + 分離パターン
  const finder = (r0, c0) => {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const inside =
          (r >= 0 && r <= 6 && (c === 0 || c === 6)) ||
          (c >= 0 && c <= 6 && (r === 0 || r === 6)) ||
          (r >= 2 && r <= 4 && c >= 2 && c <= 4);
        setF(r0 + r, c0 + c, inside ? 1 : 0);
      }
    }
  };
  finder(0, 0);
  finder(0, size - 7);
  finder(size - 7, 0);

  // タイミングパターン
  for (let i = 8; i < size - 8; i++) {
    const v = i % 2 === 0 ? 1 : 0;
    setF(6, i, v);
    setF(i, 6, v);
  }

  // 位置合わせパターン
  const pos = ALIGN_POS[version];
  for (const r of pos) {
    for (const c of pos) {
      const nearFinder =
        (r <= 8 && c <= 8) || (r <= 8 && c >= size - 9) || (r >= size - 9 && c <= 8);
      if (nearFinder) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const on = Math.max(Math.abs(dr), Math.abs(dc)) !== 1;
          setF(r + dr, c + dc, on);
        }
      }
    }
  }

  // 形式情報の領域を予約（値は後で入れる）
  const reserved = Array.from({ length: size }, () => new Uint8Array(size));
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) if (modules[r][c] !== -1) reserved[r][c] = 1;
  }
  const reserveFormat = (r, c) => {
    reserved[r][c] = 1;
    if (modules[r][c] === -1) modules[r][c] = 0;
  };
  for (let i = 0; i < 9; i++) {
    reserveFormat(8, i);
    reserveFormat(i, 8);
  }
  for (let i = 0; i < 8; i++) {
    reserveFormat(8, size - 1 - i);
    reserveFormat(size - 1 - i, 8);
  }
  setF(size - 8, 8, 1); // 常に暗のモジュール
  reserved[size - 8][8] = 1;

  // バージョン情報（7以上）
  if (version >= 7) {
    const bits = versionInfoBits(version);
    for (let i = 0; i < 18; i++) {
      const bit = (bits >>> i) & 1;
      const r = Math.floor(i / 3);
      const c = size - 11 + (i % 3);
      setF(r, c, bit);
      setF(c, r, bit);
      reserved[r][c] = 1;
      reserved[c][r] = 1;
    }
  }

  // データの配置（右下からジグザグ）
  let bitIndex = 0;
  const nextBit = () => {
    const byteIdx = bitIndex >>> 3;
    const bit = byteIdx < data.length ? (data[byteIdx] >>> (7 - (bitIndex & 7))) & 1 : 0;
    bitIndex++;
    return bit;
  };

  let upward = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5; // タイミング列は飛ばす
    for (let step = 0; step < size; step++) {
      const r = upward ? size - 1 - step : step;
      for (const c of [right, right - 1]) {
        if (reserved[r][c]) continue;
        modules[r][c] = nextBit();
      }
    }
    upward = !upward;
  }

  return { size, modules, reserved };
}

/* ---------------------------------------------- マスク */

const MASK_FN = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

function applyMaskAndFormat(base, mask) {
  const { size, modules, reserved } = base;
  const out = modules.map((row) => Int8Array.from(row));
  const fn = MASK_FN[mask];

  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (!reserved[r][c] && fn(r, c)) out[r][c] ^= 1;
    }
  }

  const bits = formatInfoBits(mask);
  const getBit = (i) => (bits >>> i) & 1;
  for (let i = 0; i <= 5; i++) out[8][i] = getBit(i);
  out[8][7] = getBit(6);
  out[8][8] = getBit(7);
  out[7][8] = getBit(8);
  for (let i = 9; i <= 14; i++) out[14 - i][8] = getBit(i);
  for (let i = 0; i <= 7; i++) out[size - 1 - i][8] = getBit(i);
  for (let i = 8; i <= 14; i++) out[8][size - 15 + i] = getBit(i);
  out[size - 8][8] = 1;

  return out;
}

function penalty(matrix, size) {
  let score = 0;

  // 規則1: 同色が5個以上続く
  const runScan = (get) => {
    for (let a = 0; a < size; a++) {
      let run = 1;
      for (let b = 1; b < size; b++) {
        if (get(a, b) === get(a, b - 1)) {
          run++;
        } else {
          if (run >= 5) score += 3 + (run - 5);
          run = 1;
        }
      }
      if (run >= 5) score += 3 + (run - 5);
    }
  };
  runScan((r, c) => matrix[r][c]);
  runScan((c, r) => matrix[r][c]);

  // 規則2: 2×2の同色ブロック
  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const v = matrix[r][c];
      if (v === matrix[r][c + 1] && v === matrix[r + 1][c] && v === matrix[r + 1][c + 1]) score += 3;
    }
  }

  // 規則3: 1:1:3:1:1 の紛らわしいパターン
  const P1 = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
  const P2 = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
  const matchAt = (get, a, b, pat) => {
    for (let i = 0; i < 11; i++) if (get(a, b + i) !== pat[i]) return false;
    return true;
  };
  for (let a = 0; a < size; a++) {
    for (let b = 0; b + 11 <= size; b++) {
      if (matchAt((x, y) => matrix[x][y], a, b, P1)) score += 40;
      if (matchAt((x, y) => matrix[x][y], a, b, P2)) score += 40;
      if (matchAt((x, y) => matrix[y][x], a, b, P1)) score += 40;
      if (matchAt((x, y) => matrix[y][x], a, b, P2)) score += 40;
    }
  }

  // 規則4: 全体の暗モジュール比率
  let dark = 0;
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) dark += matrix[r][c];
  const percent = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(percent - 50) / 5) * 10;

  return score;
}

/* ---------------------------------------------- 公開API */

/** 文字列から QR の行列（0/1の2次元配列）を作る */
export function makeQr(text) {
  const bytes = new TextEncoder().encode(text);
  const version = pickVersion(bytes.length);
  const stream = buildBitStream(bytes, version);
  const data = interleave(stream);
  const base = buildMatrix(version, data);

  let best = null;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const m = applyMaskAndFormat(base, mask);
    const s = penalty(m, base.size);
    if (s < bestScore) {
      bestScore = s;
      best = m;
    }
  }
  return { size: base.size, modules: best, version };
}

/** SVG文字列にする（印刷・プロジェクタでもきれいに出るようベクタで描く） */
export function qrSvg(text, pixelSize = 200, quietZone = 4) {
  const { size, modules } = makeQr(text);
  const total = size + quietZone * 2;
  const parts = [];
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (modules[r][c]) parts.push(`M${c + quietZone} ${r + quietZone}h1v1h-1z`);
    }
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" ` +
    `width="${pixelSize}" height="${pixelSize}" shape-rendering="crispEdges" role="img" aria-label="参加用QRコード">` +
    `<rect width="${total}" height="${total}" fill="#fff"/>` +
    `<path d="${parts.join('')}" fill="#000"/></svg>`
  );
}

/** 要素の中にQRを描く。失敗しても画面は壊さない。 */
export function renderQr(container, text, pixelSize = 200) {
  if (!container) return;
  if (container.dataset.qrText === text) return; // 同じ内容なら描き直さない
  try {
    container.innerHTML = qrSvg(text, pixelSize);
    container.dataset.qrText = text;
  } catch (err) {
    container.textContent = '';
    console.warn('[qr]', err.message);
  }
}
