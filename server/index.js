/**
 * エントリポイント: HTTP（静的ファイル + 小さなAPI）と WebSocket を1つのポートで提供します。
 *
 *   node server/index.js
 *   PORT=8080 node server/index.js
 *
 * 起動すると、同じWi-Fi内の端末からアクセスできるURLを表示します。
 */

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { attachWebSocket } from './ws.js';
import { RoomStore } from './store.js';
import { PHASE } from './room.js';
import { loadRuleset, listRulesets, CONFIG_DIR } from './rules.js';
import { decideForBot, botThinkDelay, STRATEGIES, STRATEGY_IDS, BOT_ROTATION } from './bots.js';
import { rngFor } from '../public/js/rng.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';

/* ------------------------------------------------------------------ *
 * 起動時チェック: ルールJSONがおかしければ、ここで止める
 * ------------------------------------------------------------------ */

const companies = JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, 'companies.json'), 'utf8'));

let rulesets;
try {
  rulesets = listRulesets();
  for (const r of rulesets) loadRuleset(r.file); // 全部を実際に読んで検証
} catch (err) {
  console.error('\n[起動中止] ルール設定に問題があります。\n');
  console.error(err.message);
  console.error('\nconfig/ 以下のJSONを直してから、もう一度起動してください。\n');
  process.exit(1);
}

const store = new RoomStore({ companies, persist: process.env.NO_PERSIST !== '1' });

/* ------------------------------------------------------------------ *
 * AIプレイヤーの手番
 * ------------------------------------------------------------------ */

store.onRoom = (room) => {
  room.on('botTurn', () => scheduleBots(room));
};

function scheduleBots(room) {
  const round = room.round;
  for (const player of room.activePlayers) {
    if (!player.isBot || player.submitted) continue;
    const rng = rngFor(room.seed, 'bot', round, player.id);
    const delay = botThinkDelay(rng);
    const timer = setTimeout(() => {
      // 待っている間に状況が変わっていたら何もしない
      if (room.closed || room.phase !== PHASE.DECISION || room.round !== round) return;
      if (!room.players.has(player.id) || player.submitted) return;
      const decision = decideForBot({
        rules: room.rules,
        roundIndex: round - 1,
        eventId: room.eventPlan[round - 1],
        strategy: player.botStrategy,
        rng,
      });
      room.submit(player.id, decision);
    }, delay);
    timer.unref?.();
  }
}

const restored = store.load();
if (restored) console.log(`[store] ${restored} 件のルームを復元しました。`);

/* ------------------------------------------------------------------ *
 * 静的ファイル配信
 * ------------------------------------------------------------------ */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
};

function sendJson(res, status, obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendFile(res, filePath) {
  let stat;
  try {
    stat = fs.statSync(filePath);
    if (!stat.isFile()) throw new Error('not a file');
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
    return;
  }
  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': stat.size,
    // 授業前に修正したファイルが確実に反映されるよう、キャッシュは持たせない
    'Cache-Control': 'no-cache, must-revalidate',
    'X-Content-Type-Options': 'nosniff',
  });
  fs.createReadStream(filePath).pipe(res);
}

