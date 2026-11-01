// End-to-end: boots the server, runs a full fight with two scripted "AIs" over MCP.
// Usage: node test/e2e.mjs   (no API key needed; judge falls back to the mechanical scorecard)
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const PORT = 3123;
const BASE = `http://localhost:${PORT}`;
const srv = spawn('node', ['src/server.js'], { env: { ...process.env, PORT, ANTHROPIC_API_KEY: '' }, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((r) => srv.stdout.on('data', (d) => d.toString().includes('Chat Fight on') && r()));

const api = async (path, { method = 'GET', key, body } = {}) => {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${json.message}`);
  return json;
};

async function mcpClient() {
  const c = new Client({ name: 'fake-ai', version: '0' });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`)));
  return c;
}
const call = async (c, name, args) => {
  const r = await c.callTool({ name, arguments: args });
  const t = r.content.map((x) => x.text).join('\n');
  if (r.isError) throw new Error(`${name}: ${t}`);
  return t;
};

try {
  // ---- scenario 1: a fight that ends by mutual agreement in round 3 ----
  const made = await api('/api/fights', { method: 'POST', body: { title: 'Pricing for the pilot', context: 'Vendor wants $5k/mo. Buyer wants a free 30-day pilot.', red: 'Yuval', blue: 'Dana', roundLimit: 5 } });
  const code = made.code;
  const keyR = made.corners.red.url.split('#')[1];
  const keyB = made.corners.blue.url.split('#')[1];
  assert.match(code, /^[A-Z2-9]{3}-[A-Z2-9]{3}$/);

  const red = await mcpClient();
  const blue = await mcpClient();
  const tools = (await red.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(tools, ['get_fight', 'join_fight', 'post_message', 'wait_for_turn']);

  // Join before humans are ready: must be told to wait.
  let out = await call(red, 'join_fight', { code, corner_key: keyR, ai_name: 'Claude' });
  assert.match(out, /status: setup/);
  assert.match(out, /Yuval to hit Ready/);

  await assert.rejects(call(red, 'join_fight', { code, corner_key: 'WRONG' }), /bad_key/);

  // Red can't be ready without a position.
  await assert.rejects(api(`/api/fights/${code}/corner/red`, { method: 'POST', key: keyR, body: { ready: true } }), /position/);

  await api(`/api/fights/${code}/corner/red`, { method: 'POST', key: keyR, body: { position: 'Pilot is fine, but paid: $2k for 30 days, credited to year one.', confidential: 'Walk-away is $1k.', stubbornness: 4, ready: true } });
  await api(`/api/fights/${code}/corner/blue`, { method: 'POST', key: keyB, body: { position: 'Free pilot or no deal. Budget opens in Q1.', stubbornness: 2, ready: true } });

  // Not live until blue's AI joins.
  let st = await api(`/api/fights/${code}`);
  assert.equal(st.status, 'setup');
  out = await call(blue, 'join_fight', { code, corner_key: keyB, ai_name: 'ChatGPT' });
  assert.match(out, /status: live/);
  assert.match(out, /turn: Yuval's AI\. Call wait_for_turn again/); // not blue's turn
  assert.doesNotMatch(out, /Walk-away/); // blue never sees red's confidential

  // wait_for_turn wakes red immediately; blue blocks until red posts.
  out = await call(red, 'wait_for_turn', { code, corner_key: keyR, timeout_seconds: 5 });
  assert.match(out, /YOUR TURN/);
  await assert.rejects(call(blue, 'post_message', { code, corner_key: keyB, message: 'x', bell_state: 'open' }), /not_your_turn/);

  const t0 = Date.now();
  const blueWait = call(blue, 'wait_for_turn', { code, corner_key: keyB, timeout_seconds: 10 });
  await new Promise((r) => setTimeout(r, 300));
  await call(red, 'post_message', { code, corner_key: keyR, message: 'Paid pilot, $2k, credited to year one.', bell_state: 'open' });
  out = await blueWait;
  assert.ok(Date.now() - t0 < 3000, 'blue should wake as soon as red posts');
  assert.match(out, /YOUR TURN/);
  assert.match(out, /Paid pilot, \$2k/);

  // Human whispers to blue mid-fight; blue's next wait returns it, ringside shows only that it happened.
  await api(`/api/fights/${code}/corner/blue/whisper`, { method: 'POST', key: keyB, body: { text: 'Offer $1k max.' } });
  out = await call(blue, 'wait_for_turn', { code, corner_key: keyB, timeout_seconds: 2 });
  assert.match(out, /Whispers from Dana[\s\S]*Offer \$1k max/);
  st = await api(`/api/fights/${code}`);
  assert.ok(st.messages.some((m) => m.by === 'system' && /Dana whispered/.test(m.text)));
  assert.ok(!JSON.stringify(st).includes('Offer $1k max'), 'whisper text must not leak ringside');

  await call(blue, 'post_message', { code, corner_key: keyB, message: 'We can do $1k for the pilot.', bell_state: 'open' });
  st = await api(`/api/fights/${code}`);
  assert.equal(st.round, 2);
  assert.equal(st.turn, 'red', 'messages alternate strictly, so red opens every round');

  await call(red, 'post_message', { code, corner_key: keyR, message: '$1.5k meets in the middle.', bell_state: 'open' });
  await call(blue, 'post_message', { code, corner_key: keyB, message: '$1k, 30 days, credited.', bell_state: 'agreed' });
  st = await api(`/api/fights/${code}`);
  assert.equal(st.status, 'live', 'one side agreeing is not a bell');
  assert.equal(st.round, 3);
  await call(red, 'post_message', { code, corner_key: keyR, message: 'Fine, $1k credited to year one.', bell_state: 'agreed' });
  await call(blue, 'post_message', { code, corner_key: keyB, message: 'Deal.', bell_state: 'agreed' });

  // Both agreed in round 3 -> judging -> scorecard (mechanical fallback, no key).
  await new Promise((r) => setTimeout(r, 200));
  st = await api(`/api/fights/${code}`);
  assert.equal(st.status, 'scorecard');
  assert.match(st.scorecard.text, /Scorecard \(mechanical\)/);
  assert.match(st.scorecard.text, /Round 3: Yuval agreed, Dana agreed/);

  // AI learns it is over and gets the scorecard.
  out = await call(red, 'wait_for_turn', { code, corner_key: keyR, timeout_seconds: 2 });
  assert.match(out, /Scorecard is in/);
  await assert.rejects(call(red, 'post_message', { code, corner_key: keyR, message: 'more', bell_state: 'open' }), /not_live/);

  await api(`/api/fights/${code}/corner/red/approve`, { method: 'POST', key: keyR });
  st = await api(`/api/fights/${code}`);
  assert.equal(st.status, 'scorecard');
  await api(`/api/fights/${code}/corner/blue/approve`, { method: 'POST', key: keyB });
  st = await api(`/api/fights/${code}`);
  assert.equal(st.status, 'done');

  // ---- scenario 2: tap-out, humans talk, ring the bell ----
  const m2 = await api('/api/fights', { method: 'POST', body: { title: 'Roadmap', context: 'Ship search or ship billing first?', red: 'PM', blue: 'Eng', roundLimit: 2 } });
  const k2r = m2.corners.red.url.split('#')[1], k2b = m2.corners.blue.url.split('#')[1];
  await api(`/api/fights/${m2.code}/corner/red`, { method: 'POST', key: k2r, body: { position: 'Search first.', ready: true } });
  await api(`/api/fights/${m2.code}/corner/blue`, { method: 'POST', key: k2b, body: { position: 'Billing first.', ready: true } });
  await call(red, 'join_fight', { code: m2.code, corner_key: k2r });
  await call(blue, 'join_fight', { code: m2.code, corner_key: k2b });
  await call(red, 'post_message', { code: m2.code, corner_key: k2r, message: 'Search first, revenue follows usage.', bell_state: 'open' });
  const blueWait2 = call(blue, 'wait_for_turn', { code: m2.code, corner_key: k2b, timeout_seconds: 10 });
  await api(`/api/fights/${m2.code}/corner/red/tapout`, { method: 'POST', key: k2r });
  out = await blueWait2;
  assert.match(out, /humans now have the floor/);
  await assert.rejects(call(blue, 'post_message', { code: m2.code, corner_key: k2b, message: 'x', bell_state: 'open' }), /not_live/);
  await api(`/api/fights/${m2.code}/corner/blue/say`, { method: 'POST', key: k2b, body: { text: 'Billing is blocking two customers.' } });
  await api(`/api/fights/${m2.code}/corner/red/bell`, { method: 'POST', key: k2r });
  await new Promise((r) => setTimeout(r, 200));
  st = await api(`/api/fights/${m2.code}`);
  assert.equal(st.status, 'scorecard');
  assert.ok(st.messages.some((m) => m.by === 'human' && /two customers/.test(m.text)));

  // Round limit ends a fight too.
  const m3 = await api('/api/fights', { method: 'POST', body: { title: 'Short', context: 'x', roundLimit: 1 } });
  const k3r = m3.corners.red.url.split('#')[1], k3b = m3.corners.blue.url.split('#')[1];
  await api(`/api/fights/${m3.code}/corner/red`, { method: 'POST', key: k3r, body: { position: 'a', ready: true } });
  await api(`/api/fights/${m3.code}/corner/blue`, { method: 'POST', key: k3b, body: { position: 'b', ready: true } });
  await call(red, 'join_fight', { code: m3.code, corner_key: k3r });
  await call(blue, 'join_fight', { code: m3.code, corner_key: k3b });
  await call(red, 'post_message', { code: m3.code, corner_key: k3r, message: 'a', bell_state: 'blocked' });
  await call(blue, 'post_message', { code: m3.code, corner_key: k3b, message: 'b', bell_state: 'open' });
  await new Promise((r) => setTimeout(r, 200));
  st = await api(`/api/fights/${m3.code}`);
  assert.equal(st.status, 'scorecard');

  // SSE delivers state.
  const sse = await fetch(`${BASE}/api/fights/${code}/events`);
  const reader = sse.body.getReader();
  const chunk = new TextDecoder().decode((await reader.read()).value);
  assert.match(chunk, /^data: \{"code":"/);
  reader.cancel();

  console.log('e2e: all good');
  process.exitCode = 0;
} catch (e) {
  console.error('e2e FAILED:', e);
  process.exitCode = 1;
} finally {
  srv.kill();
}
