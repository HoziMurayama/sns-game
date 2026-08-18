/**
 * 生徒用画面。
 *
 * この画面は「サーバから配られた状態を描く」だけで、計算は一切しません。
 * （クライアントで計算すると、端末ごとに結果がズレたり、書き換えられたりするため）
 */

import { Net } from './net.js';
import {
  $, el, mount, clear, fmt, fmtSigned, signClass, toast, showScreen, countdownText, dot,
  money, moneySigned, moneyValue,
} from './ui.js';
import {
  eventCard,
  playerList,
  roundResultTable,
  myResultBreakdown,
  rankingList,
  scoreLegend,
  roundSteps,
  marginSummary,
  stat,
} from './components.js';
import { activeDecisions, findOption } from '../../shared/engine.js';
import { applyBackgroundArt, JOIN_ART_CANDIDATES } from './art.js';
import { injectSprite } from './icons.js';

injectSprite();

const net = new Net('player');

// 参加画面の背景（join-bg.* があればそれ、無ければ hero.*）。どちらも無ければ配色のみ。
export const artReady = applyBackgroundArt(JOIN_ART_CANDIDATES);

let rules = null;
let state = null;
let myId = null;

/** 決定画面はラウンドごとに1度だけ組み立て、以後は差分更新する（操作中のちらつき防止） */
let builtRound = -1;
const optButtons = new Map(); // "group:optId" -> button
let localDraft = {};
let countdownTimer = null;

// テストから接続を止められるように公開しておく（ブラウザ側の動作には影響しません）
export { net };

/* ================================================================== 参加 */

const params = new URLSearchParams(location.search);

/**
 * 全角の数字を半角に直す。
 * 日本語入力がオンのまま「１２３４５６」と打つ生徒が必ず出るので、
 * エラーにせず、そのまま受け入れて直します。
 */
export const toHalfWidthDigits = (s) =>
  String(s ?? '').replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));

/** 入力された文字列からルーム番号を取り出す（貼り付け対策も兼ねる） */
export const normalizeRoomCode = (s) => toHalfWidthDigits(s).replace(/\D/g, '').slice(0, 6);

$('#codeInput').addEventListener('input', (e) => {
  const cleaned = normalizeRoomCode(e.target.value);
  if (cleaned !== e.target.value) e.target.value = cleaned;
  clearJoinError();
  // 6けた入ったら名前へ進む（タブレットでの操作を減らす）
  if (cleaned.length === 6) $('#nameInput')?.focus?.();
});

/** 入力の不備は、画面から消えるトーストではなくフォームの中に出す */
function showJoinError(message) {
  const box = $('#joinError');
  if (!box) return toast(message, 'err');
  box.textContent = message;
  box.hidden = false;
}

function clearJoinError() {
  const box = $('#joinError');
  if (box) box.hidden = true;
}

// ルーム番号側は上の入力処理の中で消しているので、ここは名前欄だけ
$('#nameInput')?.addEventListener('input', clearJoinError);

$('#joinForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const code = $('#codeInput').value.trim();
  const name = $('#nameInput').value.trim();

  if (code.length < 4) {
    showJoinError('ルーム番号を入力してください（数字6けた）。');
    $('#codeInput').focus?.();
    return;
  }
  if (!name) {
    showJoinError('あなたの名前を入力してください。');
    $('#nameInput').focus?.();
    return;
  }
  clearJoinError();
  $('#joinBtn').disabled = true;
  setTimeout(() => ($('#joinBtn').disabled = false), 1500);
  net.send({ t: 'joinRoom', code, name });
});

net.on('ready', () => {
  showScreen('join');

  // QRコードや先生が配ったURLに ?code= が付いていれば、入れておく
  const fromUrl = normalizeRoomCode(params.get('code') || '');
  if (fromUrl && !$('#codeInput').value) $('#codeInput').value = fromUrl;

  // すぐ打ち始められるようにする（番号が入っていれば名前欄へ）
  const focusTarget = $('#codeInput').value.length === 6 ? $('#nameInput') : $('#codeInput');
  focusTarget?.focus?.();

  const backup = net.loadBackupSession();
  if (backup?.code && backup?.token) {
    $('#resumeBox').hidden = false;
    $('#resumeBtn').onclick = () => net.send({ t: 'resume', code: backup.code, token: backup.token });
  }
});

