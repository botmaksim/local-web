/**
 * test/tplink_router.js
 *
 * Mock HTTP server simulating a TP-Link router.
 * Two instances can run simultaneously on different ports with the SAME cookie names,
 * testing that the proxy never mixes sessions between devices.
 *
 * Cookie used: `Authorization=<token>` (same name on all instances).
 *
 * Routes:
 *   GET  /            → 200 login page (no auth) | 200 dashboard (valid auth)
 *   POST /login.htm   → 302 / + Set-Cookie: Authorization=<DEVICE_TOKEN>
 *   GET  /admin/index → 200 dashboard body (valid auth) | 401 Unauthorized
 *   GET  /ping        → 200 {"ip":"<DEVICE_TOKEN>"} — lets tests verify WHICH instance answered
 */

'use strict';

const http = require('http');

const PORT  = parseInt(process.env.TPLINK_PORT  || '8084', 10);
const TOKEN = process.env.TPLINK_TOKEN || `TPLINK_SESSION_${PORT}`;   // unique per instance

const server = http.createServer((req, res) => {
    const cookies = req.headers.cookie || '';
    const hasAuth = cookies.includes(`Authorization=${TOKEN}`);
    const url     = req.url.split('?')[0];

    // ── GET / ─────────────────────────────────────────────────────────────────
    if (req.method === 'GET' && url === '/') {
        if (hasAuth) {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(`<html><body><h1>TP-Link Dashboard (${PORT})</h1></body></html>`);
        } else {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(`<html><body>
<form method="POST" action="/login.htm">
  <input type="text" name="username" />
  <input type="password" name="password" />
  <button type="submit">Login</button>
</form>
</body></html>`);
        }
        return;
    }

    // ── POST /login.htm ───────────────────────────────────────────────────────
    if (req.method === 'POST' && url === '/login.htm') {
        let body = '';
        req.on('data', c => { body += c; });
        req.on('end', () => {
            const p = new URLSearchParams(body);
            if (p.get('username') === 'admin' && p.get('password') === 'admin') {
                // Both TP-Links use the SAME cookie name "Authorization"
                res.writeHead(302, {
                    Location: '/',
                    'Set-Cookie': `Authorization=${TOKEN}; Path=/; HttpOnly`,
                });
                res.end();
            } else {
                res.writeHead(403, { 'Content-Type': 'text/plain' });
                res.end('Forbidden');
            }
        });
        return;
    }

    // ── GET /admin/index → protected resource ────────────────────────────────
    if (req.method === 'GET' && url === '/admin/index') {
        if (hasAuth) {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(`<html><body><h1>TP-Link Admin (${PORT})</h1></body></html>`);
        } else {
            res.writeHead(401, { 'Content-Type': 'text/plain' });
            res.end('Unauthorized');
        }
        return;
    }

    // ── GET /ping → which device answered ────────────────────────────────────
    if (req.method === 'GET' && url === '/ping') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ port: PORT, token: TOKEN, gotCookies: cookies }));
        return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end(`404: ${req.method} ${req.url}`);
});

server.listen(PORT, '127.0.0.1', () => {
    console.log(`[mock-tplink:${PORT}] Listening — token=${TOKEN}`);
});

module.exports = server;
