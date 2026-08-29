/**
 * test/run_tests.js
 *
 * Integration tests for smart-proxy server.js
 *
 * Requires the proxy to be running on localhost:9091 AND
 * the mock HTTP device to be running on localhost:8081.
 *
 * Run:
 *   node test/http_device.js &
 *   node server.js &
 *   node test/run_tests.js
 *
 * Or combined (after npm install):
 *   node test/run_tests.js --spawn
 *
 * Uses only Node.js built-ins (no test framework needed).
 * Exit code 0 = all pass, 1 = failures.
 */

'use strict';

const http  = require('http');
const https = require('https');
const { spawn, execSync } = require('child_process');
const path  = require('path');

// ── Config ──────────────────────────────────────────────────────────────────
const PROXY_PORT  = 9091;
const DEVICE_PORT = 8081;
const DEVICE_IP   = `127.0.0.1:${DEVICE_PORT}`;
const PROXY_BASE  = `http://127.0.0.1:${PROXY_PORT}`;

const SPAWN_MODE  = process.argv.includes('--spawn');

// ── Tiny HTTP client ─────────────────────────────────────────────────────────
function request(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === 'https:' ? https : http;
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: opts.method || 'GET',
      headers: opts.headers || {},
      rejectUnauthorized: false,
    };
    const req = lib.request(options, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

// ── Test runner ──────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✅  ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ❌  ${name}`);
    console.error(`      ${err.message}`);
    failed++;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed');
}

function assertIncludes(haystack, needle, label = '') {
  if (!haystack.includes(needle)) {
    throw new Error(`Expected ${label || 'string'} to include: ${JSON.stringify(needle)}\nGot: ${haystack.slice(0, 300)}`);
  }
}

function assertNotIncludes(haystack, needle, label = '') {
  if (haystack.includes(needle)) {
    throw new Error(`Expected ${label || 'string'} NOT to include: ${JSON.stringify(needle)}`);
  }
}

// ── Wait for server ───────────────────────────────────────────────────────────
function waitForPort(port, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeout;
    const tryConnect = () => {
      const sock = require('net').createConnection(port, '127.0.0.1');
      sock.on('connect', () => { sock.destroy(); resolve(); });
      sock.on('error', () => {
        if (Date.now() > deadline) return reject(new Error(`Port ${port} not ready`));
        setTimeout(tryConnect, 200);
      });
    };
    tryConnect();
  });
}

// ── Helpers to register a device via API ─────────────────────────────────────
async function addDevice(name, ip, protocol = 'http') {
  const res = await request(`${PROXY_BASE}/__smartproxy_api/devices`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, ip, protocol }),
  });
  assert(res.status === 201, `addDevice failed: ${res.status} ${res.body}`);
  return JSON.parse(res.body);
}

