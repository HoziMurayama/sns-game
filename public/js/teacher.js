/**
 * 先生用コンソール。
 *
 * 設計方針: 授業中に先生がやることを「押すだけ」にする。
 *   ルーム作成 → 番号を見せる → 開始 → 次へ → 次へ …
 * 迷いやすい操作（締め切り・AI追加・やり直し）は、必要な場面でのみ出します。
 */

import { Net } from './net.js';
import { $, el, mount, clear, toast, showScreen, countdownText, money } from './ui.js';
import {
  eventCard,
  playerList,
  roundResultTable,
  rankingList,
  scoreLegend,
  roundSteps,
} from './components.js';
import { renderQr } from './qr.js';
import { applySetupArt } from './art.js';
import { injectSprite } from './icons.js';

injectSprite();

// ルーム作成画面の背景（public/img/room-make-bg.* があれば）
export const artReady = applySetupArt();

const net = new Net('teacher');

// テストから接続を止められるように公開しておく（ブラウザ側の動作には影響しません）
export { net };

let rules = null;
let state = null;
let rulesetList = [];
let countdownTimer = null;

/* ================================================================== 起動 */

if (localStorage.getItem('ftc.projector') === '1') document.body.classList.add('projector');
$('#projBtn').onclick = () => {
  const on = document.body.classList.toggle('projector');
  localStorage.setItem('ftc.projector', on ? '1' : '0');
};

fetch('/api/rulesets')
  .then((r) => r.json())
  .then((data) => {
    rulesetList = data.rulesets || [];
    const sel = $('#rulesetSel');
    mount(
      sel,
      rulesetList.map((r) => el('option', { value: r.file }, [`${r.label}（${r.rounds}ラウンド）`]))
    );
    const showNote = () => {
      const r = rulesetList.find((x) => x.file === sel.value);
      $('#rulesetNote').textContent = r?.note || '';
    };
    sel.onchange = showNote;
    showNote();
  })
  .catch(() => toast('ルール一覧を取得できませんでした。', 'err'));

$('#createBtn').onclick = () => {
  $('#createBtn').disabled = true;
  setTimeout(() => ($('#createBtn').disabled = false), 1500);
  net.send({
    t: 'createRoom',
    ruleset: $('#rulesetSel').value || 'mvp',
    options: {
      maxPlayers: Number($('#maxPlayers').value),
      timerSec: Number($('#timerSec').value),
      demandMode: $('#demandMode').value,
    },
  });
};

net.on('ready', () => {
  showScreen('setup');
  const backup = net.loadBackupSession();
  if (backup?.code && backup?.token) {
    $('#teacherResumeBox').hidden = false;
    $('#teacherResumeBtn').onclick = () => net.send({ t: 'resume', code: backup.code, token: backup.token });
  }
});

net.on('welcome', (m) => {
  rules = m.rules;
  applyState(m.state);
});
net.on('state', (m) => applyState(m.state));
net.on('error', (m) => toast(m.message, 'err'));
net.on('roomClosed', () => {
  toast('ルームを終了しました。', '', 4000);
  setTimeout(() => location.reload(), 1200);
});
net.on('replaced', (m) => toast(m.message, 'warn', 8000));
net.on('status', ({ connected }) => {
  $('#conn').classList.toggle('off', !connected);
  $('#conn').textContent = connected ? 'オンライン' : '再接続中…';
});

net.connect();

/* ================================================================== 操作 */

$('#addBotBtn').onclick = () => net.send({ t: 'addBot' });
$('#startBtn').onclick = () => net.send({ t: 'start' });
$('#forceBtn').onclick = () => net.send({ t: 'forceResolve' });
$('#nextBtn').onclick = () => net.send({ t: 'next' });
$('#nextBtn2').onclick = () => net.send({ t: 'next' });
$('#backBtn').onclick = () => net.send({ t: 'back' });
$('#restartBtn').onclick = () => {
  if (confirm('点数をリセットして、同じメンバーでもう一度あそびますか？')) net.send({ t: 'restart' });
};
$('#closeRoomBtn').onclick = () => {
  if (confirm('このルームを終了します。よろしいですか？')) net.send({ t: 'closeRoom' });
};
$('#printBtn').onclick = () => window.print();
$('#exportBtn').onclick = () => exportCsv();

/* ================================================================== 描画 */

