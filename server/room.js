/**
 * ルーム（1回の授業＝1ゲーム）の状態管理。
 *
 * 重要な方針:
 *  - ゲームの状態と計算結果は「すべてサーバが持つ」。
 *    ブラウザから送られてくるのは「どれを選んだか」だけで、金額や点数は一切受け取らない。
 *  - 画面はサーバから配られた状態（スナップショット）を描くだけ。
 *    そのため、再接続・再読み込み・端末の入れ替えが起きても表示がズレない。
 */

import { EventEmitter } from 'node:events';
import {
  planEvents,
  findEvent,
  resolveRound,
  initialPlayerScore,
  applyResult,
  computeStandings,
  buildInsights,
  sanitizeDecision,
  isDecisionComplete,
  defaultDecision,
  activeDecisions,
} from '../shared/engine.js';
import { rngFor, token as makeToken } from '../shared/rng.js';

export const PHASE = {
  LOBBY: 'lobby',
  DECISION: 'decision',
  RESULT: 'result',
  FINAL: 'final',
};

export const FINAL_STAGE = ['profit', 'total', 'reflect'];

let counter = 0;

export class Room extends EventEmitter {
  /**
   * @param {{ code: string, rules: object, companies: object, options?: object, seed?: string }} p
   */
  constructor({ code, rules, companies, options = {}, seed }) {
    super();
    this.code = code;
    this.rules = rules;
    this.companies = companies;
    this.seed = seed || `${code}-${Date.now()}-${counter++}`;
    this.createdAt = Date.now();
    this.updatedAt = Date.now();

    this.options = {
      maxPlayers: clampInt(options.maxPlayers, rules.game.minPlayers, 8, rules.game.maxPlayers),
      demandMode: options.demandMode === 'share' ? 'share' : rules.demand.mode || 'independent',
      timerSec: clampInt(options.timerSec, 0, 600, 0),
      autoAdvance: options.autoAdvance !== false, // 全員提出したら自動で締め切る
    };
    // 需要モードはルールのコピーに反映（ルール本体は共有物なので書き換えない）
    this.rules = { ...rules, demand: { ...rules.demand, mode: this.options.demandMode } };

    this.teacherToken = makeToken(rngFor(this.seed, 'teacher'), 24);
    this.teacherConnected = false;

    /** @type {Map<string, Player>} */
    this.players = new Map();
    this.order = [];

    this.phase = PHASE.LOBBY;
    this.round = 0;
    this.eventPlan = planEvents(this.rules, this.seed);
    this.rounds = []; // 解決済みラウンドの記録
    this.finalStageIndex = 0;
    this.deadline = null;
    this._timer = null;
    this._botTimers = new Set();
    this.closed = false;
  }

  /* -------------------------------------------------- 参加まわり */

  get playerCount() {
    return this.order.length;
  }

  get activePlayers() {
    return this.order.map((id) => this.players.get(id)).filter(Boolean);
  }

  canJoin() {
    if (this.closed) return { ok: false, message: 'このルームは終了しています。' };
    if (this.phase !== PHASE.LOBBY) return { ok: false, message: 'ゲームが始まっているため参加できません。' };
    if (this.playerCount >= this.options.maxPlayers)
      return { ok: false, message: `定員（${this.options.maxPlayers}人）に達しています。` };
    return { ok: true };
  }

  /** 同じ名前が既にいれば「たろう(2)」のようにする */
  _uniqueName(name) {
    const base = String(name || '').trim().slice(0, 12) || 'プレイヤー';
    const taken = new Set(this.activePlayers.map((p) => p.name));
    if (!taken.has(base)) return base;
    for (let i = 2; i < 50; i++) {
      const candidate = `${base}(${i})`;
      if (!taken.has(candidate)) return candidate;
    }
    return `${base}(${Date.now() % 1000})`;
  }

