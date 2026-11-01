// Neutral judge: writes the shared scorecard at the final bell.
// Uses Anthropic if ANTHROPIC_API_KEY is set; otherwise a mechanical fallback.
import Anthropic from '@anthropic-ai/sdk';

export async function writeScorecard(f) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return fallback(f, 'Judge offline (no ANTHROPIC_API_KEY on the server).');

  const client = new Anthropic({ apiKey: key });
  const model = process.env.JUDGE_MODEL || 'claude-sonnet-5-5';
  const r = f.corners.red, b = f.corners.blue;
  const transcript = f.messages
    .filter((m) => m.by !== 'system')
    .map((m) => {
      const who = m.by === 'ai' ? `${f.corners[m.side].name}'s AI` : f.corners[m.side].name;
      const bell = m.bell ? ` [bell: ${m.bell}]` : '';
      return `R${m.round} ${who}${bell}: ${m.text}`;
    })
    .join('\n\n');

  const prompt = `You are the neutral judge of a Chat Fight: two people's AI assistants argued on their behalf. Write the shared scorecard both humans will read. Be concrete, short, and even-handed. Plain words, no praise, no filler. Never use em dashes.

Fight: ${f.title}
What's being decided: ${f.context}
Rounds: ${f.round} of ${f.roundLimit}

${r.name}'s stated position:
${r.position || '(none given)'}

${b.name}'s stated position:
${b.position || '(none given)'}

Transcript:
${transcript || '(no messages)'}

Output exactly this markdown, max 220 words total:

## Agreed
- (what both sides accepted; "Nothing yet" if none)

## Disputed
- (where they still differ, one line each)

## Open questions
- (things neither AI could answer and a human must)

## Next action
- **${r.name}:** one action, under 2 minutes if possible
- **${b.name}:** one action, under 2 minutes if possible`;

  const res = await client.messages.create({
    model,
    max_tokens: 700,
    messages: [{ role: 'user', content: prompt }]
  });
  const text = res.content
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n')
    .trim();
  return text || fallback(f, 'Judge returned nothing.');
}

function fallback(f, why) {
  const r = f.corners.red, b = f.corners.blue;
  const ai = f.messages.filter((m) => m.by === 'ai');
  const rounds = [...new Set(ai.map((m) => m.round))].map((n) => {
    const rr = ai.find((m) => m.round === n && m.side === 'red');
    const bb = ai.find((m) => m.round === n && m.side === 'blue');
    return `- Round ${n}: ${r.name} ${rr?.bell || '-'}, ${b.name} ${bb?.bell || '-'}`;
  });
  const last = (side) => ai.filter((m) => m.side === side).at(-1)?.text || '(nothing)';
  return `## Scorecard (mechanical)
${why}

## Bell states
${rounds.join('\n') || '- No rounds played'}

## Last word
- **${r.name}'s AI:** ${last('red')}
- **${b.name}'s AI:** ${last('blue')}

## Next action
- **${r.name}:** read the transcript and reply to the open points
- **${b.name}:** same`;
}
