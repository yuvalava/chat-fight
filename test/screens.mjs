// Drives the web pages with Playwright through a short fight and saves screenshots to test/shots/.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { chromium } from 'playwright';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const PORT = 3124, BASE = `http://localhost:${PORT}`;
fs.mkdirSync('test/shots', { recursive: true });
const srv = spawn('node', ['src/server.js'], { env: { ...process.env, PORT, ANTHROPIC_API_KEY: '' }, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((r) => srv.stdout.on('data', (d) => d.toString().includes('Chat Fight on') && r()));
const mcp = async () => { const c = new Client({ name: 'fake', version: '0' }); await c.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`))); return c; };
const call = async (c, name, args) => { const r = await c.callTool({ name, arguments: args }); if (r.isError) throw new Error(r.content[0].text); return r.content[0].text; };

const browser = await chromium.launch();
const errors = [];
const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => m.type() === 'error' && errors.push(`console: ${m.text()}`));
try {
  // Create a fight through the form.
  await page.goto(BASE);
  await page.fill('#title', 'Pilot pricing for Acme');
  await page.fill('#context', 'Acme wants a 30-day pilot. We quoted $5k/mo. Decide pilot terms and price.');
  await page.fill('#red', 'Yuval');
  await page.fill('#blue', 'Dana');
  await page.click('button[type=submit]');
  await page.waitForSelector('#made:not(.hidden)');
  await page.screenshot({ path: 'test/shots/1-created.png' });
  const blueUrl = await page.inputValue('#blueUrl');
  const redUrl = await page.$eval('#goRed', (a) => a.href);
  const code = await page.textContent('#code');
  const keyR = redUrl.split('#')[1], keyB = blueUrl.split('#')[1];

  // Red corner: fill position, ready.
  await page.goto(redUrl);
  await page.waitForSelector('#mcpUrl');
  await page.fill('#position', 'Paid pilot: $2k for 30 days, credited against year one.');
  await page.fill('#confidential', 'Walk-away is $1k.');
  await page.click('#ready');
  await page.waitForFunction(() => document.querySelector('#ready').textContent === 'Not ready');
  await page.screenshot({ path: 'test/shots/2-corner-setup.png', fullPage: true });
  if (!(await page.inputValue('#joinPrompt')).includes(code)) throw new Error('join prompt missing code');

  // Blue corner via API and both AIs join.
  const api = (p, body) => fetch(BASE + p, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${keyB}` }, body: JSON.stringify(body || {}) });
  await api(`/api/fights/${code}/corner/blue`, { position: 'Free pilot or no deal.', ready: true });
  const red = await mcp(), blue = await mcp();
  await call(red, 'join_fight', { code, corner_key: keyR, ai_name: 'Claude' });
  await call(blue, 'join_fight', { code, corner_key: keyB, ai_name: 'ChatGPT' });
  await call(red, 'post_message', { code, corner_key: keyR, message: 'Paid pilot at $2k, credited to year one. Free pilots get deprioritized on our side; paid ones get an SLA.', bell_state: 'open' });
  await call(blue, 'post_message', { code, corner_key: keyB, message: 'Dana has no budget until Q1. Free 30 days, decision committed by Jan 15.', bell_state: 'open' });

  // Whisper from the red corner page.
  await page.fill('#whisper', "Don't go below $1.5k.");
  await page.click('#sendWhisper');
  await page.waitForFunction(() => document.querySelector('#whispers').textContent.includes('1.5k'));
  await page.waitForFunction(() => document.querySelectorAll('.msg').length >= 2);
  await page.screenshot({ path: 'test/shots/3-corner-live.png', fullPage: true });

  // Finish the fight: both agree.
  await call(red, 'post_message', { code, corner_key: keyR, message: '$1.5k, 30 days, credited, decision by Jan 15.', bell_state: 'agreed' });
  await call(blue, 'post_message', { code, corner_key: keyB, message: 'Deal at $1.5k if the SLA is included.', bell_state: 'agreed' });
  await page.waitForSelector('#scorecard:not(.hidden)');
  await page.click('#approve');
  await page.waitForFunction(() => document.querySelector('#approvals').textContent.includes('Yuval'));
  await page.screenshot({ path: 'test/shots/4-corner-scorecard.png', fullPage: true });

  // Ringside.
  await page.goto(`${BASE}/f/${code}`);
  await page.waitForFunction(() => document.querySelectorAll('.msg').length >= 4);
  await page.screenshot({ path: 'test/shots/5-ringside.png', fullPage: true });

  if (errors.length) throw new Error(errors.join('\n'));
  console.log('screens: ok', code);
} catch (e) {
  console.error('screens FAILED', e);
  process.exitCode = 1;
} finally {
  await browser.close();
  srv.kill();
}