  addPlayer({ name, isBot = false, botStrategy = null }) {
    const check = this.canJoin();
    if (!check.ok) return { error: check.message };

    const rng = rngFor(this.seed, 'player', this.playerCount, Date.now());
    const id = `p${this.playerCount + 1}_${makeToken(rng, 6)}`;
    const list = this.companies.list;
    const company = list[this.playerCount % list.length];

    const player = {
      id,
      name: this._uniqueName(name),
      company: company.name,
      color: company.color,
      icon: company.icon,
      token: makeToken(rng, 24),
      isBot,
      botStrategy,
      connected: isBot,
      lastSeen: Date.now(),
      score: initialPlayerScore(this.rules),
      draft: defaultDecision(this.rules),
      submitted: false,
      submittedDecision: null,
    };
    this.players.set(id, player);
    this.order.push(id);
    this.touch();
    return { player };
  }

  removePlayer(playerId) {
    if (!this.players.has(playerId)) return false;
    this.players.delete(playerId);
    this.order = this.order.filter((id) => id !== playerId);
    this.touch();
    this._maybeResolve();
    return true;
  }

  findByToken(token) {
    for (const p of this.players.values()) if (p.token === token) return p;
    return null;
  }

  setConnected(playerId, connected) {
    const p = this.players.get(playerId);
    if (!p) return;
    p.connected = connected;
    p.lastSeen = Date.now();
    this.touch();
  }

  /* -------------------------------------------------- 進行 */

  start() {
    if (this.phase !== PHASE.LOBBY) return { error: 'すでに開始しています。' };
    if (this.playerCount < this.rules.game.minPlayers)
      return { error: `${this.rules.game.minPlayers}人以上で開始できます。` };
    this.round = 1;
    this._enterDecision();
    return { ok: true };
  }

  _enterDecision() {
    this.phase = PHASE.DECISION;
    for (const p of this.players.values()) {
      p.submitted = false;
      p.submittedDecision = null;
      // 前ラウンドの選択を初期値として残す（毎回ゼロから選ばせない）
      p.draft = sanitizeDecision(this.rules, p.draft);
    }
    this._clearTimer();
    if (this.options.timerSec > 0) {
      this.deadline = Date.now() + this.options.timerSec * 1000;
      this._timer = setTimeout(() => this.forceResolve('time'), this.options.timerSec * 1000);
      this._timer.unref?.();
    } else {
      this.deadline = null;
    }
    this.emit('botTurn', this);
    this.touch();
  }

  setDraft(playerId, decision) {
    const p = this.players.get(playerId);
    if (!p || this.phase !== PHASE.DECISION) return false;
    p.draft = sanitizeDecision(this.rules, { ...p.draft, ...decision });
    if (p.submitted) {
      // 提出後に変更したら提出は取り消し扱い（締め切り前なら何度でも変更できる）
      p.submitted = false;
      p.submittedDecision = null;
    }
    this.touch();
    return true;
  }

  submit(playerId, decision) {
    const p = this.players.get(playerId);
    if (!p) return { error: 'プレイヤーが見つかりません。' };
    if (this.phase !== PHASE.DECISION) return { error: 'いまは決定できません。' };
    if (decision) p.draft = sanitizeDecision(this.rules, { ...p.draft, ...decision });
    if (!isDecisionComplete(this.rules, p.draft)) return { error: 'すべての項目を選んでください。' };
    p.submitted = true;
    p.submittedDecision = { ...p.draft };
    this.touch();
    this._maybeResolve();
    return { ok: true };
  }

  unsubmit(playerId) {
    const p = this.players.get(playerId);
    if (!p || this.phase !== PHASE.DECISION) return false;
    p.submitted = false;
    p.submittedDecision = null;
    this.touch();
    return true;
  }

  get submittedCount() {
    return this.activePlayers.filter((p) => p.submitted).length;
  }

  _maybeResolve() {
    if (this.phase !== PHASE.DECISION) return;
    if (!this.options.autoAdvance) return;
    if (this.playerCount === 0) return;
    if (this.activePlayers.every((p) => p.submitted)) this._resolve('all');
  }

