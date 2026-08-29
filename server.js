'use strict';

/**
 * server.js — Entry point for smart-proxy.
 *
 * Wires together:
 *   src/router.js     — /__smartproxy_api/ management REST API
 *   src/proxy.js      — reverse-proxy middleware + routing logic
 *
 * Start:  node server.js
 * Dev:    node --watch server.js
 * Test:   npm test
 */

const express      = require('express');
const cookieParser = require('cookie-parser');
const path         = require('path');
const fs           = require('fs');

const devicesRouter    = require('./src/router');
const { proxyRouter, proxy }  = require('./src/proxy');

// ---------------------------------------------------------------------------
// App setup
// ---------------------------------------------------------------------------

const app  = express();
const PORT = process.env.PORT || 9091;

// express.json() is applied ONLY to the management API route.
// Applying it globally would drain the request stream before the proxy can
// read the raw body — causing ECONNRESET when forwarding POST/PUT to devices.
app.use(cookieParser());

// ---------------------------------------------------------------------------
// Management API (JSON body parsing scoped here only)
// ---------------------------------------------------------------------------

// CORS is intentionally NOT applied globally.
// /__smartproxy_api/ must be same-origin only (no CORS).
// Proxied device responses carry their own CORS headers from the upstream.
app.use('/__smartproxy_api/devices', express.json(), devicesRouter);

// ---------------------------------------------------------------------------
// Reverse proxy
// ---------------------------------------------------------------------------

app.use(proxyRouter);

// ---------------------------------------------------------------------------
// Static frontend + SPA fallback
// ---------------------------------------------------------------------------

const FRONTEND_DIST = path.join(__dirname, 'frontend', 'dist');

app.use(express.static(FRONTEND_DIST));

app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    const indexPath = path.join(FRONTEND_DIST, 'index.html');
    if (fs.existsSync(indexPath)) {
        res.sendFile(indexPath);
    } else {
        res.status(404).send('Frontend not built. Run `npm run build` inside /frontend.');
    }
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const log = (level, msg) =>
    console.log(`[${new Date().toISOString()}] [${level}] ${msg}`);

const server = app.listen(PORT, () =>
    log('INFO', `Gateway running on http://0.0.0.0:${PORT}`)
);

// Bind WebSocket upgrades to the proxy middleware
server.on('upgrade', proxy.upgrade);

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

const shutdown = (signal) => {
    log('INFO', `${signal} received, shutting down gracefully…`);
    server.close(() => {
        log('INFO', 'Server closed.');
        process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
