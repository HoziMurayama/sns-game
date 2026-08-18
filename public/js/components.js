/**
 * 先生画面・生徒画面で共通して使う表示部品。
 * サーバから受け取った状態（snapshot）とルールだけを見て描画します。
 */

import { el, fmt, signClass, fmtQty, medal, dot, money, moneySigned, moneyValue, moneyUnit } from './ui.js';
// engine.js はブラウザでも Node でも同じファイルを指します
// （ブラウザ: /js/engine.js ／ Node: public/js/engine.js）。
// これでサーバとまったく同じ定義を画面側でも使え、テストからも読み込めます。
import { findOption } from './engine.js';

/* ------------------------------------------------ イベント */

export function eventCard(event, { showLearn = false, compact = false } = {}) {
  if (!event) return null;
  const quiet = !event.headline || event.id === 'quiet';
  return el('div', { class: `event-card${quiet ? ' quiet' : ''}` }, [
    el('div', { class: 'ev-icon' }, [event.icon || '📰']),
    el('div', { class: 'grow' }, [
      el('div', { class: 'ev-name' }, [`市場ニュース ・ ${event.name || ''}`]),
      el('div', { class: 'ev-headline' }, [event.headline || '']),
      compact ? null : el('p', { class: 'ev-body' }, [event.body || '']),
      showLearn && event.learn
        ? el('div', { class: 'learn-note' }, [
            el('span', { class: 'learn-label' }, ['まめ知識']),
            event.learn,
          ])
        : null,
    ]),
  ]);
}

/* ------------------------------------------------ 参加者 */

export function playerList(state, { myId = null, showSubmitted = true, onRemove = null } = {}) {
  const inDecision = state.phase === 'decision';
  return el(
    'div',
    { class: 'players' },
    state.players.map((p) => {
      const done = showSubmitted && inDecision && p.submitted;
      const cls = ['player', done ? 'done' : '', p.connected ? '' : 'off'].filter(Boolean).join(' ');
      return el('div', { class: cls }, [
        dot(p.color),
        el('div', { class: 'who' }, [
          el('div', { class: 'nm' }, [p.name, p.id === myId ? ' (あなた)' : '', p.isBot ? ' 🤖' : '']),
          el('div', { class: 'co' }, [p.company]),
        ]),
        el('span', { class: 'state' }, [
          !p.connected ? '切断中' : inDecision ? (p.submitted ? '決定ずみ' : '考え中') : '参加中',
        ]),
        onRemove
          ? el('button', { class: 'btn btn-ghost small', title: '退出させる', onclick: () => onRemove(p) }, ['✕'])
          : null,
      ]);
    })
  );
}

/* ------------------------------------------------ 決定内容の要約 */

/** 選んだ内容を小さなバッジで表す */
export function decisionBadges(rules, decision) {
  if (!decision) return el('span', { class: 'muted small' }, ['—']);
  const parts = [];
  for (const group of rules.decisions) {
    if (group.enabled === false) continue;
    const opt = findOption(group, decision[group.key]);
    if (!opt) continue;
    if (group.kind === 'material') {
      parts.push(
        el('span', { class: `tier tier-${opt.tier}`, title: `${group.label}: ${opt.name}` }, [
          `${group.icon || ''}${opt.short || opt.name}`,
        ])
      );
    } else {
      parts.push(el('span', { class: 'small muted nowrap' }, [`${group.icon || ''}${opt.short || opt.name}`]));
    }
  }
  return el('span', { class: 'row row-tight', style: { gap: '5px' } }, parts);
}

/* ------------------------------------------------ ラウンド結果の表 */

