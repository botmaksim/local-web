'use strict';
/**
 * test-integration.js — Integration test for smart-proxy
 *
 * Simulates OpenWrt + Huawei routers and runs assertions through the proxy.
 * Run: node test-integration.js
 */

const http         = require('http');
const express      = require('express');
const cookieParser = require('cookie-parser');
const path         = require('path');
const fs           = require('fs');

// ─── colours ─────────────────────────────────────────────────────────────────
const OK   = s => `\x1b[32m✓ ${s}\x1b[0m`;
const FAIL = s => `\x1b[31m✗ ${s}\x1b[0m`;
const INFO = s => `\x1b[33m  ${s}\x1b[0m`;
let passed = 0, failed = 0;
function assert(cond, msg) { if (cond) { console.log(OK(msg)); passed++; } else { console.log(FAIL(msg)); failed++; } }
function heading(s) { console.log(`\n\x1b[36m── ${s} ${'─'.repeat(Math.max(0,50-s.length))}\x1b[0m`); }

// ─── HTTP helper (no follow-redirect) ────────────────────────────────────────
function httpReq(options, body = null) {
    return new Promise((resolve, reject) => {
        const r = http.request(options, res => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
        });
        r.on('error', reject);
        if (body) r.write(body);
        r.end();
    });
}

// ─── Fake routers ─────────────────────────────────────────────────────────────
function startOpenWrt(port) {
    const app = express();
    app.use(express.urlencoded({ extended: true }));

    app.get('/', (_req, res) =>
        res.send('<html><body><form method="POST" action="/?form=login">' +
                 '<input name="username"/><input name="password" type="password"/>' +
                 '<button>Login</button></form></body></html>'));

    app.post('/', (req, res) => {
        const { username, password } = req.body || {};
        if (username === 'root' && password === 'password') {
            res.setHeader('Set-Cookie', 'sysauth=OPENWRT_SESSION_ABC; Path=/; HttpOnly');
            res.status(200).json({ result: 'ok' });
        } else { res.status(403).json({ error: 'bad creds' }); }
    });

    app.get('/cgi-bin/luci/', (req, res) => {
        if ((req.headers.cookie || '').includes('sysauth=OPENWRT_SESSION_ABC'))
            res.send('<html><body><h1>OpenWrt Dashboard</h1></body></html>');
        else res.status(403).send('Forbidden');
    });

    return new Promise(r => { const s = app.listen(port, () => { console.log(INFO(`Fake OpenWrt :${port}`)); r(s); }); });
}

function startHuawei(port) {
    const app = express();

    app.get('/', (req, res) => {
        if ((req.headers.cookie || '').includes('SessionID=HUAWEI_SESSION_XYZ'))
            res.send('<html><body><h1>Huawei Dashboard</h1></body></html>');
        else res.redirect(302, '/html/index.asp');
    });

    app.get('/html/index.asp', (req, res) => {
        if ((req.headers.cookie || '').includes('SessionID=HUAWEI_SESSION_XYZ'))
            // Real Huawei does a bare JS redirect to "/"
            res.send('<html><body><script>window.location = "/";</script></body></html>');
        else
            res.send('<html><body><form method="POST" action="/login.cgi">' +
                     '<input name="Username"/><input name="Password" type="password"/>' +
                     '<button>Login</button></form></body></html>');
    });

    app.post('/login.cgi', express.urlencoded({ extended: true }), (req, res) => {
        const { Username, Password } = req.body || {};
        if (Username === 'admin' && Password === 'admin') {
            res.setHeader('Set-Cookie', [
                'Cookie=sid=HUAWEI_SID; Path=/; HttpOnly',
                'SessionID=HUAWEI_SESSION_XYZ; Path=/; HttpOnly',
            ]);
            res.redirect(302, '/html/index.asp');
        } else { res.status(403).send('Forbidden'); }
    });

    return new Promise(r => { const s = app.listen(port, () => { console.log(INFO(`Fake Huawei :${port}`)); r(s); }); });
}

