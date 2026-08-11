/**
 * test/http_device.js
 *
 * HTTP mock server simulating various real-world LAN device behaviours:
 *   - Relative asset paths in HTML (stylesheet, script, image)
 *   - Hardcoded absolute self-URLs in HTML attributes and JS fetch() calls
 *   - Login form with POST redirect (302)
 *   - Set-Cookie header on login
 *   - A JSON API endpoint with self-referencing absolute URLs
 *   - A page that only has inline JS (no <head>) to stress-test <base> injection
 *
 * Usage:
 *   node test/http_device.js
 *
 * Then add device 127.0.0.1:8081 (http) to the proxy dashboard and open it.
 */

'use strict';

const http = require('http');
const PORT = 8081;
const SELF = `http://127.0.0.1:${PORT}`;

const routes = {

  // ── Root page ─────────────────────────────────────────────────────────────
  'GET /': () => ({
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
    body: `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <title>Mock Device</title>
  <link rel="stylesheet" href="/styles.css">
</head>
<body>
  <h1>Mock LAN Device</h1>
  <p>Absolute self-link: <a href="${SELF}/dashboard">Dashboard (abs)</a></p>
  <p>Relative link: <a href="/dashboard">Dashboard (rel)</a></p>
  <img src="/logo.png" alt="logo" width="32" height="32">
  <form action="/login" method="POST">
    <input type="text"     name="user" placeholder="admin">
    <input type="password" name="pass" placeholder="password">
    <button type="submit">Login</button>
  </form>
  <script src="/app.js"></script>
</body>
</html>`,
  }),

  // ── Dashboard page (no <head>, only inline JS) ────────────────────────────
  'GET /dashboard': () => ({
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
    body: `<html><body>
<h2>Dashboard</h2>
<script>
  // Simulates a JS file that uses hardcoded absolute URL
  fetch('${SELF}/api/data').then(r => r.json()).then(console.log);
</script>
</body></html>`,
  }),

  // ── Stylesheet ────────────────────────────────────────────────────────────
  'GET /styles.css': () => ({
    status: 200,
    headers: { 'Content-Type': 'text/css' },
    body: 'body { font-family: sans-serif; background: #f5f5f5; } h1 { color: #333; }',
  }),

  // ── JavaScript ───────────────────────────────────────────────────────────
  'GET /app.js': () => ({
    status: 200,
    headers: { 'Content-Type': 'application/javascript' },
    body: `
// This script uses hardcoded absolute URLs — the proxy must rewrite them.
const BASE = '${SELF}';
async function fetchStatus() {
  const res = await fetch(BASE + '/api/data');
  const json = await res.json();
  console.log('[mock device] api response:', json);
}
fetchStatus();
console.log('[mock device] app.js loaded');
`,
  }),

  // ── Tiny PNG logo ─────────────────────────────────────────────────────────
  'GET /logo.png': () => ({
    status: 200,
    headers: { 'Content-Type': 'image/png' },
    body: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
      'base64'
    ),
  }),

  // ── Login POST → 302 redirect with Set-Cookie ─────────────────────────────
  'POST /login': () => ({
    status: 302,
    headers: {
      'Location': '/dashboard',
      'Set-Cookie': 'session=abc123; Path=/; HttpOnly',
    },
    body: '',
  }),

  // ── JSON API endpoint ─────────────────────────────────────────────────────
  'GET /api/data': () => ({
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      status: 'ok',
      self: `${SELF}/api/data`,       // absolute URL — proxy must rewrite
      links: [
        `${SELF}/dashboard`,
        `${SELF}/api/status`,
      ],
    }),
  }),
};

const server = http.createServer((req, res) => {
  const key = `${req.method} ${req.url.split('?')[0]}`;
  const handler = routes[key];

  if (!handler) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end(`404 Not Found: ${key}`);
    return;
  }

  const { status, headers, body } = handler();
  res.writeHead(status, headers);
  res.end(body);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[mock-device] HTTP server listening on http://127.0.0.1:${PORT}`);
  console.log(`[mock-device] Add to Smart Proxy dashboard:`);
  console.log(`  Name:     Mock Device`);
  console.log(`  Protocol: http`);
  console.log(`  IP:       127.0.0.1:${PORT}`);
});
