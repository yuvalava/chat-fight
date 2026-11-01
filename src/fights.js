// Fight state, rules and transitions. One in-memory store, optional JSON snapshot on disk.
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { writeScorecard } from './judge.js';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function rand(n) {
  const b = randomBytes(n);
  let s = '';
  for (let i = 0; i < n; i++) s += ALPHABET[b[i] % ALPHABET.length];
  return s;
}

export const SIDES = ['red', 'blue'];
export const BELLS = ['agreed', 'open', 'blocked'];
export const STATUSES = ['setup', 'live', 'humans', 'judging', 'scorecard', 'done'];

export const STUBBORNNESS = {
  1: 'Flexible. Look for the deal; concede freely on anything not in the position.',
  2: 'Cooperative. Trade concessions, never give them away.',
  3: 'Firm. Hold the position; concede only for something in return.',
  4: 'Hard. Concede only on minor points and make the other side move first.',
  5: 'Immovable. Argue the position as stated. Conceding is for the human, not for you.'
};

export class FightStore extends EventEmitter {
  constructor(file) {
    super();
    this.setMaxListeners(1000);
    this.file = file || null;
    this.fights = new Map();
    this.load();
  }

  load() {
    if (!this.file || !fs.existsSync(this.file)) return;
    try {
      for (const f of JSON.parse(fs.readFileSync(this.file, 'utf8'))) this.fights.set(f.code, f);
    } catch (e) {
      console.error('could not load snapshot', e.message);
    }
  }

  save() {
    if (!this.file) return;
    clearTimeout(this._t);
    this._t = setTimeout(() => {
      try {
        fs.writeFileSync(this.file, JSON.stringify([...this.fights.values()]));
      } catch (e) {
        console.error('could not save snapshot', e.message);
      }
    }, 300);
  }

  touch(f) {
    f.updatedAt = Date.now();
    this.save();
    this.emit(`fight:${f.code}`, f);
  }

  get(code) {
    return this.fights.get(String(code || '').toUpperCase().trim());
  }

  // Resolve a fight + side from a corner key. Throws on bad key.
  auth(code, key) {
    const f = this.get(code);
    if (!f) throw new FightError('no_such_fight', `No fight with code ${code}.`);
    const side = SIDES.find((s) => f.corners[s].token === String(key || '').trim());
    if (!side) throw new FightError('bad_key', 'Corner key does not match this fight.');
    return { f, side };
  }

  create({ title, context, roundLimit, red, blue }) {
    title = String(title || '').trim().slice(0, 120);
    context = String(context || '').trim().slice(0, 4000);
    if (!title) throw new FightError('bad_input', 'Title is required.');
    if (!context) throw new FightError('bad_input', "Context (what's being decided) is required.");
    roundLimit = Math.min(12, Math.max(1, parseInt(roundLimit, 10) || 5));
    let code;
    do code = `${rand(3)}-${rand(3)}`;
    while (this.fights.has(code));
    const f = {
      code,
      title,
      context,
      roundLimit,
      status: 'setup',
      round: 0,
      turn: 'red',
      seq: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      corners: {
        red: newCorner(red || 'Red'),
        blue: newCorner(blue || 'Blue')
      },
      messages: [],
      scorecard: null
    };
    this.fights.set(code, f);
    this.system(f, `Fight created. Waiting for both corners to get ready and both AIs to join.`);
    this.touch(f);
    return f;
  }

  system(f, text) {
    f.messages.push({ id: ++f.seq, round: f.round, side: null, by: 'system', text, ts: Date.now() });
  }

  updateCorner(f, side, patch) {
    const c = f.corners[side];
    if (f.status !== 'setup' && 'position' in patch) {
      // Position can be edited only before the first bell.
      if (f.round > 0) throw new FightError('locked', 'Position is locked once the fight is live.');
    }
    if ('position' in patch) c.position = String(patch.position || '').slice(0, 1500);
    if ('confidential' in patch) c.confidential = String(patch.confidential || '').slice(0, 3000);
    if ('stubbornness' in patch) c.stubbornness = Math.min(5, Math.max(1, parseInt(patch.stubbornness, 10) || 3));
    if ('ready' in patch) {
      const ready = !!patch.ready;
      if (ready && !c.position.trim()) throw new FightError('bad_input', 'Write your position before you hit Ready.');
      if (ready !== c.ready) {
        c.ready = ready;
        this.system(f, `${c.name} is ${ready ? 'ready' : 'no longer ready'}.`);
      }
    }
    this.maybeStart(f);
    this.touch(f);
    return c;
  }

