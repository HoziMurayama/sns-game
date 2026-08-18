/**
 * 依存パッケージなしの WebSocket サーバ実装（RFC 6455 / version 13）。
 *
 * なぜ自前実装か:
 *  - 学校のネットワーク・PCでは `npm install` が通らないことがあるため、
 *    「Node.js を入れて node server/index.js だけで動く」状態にしておきたい。
 *  - 外部パッケージのアップデート事故・サプライチェーンの心配をなくすため。
 *
 * 対応範囲: テキストフレーム / 分割フレーム / ping / pong / close / マスク解除。
 * 未対応 : 拡張（permessage-deflate 等）とバイナリ用途。今回の用途には不要です。
 */

import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

// RFC 6455 で定められた固定文字列。Sec-WebSocket-Accept の計算に使う。
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const OP = {
  CONTINUATION: 0x0,
  TEXT: 0x1,
  BINARY: 0x2,
  CLOSE: 0x8,
  PING: 0x9,
  PONG: 0xa,
};

const CLOSE = {
  NORMAL: 1000,
  GOING_AWAY: 1001,
  PROTOCOL_ERROR: 1002,
  UNSUPPORTED: 1003,
  TOO_LARGE: 1009,
  INTERNAL: 1011,
};

/** Sec-WebSocket-Accept の計算（RFC 6455 §4.2.2） */
export function computeAccept(key) {
  return crypto
    .createHash('sha1')
    .update(key + GUID)
    .digest('base64');
}

