# Chat Fight: context for Claude Code

Read this first. It is the handoff from the claude.ai session that built v0 (1 Nov 2026).

## What this is
Two people connect their AIs and let them argue it out, each AI carrying its person's context, role and goals. Humans watch ringside, whisper to steer, tap out to take over, and approve one shared scorecard. Tagline: "Your AIs already talk. Let them."
Side project of Yuval (BD at Magma Devs). Public app, not internal. Proposal doc: https://claude.ai/artifact/QYgpK9RWVTNSYvAxxRWHSj

## Decisions already made (do not reopen without asking)
- Name: Chat Fight. Rejected: Claude Fight (trademark, vendor lock), Proxy Fight, Backchannel, Seconds.
- One game, no modes. Title + context set the stance (brainstorm, sales call, negotiation, scoping, hiring screen all use the same engine).
- Bring your own AI via MCP connector only. No API-wrapper corners. Reason: no vendor lets a third-party app read a user's memory; "Sign in with ChatGPT" / Claude OAuth give identity and billing, not memory. The user's own chat app must be the client.
- Claude first, ChatGPT second. Same MCP server serves both, so Claude-only saves nothing.
- Scorecard by a neutral judge (Anthropic API, `ANTHROPIC_API_KEY`), mechanical fallback without a key.
- Live ringside (not async). Humans approve the scorecard; nothing binding.
- No accounts, no SSO in v0. Per-corner secret keys in the link hash are the credential.
- Host: Fly.io (Dockerfile + fly.toml in repo). Railway/Render also work from the Dockerfile.
- v0 ships all features, no design polish.

## Architecture
Node 22, plain ESM JS, no build step. Express 5 + `@modelcontextprotocol/sdk` (Streamable HTTP, stateless, `enableJsonResponse`) + `@anthropic-ai/sdk`.

- `src/server.js`: REST, SSE (`/api/fights/:code/events`), MCP at `POST /mcp`, static pages. Corner auth = `Authorization: Bearer <corner key>`.
- `src/fights.js`: state + rules. Statuses: setup → live → (humans | judging) → scorecard → done. A round = one message per side, strict alternation (red always opens). Both "agreed" in the same round, round limit, or a human ringing the bell → judging. Tap-out → `humans` (AIs stop, humans type, either rings the bell). Whispers are private to a corner; ringside only sees that one happened. Confidential text never leaves the corner (not to opponent, judge, or ringside).
- `src/mcp.js`: tools `join_fight`, `wait_for_turn` (long-poll, default 25s, max 45s), `post_message` (bell_state agreed/open/blocked), `get_fight`. `briefing()` is the AI's system-style instructions; `stateBlock()` is what every call returns.
- `src/judge.js`: scorecard prompt (Agreed / Disputed / Open questions / Next action per human). Model from `JUDGE_MODEL`, default `claude-sonnet-5-5`.
- `public/`: `index.html` (create), `corner.html` (the main UI per human: position, confidential, stubbornness 1-5, ready, connector URL + join prompt, whisper, tap out, bell, approve), `ringside.html` (read-only). `app.js` shared rendering, `app.css`.
- State is in memory; optional JSON snapshot via `SNAPSHOT_FILE`. Fly config keeps one machine running because `wait_for_turn` holds connections.

## Status (5 Nov 2026)
- v0 code complete and on `main`.
- `npm test` (test/e2e.mjs): two scripted AIs over MCP, whispers, tap-out, bell, round limit, scorecard, approvals. Passes.
- `node test/screens.mjs`: Playwright run of all pages, no console errors. Passes (needs `npm i -D playwright && npx playwright install chromium`).
- NOT yet done: run against a real Claude.ai or ChatGPT connector. NOT deployed.

## Next steps, in order
1. Local play: `npm install`, `npx cloudflared tunnel --url http://localhost:3000` in a second terminal, then `PUBLIC_URL=<tunnel url> ANTHROPIC_API_KEY=... npm start`. Add `<tunnel url>/mcp` as a custom connector in Claude, open two chats, paste the red and blue join prompts from the corner pages. Yuval playing both sides is enough to test mechanics.
2. Deploy: `fly launch --copy-config --no-deploy`, `fly volumes create chat_fight_data --size 1 --region fra`, `fly secrets set ANTHROPIC_API_KEY=... PUBLIC_URL=https://<app>.fly.dev`, `fly deploy`.
3. First real fight with a second person.

## Known unknowns (the first real fight answers these)
- Does Claude.ai keep calling `wait_for_turn` across rounds inside one chat turn, or does it stop and need "continue"? The corner page shows a "nudge" after 45s idle. If it stops every round, consider shorter rounds or a `wait_for_turn` that returns faster with a "call me again" hint.
- Claude.ai's tool-call timeout vs the 25s long-poll. If calls time out, lower `DEFAULT_WAIT_S` in `src/mcp.js`.
- ChatGPT developer-mode connectors with no auth: untested.
- Whether Claude.ai custom connectors are available on Yuval's plan. The corner page assumes yes.

## Ideas parked for v1
Hosted Claude corner as fallback (paste context, no memory). Accounts / SSO. Async fights (AIs run overnight). Fight history per counterpart. Cross-vendor via an agent-to-agent protocol.

## How Yuval wants to work
- Shortest possible replies. Lead with the next concrete action. Number multi-step work, one bounded action per step, max 5 items. End with one next action under 2 minutes.
- No preamble, no recaps, no pleasantries. Direct; disagree when you disagree.
- Never use em dashes. Use a hyphen, comma, or a new sentence.
- Ask clarifying questions when a wrong guess is expensive; otherwise just do it.
- He is not an engineer by trade. Give exact commands, not descriptions of commands.
