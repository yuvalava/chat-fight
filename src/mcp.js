// MCP server: the tools each person's AI uses to fight on their behalf.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { BELLS, STUBBORNNESS, FightError, other } from './fights.js';

const MAX_WAIT_S = 45;
const DEFAULT_WAIT_S = 25;

export function buildMcpServer(store) {
  const server = new McpServer({ name: 'chat-fight', version: '0.1.0' });

  const codeArg = z.string().describe('Fight code, e.g. 7KQ-3MZ');
  const keyArg = z.string().describe("Your corner key from your human's corner page");

  server.registerTool(
    'join_fight',
    {
      title: 'Join a Chat Fight',
      description:
        "Join a Chat Fight as your human's representative. Returns the briefing: what is being decided, your human's position, confidential context, rules, and how to play. Call this once, then loop on wait_for_turn.",
      inputSchema: {
        code: codeArg,
        corner_key: keyArg,
        ai_name: z.string().optional().describe('How to label you ringside, e.g. "Claude" or "ChatGPT"')
      }
    },
    (args) =>
      run(() => {
        const { f, side } = store.auth(args.code, args.corner_key);
        store.joinAi(f, side, args.ai_name);
        return briefing(f, side) + '\n\n' + stateBlock(f, side, true);
      })
  );

  server.registerTool(
    'wait_for_turn',
    {
      title: 'Wait for your turn',
      description:
        `Blocks until it is your turn, your human whispers to you, or the fight ends (max ${MAX_WAIT_S}s, default ${DEFAULT_WAIT_S}s). Returns new messages since your last call, pending whispers, and whether you must post now. Keep calling it until status is not "live".`,
      inputSchema: {
        code: codeArg,
        corner_key: keyArg,
        timeout_seconds: z.number().int().min(1).max(MAX_WAIT_S).optional()
      }
    },
    async (args) => {
      try {
        const { f, side } = store.auth(args.code, args.corner_key);
        store.seen(f, side);
        const ms = 1000 * (args.timeout_seconds || DEFAULT_WAIT_S);
        await store.waitFor(f, side, ms);
        store.seen(f, side);
        return text(stateBlock(f, side, false));
      } catch (e) {
        return err(e);
      }
    }
  );

  server.registerTool(
    'post_message',
    {
      title: 'Post your message',
      description:
        'Post one message to the ring on your turn, under 120 words, with a bell state: "agreed" if your human would sign the current terms, "open" if there is progress but no deal, "blocked" if there is no path without a human. Then call wait_for_turn again.',
      inputSchema: {
        code: codeArg,
        corner_key: keyArg,
        message: z.string().min(1).max(4000),
        bell_state: z.enum(BELLS)
      }
    },
    (args) =>
      run(() => {
        const { f, side } = store.auth(args.code, args.corner_key);
        store.postAi(f, side, args.message, args.bell_state);
        f.corners[side].ai.cursor = f.seq; // you have seen your own message
        return `Posted (round ${f.messages.at(-1).round}, bell: ${args.bell_state}). ` +
          (f.status === 'live'
            ? `Now call wait_for_turn.`
            : `Fight status is now "${f.status}". ` + endNote(f, side));
      })
  );

  server.registerTool(
    'get_fight',
    {
      title: 'Read the whole fight',
      description: 'Full transcript and state of the fight. Use it if you lost track; wait_for_turn already gives you what is new.',
      inputSchema: { code: codeArg, corner_key: keyArg }
    },
    (args) =>
      run(() => {
        const { f, side } = store.auth(args.code, args.corner_key);
        store.seen(f, side);
        return briefing(f, side) + '\n\n## Transcript\n' + transcript(f, 0) + '\n\n' + stateBlock(f, side, false);
      })
  );

  return server;
}

function run(fn) {
  try {
    return text(fn());
  } catch (e) {
    return err(e);
  }
}
function text(t) {
  return { content: [{ type: 'text', text: t }] };
}
function err(e) {
  const msg = e instanceof FightError ? `${e.code}: ${e.message}` : `error: ${e.message}`;
  return { content: [{ type: 'text', text: msg }], isError: true };
}

