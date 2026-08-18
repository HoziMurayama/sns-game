/**
 * QRコード生成の検証。
 * 規格で決まっている値（形式情報・型番情報・固定パターン）と照合します。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { makeQr, qrSvg, formatInfoBits, versionInfoBits } from '../public/js/qr.js';

/* 規格 (ISO/IEC 18004) の付表にある、誤り訂正レベルM の形式情報 */
const FORMAT_M = [
  '101010000010010',
  '101000100100101',
  '101111001111100',
  '101101101001011',
  '100010111111001',
  '100000011001110',
  '100111110010111',
  '100101010100000',
];

test('形式情報のビット列が規格どおり（BCH符号の検証）', () => {
  for (let mask = 0; mask < 8; mask++) {
    const bits = formatInfoBits(mask).toString(2).padStart(15, '0');
    assert.equal(bits, FORMAT_M[mask], `mask ${mask}`);
  }
});

test('型番情報のビット列が規格どおり', () => {
  const expected = {
    7: '000111110010010100',
    8: '001000010110111100',
    9: '001001101010011001',
    10: '001010010011010011',
  };
  for (const [v, bits] of Object.entries(expected)) {
    assert.equal(versionInfoBits(Number(v)).toString(2).padStart(18, '0'), bits, `version ${v}`);
  }
});

test('サイズが型番から決まる（4×型番+17）', () => {
  const short = makeQr('http://192.168.0.2:3000/j/123456');
  assert.equal(short.size, short.version * 4 + 17);
  assert.ok(short.version >= 1 && short.version <= 10);
});

test('位置検出パターンが3隅にある', () => {
  const { size, modules } = makeQr('http://localhost:3000/j/482913');
  const checkFinder = (r0, c0) => {
    for (let r = 0; r < 7; r++) {
      for (let c = 0; c < 7; c++) {
        const expect =
          (r === 0 || r === 6 || c === 0 || c === 6) || (r >= 2 && r <= 4 && c >= 2 && c <= 4) ? 1 : 0;
        assert.equal(modules[r0 + r][c0 + c], expect, `finder(${r0},${c0}) の (${r},${c})`);
      }
    }
  };
  checkFinder(0, 0);
  checkFinder(0, size - 7);
  checkFinder(size - 7, 0);
});

test('タイミングパターンが交互になっている', () => {
  const { size, modules } = makeQr('http://localhost:3000/j/482913');
  for (let i = 8; i < size - 8; i++) {
    assert.equal(modules[6][i], i % 2 === 0 ? 1 : 0, `行のタイミング ${i}`);
    assert.equal(modules[i][6], i % 2 === 0 ? 1 : 0, `列のタイミング ${i}`);
  }
});

test('常に暗となるモジュールが立っている', () => {
  const { size, modules } = makeQr('abc');
  assert.equal(modules[size - 8][8], 1);
});

test('同じ文字列からは必ず同じQRができる', () => {
  const a = makeQr('http://example.test/j/111111');
  const b = makeQr('http://example.test/j/111111');
  assert.deepEqual(
    a.modules.map((r) => [...r]),
    b.modules.map((r) => [...r])
  );
});

test('文字列が違えば別のQRになる', () => {
  const a = makeQr('http://example.test/j/111111');
  const b = makeQr('http://example.test/j/222222');
  const same = a.size === b.size && a.modules.every((row, r) => row.every((v, c) => v === b.modules[r][c]));
  assert.equal(same, false);
});

test('長さに応じて型番が上がる', () => {
  const v1 = makeQr('short').version;
  const v2 = makeQr('x'.repeat(100)).version;
  const v3 = makeQr('x'.repeat(210)).version;
  assert.ok(v1 < v2 && v2 <= v3, `${v1} < ${v2} <= ${v3}`);
});

test('長すぎる文字列は明示的にエラーになる', () => {
  assert.throws(() => makeQr('x'.repeat(300)), /長すぎ/);
});

test('SVGとして出力できる', () => {
  const svg = qrSvg('http://192.168.1.10:3000/j/123456', 240);
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.match(svg, /width="240" height="240"/);
  assert.match(svg, /<path d="M/);
  assert.ok(svg.includes('shape-rendering="crispEdges"'));
});

test('日本語（マルチバイト）も符号化できる', () => {
  const qr = makeQr('フェアトレード');
  assert.ok(qr.size > 0);
});
