/**
 * ルームの保管庫。
 *
 * 授業中にサーバが再起動しても（デプロイ先の再起動・省電力スリープ・手元での操作ミス等）
 * ゲームが消えないよう、ルーム状態をディスクに保存し、起動時に復元します。
 * 生徒はブラウザに保存されたトークンで自動的に元の会社へ戻ります。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Room } from './room.js';
import { loadRuleset } from './rules.js';
import { rngFor, roomCode } from '../shared/rng.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(HERE, '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'rooms.json');

const ROOM_TTL_MS = 6 * 60 * 60 * 1000; // 6時間さわられていないルームは片付ける
const MAX_ROOMS = 200;

export class RoomStore {
  constructor({ companies, persist = true }) {
    this.companies = companies;
    this.persist = persist;
    /** @type {Map<string, Room>} */
    this.rooms = new Map();
    /** @type {Map<string, Set<import('./ws.js').WsConnection>>} */
    this.connections = new Map();
    this._saveTimer = null;
    this._dirty = new Set();
    this._flushScheduled = false;
    this.onBroadcast = null; // index.js が差し込む
  }

  /* ------------------------------------------- ルーム操作 */

  createRoom({ rulesetId = 'mvp', options = {} }) {
    if (this.rooms.size >= MAX_ROOMS) {
      this.sweep(true);
      if (this.rooms.size >= MAX_ROOMS) throw new Error('同時に開けるルーム数の上限に達しました。');
    }
    const rules = loadRuleset(rulesetId);
    const code = this._freshCode();
    const room = new Room({ code, rules, companies: this.companies, options });
    this._register(room);
    this.markDirty(room);
    return room;
  }

  _register(room) {
    this.rooms.set(room.code, room);
    room.on('change', () => this.markDirty(room));
    // 新規作成・復元のどちらでも呼ばれる（AIの手番などをここで繋ぐ）
    this.onRoom?.(room);
  }

  _freshCode() {
    for (let i = 0; i < 500; i++) {
      const code = roomCode(rngFor('code', Date.now(), i, Math.floor(Math.random() * 1e9)));
      if (!this.rooms.has(code)) return code;
    }
    throw new Error('ルームコードを発行できませんでした。');
  }

  get(code) {
    return this.rooms.get(String(code || '').trim());
  }

  remove(code) {
    const room = this.rooms.get(code);
    if (!room) return;
    room.close();
    room.removeAllListeners();
    this.rooms.delete(code);
    this.connections.delete(code);
    this.saveSoon();
  }

  sweep(force = false) {
    const now = Date.now();
    for (const [code, room] of this.rooms) {
      const idle = now - room.updatedAt;
      const hasConnections = (this.connections.get(code)?.size ?? 0) > 0;
      if ((idle > ROOM_TTL_MS && !hasConnections) || (force && room.closed)) {
        this.remove(code);
      }
    }
  }

  /* ------------------------------------------- 接続管理 */

  attach(code, conn) {
    if (!this.connections.has(code)) this.connections.set(code, new Set());
    this.connections.get(code).add(conn);
  }

  detach(code, conn) {
    this.connections.get(code)?.delete(conn);
  }

  connectionsOf(code) {
    return this.connections.get(code) || new Set();
  }

  /* ------------------------------------------- 更新通知 */

  /** 状態が変わったルームを覚えておき、同じティック内の変更をまとめて1回だけ配信する */
  markDirty(room) {
    this._dirty.add(room.code);
    this.saveSoon();
    if (this._flushScheduled) return;
    this._flushScheduled = true;
    setImmediate(() => {
      this._flushScheduled = false;
      const codes = [...this._dirty];
      this._dirty.clear();
      for (const code of codes) this.onBroadcast?.(code);
    });
  }

  /* ------------------------------------------- 保存・復元 */

  saveSoon() {
    if (!this.persist) return;
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this.saveNow();
    }, 800);
    this._saveTimer.unref?.();
  }

  saveNow() {
    if (!this.persist) return;
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const payload = {
        savedAt: Date.now(),
        rooms: [...this.rooms.values()].filter((r) => !r.closed).map((r) => r.toJSON()),
      };
      const tmp = `${DATA_FILE}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(payload), 'utf8');
      fs.renameSync(tmp, DATA_FILE); // 書きかけのファイルを読ませないため
    } catch (err) {
      console.warn('[store] 保存に失敗しました:', err.message);
    }
  }

  load() {
    if (!this.persist) return 0;
    if (!fs.existsSync(DATA_FILE)) return 0;
    let payload;
    try {
      payload = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    } catch (err) {
      console.warn('[store] 保存ファイルを読めませんでした:', err.message);
      return 0;
    }
    let restored = 0;
    for (const data of payload.rooms || []) {
      try {
        if (Date.now() - (data.updatedAt || 0) > ROOM_TTL_MS) continue;
        const rules = loadRuleset(data.ruleId || 'mvp');
        const room = Room.fromJSON(data, { rules, companies: this.companies });
        this._register(room);
        restored++;
      } catch (err) {
        console.warn(`[store] ルーム ${data.code} を復元できませんでした:`, err.message);
      }
    }
    return restored;
  }
}

export { DATA_FILE, DATA_DIR };
