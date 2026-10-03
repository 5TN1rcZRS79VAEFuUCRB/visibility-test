// Minimal Chrome DevTools Protocol client using Node's built-in WebSocket (no deps).
// Opens a new foreground tab so the page under test becomes a background tab, holds for a
// while, then exits. run-tests.sh uses this to test the userscript against a genuinely hidden
// tab in headless Chromium -- the one condition that can't be reproduced by loading a page alone.
//
// Usage: node cdp-background.js <remote-debugging-port> <holdMs>
const http = require('http');
const [, , port = '9333', holdMs = '9000'] = process.argv;

const getJSON = (path) => new Promise((res, rej) =>
  http.get({ host: '127.0.0.1', port, path }, (r) => {
    let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => res(JSON.parse(d)));
  }).on('error', rej));

(async () => {
  const ver = await getJSON('/json/version');
  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const send = (method, params = {}) => {
    const i = ++id;
    ws.send(JSON.stringify({ id: i, method, params }));
    return new Promise((r) => pending.set(i, r));
  };
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  });
  await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j); });
  // A new foreground tab pushes the page under test into the background (document.hidden -> true).
  await send('Target.createTarget', { url: 'about:blank' });
  await new Promise((r) => setTimeout(r, +holdMs));
  process.exit(0);
})().catch((e) => { console.error('cdp-background:', e.message); process.exit(1); });