  /** 先生が「締め切る」を押した／制限時間切れ */
  forceResolve(reason = 'teacher') {
    if (this.phase !== PHASE.DECISION) return { error: 'いまは締め切れません。' };
    if (this.playerCount === 0) return { error: '参加者がいません。' };
    this._resolve(reason);
    return { ok: true };
  }

  _resolve(reason) {
    this._clearTimer();
    const eventId = this.eventPlan[this.round - 1];

    const submissions = this.activePlayers.map((p) => ({
      playerId: p.id,
      decision: p.submitted ? p.submittedDecision : p.draft,
      auto: !p.submitted,
    }));

    const results = resolveRound({
      rules: this.rules,
      roundIndex: this.round - 1,
      eventId,
      submissions,
      seed: this.seed,
    });

    for (const r of results) {
      const p = this.players.get(r.playerId);
      if (!p) continue;
      p.score = applyResult(p.score, r);
      p.submitted = true;
      p.submittedDecision = r.decision;
      p.draft = { ...r.decision };
    }

    this.rounds.push({
      round: this.round,
      eventId,
      closedBy: reason,
      at: Date.now(),
      results,
    });

    this.phase = PHASE.RESULT;
    this.touch();
  }

  /** 先生が「次へ」を押す */
  next() {
    if (this.phase === PHASE.RESULT) {
      if (this.round >= this.rules.game.rounds) {
        this.phase = PHASE.FINAL;
        this.finalStageIndex = 0;
      } else {
        this.round += 1;
        this._enterDecision();
      }
      this.touch();
      return { ok: true };
    }
    if (this.phase === PHASE.FINAL) {
      if (this.finalStageIndex < FINAL_STAGE.length - 1) {
        this.finalStageIndex += 1;
        this.touch();
        return { ok: true };
      }
      return { error: 'これが最後の画面です。' };
    }
    return { error: 'いまは進めません。' };
  }

  back() {
    if (this.phase === PHASE.FINAL && this.finalStageIndex > 0) {
      this.finalStageIndex -= 1;
      this.touch();
      return { ok: true };
    }
    return { error: '戻れません。' };
  }

  /** 同じメンバーでもう一度（点数リセット、イベントは引き直し） */
  restart() {
    this._clearTimer();
    this.seed = `${this.code}-${Date.now()}-${counter++}`;
    this.eventPlan = planEvents(this.rules, this.seed);
    this.rounds = [];
    this.round = 0;
    this.phase = PHASE.LOBBY;
    this.finalStageIndex = 0;
    for (const p of this.players.values()) {
      p.score = initialPlayerScore(this.rules);
      p.draft = defaultDecision(this.rules);
      p.submitted = false;
      p.submittedDecision = null;
    }
    this.touch();
    return { ok: true };
  }

  close() {
    this.closed = true;
    this._clearTimer();
    this.touch();
  }

  _clearTimer() {
    if (this._timer) clearTimeout(this._timer);
    this._timer = null;
    this.deadline = null;
  }

  touch() {
    this.updatedAt = Date.now();
    this.emit('change', this);
  }

  /* -------------------------------------------------- 集計 */

  standings() {
    if (!this.rounds.length) return null;
    return computeStandings(
      this.rules,
      this.activePlayers.map((p) => ({ id: p.id, name: p.name, company: p.company, score: p.score }))
    );
  }

  /* -------------------------------------------------- 画面に配る状態 */