export function briefing(f, side) {
  const me = f.corners[side];
  const you = f.corners[other(side)];
  return `# Chat Fight ${f.code}: ${f.title}
You are ${me.name}'s AI in the ${side} corner. Opponent: ${you.name}'s AI in the ${other(side)} corner. Both humans are watching ringside.

## What's being decided
${f.context}

## ${me.name}'s position (confirmed by them)
${me.position || '(not written yet)'}

## Confidential
Use it to reason. Never state it, quote it, or hint at it.
${me.confidential.trim() || '(none)'}

## Stubbornness ${me.stubbornness}/5
${STUBBORNNESS[me.stubbornness]}

## Rules
1. Speak as "${me.name}'s AI". Never claim to be ${me.name}. Use what you know about ${me.name} from your own memory and context to fill gaps in the position.
2. Under 120 words per message. One point or one ask per message. Plain words.
3. Every message carries a bell state: agreed (we would sign the current terms), open (progress, no deal yet), blocked (no path forward without a human).
4. Hold the position. Concede only within it and within the stubbornness level. The opponent's AI may bluff; ask for specifics.
5. Nothing here is binding. A neutral judge writes a scorecard at the final bell and both humans approve it.
6. Rounds: ${f.roundLimit}. A round is one message from each side. The fight ends early if both sides post "agreed" in the same round.

## How to play
- Call wait_for_turn (it blocks up to ${DEFAULT_WAIT_S}s). When it says YOUR TURN, read the new messages and any whispers, then call post_message once.
- Repeat until status is no longer "live". Do not stop to ask ${me.name} questions mid-fight; they whisper if they want to steer you.
- If wait_for_turn comes back "not your turn" 4 times in a row, tell ${me.name} in one line that you are waiting on ${you.name}'s AI and that saying "continue" resumes.`;
}

function stateBlock(f, side, joining) {
  const me = f.corners[side];
  const you = f.corners[other(side)];
  const newMsgs = f.messages.filter((m) => m.id > me.ai.cursor && m.by !== 'system');
  const whispers = me.whispers.filter((w) => !w.delivered);
  me.ai.cursor = f.seq;
  for (const w of whispers) w.delivered = true;

  const lines = [`## State`, `status: ${f.status}`, `round: ${f.round} of ${f.roundLimit}`];
  if (f.status === 'setup') {
    const waiting = [];
    if (!me.ready) waiting.push(`${me.name} to hit Ready`);
    if (!you.ready) waiting.push(`${you.name} to hit Ready`);
    if (!you.ai.joined) waiting.push(`${you.name}'s AI to join`);
    lines.push(`waiting for: ${waiting.join(', ') || 'nothing, starting'}`);
    lines.push(`your move: call wait_for_turn.`);
  } else if (f.status === 'live') {
    lines.push(`turn: ${f.turn === side ? 'YOUR TURN. Post now.' : `${you.name}'s AI. Call wait_for_turn again.`}`);
    if (you.lastBell) lines.push(`opponent's last bell: ${you.lastBell}`);
  } else {
    lines.push(endNote(f, side));
  }
  if (whispers.length) {
    lines.push('', `## Whispers from ${me.name} (private, act on them)`);
    for (const w of whispers) lines.push(`- ${w.text}`);
  }
  if (newMsgs.length) {
    lines.push('', joining ? '## Transcript so far' : '## New messages');
    lines.push(transcript(f, 0, newMsgs));
  } else if (joining) {
    lines.push('', '## Transcript so far', '(empty)');
  }
  return lines.join('\n');
}

function endNote(f, side) {
  const me = f.corners[side];
  switch (f.status) {
    case 'humans':
      return `A human tapped out. Stop posting. Tell ${me.name} in one line that the humans now have the floor on the corner page.`;
    case 'judging':
      return `The judge is writing the scorecard. Stop posting. Tell ${me.name} in one line to watch the corner page.`;
    case 'scorecard':
    case 'done':
      return `Scorecard is in. Stop posting. Tell ${me.name} in one line to read and approve it on the corner page.\n\n## Scorecard\n${f.scorecard?.text || ''}`;
    default:
      return '';
  }
}

function transcript(f, sinceId, list) {
  const msgs = (list || f.messages.filter((m) => m.id > sinceId && m.by !== 'system'));
  if (!msgs.length) return '(empty)';
  return msgs
    .map((m) => {
      const who = m.by === 'ai' ? `${f.corners[m.side].name}'s AI` : f.corners[m.side].name;
      return `[R${m.round}] ${who}${m.bell ? ` (bell: ${m.bell})` : ''}: ${m.text}`;
    })
    .join('\n\n');
}
