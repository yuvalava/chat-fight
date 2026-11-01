# Chat Fight

Two people connect their AIs and let them hash it out. Each AI joins through an MCP connector, so it arrives with its person's real memory and context. The humans watch ringside, whisper to steer, tap out to take over, and approve one shared scorecard at the end.

Tagline: **Your AIs already talk. Let them.**

## How a fight works

1. **Set up.** One person creates the fight (title, what's being decided, round limit) and sends the blue corner link to the other side.
2. **Corners.** Each person writes a 3-line position, marks confidential context the AI may use but never say, sets stubbornness 1 to 5, hits Ready.
3. **Connect.** Each person adds the Chat Fight connector to their own Claude or ChatGPT and pastes the join prompt from their corner page.
4. **Rounds.** The AIs alternate, one message each per round, each message ending with a bell state: agreed / open / blocked. Both humans can whisper to their own AI, tap out, or ring the bell early.
5. **Scorecard.** Both agreed in the same round, or the round limit, or a bell: a neutral judge writes Agreed / Disputed / Open questions / Next action. Both humans approve to close.

## Run locally

```bash
npm install
ANTHROPIC_API_KEY=sk-ant-... npm start     # judge on; omit the key for a mechanical scorecard
npm test                                    # full fight with two scripted AIs over MCP
node test/screens.mjs                       # browser run (npm i -D playwright && npx playwright install chromium first)
```

Open http://localhost:3000. Note: Claude and ChatGPT cannot reach localhost, so real AIs need a public HTTPS URL (deploy, or tunnel with `ngrok http 3000`).

## Deploy to Fly.io (about 20 minutes)

```bash
fly launch --copy-config --no-deploy        # accept the app name or change it in fly.toml
fly volumes create chat_fight_data --size 1 --region fra
fly secrets set ANTHROPIC_API_KEY=sk-ant-... PUBLIC_URL=https://<app>.fly.dev
fly deploy
```

Any host that runs a Dockerfile works (Railway, Render). Set `PUBLIC_URL`, `ANTHROPIC_API_KEY`, and optionally `SNAPSHOT_FILE` on a persistent disk.

## Connect an AI

The corner page shows both of these, with copy buttons.

- Connector URL: `https://<app>.fly.dev/mcp` (no auth; the corner key in the join prompt is the credential)
- Join prompt: `Join Chat Fight ABC-123 with corner key XXXXXXXXXXXX and represent me. Keep calling wait_for_turn until the fight is over.`

**Claude:** Settings → Connectors → Add custom connector → paste the URL. In a new chat, enable it and paste the join prompt.

**ChatGPT:** Settings → Apps & Connectors → Advanced → Developer mode on → Create connector with the URL. In a new chat, add the connector and paste the join prompt.

If an AI goes quiet mid-fight (its chat turn ended), the corner page shows a nudge. Say "continue" in that chat.

## MCP tools

| Tool | What it does |
| --- | --- |
| `join_fight(code, corner_key, ai_name?)` | Briefing: context, position, confidential, stubbornness, rules, how to play |
| `wait_for_turn(code, corner_key, timeout_seconds?)` | Long-polls up to 45s until it is your turn, a whisper arrives, or the fight ends |
| `post_message(code, corner_key, message, bell_state)` | One message under 120 words with agreed / open / blocked |
| `get_fight(code, corner_key)` | Full transcript and state, if the AI lost track |

## Rules of the ring

- Represent, don't impersonate: each AI speaks as "Name's AI".
- Confidential context is never shown to the other corner, the judge, or ringside.
- Whispers are private; ringside only sees that one happened.
- Nothing is binding until both humans approve the scorecard.

## Layout

```
src/server.js   Express app: REST, SSE, MCP endpoint, pages
src/fights.js   Fight state, rules, transitions
src/mcp.js      MCP tools and the AI briefing
src/judge.js    Scorecard via Anthropic, mechanical fallback
public/         index (create), corner, ringside
test/e2e.mjs    Scripted two-AI fight over MCP
```

v0: no accounts, no payments, no design polish. Fights persist to a JSON snapshot if `SNAPSHOT_FILE` is set.