function applyState(next) {
  state = next;

  $('#chipRoom').hidden = false;
  $('#chipRoom').textContent = `ルーム ${state.code}`;
  $('#chipPlayers').hidden = false;
  $('#chipPlayers').textContent = `${state.playerCount}人`;
  $('#chipRound').hidden = state.phase === 'lobby';
  $('#chipRound').textContent = `${state.round}/${state.totalRounds}`;
  $('#adminBar').hidden = false;
  $('#adminCode').textContent = state.code;
  $('#adminRule').textContent = `${state.ruleLabel} / ${
    state.demandMode === 'share' ? '競争モード' : '通常モード'
  }`;

  switch (state.phase) {
    case 'lobby':
      renderLobby();
      showScreen('lobby');
      break;
    case 'decision':
    case 'result':
      renderRunning();
      showScreen('running');
      break;
    case 'final':
      renderFinal();
      showScreen('final');
      break;
  }
}

/* ---------------------------------------------------------- 待機 */

function renderLobby() {
  $('#roomCode').textContent = state.code;
  const url = `${location.origin}/j/${state.code}`;
  $('#joinUrl').textContent = url;
  renderQr($('#qrBox'), url, 200);

  $('#lobbyCount').textContent = `${state.playerCount} / ${state.maxPlayers}人`;
  mount($('#lobbyPlayers'), [
    state.playerCount
      ? playerList(state, { onRemove: (p) => net.send({ t: 'removePlayer', playerId: p.id }) })
      : el('p', { class: 'hint center' }, ['まだ誰も参加していません。']),
  ]);

  const enough = state.playerCount >= state.minPlayers;
  $('#startBtn').disabled = !enough;
  $('#startHint').textContent = enough
    ? `${state.playerCount}人でスタートします（推奨は4〜6人）`
    : `あと${state.minPlayers - state.playerCount}人で開始できます`;

  mount(
    $('#flowHelp'),
    (rules.help?.flow || []).map((line, i) =>
      el('div', { class: 'panel panel-soft panel-flat' }, [
        el('div', { class: 'small muted' }, [`STEP ${i + 1}`]),
        el('div', {}, [line]),
      ])
    )
  );
}

/* ---------------------------------------------------------- 進行中 */

function renderRunning() {
  const isDecision = state.phase === 'decision';

  mount($('#runHead'), [
    el('div', { class: 'panel panel-flat' }, [
      el('div', { class: 'row' }, [
        el('h1', { style: { margin: 0 } }, [
          `${state.round}${rules.game.roundUnit || ''}`,
          el('span', { class: 'muted', style: { fontSize: '.6em', marginLeft: '10px' } }, [
            isDecision ? '経営を決めています' : '結果発表',
          ]),
        ]),
        el('span', { class: 'right' }, [roundSteps(state)]),
      ]),
    ]),
  ]);

  mount($('#runEvent'), [eventCard(state.event, { showLearn: !isDecision })]);

  const body = clear($('#runBody'));

  if (isDecision) {
    const pct = state.playerCount ? Math.round((state.submittedCount / state.playerCount) * 100) : 0;
    body.appendChild(
      el('div', { class: 'panel' }, [
        el('div', { class: 'section-title' }, [
          el('h2', {}, ['決定の状況']),
          el('span', { class: 'sub' }, [`${state.submittedCount} / ${state.playerCount} 人`]),
        ]),
        el('div', { class: 'progress' }, [el('span', { style: { width: `${pct}%` } })]),
        el('div', { style: { marginTop: '14px' } }, [
          playerList(state, { onRemove: (p) => net.send({ t: 'removePlayer', playerId: p.id }) }),
        ]),
        el('div', { class: 'row no-print', style: { marginTop: '14px' } }, [
          el('button', { class: 'btn small', onclick: () => net.send({ t: 'addBot' }) }, ['🤖 AIを追加']),
          el('span', { class: 'small muted' }, ['途中参加の代わりに、AIで人数を埋められます']),
        ]),
      ])
    );
    if (state.rounds.length) body.appendChild(standingsPanel('途中経過'));
  } else {
    const entry = state.rounds[state.rounds.length - 1];
    body.appendChild(
      el('div', { class: 'panel' }, [
        el('div', { class: 'section-title' }, [
          el('h2', {}, [`${entry.round}${rules.game.roundUnit || ''}の結果`]),
          el('span', { class: 'sub' }, ['利益の大きい順']),
        ]),
        roundResultTable(state, rules, entry),
      ])
    );
    body.appendChild(standingsPanel('ここまでの総合'));
    body.appendChild(discussionPanel());
  }

  // 操作ボタン
  $('#forceBtn').hidden = !isDecision;
  $('#forceBtn').disabled = !isDecision || state.playerCount === 0;
  $('#nextBtn').hidden = isDecision;
  $('#nextBtn').textContent =
    state.round >= state.totalRounds ? '最終結果を発表する ▶' : `${state.round + 1}${rules.game.roundUnit || ''}へ ▶`;

  const statusText = clear($('#runStatusText'));
  if (isDecision) {
    statusText.appendChild(
      el('span', { class: 'small muted' }, [
        state.submittedCount === state.playerCount
          ? '全員が決定しました。まもなく結果が出ます。'
          : `${state.playerCount - state.submittedCount}人がまだ決めていません。待たずに締め切ることもできます。`,
      ])
    );
    if (state.deadline) statusText.appendChild(el('b', { id: 'countdown', style: { marginLeft: '10px' } }, ['']));
  } else {
    statusText.appendChild(el('span', { class: 'small muted' }, ['結果を見せながら、話し合いの時間を取れます。']));
  }
  startCountdown();
}