/* ================================================================== 受信 */

net.on('welcome', (m) => {
  rules = m.rules;
  myId = m.playerId;
  applyState(m.state);
});

net.on('state', (m) => applyState(m.state));

net.on('error', (m) => {
  // 参加前のエラー（番号ちがい・定員オーバーなど）は、
  // 消えてしまうトーストではなくフォームの中に残す
  if (document.body.classList.contains('screen-join')) {
    showJoinError(m.message);
    $('#joinBtn').disabled = false;
    return;
  }
  toast(m.message, 'err');
});

net.on('kicked', (m) => {
  toast(m.message || '退出しました。', 'warn', 6000);
  location.reload();
});
net.on('roomClosed', () => {
  toast('ゲームが終了しました。ご参加ありがとうございました！', '', 8000);
  setTimeout(() => location.reload(), 2500);
});
net.on('replaced', (m) => toast(m.message, 'warn', 6000));

net.on('status', ({ connected }) => {
  const badge = $('#conn');
  badge.classList.toggle('off', !connected);
  badge.textContent = connected ? 'オンライン' : '再接続中…';
});
net.on('reconnecting', () => {
  $('#conn').classList.add('off');
  $('#conn').textContent = '再接続中…';
});

net.connect();

/* ================================================================== 描画 */

function applyState(next) {
  const prev = state;
  state = next;
  if (state.you) localDraft = { ...state.you.draft };

  // ヘッダ
  const me = state.you;
  toggleChip('#chipCompany', me ? `${me.icon || ''} ${me.company}` : null);
  toggleChip('#chipRoom', `ルーム ${state.code}`);
  toggleChip('#chipRound', state.phase === 'lobby' ? null : `${state.round}/${state.totalRounds} ${rules.game.roundUnit || ''}`);

  if (prev && prev.round !== state.round) builtRound = -1;

  switch (state.phase) {
    case 'lobby':
      builtRound = -1;
      renderLobby();
      showScreen('lobby');
      break;
    case 'decision':
      renderDecision();
      showScreen('decision');
      break;
    case 'result':
      renderResult();
      showScreen('result');
      break;
    case 'final':
      renderFinal();
      showScreen('final');
      break;
  }
}

function toggleChip(sel, text) {
  const node = $(sel);
  node.hidden = !text;
  if (text) node.textContent = text;
}

/* ---------------------------------------------------------- 待機画面 */

function icon(id, cls = 'ic') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', cls);
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#${id}`);
  svg.appendChild(use);
  return svg;
}

function renderLobby() {
  const me = state.you;

  // ルーム番号と、そのすぐ下の参加人数
  $('#lobbyCode').textContent = state.code;
  $('#lobbyCount').textContent = `${state.playerCount} / ${state.maxPlayers}`;
  $('#lobbyMembers').textContent = `${state.playerCount}人 / 最大${state.maxPlayers}人`;

  // 自分の会社
  if (me) {
    mount($('#myCard'), [
      el('div', { class: 'my-company' }, [
        el('span', { class: 'mc-badge', style: { background: me.color || '#8a5a2b' } }, [icon('i-pod')]),
        el('div', {}, [
          el('div', { class: 'mc-name' }, [me.company]),
          el('div', { class: 'mc-sub' }, [`${me.name} さん ／ 資金 ${money(me.score.funds, rules)} からスタート`]),
        ]),
      ]),
    ]);
  }

  mount($('#lobbyPlayers'), [playerList(state, { myId })]);

  mount(
    $('#howto'),
    (rules.help?.flow || []).map((line) => el('li', {}, [line]))
  );

  renderRoomSettings();
  renderRoster();
}

/** 右上: ルーム設定 */
function renderRoomSettings() {
  const w = rules.scoring.weights;
  const rows = [
    ['ラウンド数', `${rules.game.rounds}ラウンド`, false],
    ['制限時間', state.timerSec > 0 ? `${state.timerSec}秒` : '先生が締め切る', false],
    ['はじめの資金', money(rules.game.startingFunds, rules), false],
    [
      '総合得点のわりあい',
      `利益 ${Math.round(w.profit * 100)}％ ／ 生産者 ${Math.round(w.producer * 100)}％ ／ 社会・環境 ${Math.round(
        w.society * 100
      )}％`,
      true,
    ],
  ];
  mount(
    $('#roomSettings'),
    rows.flatMap(([k, v, small]) => [
      el('dt', {}, [k]),
      el('dd', { class: small ? 'small-val' : '' }, [v]),
    ])
  );
}