export function roundResultTable(state, rules, roundEntry, { myId = null } = {}) {
  if (!roundEntry) return null;
  const byId = new Map(state.players.map((p) => [p.id, p]));
  const rows = roundEntry.results
    .map((r) => ({ r, p: byId.get(r.playerId) }))
    .filter((x) => x.p)
    .sort((a, b) => b.r.profit - a.r.profit);

  return el('div', { class: 'table-scroll' }, [
    el('table', { class: 'tbl' }, [
      el('thead', {}, [
        el('tr', {}, [
          el('th', {}, ['会社']),
          el('th', { style: { textAlign: 'left' } }, ['選んだこと']),
          el('th', {}, ['販売数']),
          // 金額の単位は見出しにまとめて出す（1マスずつ付けると表が読みにくくなるため）
          el('th', {}, [`売上（${moneyUnit(rules)}）`]),
          el('th', {}, [`原料費（${moneyUnit(rules)}）`]),
          el('th', {}, [`広告（${moneyUnit(rules)}）`]),
          el('th', {}, [`還元（${moneyUnit(rules)}）`]),
          el('th', {}, [`利益（${moneyUnit(rules)}）`]),
          el('th', {}, [`資金（${moneyUnit(rules)}）`]),
          el('th', {}, ['貢献']),
        ]),
      ]),
      el(
        'tbody',
        {},
        rows.map(({ r, p }) =>
          el('tr', { class: p.id === myId ? 'me' : '' }, [
            el('td', {}, [
              el('span', { class: 'row row-tight', style: { gap: '6px' } }, [dot(p.color), p.company]),
            ]),
            el('td', { style: { textAlign: 'left' } }, [decisionBadges(rules, r.decision)]),
            el('td', {}, [Number(r.quantity).toFixed(rules.game.quantity?.decimals ?? 1)]),
            el('td', {}, [moneyValue(r.revenue, rules)]),
            el('td', {}, [`-${moneyValue(r.materialCost, rules)}`]),
            el('td', {}, [r.adCost ? `-${moneyValue(r.adCost, rules)}` : '—']),
            el('td', {}, [r.giveCost ? `-${moneyValue(r.giveCost, rules)}` : '—']),
            el('td', { class: signClass(r.profit) }, [
              (r.profit > 0 ? '+' : '') + moneyValue(r.profit, rules),
            ]),
            el('td', {}, [moneyValue(p.funds, rules)]),
            el('td', {}, [`👤${r.producerGain} 🌱${r.societyGain}`]),
          ])
        )
      ),
    ]),
  ]);
}

/* ------------------------------------------------ 自分の結果の内訳 */

export function myResultBreakdown(rules, result, player) {
  if (!result) return null;
  const q = rules.game.quantity || {};
  const f = result.factors || {};
  const factorChips = [
    ['価格', f.price],
    ['広告', f.ad],
    ['原料の評判', f.ethical],
    ['イベント', f.event],
    ['運', f.luck],
  ]
    .filter(([, v]) => v !== undefined && Math.abs(v - 1) > 0.001)
    .map(([k, v]) =>
      el('span', { class: 'step' }, [`${k} ×${Number(v).toFixed(2)}`])
    );

  return el('div', { class: 'stack' }, [
    el('div', { class: 'stats' }, [
      stat('販売数', fmtQty(result.quantity, rules)),
      stat(
        '売上',
        money(result.revenue, rules),
        `${money(result.unitPrice, rules)} × ${Number(result.quantity).toFixed(q.decimals ?? 1)}`
      ),
      stat('原料費', `-${money(result.materialCost, rules)}`, `1${q.unitLabel || ''}あたり ${money(result.unitCost, rules)}`),
      stat('広告費', result.adCost ? `-${money(result.adCost, rules)}` : '0'),
      stat('還元', result.giveCost ? `-${money(result.giveCost, rules)}` : '0'),
      stat('今年の利益', moneySigned(result.profit, rules), null, signClass(result.profit)),
    ]),
    factorChips.length
      ? el('div', {}, [
          el('div', { class: 'hint', style: { marginBottom: '6px' } }, ['販売数に効いたもの']),
          el('div', { class: 'steps' }, factorChips),
        ])
      : null,
    el('div', { class: 'stats' }, [
      stat('会社の資金', money(player?.funds ?? 0, rules)),
      stat('生産者への貢献', `${fmt(player?.producer ?? 0)} 点`, `今年 +${result.producerGain}`),
      stat('社会・環境への貢献', `${fmt(player?.society ?? 0)} 点`, `今年 +${result.societyGain}`),
    ]),
  ]);
}

export function stat(k, v, d = null, cls = '') {
  return el('div', { class: 'stat' }, [
    el('div', { class: 'k' }, [k]),
    el('div', { class: `v ${cls}` }, [v]),
    d ? el('div', { class: 'd muted' }, [d]) : null,
  ]);
}

/* ------------------------------------------------ ランキング */

/**
 * @param {Array} rows computeStandings() の結果配列
 * @param {{ unit?: string, myId?: string, sub?: (row)=>string, bar?: boolean }} opts
 */
export function rankingList(rows, opts = {}) {
  const { unit = '', myId = null, sub = null, bar = false, rules = null } = opts;
  // rules を渡すと、値を金額として（円→万円などの設定に従って）整形します
  const fmtValue = (v) => (rules ? moneyValue(v, rules) : fmt(Math.round(v * 10) / 10));
  return el(
    'div',
    { class: 'rank-list' },
    rows.map((row, i) =>
      el(
        'div',
        {
          class: `rank-row r${row.rank}${row.id === myId ? ' me' : ''}`,
          style: { animationDelay: `${Math.min(i, 8) * 70}ms` },
        },
        [
          el('div', { class: 'place' }, [medal(row.rank) || `${row.rank}`]),
          el('div', { class: 'who' }, [
            el('div', { class: 'co' }, [row.company, row.id === myId ? ' ★' : '']),
            el('div', { class: 'nm' }, [row.name, sub ? ` ・ ${sub(row)}` : '']),
          ]),
          bar ? scoreBar(row) : null,
          el('div', { class: 'val' }, [fmtValue(row.value), unit ? el('small', {}, [unit]) : null]),
        ]
      )
    )
  );
}

