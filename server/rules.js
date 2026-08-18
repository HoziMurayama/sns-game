/**
 * ルールセットの読み込み・継承・検証。
 *
 * config/*.json を読み、"extends" があれば親をマージします。
 * 数値を1つ変えたいだけのときに、ファイル全体をコピーしなくて済むようにするためです。
 *
 * 起動時に検証し、ルールJSONの書き間違いは「起動しない＋理由を表示」で気づけるようにします。
 * （授業の最中に、ゲーム中盤で初めてエラーになる、という事態を避けるため）
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const CONFIG_DIR = path.resolve(HERE, '..', 'config');

const isObject = (v) => v && typeof v === 'object' && !Array.isArray(v);
const identityOf = (v) => (isObject(v) ? (v.id ?? v.key) : undefined);

function mergeArrays(base, over) {
  const keyed =
    base.length > 0 &&
    base.every((x) => identityOf(x) !== undefined) &&
    over.every((x) => identityOf(x) !== undefined);
  if (!keyed) return over; // id を持たない配列（effects など）は丸ごと置き換え
  const out = base.slice();
  for (const item of over) {
    const i = out.findIndex((x) => identityOf(x) === identityOf(item));
    if (i >= 0) out[i] = deepMerge(out[i], item);
    else out.push(item);
  }
  return out;
}

function deepMerge(base, over) {
  if (over === undefined) return base;
  if (Array.isArray(base) && Array.isArray(over)) return mergeArrays(base, over);
  if (isObject(base) && isObject(over)) {
    const out = { ...base };
    for (const [k, v] of Object.entries(over)) out[k] = deepMerge(base[k], v);
    return out;
  }
  return over;
}

function readJson(file) {
  const raw = fs.readFileSync(file, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`ルールファイルのJSONが壊れています: ${path.basename(file)}\n  ${err.message}`);
  }
}

/** ルールセットを1つ読み込む（extends を解決済み・検証済み） */
export function loadRuleset(name, seen = new Set()) {
  const file = name.endsWith('.json')
    ? path.resolve(CONFIG_DIR, name)
    : path.resolve(CONFIG_DIR, `rules.${name}.json`);

  if (!fs.existsSync(file)) {
    throw new Error(`ルールファイルが見つかりません: ${file}`);
  }
  if (seen.has(file)) {
    throw new Error(`ルールの extends が循環しています: ${[...seen, file].join(' -> ')}`);
  }
  seen.add(file);

  const raw = readJson(file);
  const merged = raw.extends ? deepMerge(loadRuleset(raw.extends, seen), raw) : raw;
  delete merged.extends;
  merged.sourceFile = path.basename(file);
  return validateRules(merged);
}

/** config/ にあるルールセットの一覧（先生の作成画面で選ばせる） */
export function listRulesets() {
  return fs
    .readdirSync(CONFIG_DIR)
    .filter((f) => /^rules\..+\.json$/.test(f))
    .map((f) => {
      try {
        const r = loadRuleset(f);
        return { id: r.id, label: r.label, file: f, rounds: r.game.rounds, note: r.note || '' };
      } catch (err) {
        return { id: f, label: `(読み込みエラー) ${f}`, file: f, error: String(err.message) };
      }
    })
    .filter((r) => !r.error || true)
    .sort((a, b) => (a.id === 'mvp' ? -1 : b.id === 'mvp' ? 1 : a.id.localeCompare(b.id)));
}

/** ルールの整合性チェック。問題があれば理由つきで throw する。 */
export function validateRules(r) {
  const errors = [];
  const req = (cond, msg) => {
    if (!cond) errors.push(msg);
  };

  req(r.id, 'id が必要です');
  req(isObject(r.game), 'game が必要です');
  if (isObject(r.game)) {
    req(Number.isInteger(r.game.rounds) && r.game.rounds > 0, 'game.rounds は1以上の整数にしてください');
    req(typeof r.game.startingFunds === 'number', 'game.startingFunds は数値にしてください');
    req(r.game.minPlayers >= 1, 'game.minPlayers は1以上にしてください');
    req(r.game.maxPlayers >= r.game.minPlayers, 'game.maxPlayers は minPlayers 以上にしてください');
  }

  req(isObject(r.demand), 'demand が必要です');
  if (isObject(r.demand)) {
    req(typeof r.demand.base === 'number' && r.demand.base > 0, 'demand.base は正の数にしてください');
    req(
      r.demand.randomness >= 0 && r.demand.randomness < 1,
      'demand.randomness は 0以上1未満にしてください（例: 0.06 で ±6%）'
    );
  }

  req(Array.isArray(r.decisions) && r.decisions.length > 0, 'decisions が必要です');
  const keys = new Set();
  let priceGroups = 0;
  for (const g of r.decisions || []) {
    req(g.key, 'decisions[].key が必要です');
    req(!keys.has(g.key), `decisions[].key が重複しています: ${g.key}`);
    keys.add(g.key);
    req(['material', 'price', 'cost'].includes(g.kind), `decisions[${g.key}].kind は material/price/cost のいずれか`);
    req(Array.isArray(g.options) && g.options.length > 0, `decisions[${g.key}].options が空です`);
    if (g.kind === 'price') priceGroups++;
    const ids = new Set();
    for (const o of g.options || []) {
      req(o.id, `decisions[${g.key}] の選択肢に id が必要です`);
      req(!ids.has(o.id), `decisions[${g.key}] の選択肢 id が重複: ${o.id}`);
      ids.add(o.id);
      if (g.kind === 'material') {
        req(typeof o.unitCost === 'number', `decisions[${g.key}].${o.id}.unitCost が必要です`);
        req(!!o.tier, `decisions[${g.key}].${o.id}.tier が必要です`);
      }
      if (g.kind === 'price') {
        req(typeof o.unitPrice === 'number', `decisions[${g.key}].${o.id}.unitPrice が必要です`);
      }
      if (g.kind === 'cost') {
        req(typeof o.cost === 'number', `decisions[${g.key}].${o.id}.cost が必要です`);
      }
    }
    const defaults = (g.options || []).filter((o) => o.default);
    req(defaults.length <= 1, `decisions[${g.key}] の default が複数あります`);
  }
  req(priceGroups === 1, 'kind:"price" の決定項目はちょうど1つにしてください');

  req(isObject(r.events) && Array.isArray(r.events.list) && r.events.list.length > 0, 'events.list が必要です');
  for (const e of r.events?.list || []) {
    req(e.id, 'events.list[].id が必要です');
    for (const eff of e.effects || []) {
      req(['materialCost', 'demand'].includes(eff.type), `イベント ${e.id}: effects[].type は materialCost/demand`);
      req(typeof eff.mul === 'number' && eff.mul >= 0, `イベント ${e.id}: effects[].mul は0以上の数値`);
    }
  }

  req(isObject(r.scoring?.weights), 'scoring.weights が必要です');
  if (isObject(r.scoring?.weights)) {
    const w = r.scoring.weights;
    const sum = (w.profit || 0) + (w.producer || 0) + (w.society || 0);
    req(Math.abs(sum - 1) < 1e-6, `scoring.weights の合計が1になっていません（現在 ${sum}）`);
  }

  if (errors.length) {
    throw new Error(
      `ルール「${r.sourceFile || r.id}」に問題があります:\n` + errors.map((e) => `  - ${e}`).join('\n')
    );
  }
  return r;
}