/** 右下: 参加者一覧（空きは「参加待ち…」で埋める） */
function renderRoster() {
  const items = state.players.map((p) =>
    el('li', { class: p.connected ? '' : 'off' }, [
      el('span', { class: 'r-ic', style: { background: p.color || '#9c8b7c' } }, [icon('i-person')]),
      el('span', { class: 'r-nm' }, [
        p.name,
        p.id === myId ? el('span', { class: 'r-you' }, ['（あなた）']) : null,
      ]),
    ])
  );
  for (let i = state.players.length; i < state.maxPlayers; i++) {
    items.push(
      el('li', { class: 'empty' }, [
        el('span', { class: 'r-ic' }, [icon('i-hourglass')]),
        el('span', { class: 'r-nm' }, ['参加待ち…']),
      ])
    );
  }
  mount($('#rosterList'), items);
}

/* ---------------------------------------------------------- 決定画面 */

function renderDecision() {
  mount($('#decEvent'), [eventCard(state.event, { showLearn: true })]);

  if (builtRound !== state.round) {
    buildDecisionGroups();
    builtRound = state.round;
  }
  paintSelections();
  renderDecisionStatus();
  mount($('#decMargin'), [marginSummary(rules, localDraft, findEventDef())]);
  renderDecisionSubmit();
  renderHistoryStrip();
}

function findEventDef() {
  // イベントの効果はルール側にある（サーバから届く rules に含まれる）
  return rules.events.list.find((e) => e.id === state.event?.id) || null;
}

function buildDecisionGroups() {
  optButtons.clear();
  const container = clear($('#decGroups'));
  const groups = activeDecisions(rules);

  groups.forEach((group, gi) => {
    const wrap = el('div', { class: 'decision' }, [
      el('div', { class: 'decision-head' }, [
        el('span', { class: 'icon' }, [group.icon || '']),
        el('span', { class: 'label' }, [`${gi + 1}. ${group.label}`]),
        el('span', { class: 'hint' }, [group.hint || '']),
      ]),
      el(
        'div',
        { class: 'opts' },
        group.options.map((opt) => {
          const btn = el(
            'button',
            {
              class: 'opt',
              type: 'button',
              'aria-pressed': 'false',
              dataset: { tier: opt.tier || '' },
              onclick: () => choose(group.key, opt.id),
            },
            [
              el('div', { class: 'row row-tight', style: { justifyContent: 'space-between' } }, [
                el('span', { class: 'opt-name' }, [opt.name]),
                opt.tier ? el('span', { class: `tier tier-${opt.tier}` }, [opt.short || '']) : null,
              ]),
              el('div', { class: 'opt-cost' }, [priceLabel(group, opt)]),
              el('div', { class: 'opt-meta' }, [opt.desc || '']),
            ]
          );
          optButtons.set(`${group.key}:${opt.id}`, btn);
          return btn;
        })
      ),
    ]);
    container.appendChild(wrap);
  });
}

function priceLabel(group, opt) {
  const unit = rules.game.quantity?.unitLabel || '';
  if (group.kind === 'material') return `仕入 ${money(opt.unitCost, rules)} / 1${unit}`;
  if (group.kind === 'price') return `${money(opt.unitPrice, rules)} / 1${unit}`;
  return opt.cost ? `-${money(opt.cost, rules)}` : money(0, rules);
}

function choose(key, optId) {
  if (state.you?.submitted) {
    // 提出済みでも締め切り前なら選び直せる（サーバ側で提出は取り消される）
    toast('決定を取り消して、選び直します。', '', 1800);
  }
  localDraft = { ...localDraft, [key]: optId };
  paintSelections();
  mount($('#decMargin'), [marginSummary(rules, localDraft, findEventDef())]);
  net.send({ t: 'draft', decision: { [key]: optId } });
}

function paintSelections() {
  for (const [key, btn] of optButtons) {
    const [groupKey, optId] = key.split(':');
    btn.setAttribute('aria-pressed', localDraft[groupKey] === optId ? 'true' : 'false');
  }
}

