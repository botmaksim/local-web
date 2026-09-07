/**
 * test/test_auth_token_deletion.js
 *
 * This test specifically verifies that the logout endpoints
 * properly clear the Cloudflare Access authorization token (CF_Authorization)
 * and the internal device tracking cookies.
 */

'use strict';

const http = require('http');
const https = require('https');

const PROXY_PORT = 9091;
const PROXY_BASE = `http://127.0.0.1:${PROXY_PORT}`;

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

function assertIncludes(haystack, needle, label) {
    if (!haystack.includes(needle)) {
        throw new Error(`Expected ${label} to include '${needle}', but got: ${haystack}`);
    }
}

async function runTests() {
    console.log('Testing Authentication Token Deletion...');
    let passed = 0;
    
    // 1. Test POST /__smartproxy_api/logout
    try {
        const res = await request(`${PROXY_BASE}/__smartproxy_api/logout`, {
            method: 'POST',
            headers: { 'Cookie': 'CF_Authorization=faketoken; sp_active_device=127.0.0.1' },
        });
        if (res.status !== 200) throw new Error(`Expected status 200, got ${res.status}`);
        
        const cookies = [res.headers['set-cookie']].flat().filter(Boolean);
        const cfCookie = cookies.find(c => c.startsWith('CF_Authorization='));
        
        if (!cfCookie) throw new Error('CF_Authorization clear cookie missing');
        assertIncludes(cfCookie, 'Expires=Thu, 01 Jan 1970', 'CF_Authorization expired');
        console.log('[PASS] POST /__smartproxy_api/logout correctly deletes CF_Authorization cookie.');
        passed++;
    } catch (err) {
        console.error('[FAIL] POST /__smartproxy_api/logout test failed:', err.message);
    }
    
    // 2. Test GET /cdn-cgi/access/logout
    try {
        const res = await request(`${PROXY_BASE}/cdn-cgi/access/logout?returnTo=/dashboard`);
        if (res.status !== 302) throw new Error(`Expected status 302, got ${res.status}`);
        if (res.headers['location'] !== '/dashboard') throw new Error(`Wrong redirect location: ${res.headers['location']}`);
        
        const cookies = [res.headers['set-cookie']].flat().filter(Boolean);
        const cfCookie = cookies.find(c => c.startsWith('CF_Authorization='));
        
        if (!cfCookie) throw new Error('CF_Authorization clear cookie missing');
        assertIncludes(cfCookie, 'Expires=Thu, 01 Jan 1970', 'CF_Authorization expired');
        console.log('[PASS] GET /cdn-cgi/access/logout correctly clears cookies and redirects.');
        passed++;
    } catch (err) {
        console.error('[FAIL] GET /cdn-cgi/access/logout test failed:', err.message);
    }
    
    console.log(`\nResults: ${passed}/2 passed.`);
    process.exit(passed === 2 ? 0 : 1);
}

// Make sure server is running before executing
setTimeout(() => {
  runTests();
}, 500);