/** ディレクトリの外に出るパスを弾く */
function safeJoin(base, urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath.split('?')[0]);
  } catch {
    return null; // "%" 単体などの壊れたURLエンコード
  }
  if (decoded.includes('\0')) return null;
  const resolved = path.resolve(base, '.' + decoded);
  // base + セパレータまで見る。startsWith だけだと public-old/ のような
  // 「名前が前方一致する別ディレクトリ」を通してしまう。
  return resolved === base || resolved.startsWith(base + path.sep) ? resolved : null;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' });
    res.end();
    return;
  }

  // --- 小さなAPI ---
  if (pathname === '/api/health') {
    return sendJson(res, 200, {
      ok: true,
      rooms: store.rooms.size,
      uptimeSec: Math.round(process.uptime()),
      node: process.version,
    });
  }
  if (pathname === '/api/rulesets') {
    return sendJson(res, 200, { rulesets, strategies: STRATEGY_IDS.map((id) => STRATEGIES[id]) });
  }
  if (pathname === '/api/news') {
    // 毎回読み直す（サーバを止めずにお知らせを更新できるようにするため）
    try {
      const raw = fs.readFileSync(path.join(CONFIG_DIR, 'news.json'), 'utf8');
      return sendJson(res, 200, { items: JSON.parse(raw).items || [] });
    } catch {
      return sendJson(res, 200, { items: [] });
    }
  }
  if (pathname === '/api/room/exists') {
    const room = store.get(url.searchParams.get('code'));
    return sendJson(res, 200, {
      exists: !!room,
      joinable: room ? room.canJoin().ok : false,
      phase: room?.phase ?? null,
    });
  }

  // --- ルーティング ---
  if (pathname === '/') return sendFile(res, path.join(PUBLIC_DIR, 'index.html'));
  if (pathname === '/teacher.html' || pathname === '/teacher.html/')
    return sendFile(res, path.join(PUBLIC_DIR, 'teacher.html'));
  if (pathname === '/play.html' || pathname === '/play.html/') return sendFile(res, path.join(PUBLIC_DIR, 'play.html'));

  // QRコード用の短いURL: /j/123456 → 参加画面（コード入力済み）
  const short = pathname.match(/^\/j\/(\d{4,8})\/?$/);
  if (short) {
    res.writeHead(302, { Location: `/play.html?code=${short[1]}`, 'Cache-Control': 'no-store' });
    res.end();
    return;
  }

  // --- 静的ファイル ---
  const file = safeJoin(PUBLIC_DIR, pathname);
  if (file) return sendFile(res, file);

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('404 Not Found');
});

/* ------------------------------------------------------------------ *
 * WebSocket プロトコル
 * ------------------------------------------------------------------ */

const MAX_MSG_PER_WINDOW = 60;
const RATE_WINDOW_MS = 5000;

function fail(conn, message, code = 'error') {
  conn.sendJson({ t: 'error', code, message });
}

function broadcast(code) {
  const room = store.get(code);
  const conns = store.connectionsOf(code);
  if (!room) {
    for (const conn of conns) {
      conn.sendJson({ t: 'roomClosed', message: 'ルームが終了しました。' });
      conn.close(1000, 'room closed');
    }
    return;
  }
  for (const conn of conns) {
    const { role, playerId } = conn.ctx;
    conn.sendJson({ t: 'state', state: room.snapshot({ role, playerId }) });
  }
}
store.onBroadcast = broadcast;

function syncTeacherPresence(room) {
  const has = [...store.connectionsOf(room.code)].some((c) => c.ctx.role === 'teacher');
  if (room.teacherConnected !== has) {
    room.teacherConnected = has;
    room.touch();
  }
}

function bindConnection(conn, room, role, playerId) {
  // 同じ端末からの二重接続を防ぐ（ブラウザ更新時に古い接続が残るケース）
  for (const other of store.connectionsOf(room.code)) {
    if (other === conn) continue;
    if (role === 'teacher' && other.ctx.role === 'teacher') {
      other.sendJson({ t: 'replaced', message: '別の画面で先生用コンソールが開かれました。' });
      other.close(1000, 'replaced');
    }
    if (role === 'player' && other.ctx.playerId === playerId) {
      other.sendJson({ t: 'replaced', message: '別の画面で同じ会社が開かれました。' });
      other.close(1000, 'replaced');
    }
  }
  conn.ctx = { code: room.code, role, playerId };
  store.attach(room.code, conn);
}

function welcome(conn, room, role, playerId) {
  const player = playerId ? room.players.get(playerId) : null;
  conn.sendJson({
    t: 'welcome',
    role,
    token: role === 'teacher' ? room.teacherToken : player?.token,
    playerId: playerId || null,
    rules: room.rules,
    strategies: STRATEGY_IDS.map((id) => STRATEGIES[id]),
    state: room.snapshot({ role, playerId }),
  });
}

