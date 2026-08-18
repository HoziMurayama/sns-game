/** テスト用: サーバを立ち上げ、WebSocketクライアントを扱いやすくする道具。 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** テスト用サーバを起動して、受け付け可能になるまで待つ */
export async function startServer(port) {
  const child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    env: { ...process.env, PORT: String(port), NO_PERSIST: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: ROOT,
  });

  let stderr = '';
  child.stderr.on('data', (d) => (stderr += d));

  const deadline = Date.now() + 15000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`サーバが終了しました (${child.exitCode})\n${stderr}`);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.ok) break;
    } catch {
      /* まだ起動中 */
    }
    if (Date.now() > deadline) throw new Error(`サーバが起動しませんでした\n${stderr}`);
    await sleep(120);
  }

  return {
    port,
    url: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}/ws`,
    async stop() {
      child.kill('SIGKILL');
      await new Promise((r) => child.once('exit', r));
    },
  };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * WebSocketクライアント（Node 20+ の組み込み WebSocket を使用）。
 * 受信メッセージを貯め、条件を満たすまで待てるようにする。
 */
export class TestClient {
  constructor(wsUrl, label = 'client') {
    this.wsUrl = wsUrl;
    this.label = label;
    this.messages = [];
    this.state = null;
    this.welcome = null;
    this.rules = null;
    this.waiters = [];
  }

  async connect() {
    this.ws = new WebSocket(this.wsUrl);
    this.ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      this.messages.push(msg);
      if (msg.t === 'welcome') {
        this.welcome = msg;
        this.rules = msg.rules;
        this.state = msg.state;
      }
      if (msg.t === 'state') this.state = msg.state;
      for (const w of this.waiters.slice()) {
        if (w.test(msg, this)) {
          this.waiters.splice(this.waiters.indexOf(w), 1);
          w.resolve(msg);
        }
      }
    });
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', () => reject(new Error(`${this.label}: 接続できません`)), { once: true });
    });
    return this;
  }

  send(msg) {
    this.ws.send(JSON.stringify(msg));
    return this;
  }

  /** 条件に合うメッセージを待つ（すでに届いていれば即座に返す） */
  waitFor(test, { timeout = 8000, fresh = false } = {}) {
    if (!fresh) {
      const found = this.messages.find((m) => test(m, this));
      if (found) return Promise.resolve(found);
    }
    return new Promise((resolve, reject) => {
      const waiter = { test, resolve };
      this.waiters.push(waiter);
      const timer = setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        reject(
          new Error(
            `${this.label}: 待機タイムアウト。最後の状態=${JSON.stringify({
              phase: this.state?.phase,
              round: this.state?.round,
              submitted: this.state?.submittedCount,
            })}`
          )
        );
      }, timeout);
      const orig = waiter.resolve;
      waiter.resolve = (v) => {
        clearTimeout(timer);
        orig(v);
      };
    });
  }

  /** 指定の phase になるまで待つ */
  waitPhase(phase, extra = () => true, opts = {}) {
    if (this.state?.phase === phase && extra(this.state)) return Promise.resolve(this.state);
    return this.waitFor((m) => {
      const st = m.t === 'state' || m.t === 'welcome' ? m.state : null;
      return st?.phase === phase && extra(st);
    }, opts).then(() => this.state);
  }

  close() {
    try {
      this.ws.close();
    } catch {
      /* noop */
    }
  }
}