function startCountdown() {
  clearInterval(countdownTimer);
  if (!state.deadline) return;
  const tick = () => {
    const node = $('#countdown');
    if (!node) return clearInterval(countdownTimer);
    node.textContent = `残り ${countdownText(state.deadline)}`;
  };
  tick();
  countdownTimer = setInterval(tick, 500);
}

function standingsPanel(title) {
  const s = state.standings;
  if (!s) return el('div');
  return el('div', { class: 'grid grid-2' }, [
    el('div', { class: 'panel' }, [
      el('div', { class: 'section-title' }, [el('h2', {}, [`${title}：資金`])]),
      rankingList(s.profit, { unit: rules.game.currencyLabel, rules }),
    ]),
    el('div', { class: 'panel' }, [
      el('div', { class: 'section-title' }, [el('h2', {}, [`${title}：総合`])]),
      rankingList(s.total, { unit: '点', bar: true }),
      el('div', { style: { marginTop: '10px' } }, [scoreLegend(rules)]),
    ]),
  ]);
}

/** ラウンド結果のあとに、先生が投げかけられる問いを出す */
function discussionPanel() {
  const entry = state.rounds[state.rounds.length - 1];
  const ev = rules.events.list.find((e) => e.id === entry.eventId);
  const best = [...entry.results].sort((a, b) => b.profit - a.profit)[0];
  const bestPlayer = state.players.find((p) => p.id === best?.playerId);
  const asks = [];
  if (bestPlayer) asks.push(`今年いちばん利益を出したのは「${bestPlayer.company}」です。なぜうまくいったのでしょう？`);
  if (entry.results.some((r) => r.profit < 0)) asks.push('赤字になった会社は、来年どう立て直しますか？');
  if (ev?.learn) asks.push(ev.learn);

  return el('div', { class: 'panel panel-soft' }, [
    el('h3', { style: { marginTop: 0 } }, ['💬 話し合いのヒント']),
    el('ul', { style: { margin: 0, paddingLeft: '1.2em' } }, asks.map((a) => el('li', {}, [a]))),
  ]);
}

/* ---------------------------------------------------------- 最終結果 */