function handleMessage(conn, msg) {
  const type = msg?.t;
  if (type === 'ping') {
    conn.sendJson({ t: 'pong', at: Date.now() });
    return;
  }

  /* ---- ルーム作成（先生） ---- */
  if (type === 'createRoom') {
    let room;
    try {
      room = store.createRoom({ rulesetId: msg.ruleset || 'mvp', options: msg.options || {} });
    } catch (err) {
      return fail(conn, err.message, 'createFailed');
    }
    bindConnection(conn, room, 'teacher', null);
    syncTeacherPresence(room);
    welcome(conn, room, 'teacher', null);
    console.log(`[room] 作成 ${room.code} (${room.rules.id} / ${room.options.demandMode})`);
    return;
  }

  /* ---- 参加（生徒） ---- */
  if (type === 'joinRoom') {
    const room = store.get(msg.code);
    if (!room) return fail(conn, 'そのルーム番号は見つかりませんでした。番号を確認してください。', 'noRoom');
    const check = room.canJoin();
    if (!check.ok) return fail(conn, check.message, 'cannotJoin');
    const { player, error } = room.addPlayer({ name: msg.name });
    if (error) return fail(conn, error, 'cannotJoin');
    bindConnection(conn, room, 'player', player.id);
    room.setConnected(player.id, true);
    welcome(conn, room, 'player', player.id);
    return;
  }

  /* ---- 再接続（更新・回線切断からの復帰） ---- */
  if (type === 'resume') {
    const room = store.get(msg.code);
    if (!room) return fail(conn, 'ルームが見つかりません。もう一度参加してください。', 'noRoom');
    if (msg.token && msg.token === room.teacherToken) {
      bindConnection(conn, room, 'teacher', null);
      syncTeacherPresence(room);
      welcome(conn, room, 'teacher', null);
      return;
    }
    const player = room.findByToken(msg.token);
    if (!player) return fail(conn, '前回の参加情報が確認できませんでした。もう一度参加してください。', 'noSession');
    bindConnection(conn, room, 'player', player.id);
    room.setConnected(player.id, true);
    welcome(conn, room, 'player', player.id);
    return;
  }

  /* ---- ここから先は入室済みが前提 ---- */
  const { code, role, playerId } = conn.ctx;
  const room = code ? store.get(code) : null;
  if (!room) return fail(conn, 'ルームに接続していません。', 'notInRoom');

  if (role === 'player') {
    switch (type) {
      case 'draft':
        room.setDraft(playerId, msg.decision);
        return;
      case 'submit': {
        const r = room.submit(playerId, msg.decision);
        if (r.error) return fail(conn, r.error, 'submitFailed');
        return;
      }
      case 'unsubmit':
        room.unsubmit(playerId);
        return;
      case 'leave':
        room.removePlayer(playerId);
        conn.ctx = {};
        store.detach(code, conn);
        conn.sendJson({ t: 'left' });
        return;
      default:
        return fail(conn, `この操作はできません: ${type}`, 'badRequest');
    }
  }

  if (role !== 'teacher') return fail(conn, '権限がありません。', 'forbidden');

  switch (type) {
    case 'start': {
      const r = room.start();
      if (r.error) return fail(conn, r.error, 'startFailed');
      console.log(`[room] 開始 ${room.code} 参加者${room.playerCount}人`);
      return;
    }
    case 'forceResolve': {
      const r = room.forceResolve('teacher');
      if (r.error) return fail(conn, r.error, 'resolveFailed');
      return;
    }
    case 'next': {
      const r = room.next();
      if (r.error) return fail(conn, r.error, 'nextFailed');
      return;
    }
    case 'back':
      room.back();
      return;
    case 'addBot': {
      const strategy = STRATEGY_IDS.includes(msg.strategy)
        ? msg.strategy
        : BOT_ROTATION[room.activePlayers.filter((p) => p.isBot).length % BOT_ROTATION.length];
      const nameList = companies.botNames || ['AI'];
      const nth = room.activePlayers.filter((p) => p.isBot).length;
      const { player, error } = room.addPlayer({
        name: nameList[nth % nameList.length],
        isBot: true,
        botStrategy: strategy,
      });
      if (error) return fail(conn, error, 'cannotJoin');
      if (room.phase === PHASE.DECISION) scheduleBots(room);
      return;
    }
    case 'removePlayer':
      room.removePlayer(msg.playerId);
      // 反復中に detach するので、いったんコピーしてから回す
      for (const other of [...store.connectionsOf(room.code)]) {
        if (other.ctx.playerId === msg.playerId) {
          other.sendJson({ t: 'kicked', message: '先生によって退出しました。' });
          other.ctx = {};
          store.detach(room.code, other);
        }
      }
      return;
    case 'restart':
      room.restart();
      return;
    case 'setOptions':
      if (msg.timerSec != null) room.options.timerSec = Math.max(0, Math.min(600, Number(msg.timerSec) || 0));
      if (msg.autoAdvance != null) room.options.autoAdvance = !!msg.autoAdvance;
      room.touch();
      return;
    case 'closeRoom': {
      console.log(`[room] 終了 ${room.code}`);
      // 先に全員へ知らせてから片付ける。
      // （store.remove() は接続一覧も消すので、順番を逆にすると誰にも届かない）
      const conns = [...store.connectionsOf(room.code)];
      store.remove(room.code);
      for (const c of conns) {
        c.sendJson({ t: 'roomClosed', message: 'ゲームが終了しました。ご参加ありがとうございました！' });
        c.ctx = {};
        c.close(1000, 'room closed');
      }
      return;
    }
    default:
      return fail(conn, `不明な操作です: ${type}`, 'badRequest');
  }
}

