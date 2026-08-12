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
  let deviceServer, proxyServer;

  if (SPAWN_MODE) {
    console.log('\n[setup] Spawning mock device and proxy servers…');
    deviceServer = spawn('node', [path.join(__dirname, 'http_device.js')], { stdio: 'inherit' });
    proxyServer  = spawn('node', [path.join(__dirname, '../server.js')],  { stdio: 'inherit' });

    await Promise.all([
      waitForPort(DEVICE_PORT),
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

  // ── Cleanup ───────────────────────────────────────────────────────────────
  await deleteDevice(createdDevice.id);

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log('\n═══════════════════════════════════════════════');
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  console.log('═══════════════════════════════════════════════\n');

  if (SPAWN_MODE) {
    deviceServer.kill();
    proxyServer.kill();
  }

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Unexpected test error:', err);
  process.exit(1);
});