  joinAi(f, side, aiName) {
    const c = f.corners[side];
    const first = !c.ai.joined;
    c.ai.joined = true;
    c.ai.name = String(aiName || c.ai.name || 'AI').slice(0, 40);
    c.ai.lastSeen = Date.now();
    if (first) this.system(f, `${c.name}'s AI (${c.ai.name}) joined the ${side} corner.`);
    this.maybeStart(f);
    this.touch(f);
  }

  seen(f, side) {
    f.corners[side].ai.lastSeen = Date.now();
  }

  maybeStart(f) {
    if (f.status !== 'setup') return;
    const r = f.corners.red, b = f.corners.blue;
    if (r.ready && b.ready && r.ai.joined && b.ai.joined) {
      f.status = 'live';
      f.round = 1;
      f.turn = 'red';
      this.system(f, `Round 1. ${r.name}'s AI opens.`);
    }
  }

  // Human whispers to their own AI. Private: ringside sees only that a whisper happened.
  whisper(f, side, text) {
    text = String(text || '').trim().slice(0, 1000);
    if (!text) throw new FightError('bad_input', 'Empty whisper.');
    const c = f.corners[side];
    c.whispers.push({ id: ++f.seq, text, ts: Date.now(), delivered: false });
    this.system(f, `${c.name} whispered to their corner.`);
    this.touch(f);
  }

  postAi(f, side, text, bell) {
    text = String(text || '').trim();
    if (!text) throw new FightError('bad_input', 'Empty message.');
    if (!BELLS.includes(bell)) throw new FightError('bad_input', `bell_state must be one of ${BELLS.join(', ')}.`);
    if (f.status === 'setup') throw new FightError('not_live', 'Fight has not started. Call wait_for_turn.');
    if (f.status !== 'live') throw new FightError('not_live', `Fight is ${f.status}; AIs are no longer posting.`);
    if (f.turn !== side) throw new FightError('not_your_turn', `It is ${f.corners[f.turn].name}'s AI's turn. Call wait_for_turn.`);
    const c = f.corners[side];
    c.ai.lastSeen = Date.now();
    c.lastBell = bell;
    c.lastBellRound = f.round;
    f.messages.push({ id: ++f.seq, round: f.round, side, by: 'ai', text: text.slice(0, 4000), bell, ts: Date.now() });

    const other = side === 'red' ? 'blue' : 'red';
    const o = f.corners[other];
    const roundComplete = o.lastBellRound === f.round;
    if (roundComplete) {
      if (c.lastBell === 'agreed' && o.lastBell === 'agreed') {
        this.system(f, `Bell. Both corners agreed in round ${f.round}.`);
        this.toJudging(f);
      } else if (f.round >= f.roundLimit) {
        this.system(f, `Final bell after round ${f.round}.`);
        this.toJudging(f);
      } else {
        f.round += 1;
        f.turn = other;
        this.system(f, `Round ${f.round}. ${o.name}'s AI opens.`);
      }
    } else {
      f.turn = other;
    }
    this.touch(f);
  }

  // Human takes over: AIs stop, humans may type directly, either human can ring the bell.
  tapOut(f, side) {
    if (!['setup', 'live'].includes(f.status)) throw new FightError('bad_state', `Cannot tap out while ${f.status}.`);
    const c = f.corners[side];
    c.tappedOut = true;
    f.status = 'humans';
    this.system(f, `${c.name} tapped out. The AIs stop here; humans have the floor. Either side can ring the bell for a scorecard.`);
    this.touch(f);
  }

  postHuman(f, side, text) {
    text = String(text || '').trim();
    if (!text) throw new FightError('bad_input', 'Empty message.');
    if (f.status !== 'humans') throw new FightError('bad_state', 'Humans can type only after a tap-out.');
    f.messages.push({ id: ++f.seq, round: f.round, side, by: 'human', text: text.slice(0, 4000), ts: Date.now() });
    this.touch(f);
  }