  /**
   * @param {{ role: 'teacher'|'player', playerId?: string }} viewer
   */
  snapshot(viewer = { role: 'player' }) {
    const standings = this.standings();
    const currentEventId = this.eventPlan[this.round - 1];
    const showEvent = this.phase === PHASE.DECISION || this.phase === PHASE.RESULT;

    const snap = {
      code: this.code,
      phase: this.phase,
      round: this.round,
      totalRounds: this.rules.game.rounds,
      ruleId: this.rules.id,
      ruleLabel: this.rules.label,
      demandMode: this.options.demandMode,
      maxPlayers: this.options.maxPlayers,
      minPlayers: this.rules.game.minPlayers,
      autoAdvance: this.options.autoAdvance,
      timerSec: this.options.timerSec,
      deadline: this.deadline,
      teacherConnected: this.teacherConnected,
      closed: this.closed,
      finalStage: FINAL_STAGE[this.finalStageIndex],
      finalStageIndex: this.finalStageIndex,
      finalStageCount: FINAL_STAGE.length,
      event: showEvent ? publicEvent(findEvent(this.rules, currentEventId)) : null,
      players: this.activePlayers.map((p) => ({
        id: p.id,
        name: p.name,
        company: p.company,
        color: p.color,
        icon: p.icon,
        connected: p.connected,
        isBot: p.isBot,
        submitted: p.submitted,
        funds: p.score.funds,
        producer: p.score.producer,
        society: p.score.society,
      })),
      submittedCount: this.submittedCount,
      playerCount: this.playerCount,
      rounds: this.rounds.map((r) => ({
        round: r.round,
        eventId: r.eventId,
        closedBy: r.closedBy, // 'all' | 'teacher' | 'time'
        results: r.results,
      })),
      standings,
      insights: this.phase === PHASE.FINAL && standings ? buildInsights(this.rules, standings) : [],
      updatedAt: this.updatedAt,
    };

    if (viewer.role === 'player' && viewer.playerId) {
      const me = this.players.get(viewer.playerId);
      if (me) {
        snap.you = {
          id: me.id,
          name: me.name,
          company: me.company,
          color: me.color,
          icon: me.icon,
          score: me.score,
          draft: me.draft,
          submitted: me.submitted,
          requiredKeys: activeDecisions(this.rules).map((d) => d.key),
        };
      }
    }
    return snap;
  }

  /* -------------------------------------------------- 保存・復元 */

  toJSON() {
    return {
      code: this.code,
      ruleId: this.rules.id,
      seed: this.seed,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      options: this.options,
      teacherToken: this.teacherToken,
      phase: this.phase,
      round: this.round,
      finalStageIndex: this.finalStageIndex,
      closed: this.closed,
      rounds: this.rounds,
      order: this.order,
      players: this.order.map((id) => {
        const p = this.players.get(id);
        return {
          id: p.id,
          name: p.name,
          company: p.company,
          color: p.color,
          icon: p.icon,
          token: p.token,
          isBot: p.isBot,
          botStrategy: p.botStrategy,
          score: p.score,
          draft: p.draft,
          submitted: p.submitted,
          submittedDecision: p.submittedDecision,
        };
      }),
    };
  }

  static fromJSON(data, { rules, companies }) {
    const room = new Room({
      code: data.code,
      rules,
      companies,
      options: data.options,
      seed: data.seed,
    });
    room.createdAt = data.createdAt;
    room.updatedAt = data.updatedAt;
    room.teacherToken = data.teacherToken;
    room.phase = data.phase;
    room.round = data.round;
    room.finalStageIndex = data.finalStageIndex || 0;
    room.closed = !!data.closed;
    room.rounds = data.rounds || [];
    room.order = data.order || [];
    room.players = new Map();
    for (const p of data.players || []) {
      room.players.set(p.id, {
        ...p,
        connected: !!p.isBot, // 再起動直後は全員未接続扱い（再入室で復帰する）
        lastSeen: 0,
      });
    }
    // タイマーは復元しない（授業中に再起動したら先生が締め切る）
    room.deadline = null;
    return room;
  }
}

function publicEvent(e) {
  if (!e) return null;
  return {
    id: e.id,
    name: e.name,
    icon: e.icon,
    headline: e.headline,
    body: e.body,
    learn: e.learn,
  };
}

function clampInt(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}