function renderDecisionStatus() {
  const done = state.submittedCount;
  const total = state.playerCount;
  const pct = total ? Math.round((done / total) * 100) : 0;

  const nodes = [
    el('div', { class: 'panel panel-flat', style: { padding: '14px 18px' } }, [
      el('div', { class: 'row' }, [
        roundSteps(state),
        el('span', { class: 'right small muted' }, [`${done} / ${total} 人が決定ずみ`]),
      ]),
      el('div', { class: 'progress', style: { marginTop: '8px' } }, [el('span', { style: { width: `${pct}%` } })]),
      state.deadline ? el('div', { class: 'right small', id: 'countdown' }, ['']) : null,
    ]),
  ];
  mount($('#decStatus'), nodes);
  startCountdown();
}

function startCountdown() {
  clearInterval(countdownTimer);
  if (!state.deadline) return;
  const tick = () => {
    const node = $('#countdown');
    if (!node) return clearInterval(countdownTimer);
    const left = state.deadline - Date.now();
    node.textContent = `残り ${countdownText(state.deadline)}`;
    node.style.color = left < 15000 ? 'var(--bad)' : '';
  };
  tick();
  countdownTimer = setInterval(tick, 500);
}

function renderDecisionSubmit() {
  const submitted = !!state.you?.submitted;
  const box = clear($('#decSubmit'));

  if (submitted) {
    box.appendChild(
      el('div', { class: 'row' }, [
        el('div', { class: 'grow' }, [
          el('b', { style: { fontSize: '1.1rem', color: 'var(--good)' } }, ['✓ 決定しました']),
          el('div', { class: 'small muted' }, [
            `ほかの人を待っています（${state.submittedCount}/${state.playerCount}）。締め切りまでは選び直せます。`,
          ]),
        ]),
        el('button', { class: 'btn', onclick: () => net.send({ t: 'unsubmit' }) }, ['選び直す']),
      ])
    );
  } else {
    box.appendChild(
      el('div', { class: 'row' }, [
        el('div', { class: 'grow small muted' }, ['えらび終わったら、こちらを押してください。']),
        el(
          'button',
          {
            class: 'btn btn-primary btn-lg',
            onclick: () => net.send({ t: 'submit', decision: localDraft }),
          },
          ['この内容で決定する']
        ),
      ])
    );
  }
}

function renderHistoryStrip() {
  const box = clear($('#decHistory'));
  const me = state.you;
  if (!me) return;
  box.appendChild(
    el('div', { class: 'stats' }, [
      stat('会社の資金', money(me.score.funds, rules)),
      stat('生産者への貢献', `${fmt(me.score.producer)} 点`),
      stat('社会・環境への貢献', `${fmt(me.score.society)} 点`),
    ])
  );
  if (state.rounds.length) {
    box.appendChild(
      el('div', { class: 'table-scroll', style: { marginTop: '12px' } }, [
        el('table', { class: 'tbl' }, [
          el('thead', {}, [
            el('tr', {}, [el('th', {}, ['年']), el('th', {}, ['販売数']), el('th', {}, ['利益']), el('th', {}, ['資金'])]),
          ]),
          el(
            'tbody',
            {},
            state.rounds.map((r) => {
              const mine = r.results.find((x) => x.playerId === myId);
              return el('tr', {}, [
                el('td', {}, [`${r.round}${rules.game.roundUnit || ''}`]),
                el('td', {}, [mine ? Number(mine.quantity).toFixed(1) : '-']),
                el('td', { class: signClass(mine?.profit) }, [mine ? fmtSigned(mine.profit) : '-']),
                el('td', {}, [mine ? moneyValue(runningFunds(r.round), rules) : '-']),
              ]);
            })
          ),
        ]),
      ])
    );
  }
}

function runningFunds(uptoRound) {
  let funds = rules.game.startingFunds;
  for (const r of state.rounds) {
    if (r.round > uptoRound) break;
    const mine = r.results.find((x) => x.playerId === myId);
    if (mine) funds += mine.profit;
  }
  return funds;
}

/* ---------------------------------------------------------- ラウンド結果 */