function encodeFrame(opcode, payload) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.allocUnsafe(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.allocUnsafe(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.allocUnsafe(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x80 | opcode; // FIN = 1
  return Buffer.concat([header, payload]);
}

export class WsConnection extends EventEmitter {
  /**
   * @param {import('node:net').Socket} socket
   * @param {{ maxPayload?: number }} opts
   */
  constructor(socket, opts = {}) {
    super();
    this.socket = socket;
    this.maxPayload = opts.maxPayload ?? 512 * 1024;
    this.readyState = 'open';
    this.isAlive = true;
    /** アプリ側が自由に使えるコンテキスト（ルームIDなどを入れる） */
    this.ctx = {};

    this._buf = Buffer.alloc(0);
    this._fragments = [];
    this._fragmentOp = null;
    this._closeTimer = null;

    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('close', () => this._finish());
    socket.on('end', () => this._finish());
    socket.on('error', (err) => {
      this.emit('socketError', err);
      this._finish();
    });
    socket.setNoDelay(true);
  }

  /** JSON を1メッセージとして送る */
  sendJson(obj) {
    let text;
    try {
      text = JSON.stringify(obj);
    } catch {
      return false;
    }
    return this.send(text);
  }

  send(text) {
    if (this.readyState !== 'open') return false;
    try {
      this.socket.write(encodeFrame(OP.TEXT, Buffer.from(text, 'utf8')));
      return true;
    } catch {
      this._finish();
      return false;
    }
  }

  ping() {
    if (this.readyState !== 'open') return;
    try {
      this.socket.write(encodeFrame(OP.PING, Buffer.alloc(0)));
    } catch {
      this._finish();
    }
  }

  close(code = CLOSE.NORMAL, reason = '') {
    if (this.readyState !== 'open') return;
    this.readyState = 'closing';
    const reasonBuf = Buffer.from(String(reason), 'utf8').subarray(0, 123);
    const payload = Buffer.allocUnsafe(2 + reasonBuf.length);
    payload.writeUInt16BE(code, 0);
    reasonBuf.copy(payload, 2);
    try {
      this.socket.write(encodeFrame(OP.CLOSE, payload));
    } catch {
      /* すでに切れている */
    }
    // 相手のcloseを待たずに一定時間で切る
    this._closeTimer = setTimeout(() => this.terminate(), 3000);
    this._closeTimer.unref?.();
  }

  terminate() {
    try {
      this.socket.destroy();
    } catch {
      /* noop */
    }
    this._finish();
  }

  _finish() {
    if (this.readyState === 'closed') return;
    this.readyState = 'closed';
    if (this._closeTimer) clearTimeout(this._closeTimer);
    this.emit('close');
  }

  _fail(code, message) {
    this.emit('protocolError', message);
    this.close(code, message);
  }

  _onData(chunk) {
    this._buf = this._buf.length ? Buffer.concat([this._buf, chunk]) : chunk;
    // 1回のデータで複数フレームが届くことがあるのでループする
    for (;;) {
      const consumed = this._readFrame();
      if (!consumed) break;
      if (this.readyState === 'closed') break;
    }
  }

  /** @returns {boolean} 1フレーム読めたら true */
  _readFrame() {
    const buf = this._buf;
    if (buf.length < 2) return false;

    const b0 = buf[0];
    const b1 = buf[1];
    const fin = (b0 & 0x80) !== 0;
    const rsv = b0 & 0x70;
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;

    if (rsv !== 0) {
      this._fail(CLOSE.PROTOCOL_ERROR, 'RSV bits must be 0');
      return false;
    }

    let len = b1 & 0x7f;
    let offset = 2;

    const isControl = (opcode & 0x8) !== 0;
    if (isControl && (len > 125 || !fin)) {
      this._fail(CLOSE.PROTOCOL_ERROR, 'invalid control frame');
      return false;
    }

    if (len === 126) {
      if (buf.length < 4) return false;
      len = buf.readUInt16BE(2);
      offset = 4;
    } else if (len === 127) {
      if (buf.length < 10) return false;
      const big = buf.readBigUInt64BE(2);
      if (big > BigInt(this.maxPayload)) {
        this._fail(CLOSE.TOO_LARGE, 'message too large');
        return false;
      }
      len = Number(big);
      offset = 10;
    }

    if (len > this.maxPayload) {
      this._fail(CLOSE.TOO_LARGE, 'message too large');
      return false;
    }

    // クライアント → サーバのフレームは必ずマスクされていなければならない
    if (!masked) {
      this._fail(CLOSE.PROTOCOL_ERROR, 'client frames must be masked');
      return false;
    }
    if (buf.length < offset + 4) return false;
    const mask = buf.subarray(offset, offset + 4);
    offset += 4;

    if (buf.length < offset + len) return false;

    const payload = Buffer.allocUnsafe(len);
    buf.copy(payload, 0, offset, offset + len);
    for (let i = 0; i < len; i++) payload[i] ^= mask[i & 3];

    this._buf = buf.subarray(offset + len);

    switch (opcode) {
      case OP.PING:
        try {
          this.socket.write(encodeFrame(OP.PONG, payload));
        } catch {
          this._finish();
        }
        return true;

      case OP.PONG:
        this.isAlive = true;
        this.emit('pong');
        return true;

      case OP.CLOSE: {
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : CLOSE.NORMAL;
        if (this.readyState === 'open') {
          this.readyState = 'closing';
          try {
            this.socket.write(encodeFrame(OP.CLOSE, payload));
          } catch {
            /* noop */
          }
        }
        this.terminate();
        this.emit('closeCode', code);
        return false;
      }

      case OP.TEXT:
      case OP.BINARY: {
        if (this._fragmentOp !== null) {
          this._fail(CLOSE.PROTOCOL_ERROR, 'unexpected new data frame while fragmented');
          return false;
        }
        if (!fin) {
          this._fragmentOp = opcode;
          this._fragments = [payload];
          return true;
        }
        this._deliver(opcode, payload);
        return true;
      }

      case OP.CONTINUATION: {
        if (this._fragmentOp === null) {
          this._fail(CLOSE.PROTOCOL_ERROR, 'unexpected continuation frame');
          return false;
        }
        this._fragments.push(payload);
        const total = this._fragments.reduce((a, b) => a + b.length, 0);
        if (total > this.maxPayload) {
          this._fail(CLOSE.TOO_LARGE, 'message too large');
          return false;
        }
        if (fin) {
          const op = this._fragmentOp;
          const full = Buffer.concat(this._fragments);
          this._fragmentOp = null;
          this._fragments = [];
          this._deliver(op, full);
        }
        return true;
      }

      default:
        this._fail(CLOSE.PROTOCOL_ERROR, `unknown opcode ${opcode}`);
        return false;
    }
  }

  _deliver(opcode, payload) {
    this.isAlive = true;
    if (opcode === OP.BINARY) {
      // このアプリはテキスト(JSON)しか使わない
      this._fail(CLOSE.UNSUPPORTED, 'binary frames are not supported');
      return;
    }
    const text = payload.toString('utf8');
    this.emit('message', text);
  }
}

/**
 * HTTP サーバに WebSocket を生やす。
 *
 * @param {import('node:http').Server} server
 * @param {{ path?: string, onConnection: (conn: WsConnection, req) => void,
 *           heartbeatMs?: number, maxPayload?: number }} opts
 */
export function attachWebSocket(server, opts) {
  const wsPath = opts.path || '/ws';
  const heartbeatMs = opts.heartbeatMs ?? 25000;
  /** @type {Set<WsConnection>} */
  const clients = new Set();

  server.on('upgrade', (req, socket) => {
    const url = req.url?.split('?')[0];
    if (url !== wsPath) {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const key = req.headers['sec-websocket-key'];
    const version = req.headers['sec-websocket-version'];
    const upgrade = String(req.headers.upgrade || '').toLowerCase();

    if (upgrade !== 'websocket' || !key || String(version) !== '13') {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    const accept = crypto
      .createHash('sha1')
      .update(key + GUID)
      .digest('base64');

    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n` +
        '\r\n'
    );

    const conn = new WsConnection(socket, { maxPayload: opts.maxPayload });
    clients.add(conn);
    conn.on('close', () => clients.delete(conn));
    opts.onConnection(conn, req);
  });

  // 生存確認。学校のWi-Fiでは「切れたのにTCPは生きているように見える」ことがあるため、
  // ping/pong で実際に応答があるかを確かめる。
  const timer = setInterval(() => {
    for (const conn of clients) {
      if (!conn.isAlive) {
        conn.terminate();
        continue;
      }
      conn.isAlive = false;
      conn.ping();
    }
  }, heartbeatMs);
  timer.unref?.();

  return {
    clients,
    close() {
      clearInterval(timer);
      for (const c of clients) c.close(CLOSE.GOING_AWAY, 'server shutdown');
    },
  };
}

export { OP, CLOSE, encodeFrame };