// ─── Proxy setup ──────────────────────────────────────────────────────────────
function startProxy(port, devices) {
    // Write devices before requiring proxy so getDevices() picks them up fresh
    const dataDir = path.join(__dirname, 'data');
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir);
    fs.writeFileSync(path.join(dataDir, 'devices.json'), JSON.stringify(devices));

    const { proxyRouter } = require('./src/proxy');
    const app = express();
    app.use(cookieParser());
    app.use(proxyRouter);
    app.use((_req, res) => res.status(200).send('<html><body>SPA Dashboard</body></html>'));
    return new Promise(r => { const s = app.listen(port, () => { console.log(INFO(`Proxy :${port}`)); r(s); }); });
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function run() {
    const OW_PORT = 18080, HW_PORT = 18081, P_PORT = 19090;
    const owIp = `127.0.0.1:${OW_PORT}`, hwIp = `127.0.0.1:${HW_PORT}`;

    let ow, hw, px;
    try {
        ow = await startOpenWrt(OW_PORT);
        hw = await startHuawei(HW_PORT);
        px = await startProxy(P_PORT, [
            { id: '1', name: 'OpenWrt', ip: owIp, protocol: 'http' },
            { id: '2', name: 'Huawei',  ip: hwIp, protocol: 'http' },
        ]);

        // ── 1. Direct sanity ──────────────────────────────────────────────────
        heading('1. Direct router sanity');

        const d1 = await httpReq({ host: '127.0.0.1', port: OW_PORT, path: '/' });
        assert(d1.status === 200 && d1.body.includes('form'), 'OpenWrt: GET / → login form');

        const d2 = await httpReq({ host: '127.0.0.1', port: OW_PORT, path: '/?form=login', method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }, 'username=root&password=password');
        assert(d2.status === 200, 'OpenWrt: correct login → 200');
        assert((d2.headers['set-cookie'] || []).some(c => c.includes('sysauth=')), 'OpenWrt: sets sysauth cookie');

        const d3 = await httpReq({ host: '127.0.0.1', port: HW_PORT, path: '/login.cgi', method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }, 'Username=admin&Password=admin');
        assert(d3.status === 302, 'Huawei: correct login → 302');
        assert((d3.headers['set-cookie'] || []).some(c => c.includes('SessionID=')), 'Huawei: sets SessionID cookie');

        // ── 2. Proxy – OpenWrt ────────────────────────────────────────────────
        heading('2. Proxy – OpenWrt');

        const p1 = await httpReq({ host: '127.0.0.1', port: P_PORT, path: `/${owIp}/` });
        assert(p1.status === 200 && p1.body.includes('form'), 'GET /{owIp}/ → login form');

        const lb = 'username=root&password=password';
        const p2 = await httpReq({ host: '127.0.0.1', port: P_PORT, path: `/${owIp}/?form=login`, method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': lb.length } }, lb);
        assert(p2.status === 200, 'POST /{owIp}/?form=login → 200');
        const p2c = p2.headers['set-cookie'] || [];
        assert(p2c.some(c => c.includes('sysauth=OPENWRT_SESSION_ABC')), 'Response has sysauth cookie');
        assert(p2c.some(c => c.includes('sp_active_device')), 'Response has sp_active_device');
        const sysauthLine = p2c.find(c => c.includes('sysauth=')) || '';
        assert(sysauthLine.toLowerCase().includes('path=/'), 'sysauth cookie has Path=/');

        const p3 = await httpReq({ host: '127.0.0.1', port: P_PORT, path: `/${owIp}/cgi-bin/luci/`,
            headers: { Cookie: `sysauth=OPENWRT_SESSION_ABC; sp_active_device=${encodeURIComponent(owIp)}` } });
        assert(p3.status === 200 && p3.body.includes('Dashboard'), 'GET /{owIp}/cgi-bin/luci/ with sysauth → 200 Dashboard');

        const p4 = await httpReq({ host: '127.0.0.1', port: P_PORT, path: `/${owIp}/cgi-bin/luci/` });
        assert(p4.status === 403, 'GET /{owIp}/cgi-bin/luci/ without cookies → 403');

        // ── 3. SPA routing ────────────────────────────────────────────────────
        heading('3. Proxy – SPA routing');

        const s1 = await httpReq({ host: '127.0.0.1', port: P_PORT, path: '/' });
        assert(s1.status === 200 && s1.body.includes('SPA Dashboard'), 'GET / without device → SPA');

        const s2 = await httpReq({ host: '127.0.0.1', port: P_PORT, path: '/',
            headers: { Cookie: `sp_active_device=${encodeURIComponent(owIp)}` } });
        assert(s2.status === 200 && s2.body.includes('SPA Dashboard'),
               'GET / with device cookie but NO referer → SPA');

        const s3 = await httpReq({ host: '127.0.0.1', port: P_PORT, path: '/', headers: {
            Cookie: `sysauth=OPENWRT_SESSION_ABC; sp_active_device=${encodeURIComponent(owIp)}`,
            Referer: `http://127.0.0.1:${P_PORT}/${owIp}/cgi-bin/luci/`,
        }});
        assert(s3.status === 200 && s3.body.includes('form'),
               'GET / with IP-prefix Referer → proxied to router root (not SPA)');

        const s4 = await httpReq({ host: '127.0.0.1', port: P_PORT, path: '/', headers: {
            Cookie: `sysauth=OPENWRT_SESSION_ABC; sp_active_device=${encodeURIComponent(owIp)}`,
            Referer: `http://127.0.0.1:${P_PORT}/cgi-bin/luci/`,  // referer has .cgi-like path
        }});
        // cgi-bin path in referer → hasDeviceReferer is true → proxy to router
        assert(s4.status === 200 && s4.body.includes('form'),
               'GET / with .cgi-path Referer → proxied to router (not SPA)');

        // ── 4. Proxy – Huawei ─────────────────────────────────────────────────
        heading('4. Proxy – Huawei');

        const h1 = await httpReq({ host: '127.0.0.1', port: P_PORT, path: `/${hwIp}/html/index.asp` });
        assert(h1.status === 200 && h1.body.includes('form'), 'GET /{hwIp}/html/index.asp → login form');

        const hlb = 'Username=admin&Password=admin';
        const h2 = await httpReq({ host: '127.0.0.1', port: P_PORT, path: `/${hwIp}/login.cgi`, method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': hlb.length } }, hlb);
        assert(h2.status === 302, 'POST /{hwIp}/login.cgi correct creds → 302');
        const h2c = h2.headers['set-cookie'] || [];
        assert(h2c.some(c => c.includes('SessionID=HUAWEI_SESSION_XYZ')), 'Huawei login has SessionID cookie');
        const h2loc = h2.headers['location'] || '';
        // Location must include the IP prefix, NOT the bare router URL
        assert(h2loc.includes(hwIp) || h2loc.startsWith(`/${hwIp}`),
               `Huawei Location header includes IP prefix (got: "${h2loc}")`);
        assert(!h2loc.startsWith(`http://127.0.0.1:${HW_PORT}/`),
               `Huawei Location is NOT bare router URL (got: "${h2loc}")`);

        // After login, browser follows to /html/index.asp — should return JS redirect
        // but proxy MUST rewrite window.location = "/" → window.location = "/{hwIp}/"
        const h3 = await httpReq({ host: '127.0.0.1', port: P_PORT, path: `/${hwIp}/html/index.asp`,
            headers: { Cookie: `SessionID=HUAWEI_SESSION_XYZ; sp_active_device=${encodeURIComponent(hwIp)}` } });
        assert(h3.status === 200, 'GET /{hwIp}/html/index.asp with session → 200');
        const bareRootRe = /window\.location\s*=\s*["']\/["']/;
        assert(!bareRootRe.test(h3.body), 'JS root redirect is NOT bare "/" in rewritten HTML');
        assert(h3.body.includes(hwIp), 'JS redirect rewritten to include IP prefix');

        // Browser follows the rewritten redirect to /{hwIp}/ with session → Dashboard
        const h4 = await httpReq({ host: '127.0.0.1', port: P_PORT, path: `/${hwIp}/`,
            headers: { Cookie: `SessionID=HUAWEI_SESSION_XYZ; sp_active_device=${encodeURIComponent(hwIp)}` } });
        assert(h4.status === 200 && h4.body.includes('Dashboard'),
               'GET /{hwIp}/ with session → Huawei Dashboard');

        // Without session cookie → Huawei redirects to login
        const h5 = await httpReq({ host: '127.0.0.1', port: P_PORT, path: `/${hwIp}/` });
        assert(h5.status === 302, 'GET /{hwIp}/ without session → 302 to login');

        // ── 5. Cookie isolation (device switch) ───────────────────────────────
        heading('5. Proxy – Cookie isolation (device switch)');

        // Login to OpenWrt, collect all cookies the browser would store
        const iso_ow = await httpReq({ host: '127.0.0.1', port: P_PORT, path: `/${owIp}/?form=login`, method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': lb.length } }, lb);
        const iso_owCookieJar = (iso_ow.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');
        console.log(INFO(`  Browser jar after OpenWrt login: ${iso_owCookieJar}`));

        // Request Huawei with OpenWrt's cookie jar (sysauth + sp_active_device=owIp)
        // sp_active_device differs from hwIp → proxy should strip old session cookies
        const iso_hw = await httpReq({ host: '127.0.0.1', port: P_PORT, path: `/${hwIp}/`,
            headers: { Cookie: iso_owCookieJar } });
        console.log(INFO(`  Huawei with OpenWrt jar → status ${iso_hw.status}`));
        // Huawei receives no SessionID → redirects to login (302), NOT 403 from stale sysauth
        assert(iso_hw.status === 302, 'Huawei request after OpenWrt session → 302 (not 403 from leaked sysauth)');
        assert(!iso_hw.body.toLowerCase().includes('openwrt'), 'Huawei response has no OpenWrt content');

    } catch (e) {
        console.error('\x1b[31mCrash:\x1b[0m', e.message);
        console.error(e.stack);
        failed++;
    } finally {
        if (ow) ow.close();
        if (hw) hw.close();
        if (px) px.close();
        const color = failed > 0 ? '31' : '32';
        console.log('\n─────────────────────────────────────────────────────────');
        console.log(`Results: \x1b[32m${passed} passed\x1b[0m, \x1b[${color}m${failed} failed\x1b[0m`);
        process.exit(failed > 0 ? 1 : 0);
    }
}

run().catch(e => { console.error(e); process.exit(1); });