function renderResult() {
  const entry = state.rounds[state.rounds.length - 1];
  const mine = entry?.results.find((r) => r.playerId === myId);
  const mePub = state.players.find((p) => p.id === myId);

  mount($('#resHead'), [
    el('div', { class: 'panel panel-flat' }, [
      el('div', { class: 'row' }, [
        el('h1', { style: { margin: 0 } }, [`${entry?.round}${rules.game.roundUnit || ''} の結果`]),
        el('span', { class: 'right' }, [roundSteps(state)]),
      ]),
    ]),
    eventCard(state.event, { compact: true }),
  ]);

  $('#resTitle').textContent = mine?.auto
    ? 'あなたの会社の1年（時間切れのため、そのときの選択で計算されました）'
    : 'あなたの会社の1年';
  mount($('#resMine'), [myResultBreakdown(rules, mine, mePub)]);
  mount($('#resAll'), [roundResultTable(state, rules, entry, { myId })]);

  const ev = findEventDef();
  mount($('#resLearn'), [
    ev?.learn
      ? el('div', { class: 'panel' }, [
          el('div', { class: 'learn-note', style: { marginTop: 0 } }, [
            el('span', { class: 'learn-label' }, ['まめ知識']),
            ev.learn,
          ]),
        ])
      : null,
  ]);
}

/* ---------------------------------------------------------- 最終結果 */

function renderFinal() {
  const body = clear($('#finalBody'));
  const s = state.standings;
  if (!s) return;

  const stageTitle = {
    profit: '① 利益ランキング',
    total: '② サステナビリティ総合ランキング',
    reflect: '③ ふりかえり',
  }[state.finalStage];

  body.appendChild(
    el('div', { class: 'panel center' }, [
      el('h1', { style: { margin: 0 } }, ['🏁 5年間、おつかれさまでした']),
      el('p', { class: 'hint', style: { margin: '4px 0 0' } }, [stageTitle]),
    ])
  );

  if (state.finalStage === 'profit') {
    body.appendChild(
      el('div', { class: 'panel' }, [
        el('div', { class: 'section-title' }, [
          el('h2', {}, ['利益ランキング']),
          el('span', { class: 'sub' }, ['5年後に残った資金の多い順']),
        ]),
        rankingList(s.profit, { unit: rules.game.currencyLabel, myId, rules }),
        el('p', { class: 'hint center', style: { marginTop: '14px' } }, [
          'でも、会社の成績は「もうけ」だけでしょうか？',
        ]),
      ])
    );
  }

  if (state.finalStage === 'total' || state.finalStage === 'reflect') {
    body.appendChild(
      el('div', { class: 'panel' }, [
        el('div', { class: 'section-title' }, [
          el('h2', {}, ['🏆 総合ランキング']),
          el('span', { class: 'sub' }, ['利益・生産者・社会環境の合計'])
        ]),
        rankingList(s.total, { unit: '点', myId, bar: true, sub: (r) => `資金 ${money(r.funds, rules)} / 👤${r.producerPoints} / 🌱${r.societyPoints}` }),
        el('div', { style: { marginTop: '12px' } }, [scoreLegend(rules)]),
      ])
    );
    body.appendChild(
      el('div', { class: 'grid grid-2' }, [
        el('div', { class: 'panel' }, [
          el('h3', {}, ['👤 生産者への貢献']),
          rankingList(s.producer.slice(0, 3), { unit: '点', myId }),
        ]),
        el('div', { class: 'panel' }, [
          el('h3', {}, ['🌱 社会・環境への貢献']),
          rankingList(s.society.slice(0, 3), { unit: '点', myId }),
        ]),
      ])
    );
  }

  if (state.finalStage === 'reflect') {
    body.appendChild(
      el('div', { class: 'panel' }, [
        el('div', { class: 'section-title' }, [el('h2', {}, [rules.reflection?.title || 'ふりかえり'])]),
        el(
          'ol',
          { style: { paddingLeft: '1.3em', lineHeight: '1.9' } },
          (rules.reflection?.questions || []).map((q) => el('li', {}, [q]))
        ),
      ])
    );
    const mine = s.total.find((r) => r.id === myId);
    if (mine) {
      body.appendChild(
        el('div', { class: 'panel panel-soft' }, [
          el('h3', {}, ['あなたの会社の5年間']),
          el('div', { class: 'stats' }, [
            stat('総合順位', `${mine.rank}位`),
            stat('最終資金', money(mine.funds, rules)),
            stat('生産者への貢献', `${mine.producerPoints} 点`),
            stat('社会・環境への貢献', `${mine.societyPoints} 点`),
          ]),
        ])
      );
    }
  }
}
