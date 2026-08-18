/**
 * WebSocket クライアント（自動再接続つき）。
 *
 * 教室で実際に起きること:
 *   - 生徒がブラウザを更新する / 「戻る」を押す
 *   - Wi-Fi が一瞬切れる、端末がスリープする
 *   - タブを閉じてしまう
 * このどれが起きても、同じ会社に戻れるようにします。
 *
 * セッションの保存先:
 *   sessionStorage … タブ単位。更新・スリープ復帰では自動で戻る（教室での主なケース）
 *   localStorage   … タブを閉じた場合の保険。参加画面に「続きから戻る」を出すために使う
 *                    （自動復帰にしないのは、1台で複数人ぶんの動作確認をするときに邪魔になるため）
 */

const WS_URL = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;

const BACKOFF = [500, 1000, 2000, 3000, 5000, 8000];

export class Net {
  /** @param {'teacher'|'player'} role */
  constructor(role) {
    this.role = role;
    this.ws = null;
    this.handlers = new Map();
    this.outbox = [];
    this.attempt = 0;
    this.session = null;
    this.manualClose = false;
    this.connected = false;
    this._pingTimer = null;
    this._reconnectTimer = null;
  }

  /* ---------------- イベント ---------------- */

  on(type, fn) {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    this.handlers.get(type).add(fn);
    return this;
  }

  emit(type, payload) {
    for (const fn of this.handlers.get(type) || []) {
      try {
        fn(payload);
      } catch (err) {
        console.error(`[net] ${type} ハンドラでエラー`, err);
      }
    }
  }

  /* ---------------- セッション ---------------- */

  get storageKey() {
    return `ftc.session.${this.role}`;
  }

  loadSession() {
    try {
      const raw = sessionStorage.getItem(this.storageKey);
      this.session = raw ? JSON.parse(raw) : null;
    } catch {
      this.session = null;
    }
    return this.session;
  }

  /** タブを閉じた場合の保険（自動復帰はしない） */
  loadBackupSession() {
    try {
      const raw = localStorage.getItem(this.storageKey);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  saveSession(session) {
    this.session = session;
    try {
      sessionStorage.setItem(this.storageKey, JSON.stringify(session));
      localStorage.setItem(this.storageKey, JSON.stringify(session));
    } catch {
      /* プライベートモード等では保存できないが、動作は続行する */
    }
  }

  clearSession() {
    this.session = null;
    try {
      sessionStorage.removeItem(this.storageKey);
      localStorage.removeItem(this.storageKey);
    } catch {
      /* noop */
    }
  }

  /* ---------------- 接続 ---------------- */

  connect() {
    this.manualClose = false;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;

    let ws;
    try {
      ws = new WebSocket(WS_URL);
    } catch {
      this._scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      this.attempt = 0;
      this.connected = true;
      this.emit('status', { connected: true });

      // 前回の続きがあれば、まず復帰を試す
      if (this.session?.code && this.session?.token) {
        this.sendNow({ t: 'resume', code: this.session.code, token: this.session.token });
      } else {
        this.emit('ready');
      }
      // 溜めておいた送信を流す
      const pending = this.outbox.splice(0);
      for (const m of pending) this.sendNow(m);

      clearInterval(this._pingTimer);
      this._pingTimer = setInterval(() => this.sendNow({ t: 'ping' }), 20000);
    };

    ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.t === 'pong') return;
      if (msg.t === 'welcome') {
        this.saveSession({
          code: msg.state.code,
          token: msg.token,
          role: msg.role,
          playerId: msg.playerId,
        });
      }
      if (msg.t === 'error' && (msg.code === 'noSession' || msg.code === 'noRoom')) {
        // 「前回の続きに戻ろうとして戻れなかった」場合だけ、参加画面に戻す。
        //
        // ここを区別しないと、生徒がルーム番号を打ち間違えたときにも
        // 黙って参加画面に戻るだけになり、何が悪かったのか分からなくなる。
        // （教室でいちばん多い操作ミスなので、必ず理由を出す）
        const wasResuming = !!this.session;
        this.clearSession();
        if (wasResuming) {
          this.emit('sessionLost', msg);
          this.emit('ready');
          return;
        }
        // 復帰中でなければ、通常のエラーとして画面へ伝える（下へ流す）
      }
      if (msg.t === 'kicked' || msg.t === 'left' || msg.t === 'roomClosed') {
        this.clearSession();
      }
      this.emit(msg.t, msg);
      this.emit('*', msg);
    };

    ws.onclose = () => {
      this.connected = false;
      clearInterval(this._pingTimer);
      this.emit('status', { connected: false });
      if (!this.manualClose) this._scheduleReconnect();
    };

    ws.onerror = () => {
      /* onclose が続けて呼ばれるので、ここでは何もしない */
    };
  }

  _scheduleReconnect() {
    if (this.manualClose) return;
    const delay = BACKOFF[Math.min(this.attempt, BACKOFF.length - 1)];
    this.attempt++;
    this.emit('reconnecting', { attempt: this.attempt, delay });
    clearTimeout(this._reconnectTimer);
    this._reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  disconnect() {
    this.manualClose = true;
    clearInterval(this._pingTimer);
    // 予約ずみの再接続も止める。
    // 消さないと connect() が manualClose を false に戻し、切ったはずが繋がり直す。
    clearTimeout(this._reconnectTimer);
    this._reconnectTimer = null;
    try {
      this.ws?.close();
    } catch {
      /* noop */
    }
  }

  /** 未接続なら送信をためておき、つながった時点でまとめて送る */
  send(msg) {
    if (this.ws?.readyState === WebSocket.OPEN) return this.sendNow(msg);
    this.outbox.push(msg);
    this.connect();
    return false;
  }

  sendNow(msg) {
    try {
      this.ws.send(JSON.stringify(msg));
      return true;
    } catch {
      return false;
    }
  }
}
