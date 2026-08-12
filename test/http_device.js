/**
 * test/http_device.js
 *
 * HTTP mock server simulating various real-world LAN device behaviours.
 * Covers all scenarios exercised by run_tests.js.
 *
 * Usage:
 *   node test/http_device.js
 */

'use strict';

const http = require('http');
const PORT = 8081;
const SELF = `http://127.0.0.1:${PORT}`;

// Handlers receive the full req.url string (path + query) as first argument.
const routes = {

  // ── Root page ──────────────────────────────────────────────────────────────
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

  // ── Dashboard (no <head>, only inline JS) ──────────────────────────────────
  'GET /dashboard': () => ({
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
    body: `<html><body>
<h2>Dashboard</h2>
<script>
  fetch('${SELF}/api/data').then(r => r.json()).then(console.log);
</script>
</body></html>`,
  }),

  // ── Stylesheet ─────────────────────────────────────────────────────────────
  'GET /styles.css': () => ({
    status: 200,
    headers: { 'Content-Type': 'text/css' },
    body: 'body { font-family: sans-serif; background: #f5f5f5; } h1 { color: #333; }',
  }),

  // ── JavaScript with hardcoded absolute URLs ────────────────────────────────
  'GET /app.js': () => ({
    status: 200,
    headers: { 'Content-Type': 'application/javascript' },
    body: `
const BASE = '${SELF}';
async function fetchStatus() {
  const res = await fetch(BASE + '/api/data');
  const json = await res.json();
  console.log('[mock] api response:', json);
}
fetchStatus();
console.log('[mock] app.js loaded');
`,
  }),

  // ── Tiny 1×1 PNG ──────────────────────────────────────────────────────────
  'GET /logo.png': () => ({
    status: 200,
    headers: { 'Content-Type': 'image/png' },
    body: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
      'base64'
    ),
  }),

  // ── Login POST → 302 + Set-Cookie ─────────────────────────────────────────
  'POST /login': () => ({
    status: 302,
    headers: {
      'Location': '/dashboard',
      'Set-Cookie': 'session=abc123; Path=/; HttpOnly',
    },
    body: '',
  }),

  // ── Simple JSON API ────────────────────────────────────────────────────────
  'GET /api/data': () => ({
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      status: 'ok',
      self: `${SELF}/api/data`,
      links: [`${SELF}/dashboard`, `${SELF}/api/status`],
    }),
  }),

  // ── Redirect: absolute self-URL ────────────────────────────────────────────
  // Simulates a device that returns Location: http://192.168.x.x/dashboard
  'GET /redirect/absolute-url': () => ({
    status: 302,
    headers: { 'Location': `${SELF}/dashboard` },
    body: '',
  }),

  // ── Redirect: relative path with query params ──────────────────────────────
  'GET /redirect/with-query': () => ({
    status: 302,
    headers: { 'Location': `/search?q=hello+world&page=2&sort=asc` },
    body: '',
  }),

  // ── Redirect: to external URL (must NOT be rewritten) ─────────────────────
  'GET /redirect/external': () => ({
    status: 302,
    headers: { 'Location': 'https://example.com/login' },
    body: '',
  }),

  // ── Redirect chain: step 1 of 2 ───────────────────────────────────────────
  'GET /redirect/chain-start': () => ({
    status: 302,
    headers: { 'Location': `/redirect/chain-end` },
    body: '',
  }),

  // ── Redirect chain: step 2 of 2 ───────────────────────────────────────────
  'GET /redirect/chain-end': () => ({
    status: 302,
    headers: { 'Location': `/dashboard` },
    body: '',
  }),

  // ── 301 Permanent redirect ─────────────────────────────────────────────────
  'GET /redirect/permanent': () => ({
    status: 301,
    headers: { 'Location': `/dashboard` },
    body: '',
  }),

  // ── Create resource: 201 + Location + JSON body ────────────────────────────
  'POST /api/items': () => ({
    status: 201,
    headers: {
      'Content-Type': 'application/json',
      'Location': `${SELF}/api/items/42`,
    },
    body: JSON.stringify({ id: 42, url: `${SELF}/api/items/42` }),
  }),

  // ── Update resource: 200 + JSON body ──────────────────────────────────────
  'PUT /api/items/1': () => ({
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 1, updated: true, url: `${SELF}/api/items/1` }),
  }),

  // ── Patch resource ────────────────────────────────────────────────────────
  'PATCH /api/items/1': () => ({
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 1, patched: true }),
  }),

  // ── Delete resource: 204 No Content ───────────────────────────────────────
  'DELETE /api/items/42': () => ({
    status: 204,
    headers: {},
    body: '',
  }),

  // ── Nested JSON with URLs ──────────────────────────────────────────────────
  'GET /api/nested': () => ({
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      device: {
        name: 'Mock Device',
        endpoints: {
          status:  `${SELF}/api/status`,
          control: `${SELF}/api/control`,
          ui:      `${SELF}/dashboard`,
        },
      },
      meta: {
        self:      `${SELF}/api/nested`,
        createdAt: '2024-01-01T10:00:00Z',  // ISO date — must NOT be mangled
        version:   '1.0.0',                  // non-URL — must NOT be mangled
        path:      '/api/nested',            // relative path in a string field
      },
    }),
  }),

  // ── Array of objects with URLs ────────────────────────────────────────────
  'GET /api/users': () => ({
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify([
      { id: 1, name: 'Alice', profile: `${SELF}/users/1`, avatar: `${SELF}/avatars/1.png` },
      { id: 2, name: 'Bob',   profile: `${SELF}/users/2`, avatar: `${SELF}/avatars/2.png` },
    ]),
  }),

  // ── Query string echo ──────────────────────────────────────────────────────
  // Returns the parsed query params so the test can verify pass-through fidelity
  'GET /search': (url) => {
    const qs = url.split('?')[1] || '';
    const params = Object.fromEntries(new URLSearchParams(qs));
    return {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ echo: params, raw: qs }),
    };
  },

  // ── HTML with pre-existing <base href="/"> ─────────────────────────────────
  // Proxy must OVERWRITE this base, not leave two <base> tags
  'GET /page/with-base': () => ({
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
    body: `<!DOCTYPE html>
<html>
<head>
  <base href="/">
  <title>Has Own Base</title>
  <link rel="stylesheet" href="/styles.css">
</head>
<body>
  <a href="/about">About</a>
  <img src="/logo.png" alt="logo">
</body>
</html>`,
  }),

  // ── HTML with srcset and <picture> ────────────────────────────────────────
  'GET /page/with-srcset': () => ({
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
    body: `<!DOCTYPE html>
<html>
<head><title>Srcset Test</title></head>
<body>
  <img src="/logo.png"
       srcset="/logo-300.png 300w, /logo-600.png 600w, /logo-1200.png 1200w"
       alt="Responsive logo">
  <picture>
    <source srcset="/banner-mobile.jpg 768w, /banner-desktop.jpg 1440w" type="image/jpeg">
    <img src="/banner.jpg" alt="Banner">
  </picture>
</body>
</html>`,
  }),

  // ── Multiple Set-Cookie headers ────────────────────────────────────────────
  'GET /cookies/multiple': () => ({
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Set-Cookie': [
        'session=abc123; Path=/; HttpOnly; SameSite=Lax',
        'theme=dark; Path=/settings; Max-Age=86400',
        'lang=ru; Domain=127.0.0.1; Path=/; SameSite=Strict',
      ],
    },
    body: '<html><body>Cookies set</body></html>',
  }),

  // ── Cookie without Path attribute ─────────────────────────────────────────
  // Proxy must add Path=/{deviceIp}
  'GET /cookies/no-path': () => ({
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Set-Cookie': 'csrf=tok123; HttpOnly',
    },
    body: '<html><body>CSRF cookie</body></html>',
  }),

  // ── 404 from device ───────────────────────────────────────────────────────
  'GET /not-found': () => ({
    status: 404,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ error: 'Not Found', path: '/not-found' }),
  }),

  // ── Inline JS that redirects to root "/" ───────────────────────────────────
  'GET /page/js-redirect': () => ({
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
    body: `<html><body>
<script>
  setTimeout(() => { location.href = "/"; }, 3000);
  window.location = "/";
  location.replace("/");
</script>
</body></html>`,
  }),

  // ── Canonical link ─────────────────────────────────────────────────────────
  'GET /page/with-canonical': () => ({
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
    body: `<!DOCTYPE html>
<html>
<head>
  <link rel="canonical" href="${SELF}/page/with-canonical">
  <link rel="alternate" href="/rss.xml" type="application/rss+xml">
  <title>Canonical</title>
</head>
<body><p>Canonical page</p></body>
</html>`,
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

  const { status, headers, body } = handler(req.url);
  res.writeHead(status, headers);
  res.end(body);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[mock-device] HTTP server listening on http://127.0.0.1:${PORT}`);
  console.log('[mock-device] Add to Smart Proxy dashboard:');
  console.log('  Name:     Mock Device');
  console.log('  Protocol: http');
  console.log(`  IP:       127.0.0.1:${PORT}`);
});