const wss = attachWebSocket(server, {
  path: '/ws',
  maxPayload: 64 * 1024,
  onConnection(conn) {
    conn.ctx = {};
    let count = 0;
    let windowStart = Date.now();

    conn.on('message', (text) => {
      const now = Date.now();
      if (now - windowStart > RATE_WINDOW_MS) {
        windowStart = now;
        count = 0;
      }
      if (++count > MAX_MSG_PER_WINDOW) {
        fail(conn, '操作が多すぎます。少し待ってからお試しください。', 'rateLimited');
        conn.close(1008, 'rate limited');
        return;
      }

      let msg;
      try {
        msg = JSON.parse(text);
      } catch {
        return fail(conn, '不正なデータを受信しました。', 'badJson');
      }
      try {
        handleMessage(conn, msg);
      } catch (err) {
        console.error('[ws] 処理中のエラー:', err);
        fail(conn, 'サーバ側でエラーが発生しました。', 'internal');
      }
    });

    conn.on('close', () => {
      const { code, role, playerId } = conn.ctx;
      if (!code) return;
      store.detach(code, conn);
      const room = store.get(code);
      if (!room) return;
      if (role === 'player' && playerId) room.setConnected(playerId, false);
      if (role === 'teacher') syncTeacherPresence(room);
      broadcast(code);
    });
  },
});

/* ------------------------------------------------------------------ *
 * 起動
 * ------------------------------------------------------------------ */

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const net of list || []) {
      if (net.family === 'IPv4' && !net.internal) out.push(net.address);
    }
  }
  return out;
}

const sweeper = setInterval(() => store.sweep(), 10 * 60 * 1000);
sweeper.unref?.();

server.listen(PORT, HOST, () => {
  const urls = [`http://localhost:${PORT}`, ...lanAddresses().map((ip) => `http://${ip}:${PORT}`)];
  console.log('');
  console.log('  🍫  フェアトレード・チャレンジ ～チョコレートの旅～');
  console.log('  ───────────────────────────────────────────────');
  console.log(`  先生用   : ${urls[0]}/teacher.html`);
  console.log(`  生徒用   : ${urls[0]}/play.html`);
  if (urls.length > 1) {
    console.log('');
    console.log('  同じWi-Fiの端末からは、こちらのURLで開けます:');
    for (const u of urls.slice(1)) console.log(`    ${u}/play.html`);
  }
  console.log('');
  console.log(`  ルールセット: ${rulesets.map((r) => r.id).join(', ')}`);
  console.log('  終了するには Ctrl+C');
  console.log('');
});

function shutdown(signal) {
  console.log(`\n[server] ${signal} を受信しました。保存して終了します。`);
  store.saveNow();
  wss.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref?.();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (err) => {
  // 授業中に1件の例外でサーバ全体が落ちるのを避ける
  console.error('[server] 予期しないエラー:', err);
  store.saveNow();
});

export { server, store };
