import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { FightStore, FightError, SIDES, publicState, privateCorner } from './fights.js';
import { buildMcpServer } from './mcp.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT, 10) || 3000;
const store = new FightStore(process.env.SNAPSHOT_FILE || null);

const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '200kb' }));

// ---------- MCP endpoint (stateless: one transport per request) ----------
app.all('/mcp', async (req, res) => {
  const server = buildMcpServer(store);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => {
    transport.close().catch(() => {});
    server.close().catch(() => {});
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    console.error('mcp error', e);
    if (!res.headersSent) res.status(500).json({ error: 'mcp failure' });
  }
});

// ---------- REST for the web pages ----------
const baseUrl = (req) => process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`;

app.post('/api/fights', (req, res) =>
  guard(res, () => {
    const f = store.create(req.body || {});
    res.json({
      code: f.code,
      ringside: `${baseUrl(req)}/f/${f.code}`,
      corners: Object.fromEntries(
        SIDES.map((s) => [s, { name: f.corners[s].name, url: `${baseUrl(req)}/f/${f.code}/${s}#${f.corners[s].token}` }])
      )
    });
  })
);

app.get('/api/fights/:code', (req, res) =>
  guard(res, () => {
    const f = store.get(req.params.code);
    if (!f) throw new FightError('no_such_fight', 'No such fight.');
    res.json(publicState(f));
  })
);

// Corner-private view. Key in the Authorization header.
app.get('/api/fights/:code/corner/:side', (req, res) =>
  guard(res, () => {
    const { f, side } = cornerAuth(req);
    res.json({ ...publicState(f), me: privateCorner(f, side), mcpUrl: `${baseUrl(req)}/mcp` });
  })
);

app.post('/api/fights/:code/corner/:side', (req, res) =>
  guard(res, () => {
    const { f, side } = cornerAuth(req);
    store.updateCorner(f, side, req.body || {});
    res.json({ ok: true });
  })
);

const actions = {
  whisper: (f, side, body) => store.whisper(f, side, body.text),
  tapout: (f, side) => store.tapOut(f, side),
  say: (f, side, body) => store.postHuman(f, side, body.text),
  bell: (f, side) => store.ringBell(f, side),
  approve: (f, side) => store.approve(f, side)
};
app.post('/api/fights/:code/corner/:side/:action', (req, res) =>
  guard(res, () => {
    const { f, side } = cornerAuth(req);
    const fn = actions[req.params.action];
    if (!fn) throw new FightError('bad_action', 'Unknown action.');
    fn(f, side, req.body || {});
    res.json({ ok: true });
  })
);

// Live updates: full public state on every change, heartbeat every 20s.
app.get('/api/fights/:code/events', (req, res) => {
  const f = store.get(req.params.code);
  if (!f) return res.status(404).end();
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  const send = (fight) => res.write(`data: ${JSON.stringify(publicState(fight))}\n\n`);
  send(f);
  const ev = `fight:${f.code}`;
  store.on(ev, send);
  const hb = setInterval(() => res.write(': ping\n\n'), 20000);
  req.on('close', () => {
    clearInterval(hb);
    store.off(ev, send);
  });
});

// ---------- pages ----------
const pub = path.join(__dirname, '..', 'public');
app.use(express.static(pub, { extensions: ['html'] }));
app.get('/f/:code', (_req, res) => res.sendFile(path.join(pub, 'ringside.html')));
app.get('/f/:code/:side', (req, res) => {
  if (!SIDES.includes(req.params.side)) return res.status(404).send('No such corner.');
  res.sendFile(path.join(pub, 'corner.html'));
});
app.get('/healthz', (_req, res) => res.send('ok'));

function cornerAuth(req) {
  const key = (req.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
  const { f, side } = store.auth(req.params.code, key);
  if (side !== req.params.side) throw new FightError('bad_key', 'Key belongs to the other corner.');
  return { f, side };
}

function guard(res, fn) {
  try {
    fn();
  } catch (e) {
    if (e instanceof FightError) return res.status(statusFor(e.code)).json({ error: e.code, message: e.message });
    console.error(e);
    res.status(500).json({ error: 'internal', message: e.message });
  }
}
function statusFor(code) {
  return { no_such_fight: 404, bad_key: 403, bad_input: 400, bad_action: 404 }[code] || 409;
}

app.listen(PORT, '0.0.0.0', () => console.log(`Chat Fight on :${PORT}`));