function renderFinal() {
  const body = clear($('#finalBody'));
  const s = state.standings;
  if (!s) return;

  const stage = state.finalStage;
  $('#finalHint').textContent = {
    profit: '「では、社会全体ではどうだったでしょう？」と問いかけてから次へ進みます。',
    total: '利益1位と総合1位が違ったか、確認してみましょう。',
    reflect: 'ふりかえりの問いです。クラスで話し合ってみてください。',
  }[stage];
  $('#nextBtn2').disabled = stage === 'reflect';
  $('#backBtn').disabled = state.finalStageIndex === 0;

  body.appendChild(
    el('div', { class: 'panel center' }, [
      el('h1', { style: { margin: 0, fontSize: '1.8em' } }, ['🏁 5年間の結果発表']),
      el('div', { class: 'steps', style: { justifyContent: 'center', marginTop: '10px' } }, [
        el('span', { class: `step ${stage === 'profit' ? 'on' : 'done'}` }, ['① 利益']),
        el('span', { class: `step ${stage === 'total' ? 'on' : stage === 'reflect' ? 'done' : ''}` }, ['② 総合']),
        el('span', { class: `step ${stage === 'reflect' ? 'on' : ''}` }, ['③ ふりかえり']),
      ]),
    ])
  );

  if (stage === 'profit') {
    body.appendChild(
      el('div', { class: 'panel' }, [
        el('div', { class: 'section-title' }, [
          el('h2', {}, ['① 利益ランキング']),
          el('span', { class: 'sub' }, ['5年後に残った資金']),
        ]),
        rankingList(s.profit, { unit: rules.game.currencyLabel, rules }),
        el('p', { class: 'center', style: { fontSize: '1.15em', marginTop: '18px' } }, [
          'では、社会全体ではどうだったでしょう？',
        ]),
      ])
    );
  }

  if (stage === 'total' || stage === 'reflect') {
    body.appendChild(
      el('div', { class: 'panel' }, [
        el('div', { class: 'section-title' }, [
          el('h2', {}, ['🏆 サステナビリティ総合ランキング']),
          el('span', { class: 'sub' }, ['利益＋生産者＋社会・環境']),
        ]),
        rankingList(s.total, {
          unit: '点',
          bar: true,
          sub: (r) => `資金 ${money(r.funds, rules)} ・ 👤${r.producerPoints} ・ 🌱${r.societyPoints}`,
        }),
        el('div', { style: { marginTop: '12px' } }, [scoreLegend(rules)]),
      ])
    );
    body.appendChild(
      el('div', { class: 'grid grid-3' }, [
        rankMini('💰 利益', s.profit, rules.game.currencyLabel, rules),
        rankMini('👤 生産者への貢献', s.producer, '点'),
        rankMini('🌱 社会・環境への貢献', s.society, '点'),
      ])
    );
    if (state.insights?.length) {
      body.appendChild(
        el('div', { class: 'panel panel-soft' }, [
          el('h3', { style: { marginTop: 0 } }, ['💬 ここがポイント']),
          el(
            'ul',
            { style: { margin: 0, paddingLeft: '1.2em', lineHeight: '1.9' } },
            state.insights.map((i) => el('li', {}, [i.text, el('b', { style: { marginLeft: '6px' } }, [i.ask])]))
          ),
        ])
      );
    }
  }

  if (stage === 'reflect') {
    body.appendChild(
      el('div', { class: 'panel' }, [
        el('div', { class: 'section-title' }, [el('h2', {}, [rules.reflection?.title || 'ふりかえりの問い'])]),
        el(
          'ol',
          { style: { paddingLeft: '1.3em', lineHeight: '2.1', fontSize: '1.05em' } },
          (rules.reflection?.questions || []).map((q) => el('li', {}, [q]))
        ),
      ])
    );
    body.appendChild(
      el('div', { class: 'panel' }, [
        el('div', { class: 'section-title' }, [el('h2', {}, ['全ラウンドの記録'])]),
        ...state.rounds.map((r) =>
          el('div', { style: { marginBottom: '18px' } }, [
            el('h3', {}, [
              `${r.round}${rules.game.roundUnit || ''} ・ ${
                rules.events.list.find((e) => e.id === r.eventId)?.name || ''
              }`,
            ]),
            roundResultTable(state, rules, r),
          ])
        ),
      ])
    );
  }
}

function rankMini(title, rows, unit, moneyRules = null) {
  return el('div', { class: 'panel' }, [
    el('h3', { style: { marginTop: 0 } }, [title]),
    rankingList(rows.slice(0, 3), { unit, rules: moneyRules }),
  ]);
}

/* ---------------------------------------------------------- CSV出力 */

function exportCsv() {
  if (!state?.rounds?.length) return toast('まだ書き出せる結果がありません。', 'warn');
  const byId = new Map(state.players.map((p) => [p.id, p]));
  const dec = rules.decisions.filter((d) => d.enabled !== false);
  const head = [
    'ラウンド',
    'イベント',
    '名前',
    '会社',
    ...dec.map((d) => d.label),
    '販売数',
    '売上',
    '原料費',
    '広告費',
    '還元',
    '利益',
    '生産者点',
    '社会点',
  ];
  const lines = [head];

  for (const r of state.rounds) {
    const evName = rules.events.list.find((e) => e.id === r.eventId)?.name || r.eventId;
    for (const res of r.results) {
      const p = byId.get(res.playerId);
      lines.push([
        r.round,
        evName,
        p?.name ?? '',
        p?.company ?? '',
        // dec は rules.decisions を絞り込んだものなので、探し直す必要はない
        ...dec.map((d) => d.options.find((o) => o.id === res.decision[d.key])?.name ?? ''),
        res.quantity,
        res.revenue,
        res.materialCost,
        res.adCost,
        res.giveCost,
        res.profit,
        res.producerGain,
        res.societyGain,
      ]);
    }
  }

  const s = state.standings;
  if (s) {
    lines.push([]);
    lines.push(['最終結果']);
    lines.push(['総合順位', '会社', '名前', '最終資金', '生産者点', '社会点', '総合点']);
    for (const row of s.total) {
      lines.push([row.rank, row.company, row.name, row.funds, row.producerPoints, row.societyPoints, row.total]);
    }
  }

  const csv = lines
    .map((cols) => cols.map((c) => `"${String(c ?? '').replace(/"/g, '""')}"`).join(','))
    .join('\r\n');
  // Excel が UTF-8 と判別できるように BOM を付ける
  const blob = new Blob([new Uint8Array([0xef, 0xbb, 0xbf]), csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: `fairtrade-${state.code}.csv` });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 3000);
  toast('CSVをダウンロードしました。');
}
