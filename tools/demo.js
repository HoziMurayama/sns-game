/**
 * 動作確認用: 実際に動いているサーバへ接続し、AIだけで1ゲームを最後まで通します。
 *
 *   node server/index.js          # 別のターミナルで起動しておく
 *   node tools/demo.js            # http://localhost:3000 に対して実行
 *   node tools/demo.js http://192.168.1.24:3000
 *   node tools/demo.js https://example.com
 *
 * 公開先（クラウドやLAN）にデプロイしたあと、
 * 「本当に最後まで遊べる状態になっているか」をブラウザを開かずに確認できます。
 */

const target = (process.argv[2] || 'http://localhost:3000').replace(/\/$/, '');
const wsUrl = target.replace(/^http/, 'ws') + '/ws';
const PLAYERS = Number(process.env.PLAYERS || 4);

const fmt = (n) => Math.round(n).toLocaleString('ja-JP');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function connect(label) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const client = { ws, label, state: null, rules: null, welcome: null, waiters: [] };
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.t === 'welcome') {
        client.welcome = msg;
        client.rules = msg.rules;
        client.state = msg.state;
      }
      if (msg.t === 'state') client.state = msg.state;
      if (msg.t === 'error') console.error(`  [${label}] エラー: ${msg.message}`);
      for (const w of client.waiters.slice()) {
        if (w.test(msg, client)) {
          client.waiters.splice(client.waiters.indexOf(w), 1);
          w.resolve(msg);
        }
      }
    });
    ws.addEventListener('open', () => resolve(client));
    ws.addEventListener('error', () => reject(new Error(`${label}: ${wsUrl} に接続できません`)));
    client.send = (m) => ws.send(JSON.stringify(m));
    client.waitFor = (test, timeout = 20000) =>
      new Promise((res, rej) => {
        const w = { test, resolve: res };
        client.waiters.push(w);
        const t = setTimeout(() => rej(new Error(`${label}: 待機タイムアウト`)), timeout);
        const orig = w.resolve;
        w.resolve = (v) => {
          clearTimeout(t);
          orig(v);
        };
      });
  });
}

const isState = (phase, extra = () => true) => (m) =>
  (m.t === 'state' || m.t === 'welcome') && m.state.phase === phase && extra(m.state);

async function main() {
  console.log(`\n接続先: ${target}`);

  const health = await fetch(`${target}/api/health`).then((r) => r.json());
  console.log(`サーバ: Node ${health.node} / 稼働 ${health.uptimeSec}秒 / ルーム ${health.rooms}件\n`);

  const teacher = await connect('先生');
  teacher.send({ t: 'createRoom', ruleset: 'mvp' });
  await teacher.waitFor((m) => m.t === 'welcome');
  const code = teacher.state.code;
  console.log(`ルーム作成: ${code}`);
  console.log(`参加URL   : ${target}/j/${code}\n`);

  for (let i = 0; i < PLAYERS; i++) teacher.send({ t: 'addBot' });
  await teacher.waitFor((m) => m.t === 'state' && m.state.playerCount === PLAYERS);
  console.log(`AIプレイヤー ${PLAYERS}人:`);
  for (const p of teacher.state.players) console.log(`  ${p.icon} ${p.company}（${p.name}）`);

  teacher.send({ t: 'start' });
  const total = teacher.rules.game.rounds;

  for (let round = 1; round <= total; round++) {
    await teacher.waitFor(isState('result', (s) => s.round === round), 30000);
    const entry = teacher.state.rounds.at(-1);
    const ev = teacher.rules.events.list.find((e) => e.id === entry.eventId);
    console.log(`\n── ${round}年目 ── ${ev?.icon ?? ''} ${ev?.name ?? ''}`);
    const byId = new Map(teacher.state.players.map((p) => [p.id, p]));
    for (const r of [...entry.results].sort((a, b) => b.profit - a.profit)) {
      const p = byId.get(r.playerId);
      const d = r.decision;
      console.log(
        `   ${String(p.company).padEnd(12)} ${d.cacao.padEnd(9)}/${d.sugar.padEnd(9)} ` +
          `${d.price.padEnd(4)} 販売${r.quantity.toFixed(1)} 利益${String(fmt(r.profit)).padStart(6)} ` +
          `資金${String(fmt(p.funds)).padStart(6)}`
      );
    }
    teacher.send({ t: 'next' });
  }

  await teacher.waitFor(isState('final'));
  const s = teacher.state.standings;

  console.log('\n════ ① 利益ランキング ════');
  for (const r of s.profit) console.log(`  ${r.rank}位  ${String(r.company).padEnd(12)} ${fmt(r.funds)} pt`);

  console.log('\n════ ② 総合ランキング ════');
  for (const r of s.total) {
    console.log(
      `  ${r.rank}位  ${String(r.company).padEnd(12)} ${String(r.total).padStart(5)}点  ` +
        `(利益${r.parts.profit} / 生産者${r.parts.producer} / 社会${r.parts.society})`
    );
  }

  if (teacher.state.insights?.length) {
    console.log('\n════ 話し合いのヒント ════');
    for (const i of teacher.state.insights) console.log(`  ${i.text}\n    → ${i.ask}`);
  }

  const flipped = s.profit[0].id !== s.total[0].id;
  console.log(`\n利益1位と総合1位は ${flipped ? '入れ替わりました 🔀' : '同じでした'}`);

  teacher.send({ t: 'closeRoom' });
  await wait(300);
  teacher.ws.close();
  console.log('\n✅ 1ゲームを最後まで通せました。\n');
}

main().catch((err) => {
  console.error(`\n❌ ${err.message}\n`);
  process.exit(1);
});