async function deleteDevice(id) {
  await request(`${PROXY_BASE}/__smartproxy_api/devices/${id}`, { method: 'DELETE' });
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  let deviceServer, proxyServer, dummyRouterServer;

  if (SPAWN_MODE) {
    console.log('\n[setup] Spawning mock device and proxy servers…');
    deviceServer = spawn('node', [path.join(__dirname, 'http_device.js')], { stdio: 'inherit', env: { ...process.env, ALLOW_LOOPBACK: 'true' } });
    dummyRouterServer = spawn('node', [path.join(__dirname, 'dummy_router.js')], { stdio: 'inherit', env: { ...process.env, ALLOW_LOOPBACK: 'true' } });
    proxyServer  = spawn('node', [path.join(__dirname, '../server.js')],  { stdio: 'inherit', env: { ...process.env, ALLOW_LOOPBACK: 'true' } });

    await Promise.all([
      waitForPort(DEVICE_PORT),
      waitForPort(8080),
      waitForPort(PROXY_PORT),
    ]);
    console.log('[setup] Servers ready.\n');
  } else {
    console.log('[info] Assuming servers are already running on ports', PROXY_PORT, 'and', DEVICE_PORT);
    console.log('[info] Use --spawn flag to start them automatically.\n');
    await waitForPort(PROXY_PORT).catch(() => {
      console.error(`ERROR: Proxy not reachable on port ${PROXY_PORT}. Start it first or use --spawn.`);
      process.exit(1);
    });
    await waitForPort(DEVICE_PORT).catch(() => {
      console.error(`ERROR: Mock device not reachable on port ${DEVICE_PORT}. Run: node test/http_device.js`);
      process.exit(1);
    });
  }

  // ── Clean up any leftover test devices ──────────────────────────────────
  const existing = await request(`${PROXY_BASE}/__smartproxy_api/devices`);
  const existingDevices = JSON.parse(existing.body);
  for (const d of existingDevices) {
    if (d.ip === DEVICE_IP) await deleteDevice(d.id);
  }

  console.log('═══════════════════════════════════════════════');
  console.log('  Smart Proxy — Integration Tests');
  console.log('═══════════════════════════════════════════════\n');

  // ── API tests ─────────────────────────────────────────────────────────────
  console.log('── API ──────────────────────────────────────────');

  let createdDevice;

  await test('GET /__smartproxy_api/devices returns array', async () => {
    const res = await request(`${PROXY_BASE}/__smartproxy_api/devices`);
    assert(res.status === 200, `status ${res.status}`);
    assert(Array.isArray(JSON.parse(res.body)), 'not an array');
  });

  await test('POST /__smartproxy_api/devices creates device', async () => {
    createdDevice = await addDevice('Test Device', DEVICE_IP, 'http');
    assert(createdDevice.id,      'missing id');
    assert(createdDevice.name === 'Test Device', 'wrong name');
    assert(createdDevice.ip === DEVICE_IP,       'wrong ip');
    assert(createdDevice.protocol === 'http',    'wrong protocol');
  });

  await test('POST /__smartproxy_api/devices rejects invalid IP', async () => {
    const res = await request(`${PROXY_BASE}/__smartproxy_api/devices`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Bad', ip: 'not-an-ip', protocol: 'http' }),
    });
    assert(res.status === 400, `expected 400, got ${res.status}`);
  });

  await test('POST /__smartproxy_api/devices rejects empty name', async () => {
    const res = await request(`${PROXY_BASE}/__smartproxy_api/devices`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '   ', ip: DEVICE_IP, protocol: 'http' }),
    });
    assert(res.status === 400, `expected 400, got ${res.status}`);
  });

  await test('POST /__smartproxy_api/devices rejects invalid protocol', async () => {
    const res = await request(`${PROXY_BASE}/__smartproxy_api/devices`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'X', ip: DEVICE_IP, protocol: 'ftp' }),
    });
    assert(res.status === 400, `expected 400, got ${res.status}`);
  });

  await test('PUT /__smartproxy_api/devices/:id updates device', async () => {
    const res = await request(`${PROXY_BASE}/__smartproxy_api/devices/${createdDevice.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Updated Name' }),
    });
    assert(res.status === 200, `status ${res.status}`);
    assert(JSON.parse(res.body).name === 'Updated Name', 'name not updated');
  });

  await test('DELETE /__smartproxy_api/devices/:id removes device', async () => {
    // Re-add so we can delete
    const d = await addDevice('TempDel', DEVICE_IP, 'http');
    const res = await request(`${PROXY_BASE}/__smartproxy_api/devices/${d.id}`, { method: 'DELETE' });
    assert(res.status === 200, `status ${res.status}`);
    const list = JSON.parse((await request(`${PROXY_BASE}/__smartproxy_api/devices`)).body);
    assert(!list.some(x => x.id === d.id), 'device still present');
  });

  await test('Unregistered IP returns 403', async () => {
    const res = await request(`${PROXY_BASE}/10.0.0.99/`);
    assert(res.status === 403, `expected 403, got ${res.status}`);
  });

  // ── Proxy / HTML rewriting tests ──────────────────────────────────────────
  console.log('\n── Proxy & HTML Rewriting ───────────────────────');

  // Ensure our test device is registered (may have been modified by update test)
  await deleteDevice(createdDevice.id).catch(() => {});
  createdDevice = await addDevice('Test Device', DEVICE_IP, 'http');

  await test('Proxy returns 200 for registered device root', async () => {
    const res = await request(`${PROXY_BASE}/${DEVICE_IP}/`);
    assert(res.status === 200, `status ${res.status}`);
    assertIncludes(res.headers['content-type'], 'text/html');
  });

  await test('<base> tag is injected into HTML', async () => {
    const res = await request(`${PROXY_BASE}/${DEVICE_IP}/`);
    assertIncludes(res.body, `<base href="/${DEVICE_IP}/"`, 'HTML');
  });

  await test('Absolute self-URL in href is rewritten', async () => {
    const res = await request(`${PROXY_BASE}/${DEVICE_IP}/`);
    // The device outputs href="http://127.0.0.1:8081/dashboard"
    // After rewriting it should become /${DEVICE_IP}/dashboard
    assertNotIncludes(res.body, `http://127.0.0.1:${DEVICE_PORT}`, 'HTML body');
    assertIncludes(res.body, `/${DEVICE_IP}`, 'HTML body');
  });

  await test('Root-relative <link href="/styles.css"> is rewritten', async () => {
    const res = await request(`${PROXY_BASE}/${DEVICE_IP}/`);
    assertIncludes(res.body, `href="/${DEVICE_IP}/styles.css"`, 'HTML');
  });

  await test('Root-relative <img src="/logo.png"> is rewritten', async () => {
    const res = await request(`${PROXY_BASE}/${DEVICE_IP}/`);
    assertIncludes(res.body, `src="/${DEVICE_IP}/logo.png"`, 'HTML');
  });

  await test('Root-relative <script src="/app.js"> is rewritten', async () => {
    const res = await request(`${PROXY_BASE}/${DEVICE_IP}/`);
    assertIncludes(res.body, `src="/${DEVICE_IP}/app.js"`, 'HTML');
  });

  await test('<form action="/login"> is rewritten', async () => {
    const res = await request(`${PROXY_BASE}/${DEVICE_IP}/`);
    assertIncludes(res.body, `action="/${DEVICE_IP}/login"`, 'HTML');
  });

  await test('Absolute URL in JS file is rewritten', async () => {
    const res = await request(`${PROXY_BASE}/${DEVICE_IP}/app.js`);
    assertNotIncludes(res.body, `http://127.0.0.1:${DEVICE_PORT}`, 'JS body');
    assertIncludes(res.body, `/${DEVICE_IP}`, 'JS body');
  });

  await test('Redirect Location header is rewritten', async () => {
    const res = await request(`${PROXY_BASE}/${DEVICE_IP}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'user=admin&pass=password',
    });
    // Device returns 302 → /dashboard, proxy must rewrite to /${DEVICE_IP}/dashboard
    assert(res.status === 302, `expected 302, got ${res.status}`);
    const loc = res.headers['location'] || '';
    assertIncludes(loc, `/${DEVICE_IP}/dashboard`, 'Location header');
    assertNotIncludes(loc, `http://127.0.0.1`, 'Location header');
  });

  await test('Set-Cookie Path is rewritten', async () => {
    const res = await request(`${PROXY_BASE}/${DEVICE_IP}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'user=admin&pass=password',
    });
    const setCookie = [res.headers['set-cookie']].flat().join('; ');
    assertIncludes(setCookie, `/${DEVICE_IP}`, 'Set-Cookie Path');
  });

  await test('JSON API response with absolute URLs is rewritten', async () => {
    const res = await request(`${PROXY_BASE}/${DEVICE_IP}/api/data`);
    assert(res.status === 200, `status ${res.status}`);
    assertNotIncludes(res.body, `http://127.0.0.1:${DEVICE_PORT}`, 'JSON body');
    assertIncludes(res.body, `/${DEVICE_IP}`, 'JSON body');
  });

  await test('Dashboard page (no <head>) gets <base> injected', async () => {
    const res = await request(`${PROXY_BASE}/${DEVICE_IP}/dashboard`);
    assertIncludes(res.body, `<base href="/${DEVICE_IP}/"`, 'dashboard HTML');
    assertNotIncludes(res.body, `http://127.0.0.1:${DEVICE_PORT}`, 'dashboard JS');
  });

  await test('Static CSS asset is served by proxy', async () => {
    const res = await request(`${PROXY_BASE}/${DEVICE_IP}/styles.css`);
    assert(res.status === 200, `status ${res.status}`);
    assertIncludes(res.headers['content-type'], 'text/css');
  });

  await test('Image binary asset is proxied correctly', async () => {
    const res = await request(`${PROXY_BASE}/${DEVICE_IP}/logo.png`);
    assert(res.status === 200, `status ${res.status}`);
    assertIncludes(res.headers['content-type'], 'image/png');
  });

  // ── SPA fallback ──────────────────────────────────────────────────────────
  console.log('\n── SPA & Edge Cases ─────────────────────────────');

  await test('Unknown non-IP path returns 200 (SPA fallback or 404 without build)', async () => {
    const res = await request(`${PROXY_BASE}/some-spa-route`);
    // Either SPA index.html (200) or "Frontend not built" (404) — both are acceptable
    assert(res.status === 200 || res.status === 404, `unexpected status ${res.status}`);
  });

  // ── Validation & Security ────────────────────────────────────────────────
  console.log('\n── Validation & Security ────────────────────────');

  await test('POST rejects IP with octet > 255', async () => {
    const res = await request(`${PROXY_BASE}/__smartproxy_api/devices`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Bad', ip: '192.168.1.256', protocol: 'http' }),
    });
    assert(res.status === 400, `expected 400, got ${res.status}`);
  });

  await test('POST rejects incomplete IP (3 octets)', async () => {
    const res = await request(`${PROXY_BASE}/__smartproxy_api/devices`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Bad', ip: '192.168.1', protocol: 'http' }),
    });
    assert(res.status === 400, `expected 400, got ${res.status}`);
  });

  await test('POST rejects IP with 5 octets', async () => {
    const res = await request(`${PROXY_BASE}/__smartproxy_api/devices`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Bad', ip: '1.2.3.4.5', protocol: 'http' }),
    });
    assert(res.status === 400, `expected 400, got ${res.status}`);
  });

  await test('POST rejects non-numeric octets', async () => {
    const res = await request(`${PROXY_BASE}/__smartproxy_api/devices`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Bad', ip: 'abc.def.ghi.jkl', protocol: 'http' }),
    });
    assert(res.status === 400, `expected 400, got ${res.status}`);
  });

  await test('POST rejects leading-zero octet (01.2.3.4)', async () => {
    const res = await request(`${PROXY_BASE}/__smartproxy_api/devices`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Bad', ip: '01.168.1.1', protocol: 'http' }),
    });
    assert(res.status === 400, `expected 400, got ${res.status}`);
  });

  await test('POST accepts valid IP with port (192.168.1.100:8080)', async () => {
    const d = await addDevice('PortDevice', '192.168.1.100:8080', 'http');
    assert(d.id, 'missing id');
    assert(d.ip === '192.168.1.100:8080', `wrong ip: ${d.ip}`);
    await deleteDevice(d.id);
  });

  await test('POST rejects SSRF bypass with @ (192.168.1.1:80@malicious.com)', async () => {
    const res = await request(`${PROXY_BASE}/__smartproxy_api/devices`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Bad', ip: '192.168.1.1:80@malicious.com', protocol: 'http' }),
    });
    assert(res.status === 400, `expected 400, got ${res.status}`);
  });

  await test('POST rejects SSRF bypass with path (192.168.1.1:80/evil)', async () => {
    const res = await request(`${PROXY_BASE}/__smartproxy_api/devices`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Bad', ip: '192.168.1.1:80/evil', protocol: 'http' }),
    });
    assert(res.status === 400, `expected 400, got ${res.status}`);
  });

  await test('POST rejects invalid port number (65536)', async () => {
    const res = await request(`${PROXY_BASE}/__smartproxy_api/devices`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Bad', ip: '192.168.1.1:65536', protocol: 'http' }),
    });
    assert(res.status === 400, `expected 400, got ${res.status}`);
  });

  await test('Management API response has no CORS header', async () => {
    const res = await request(`${PROXY_BASE}/__smartproxy_api/devices`);
    assert(
      !res.headers['access-control-allow-origin'],
      `unexpected CORS header: ${res.headers['access-control-allow-origin']}`
    );
  });

  // ── Complex Redirects ────────────────────────────────────────────────────
  console.log('\n── Complex Redirects ────────────────────────────');

  await test('302 to absolute self-URL is rewritten', async () => {
    const res = await request(`${PROXY_BASE}/${DEVICE_IP}/redirect/absolute-url`);
    assert(res.status === 302, `expected 302, got ${res.status}`);
    const loc = res.headers['location'] || '';
    assertIncludes(loc, `/${DEVICE_IP}/dashboard`, 'Location');
    // The device's own absolute URL (host:port as origin) must be gone.
    // Note: DEVICE_IP itself appears in the proxy path, so we check the scheme+host form.
    assertNotIncludes(loc, `http://127.0.0.1:${DEVICE_PORT}`, 'Location must not expose device origin');
  });

  await test('302 with query params: Location rewritten + query preserved', async () => {
    const res = await request(`${PROXY_BASE}/${DEVICE_IP}/redirect/with-query`);
    assert(res.status === 302, `expected 302, got ${res.status}`);
    const loc = res.headers['location'] || '';
    assertIncludes(loc, `/${DEVICE_IP}/search`, 'Location path');
    assertIncludes(loc, 'q=hello', 'Location query q');
    assertIncludes(loc, 'page=2', 'Location query page');
    assertIncludes(loc, 'sort=asc', 'Location query sort');
  });

  await test('301 permanent redirect Location is rewritten', async () => {
    const res = await request(`${PROXY_BASE}/${DEVICE_IP}/redirect/permanent`);
    assert(res.status === 301, `expected 301, got ${res.status}`);
    const loc = res.headers['location'] || '';
    assertIncludes(loc, `/${DEVICE_IP}/dashboard`, 'Location');
  });

  await test('302 to external URL is NOT rewritten', async () => {
    const res = await request(`${PROXY_BASE}/${DEVICE_IP}/redirect/external`);
    assert(res.status === 302, `expected 302, got ${res.status}`);
    const loc = res.headers['location'] || '';
    assertIncludes(loc, 'https://example.com/login', 'Location');
    assertNotIncludes(loc, DEVICE_IP, 'Location must not contain device IP');
  });

  await test('Redirect chain step 1: /chain-start → /{device}/redirect/chain-end', async () => {
    const res = await request(`${PROXY_BASE}/${DEVICE_IP}/redirect/chain-start`);
    assert(res.status === 302, `expected 302, got ${res.status}`);
    const loc = res.headers['location'] || '';
    assertIncludes(loc, `/${DEVICE_IP}/redirect/chain-end`, 'Location');
  });

  await test('Redirect chain step 2: /chain-end → /{device}/dashboard', async () => {
    const res = await request(`${PROXY_BASE}/${DEVICE_IP}/redirect/chain-end`);
    assert(res.status === 302, `expected 302, got ${res.status}`);
    const loc = res.headers['location'] || '';
    assertIncludes(loc, `/${DEVICE_IP}/dashboard`, 'Location');
  });

  // ── API Methods & Responses ──────────────────────────────────────────────
  console.log('\n── API Methods & Responses ──────────────────────');

  await test('POST /api/items → 201, Location rewritten, body URLs rewritten', async () => {
    const res = await request(`${PROXY_BASE}/${DEVICE_IP}/api/items`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'widget' }),
    });
    assert(res.status === 201, `expected 201, got ${res.status}`);
    const loc = res.headers['location'] || '';
    assertIncludes(loc, `/${DEVICE_IP}/api/items/42`, 'Location');
    assertNotIncludes(loc, `http://127.0.0.1:${DEVICE_PORT}`, 'Location must not expose device origin');
    const body = JSON.parse(res.body);
    assert(body.url.includes(`/${DEVICE_IP}/`), `url not rewritten: ${body.url}`);
  });

  await test('PUT /api/items/1 → 200, body URLs rewritten', async () => {
    const res = await request(`${PROXY_BASE}/${DEVICE_IP}/api/items/1`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'updated' }),
    });
    assert(res.status === 200, `expected 200, got ${res.status}`);
    const body = JSON.parse(res.body);
    assert(body.updated === true, 'updated flag missing');
    assert(body.url.includes(`/${DEVICE_IP}/`), `url not rewritten: ${body.url}`);
  });

  await test('DELETE /api/items/42 → 204 No Content', async () => {
    const res = await request(`${PROXY_BASE}/${DEVICE_IP}/api/items/42`, { method: 'DELETE' });
    assert(res.status === 204, `expected 204, got ${res.status}`);
    assert(res.body === '', `expected empty body, got: ${res.body}`);
  });

  await test('404 from device is passed through to client', async () => {
    const res = await request(`${PROXY_BASE}/${DEVICE_IP}/not-found`);
    assert(res.status === 404, `expected 404, got ${res.status}`);
    const body = JSON.parse(res.body);
    assert(body.error === 'Not Found', `unexpected body: ${res.body}`);
  });

  await test('Nested JSON: deep URLs rewritten', async () => {
    const res = await request(`${PROXY_BASE}/${DEVICE_IP}/api/nested`);
    assert(res.status === 200, `status ${res.status}`);
    const body = JSON.parse(res.body);
    assertNotIncludes(JSON.stringify(body.device), `http://127.0.0.1:${DEVICE_PORT}`, 'endpoints must not expose device origin');
    assert(body.device.endpoints.status.includes(`/${DEVICE_IP}/`), 'status url not rewritten');
    assert(body.device.endpoints.control.includes(`/${DEVICE_IP}/`), 'control url not rewritten');
    assert(body.device.endpoints.ui.includes(`/${DEVICE_IP}/`), 'ui url not rewritten');
  });

  await test('Nested JSON: non-URL fields untouched (timestamp, version)', async () => {
    const res = await request(`${PROXY_BASE}/${DEVICE_IP}/api/nested`);
    const body = JSON.parse(res.body);
    assert(body.meta.createdAt === '2024-01-01T10:00:00Z', `timestamp mangled: ${body.meta.createdAt}`);
    assert(body.meta.version === '1.0.0', `version mangled: ${body.meta.version}`);
  });

  await test('Array of objects: all URL fields rewritten', async () => {
    const res = await request(`${PROXY_BASE}/${DEVICE_IP}/api/users`);
    assert(res.status === 200, `status ${res.status}`);
    const body = JSON.parse(res.body);
    assert(Array.isArray(body), 'expected array');
    for (const user of body) {
      assert(user.profile.includes(`/${DEVICE_IP}/`), `profile url not rewritten: ${user.profile}`);
      assert(user.avatar.includes(`/${DEVICE_IP}/`),  `avatar url not rewritten: ${user.avatar}`);
      assertNotIncludes(user.profile, `http://127.0.0.1:${DEVICE_PORT}`, 'profile must not expose device origin');
    }
  });

  // ── Cookie Scenarios ─────────────────────────────────────────────────────
  console.log('\n── Cookie Scenarios ─────────────────────────────');

  await test('Multiple Set-Cookie: all paths rewritten to /{device}/...', async () => {
    const res = await request(`${PROXY_BASE}/${DEVICE_IP}/cookies/multiple`);
    const cookies = [res.headers['set-cookie']].flat().filter(Boolean);
    // Should have 3 device cookies + 1 sp_active_device
    const deviceCookies = cookies.filter(c => !c.startsWith('sp_active_device'));
    assert(deviceCookies.length === 3, `expected 3 device cookies, got ${deviceCookies.length}`);
    for (const c of deviceCookies) {
      assertIncludes(c, `/${DEVICE_IP}`, `cookie Path not rewritten: ${c}`);
    }
  });

  await test('Multiple Set-Cookie: Domain attribute stripped', async () => {
    const res = await request(`${PROXY_BASE}/${DEVICE_IP}/cookies/multiple`);
    const cookies = [res.headers['set-cookie']].flat().filter(Boolean);
    for (const c of cookies) {
      assertNotIncludes(c, 'Domain=', `Domain not stripped: ${c}`);
    }
  });

  await test('Cookie without Path gets /{device} path added', async () => {
    const res = await request(`${PROXY_BASE}/${DEVICE_IP}/cookies/no-path`);
    const cookies = [res.headers['set-cookie']].flat().filter(Boolean);
    const csrf = cookies.find(c => c.startsWith('csrf='));
    assert(csrf, 'csrf cookie not found');
    assertIncludes(csrf, `Path=/${DEVICE_IP}`, `Path not set: ${csrf}`);
  });

  await test('sp_active_device tracking cookie is set on every proxied response', async () => {
    const res = await request(`${PROXY_BASE}/${DEVICE_IP}/`);
    const cookies = [res.headers['set-cookie']].flat().filter(Boolean);
    const sp = cookies.find(c => c.startsWith('sp_active_device='));
    assert(sp, 'sp_active_device cookie missing');
    assertIncludes(sp, DEVICE_IP, 'sp_active_device must contain device IP');
  });

  // ── HTML Edge Cases ──────────────────────────────────────────────────────
  console.log('\n── HTML Edge Cases ──────────────────────────────');

  await test('Existing <base> is overwritten — no duplicate <base> tags', async () => {
    const res = await request(`${PROXY_BASE}/${DEVICE_IP}/page/with-base`);
    const count = (res.body.match(/<base/gi) || []).length;
    assert(count === 1, `expected exactly 1 <base>, found ${count}`);
    assertIncludes(res.body, `/${DEVICE_IP}/`, '<base href');
    assertNotIncludes(res.body, '<base href="/">', 'original base must be replaced');
  });

  await test('srcset attribute: all URLs rewritten', async () => {
    const res = await request(`${PROXY_BASE}/${DEVICE_IP}/page/with-srcset`);
    assertIncludes(res.body, `/${DEVICE_IP}/logo-300.png 300w`, 'srcset 300w');
    assertIncludes(res.body, `/${DEVICE_IP}/logo-600.png 600w`, 'srcset 600w');
    assertIncludes(res.body, `/${DEVICE_IP}/logo-1200.png 1200w`, 'srcset 1200w');
    assertNotIncludes(res.body, 'srcset="/logo-300.png', 'unrewritten srcset found');
  });

  await test('<picture><source srcset> URLs rewritten', async () => {
    const res = await request(`${PROXY_BASE}/${DEVICE_IP}/page/with-srcset`);
    assertIncludes(res.body, `/${DEVICE_IP}/banner-mobile.jpg`, '<source> mobile');
    assertIncludes(res.body, `/${DEVICE_IP}/banner-desktop.jpg`, '<source> desktop');
  });

  await test('<link rel="canonical"> href rewritten', async () => {
    const res = await request(`${PROXY_BASE}/${DEVICE_IP}/page/with-canonical`);
    assertNotIncludes(res.body, `http://127.0.0.1:${DEVICE_PORT}`, 'canonical must not expose device origin');
    assertIncludes(res.body, `/${DEVICE_IP}/page/with-canonical`, 'canonical href');
  });

  await test('Inline JS: location.href = "/" and window.location = "/" rewritten', async () => {
    const res = await request(`${PROXY_BASE}/${DEVICE_IP}/page/js-redirect`);
    assertIncludes(res.body, `"/${DEVICE_IP}/"`, 'JS redirect target');
    assertNotIncludes(res.body, 'href = "/"', 'unrewritten JS href');
    assertNotIncludes(res.body, "location = \"/\"", 'unrewritten window.location');
  });

  // ── Query String Passthrough ─────────────────────────────────────────────
  console.log('\n── Query String Passthrough ─────────────────────');

  await test('Query params passed through and echoed correctly by device', async () => {
    const res = await request(`${PROXY_BASE}/${DEVICE_IP}/search?q=hello+world&page=2&sort=asc`);
    assert(res.status === 200, `status ${res.status}`);
    const body = JSON.parse(res.body);
    assert(body.echo.q === 'hello world', `q param: ${body.echo.q}`);
    assert(body.echo.page === '2', `page param: ${body.echo.page}`);
    assert(body.echo.sort === 'asc', `sort param: ${body.echo.sort}`);
  });

  await test('URL-encoded query params preserved exactly', async () => {
    const res = await request(`${PROXY_BASE}/${DEVICE_IP}/search?q=caf%C3%A9&lang=ru`);
    assert(res.status === 200, `status ${res.status}`);
    const body = JSON.parse(res.body);
    assert(body.echo.q === 'café', `encoded param: ${body.echo.q}`);
    assert(body.echo.lang === 'ru', `lang: ${body.echo.lang}`);
  });

  // ── HTTPS Dummy Router Tests ─────────────────────────────────────────────
  console.log('\n── HTTPS Dummy Router ───────────────────────────');

  let dummyDevice;
  await test('POST /__smartproxy_api/devices creates HTTPS device', async () => {
    dummyDevice = await addDevice('Dummy Router', '127.0.0.1:8080', 'https');
    assert(dummyDevice.id, 'missing id');
    assert(dummyDevice.protocol === 'https', 'wrong protocol');
  });

  await test('Proxy returns 200 for registered HTTPS device root', async () => {
    const res = await request(`${PROXY_BASE}/127.0.0.1:8080/`);
    assert(res.status === 200, `status ${res.status}`);
    assertIncludes(res.headers['content-type'], 'text/html');
    assertIncludes(res.body, 'Welcome to the Dummy Router (HTTPS)');
  });

  await test('<base> tag is injected into HTTPS HTML', async () => {
    const res = await request(`${PROXY_BASE}/127.0.0.1:8080/`);
    assertIncludes(res.body, '<base href="/127.0.0.1:8080/"', 'HTML');
  });

  await test('Static CSS asset is served by HTTPS proxy', async () => {
    const res = await request(`${PROXY_BASE}/127.0.0.1:8080/styles.css`);
    assert(res.status === 200, `status ${res.status}`);
    assertIncludes(res.headers['content-type'], 'text/css');
  });

  await test('Static image asset is served by HTTPS proxy', async () => {
    const res = await request(`${PROXY_BASE}/127.0.0.1:8080/logo.png`);
    assert(res.status === 200, `status ${res.status}`);
    assertIncludes(res.headers['content-type'], 'image/png');
  });

  await test('POST to HTTPS device is proxied', async () => {
    const res = await request(`${PROXY_BASE}/127.0.0.1:8080/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'username=admin&password=password'
    });
    assert(res.status === 200, `status ${res.status}`);
    assertIncludes(res.body, 'Login Attempt Received');
  });

  await deleteDevice(dummyDevice.id);

  // ── Cleanup ───────────────────────────────────────────────────────────────
  await deleteDevice(createdDevice.id);

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log('\n═══════════════════════════════════════════════');
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  console.log('═══════════════════════════════════════════════\n');

  if (SPAWN_MODE) {
    deviceServer.kill();
    dummyRouterServer.kill();
    proxyServer.kill();
  }

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Unexpected test error:', err);
  process.exit(1);
});
