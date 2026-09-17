/**
 * test/openwrt_router.js
 *
 * Mock HTTP server simulating an OpenWrt router.
 *
 * Real OpenWrt behaviour (LuCI):
 *   GET  /           → 200 login form
 *   POST /?form=login → 200 + Set-Cookie: sysauth=... on success, 403 on fail
 *   GET  /cgi-bin/luci/ → 200 Dashboard if sysauth cookie present, else 403
 *
 * Usage: node test/openwrt_router.js
 */

'use strict';

const http = require('http');
const PORT  = parseInt(process.env.OPENWRT_PORT || '8083', 10);
const TOKEN = 'OW_SYSAUTH_TOKEN';

const server = http.createServer((req, res) => {
    const cookies = req.headers.cookie || '';
    const hasAuth = cookies.includes(`sysauth=${TOKEN}`);
    const url     = req.url.split('?')[0];
    const qs      = req.url.includes('?') ? req.url.split('?')[1] : '';

    // ── GET / → login page ───────────────────────────────────────────────────
    if (req.method === 'GET' && url === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<html><head><title>OpenWrt Login</title></head><body>
<form method="POST" action="/?form=login">
  <input type="text" name="username" />
  <input type="password" name="password" />
  <button type="submit">Login</button>
</form>
</body></html>`);
        return;
    }

    // ── POST /?form=login ────────────────────────────────────────────────────
    if (req.method === 'POST' && qs === 'form=login') {
        let body = '';
        req.on('data', c => { body += c; });
        req.on('end', () => {
            const params = new URLSearchParams(body);
            if (params.get('username') === 'root' && params.get('password') === 'password') {
                res.writeHead(200, {
                    'Content-Type': 'application/json',
                    'Set-Cookie': `sysauth=${TOKEN}; Path=/; HttpOnly`,
                });
                res.end(JSON.stringify({ result: 'ok' }));
            } else {
                res.writeHead(403, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ result: 'fail', reason: 'wrong credentials' }));
            }
        });
        return;
    }

    // ── GET /cgi-bin/luci/ → dashboard (protected) ──────────────────────────
    if (req.method === 'GET' && url === '/cgi-bin/luci/') {
        if (hasAuth) {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end('<html><body><h1>OpenWrt Dashboard</h1></body></html>');
        } else {
            res.writeHead(403, { 'Content-Type': 'text/plain' });
            res.end('Forbidden');
        }
        return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end(`404 Not Found: ${req.method} ${req.url}`);
});

server.listen(PORT, '127.0.0.1', () => {
    console.log(`[mock-openwrt] Listening on http://127.0.0.1:${PORT}`);
});

module.exports = server;