export function scoreBar(row) {
  const p = row.parts || {};
  const total = Math.max(1, (p.profit || 0) + (p.producer || 0) + (p.society || 0));
  const w = (v) => `${((v || 0) / total) * 100}%`;
  return el('div', { class: 'score-bar', title: `利益 ${p.profit} / 生産者 ${p.producer} / 社会 ${p.society}` }, [
    el('span', { class: 'sb-profit', style: { width: w(p.profit) } }),
    el('span', { class: 'sb-producer', style: { width: w(p.producer) } }),
    el('span', { class: 'sb-society', style: { width: w(p.society) } }),
  ]);
}

export function scoreLegend(rules) {
  const l = rules.scoring.labels || {};
  const w = rules.scoring.weights;
  return el('div', { class: 'legend' }, [
    el('span', {}, [el('i', { class: 'sb-profit', style: { background: 'var(--accent)' } }), `${l.profit || '利益'} ${Math.round(w.profit * 100)}%`]),
    el('span', {}, [el('i', { style: { background: 'var(--fairtrade)' } }), `${l.producer || '生産者'} ${Math.round(w.producer * 100)}%`]),
    el('span', {}, [el('i', { style: { background: 'var(--info)' } }), `${l.society || '社会・環境'} ${Math.round(w.society * 100)}%`]),
  ]);
}

/* ------------------------------------------------ 進行ステップ */

export function roundSteps(state) {
  const items = [];
  for (let i = 1; i <= state.totalRounds; i++) {
    const cls = i < state.round ? 'done' : i === state.round ? 'on' : '';
    items.push(el('span', { class: `step ${cls}` }, [`${i}${state.round === i ? '年目' : ''}`]));
  }
  if (state.phase === 'final') items.push(el('span', { class: 'step on' }, ['結果発表']));
  return el('div', { class: 'steps' }, items);
}

/* ------------------------------------------------ 決定の下書き用サマリ */

/**
 * 1個あたりの利益（マージン）を表示する。
 * 販売数は見せない = 答えは教えないが、原価と利幅の計算は体験させる。
 */
export function marginSummary(rules, decision, event) {
  let unitCost = 0;
  let unitPrice = 0;
  let fixed = 0;
  const notes = [];

  for (const group of rules.decisions) {
    const opt = findOption(group, decision?.[group.key]);
    if (!opt) continue;
    if (group.kind === 'material') {
      let c = opt.unitCost || 0;
      let changed = false;
      for (const eff of event?.effects || []) {
        if (eff.type !== 'materialCost') continue;
        if (eff.slot && eff.slot !== (group.slot || group.key)) continue;
        if (eff.tier && eff.tier !== opt.tier) continue;
        c *= eff.mul;
        changed = true;
      }
      if (changed) notes.push(`${group.label}はイベントの影響を受けています`);
      unitCost += c;
    } else if (group.kind === 'price') {
      unitPrice = opt.unitPrice || 0;
    } else if (group.kind === 'cost') {
      fixed += opt.cost || 0;
    }
  }
  const margin = unitPrice - unitCost;
  const unit = rules.game.quantity?.unitLabel || '';

  return el('div', { class: 'panel panel-soft' }, [
    el('div', { class: 'stats' }, [
      stat(`販売価格 / 1${unit}`, money(unitPrice, rules)),
      stat(`原料費 / 1${unit}`, `-${money(Math.round(unitCost), rules)}`),
      stat(`1${unit}の利益`, moneySigned(Math.round(margin), rules), null, signClass(margin)),
      stat('広告＋還元', fixed ? `-${money(fixed, rules)}` : '0'),
    ]),
    margin <= 0
      ? el('p', { class: 'small', style: { color: 'var(--bad)', margin: '10px 0 0' } }, [
          '⚠ このままだと、売れば売るほど赤字になります。価格か原料を見直しましょう。',
        ])
      : el('p', { class: 'small muted', style: { margin: '10px 0 0' } }, [
          `販売数は「価格・広告・原料の評判・市場イベント・運」で決まります。${
            notes.length ? notes.join('。') + '。' : ''
          }`,
        ]),
  ]);
}
