/**
 * test/huawei_router.js
 *
 * Mock HTTP server simulating a Huawei home router (e.g. HG8245H).
 *
 * Real Huawei behaviour:
 *   GET  /                → 302 → /html/index.asp  (no session)
 *                         → 200 Dashboard           (valid session)
 *   GET  /html/index.asp  → 200 login form          (no session)
 *                         → 200 window.location="/" (valid session)
 *   POST /login.cgi       → 302 → /html/index.asp + Set-Cookie on success
 *                         → 403 on bad creds
 *
 * Usage: node test/huawei_router.js
 * Registers itself on process so run_tests.js --spawn can kill it.
 */

'use strict';

const http    = require('http');
const PORT    = parseInt(process.env.HUAWEI_PORT || '8082', 10);
const SESSION = 'HUAWEI_SESSION_TOKEN';

const server = http.createServer((req, res) => {
    const cookies = req.headers.cookie || '';
    const hasSession = cookies.includes(`SessionID=${SESSION}`);
    const url = req.url.split('?')[0];

    // ── GET / ─────────────────────────────────────────────────────────────────
    if (req.method === 'GET' && url === '/') {
        if (hasSession) {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end('<html><body><h1>Huawei Dashboard</h1></body></html>');
        } else {
            res.writeHead(302, { Location: '/html/index.asp' });
            res.end();
        }
        return;
    }

    // ── GET /html/index.asp ───────────────────────────────────────────────────
    if (req.method === 'GET' && url === '/html/index.asp') {
        if (hasSession) {
            // Real Huawei does a JS redirect back to root after login
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(`<html><head><title>Redirecting</title></head><body>
<script>
window.location = "/";
</script>
</body></html>`);
        } else {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(`<html><head><title>Huawei Login</title></head><body>
<form method="POST" action="/login.cgi">
  <input type="text" name="Username" />
  <input type="password" name="Password" />
  <button type="submit">Login</button>
</form>
</body></html>`);
        }
        return;
    }

    // ── POST /login.cgi ───────────────────────────────────────────────────────
    if (req.method === 'POST' && url === '/login.cgi') {
        let body = '';
        req.on('data', c => { body += c; });
        req.on('end', () => {
            const params = new URLSearchParams(body);
            if (params.get('Username') === 'admin' && params.get('Password') === 'admin') {
                res.writeHead(302, {
                    Location: '/html/index.asp',
                    'Set-Cookie': [
                        `Cookie=sid=HW_SID; Path=/; HttpOnly`,
                        `SessionID=${SESSION}; Path=/; HttpOnly`,
                    ],
                });
                res.end();
            } else {
                res.writeHead(403, { 'Content-Type': 'text/html' });
                res.end('<html><body><p>Login failed</p></body></html>');
            }
        });
        return;
    }

    // ── Default 404 ───────────────────────────────────────────────────────────
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end(`404 Not Found: ${req.method} ${req.url}`);
});

server.listen(PORT, '127.0.0.1', () => {
    console.log(`[mock-huawei] Listening on http://127.0.0.1:${PORT}`);
    console.log(`[mock-huawei] Simulates: GET/, GET /html/index.asp, POST /login.cgi`);
});

module.exports = server;
