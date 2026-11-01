// Shared rendering for ringside and corner pages.
const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const STATUS_LABEL = { setup: 'Pre-fight', live: 'Live', humans: 'Humans have the floor', judging: 'Judging', scorecard: 'Scorecard', done: 'Closed' };
const IDLE_MS = 45000;

export function api(path, { method = 'GET', key, body } = {}) {
  return fetch(path, {
    method,
    headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: body ? JSON.stringify(body) : undefined
  }).then(async (r) => {
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.message || r.statusText);
    return j;
  });
}

export function subscribe(code, onState) {
  let es;
  const open = () => {
    es = new EventSource(`/api/fights/${code}/events`);
    es.onmessage = (e) => onState(JSON.parse(e.data));
    es.onerror = () => { es.close(); setTimeout(open, 2000); };
  };
  open();
}

export function renderHeader(f) {
  $('#title').textContent = f.title;
  $('#context').textContent = f.context;
  const b = $('#status');
  b.textContent = STATUS_LABEL[f.status] || f.status;
  b.className = `badge ${f.status}`;
  $('#round').textContent = f.round ? `Round ${f.round} / ${f.roundLimit}` : `${f.roundLimit} rounds`;
}

export function renderCorners(f, mySide) {
  for (const side of ['red', 'blue']) {
    const c = f.corners[side];
    const el = $(`#corner-${side}`);
    const you = side === mySide;
    const other = f.corners[side === 'red' ? 'blue' : 'red'];
    let meta = [];
    meta.push(c.ready ? 'ready' : 'not ready');
    meta.push(c.ai.joined ? `${esc(c.ai.name || 'AI')} in the corner` : 'AI not joined');
    if (c.lastBell) meta.push(`last bell: ${c.lastBell}`);
    if (c.tappedOut) meta.push('tapped out');
    if (f.scorecard && c.approved) meta.push('approved scorecard');
    let nudge = '';
    if (f.status === 'live' && f.turn === side) {
      const idle = f.now - c.ai.lastSeen;
      if (idle > IDLE_MS) {
        nudge = you
          ? `Your AI went quiet. In your chat, say "continue".`
          : `Waiting on ${esc(c.name)}'s AI (${Math.round(idle / 1000)}s). They can nudge it.`;
      } else {
        nudge = you ? `Your AI's turn.` : `${esc(c.name)}'s AI is thinking.`;
      }
    }
    if (f.status === 'setup') {
      if (!c.ai.joined) nudge = you ? 'Connect your AI below.' : `Waiting for ${esc(c.name)}'s AI to join.`;
      else if (!c.ready) nudge = you ? 'Hit Ready when your position is set.' : `Waiting for ${esc(c.name)} to hit Ready.`;
    }
    el.innerHTML = `<div class="name">${esc(c.name)}${you ? ' <span class="hint">(you)</span>' : ''}</div>
      <div class="meta">${meta.join(' · ')}</div>
      ${nudge ? `<div class="nudge">${nudge}</div>` : ''}`;
    void other;
  }
}

export function renderRing(f) {
  const ring = $('#ring');
  const atBottom = ring.scrollHeight - ring.scrollTop - ring.clientHeight < 60;
  ring.innerHTML = f.messages
    .map((m) => {
      if (m.by === 'system') return `<div class="sys">${esc(m.text)}</div>`;
      const c = f.corners[m.side];
      const who = m.by === 'ai' ? `${esc(c.name)}'s AI` : esc(c.name);
      const bell = m.bell ? `<span class="bell ${m.bell}">${m.bell}</span>` : '';
      return `<div class="msg ${m.side} ${m.by}"><div class="who">${who} <span class="hint">R${m.round}</span>${bell}</div>${esc(m.text)}</div>`;
    })
    .join('');
  if (atBottom) ring.scrollTop = ring.scrollHeight;
}

export function renderScorecard(f) {
  const box = $('#scorecard');
  if (!f.scorecard) return box.classList.add('hidden');
  box.classList.remove('hidden');
  const a = f.scorecard.approvals;
  $('#scorecard-body').innerHTML = md(f.scorecard.text);
  $('#approvals').textContent = `Approved by: ${['red', 'blue'].filter((s) => a[s]).map((s) => f.corners[s].name).join(', ') || 'nobody yet'}`;
}

// Tiny markdown: headings, bullets, bold. Input is escaped first.
export function md(src) {
  const lines = esc(src).split('\n');
  let out = '', inList = false;
  const close = () => { if (inList) { out += '</ul>'; inList = false; } };
  for (let l of lines) {
    l = l.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
    if (/^#{1,3}\s/.test(l)) { close(); out += `<h3>${l.replace(/^#+\s/, '')}</h3>`; }
    else if (/^\s*[-*]\s/.test(l)) { if (!inList) { out += '<ul>'; inList = true; } out += `<li>${l.replace(/^\s*[-*]\s/, '')}</li>`; }
    else if (l.trim() === '') close();
    else { close(); out += `<p>${l}</p>`; }
  }
  close();
  return out;
}

export function copyButton(btn, getText) {
  btn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(getText());
      const t = btn.textContent;
      btn.textContent = 'Copied';
      setTimeout(() => (btn.textContent = t), 1200);
    } catch {
      prompt('Copy:', getText());
    }
  });
}