  ringBell(f, side) {
    if (!['live', 'humans'].includes(f.status)) throw new FightError('bad_state', `Cannot ring the bell while ${f.status}.`);
    this.system(f, `${f.corners[side].name} rang the bell.`);
    this.toJudging(f);
    this.touch(f);
  }

  toJudging(f) {
    f.status = 'judging';
    this.system(f, 'The judge is writing the scorecard.');
    writeScorecard(f)
      .then((text) => {
        f.scorecard = { text, approvals: { red: false, blue: false }, ts: Date.now() };
        f.status = 'scorecard';
        this.system(f, 'Scorecard is in. Both humans approve to close the fight.');
        this.touch(f);
      })
      .catch((e) => {
        console.error('judge failed', e);
        f.scorecard = { text: `Judge failed: ${e.message}`, approvals: { red: false, blue: false }, ts: Date.now() };
        f.status = 'scorecard';
        this.touch(f);
      });
  }

  approve(f, side) {
    if (f.status !== 'scorecard') throw new FightError('bad_state', 'There is no scorecard to approve yet.');
    f.scorecard.approvals[side] = true;
    this.system(f, `${f.corners[side].name} approved the scorecard.`);
    if (f.scorecard.approvals.red && f.scorecard.approvals.blue) {
      f.status = 'done';
      this.system(f, 'Both approved. Fight closed.');
    }
    this.touch(f);
  }

  // Resolve when something an AI in `side` cares about changes, or after timeoutMs.
  waitFor(f, side, timeoutMs) {
    if (shouldWake(f, side)) return Promise.resolve(false);
    return new Promise((resolve) => {
      const ev = `fight:${f.code}`;
      const onChange = () => {
        if (shouldWake(f, side)) finish(false);
      };
      const finish = (timedOut) => {
        clearTimeout(t);
        this.off(ev, onChange);
        resolve(timedOut);
      };
      const t = setTimeout(() => finish(true), timeoutMs);
      this.on(ev, onChange);
    });
  }
}

function shouldWake(f, side) {
  if (f.status === 'live') {
    if (f.turn === side) return true;
    if (f.corners[side].whispers.some((w) => !w.delivered)) return true;
    return false;
  }
  if (f.status === 'setup') return false;
  return true; // humans, judging, scorecard, done: the AI should learn it is over
}

function newCorner(name) {
  return {
    name: String(name).trim().slice(0, 40) || 'Anon',
    token: rand(12),
    position: '',
    confidential: '',
    stubbornness: 3,
    ready: false,
    tappedOut: false,
    lastBell: null,
    lastBellRound: 0,
    whispers: [],
    ai: { joined: false, name: null, lastSeen: 0, cursor: 0 }
  };
}

export class FightError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function other(side) {
  return side === 'red' ? 'blue' : 'red';
}

// What anyone with the fight code may see (ringside, the opponent).
export function publicState(f) {
  const corner = (c) => ({
    name: c.name,
    ready: c.ready,
    tappedOut: c.tappedOut,
    lastBell: c.lastBell,
    approved: f.scorecard ? !!f.scorecard.approvals[c === f.corners.red ? 'red' : 'blue'] : false,
    ai: { joined: c.ai.joined, name: c.ai.name, lastSeen: c.ai.lastSeen }
  });
  return {
    code: f.code,
    title: f.title,
    context: f.context,
    roundLimit: f.roundLimit,
    status: f.status,
    round: f.round,
    turn: f.turn,
    createdAt: f.createdAt,
    updatedAt: f.updatedAt,
    corners: { red: corner(f.corners.red), blue: corner(f.corners.blue) },
    messages: f.messages,
    scorecard: f.scorecard ? { text: f.scorecard.text, approvals: f.scorecard.approvals } : null,
    now: Date.now()
  };
}

// What the owner of a corner may see on top of the public state.
export function privateCorner(f, side) {
  const c = f.corners[side];
  return {
    side,
    position: c.position,
    confidential: c.confidential,
    stubbornness: c.stubbornness,
    whispers: c.whispers,
    key: c.token
  };
}
