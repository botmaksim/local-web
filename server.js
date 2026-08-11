const express = require('express');
const { createProxyMiddleware, responseInterceptor } = require('http-proxy-middleware');
const cheerio = require('cheerio');
const fs = require('fs');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = 9091;
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'devices.json');

app.use(express.json());
app.use(cors());

// ---------------------------------------------------------------------------
// In-memory device cache — invalidated only on writes
// ---------------------------------------------------------------------------
let _deviceCache = null;

const getDevices = () => {
    if (_deviceCache !== null) return _deviceCache;
    if (!fs.existsSync(DB_FILE)) {
        _deviceCache = [];
        return _deviceCache;
    }
    try {
        _deviceCache = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
        // Migrate legacy entries that lack `protocol` field
        _deviceCache = _deviceCache.map(d => ({
            protocol: 'http',
            ...d,
        }));
    } catch (err) {
        console.error('[DB] Error reading devices:', err.message);
        _deviceCache = [];
    }
    return _deviceCache;
};

const saveDevices = (data) => {
    try {
        if (!fs.existsSync(DATA_DIR)) {
            fs.mkdirSync(DATA_DIR, { recursive: true });
        }
        fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
        _deviceCache = data; // update cache
    } catch (err) {
        console.error('[DB] Error saving devices:', err.message);
        throw err;
    }
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** IPv4 with optional port, e.g. "192.168.1.1" or "192.168.1.1:8080" */
const IP_REGEX = /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}(?::[0-9]{1,5})?$/;

const isValidIp = (ip) => IP_REGEX.test(ip);

/**
 * Extract { ip, protocol } from a proxy URL path segment like:
 *   /192.168.1.1/page     → { ip: '192.168.1.1', protocol: 'http' }
 *   /192.168.1.1:443/page → { ip: '192.168.1.1:443', protocol: 'https' }
 *
 * `protocol` comes from the stored device record (authoritative).
 */
const extractTargetFromUrl = (url, devices) => {
    const segment = url.split('/').filter(Boolean)[0] || '';
    if (!isValidIp(segment)) return null;

    const device = devices.find(d => d.ip === segment);
    if (!device) return null;

    return { ip: segment, protocol: device.protocol || 'http' };
};

const log = (level, msg, extra = '') =>
    console.log(`[${new Date().toISOString()}] [${level}] ${msg}${extra ? ' ' + extra : ''}`);

// ---------------------------------------------------------------------------
// REST API — use express.Router() for Express 5 / router@2.x compatibility
// (app.METHOD() does not work reliably in Express 5 with router@2.2.0)
// ---------------------------------------------------------------------------

const devicesRouter = express.Router();

devicesRouter.get('/', (_req, res) => res.json(getDevices()));

devicesRouter.post('/', (req, res) => {
    const { name, ip, protocol = 'http' } = req.body;

    if (!name || typeof name !== 'string' || name.trim().length === 0) {
        return res.status(400).json({ error: 'Invalid name' });
    }
    if (!isValidIp(ip)) {
        return res.status(400).json({ error: 'Invalid IP address' });
    }
    if (!['http', 'https'].includes(protocol)) {
        return res.status(400).json({ error: 'Protocol must be http or https' });
    }

    const devices = getDevices();
    const newDevice = { id: Date.now().toString(), name: name.trim(), ip, protocol };
    devices.push(newDevice);
    try {
        saveDevices(devices);
    } catch {
        return res.status(500).json({ error: 'Failed to save device' });
    }
    res.status(201).json(newDevice);
});

devicesRouter.put('/:id', (req, res) => {
    const { name, ip, protocol } = req.body;

    if (name !== undefined && (typeof name !== 'string' || name.trim().length === 0)) {
        return res.status(400).json({ error: 'Invalid name' });
    }
    if (ip !== undefined && !isValidIp(ip)) {
        return res.status(400).json({ error: 'Invalid IP address' });
    }
    if (protocol !== undefined && !['http', 'https'].includes(protocol)) {
        return res.status(400).json({ error: 'Protocol must be http or https' });
    }

    const devices = getDevices();
    const idx = devices.findIndex(d => d.id === req.params.id);
    if (idx === -1) {
        return res.status(404).json({ error: 'Device not found' });
    }

    devices[idx] = {
        ...devices[idx],
        ...(name !== undefined && { name: name.trim() }),
        ...(ip !== undefined && { ip }),
        ...(protocol !== undefined && { protocol }),
    };
    try {
        saveDevices(devices);
    } catch {
        return res.status(500).json({ error: 'Failed to save device' });
    }
    res.json(devices[idx]);
});

devicesRouter.delete('/:id', (req, res) => {
    const devices = getDevices().filter(d => d.id !== req.params.id);
    try {
        saveDevices(devices);
    } catch {
        return res.status(500).json({ error: 'Failed to save' });
    }
    res.json({ success: true });
});

app.use('/api/devices', devicesRouter);

// ---------------------------------------------------------------------------
// Proxy middleware
// ---------------------------------------------------------------------------

const proxy = createProxyMiddleware({
    // Dummy default; overridden by `router` below
    target: 'http://127.0.0.1',
    router: (req) => {
        const target = extractTargetFromUrl(req.originalUrl, getDevices());
        if (!target) return 'http://127.0.0.1'; // will 502
        return `${target.protocol}://${target.ip}`;
    },
    secure: false,          // allow self-signed certs on LAN devices
    changeOrigin: true,
    selfHandleResponse: true,
    pathRewrite: (urlPath, req) => {
        // Strip the leading /ip-segment from the path
        // urlPath here is what HPM received (req.url), e.g. "/192.168.1.1/page"
        const segment = urlPath.split('/').filter(Boolean)[0] || '';
        let newPath = urlPath.slice(segment.length + 1) || '/'; // +1 for leading /
        if (!newPath.startsWith('/')) newPath = '/' + newPath;
        return newPath;
    },
    ws: true,
    on: {
        proxyRes: responseInterceptor(async (responseBuffer, proxyRes, req, res) => {
            const target = extractTargetFromUrl(req.originalUrl, getDevices());
            if (!target) return responseBuffer;
            const { ip: targetIp, protocol: targetProtocol } = target;

            log('PROXY', `${req.method} ${req.originalUrl} → ${proxyRes.statusCode}`);

            // ── Location header ──────────────────────────────────────────────
            const location = proxyRes.headers['location'];
            if (location) {
                let newLoc = location;
                const absRegex = new RegExp(`^https?://${escapeRegex(targetIp)}(:[0-9]+)?`);
                newLoc = newLoc.replace(absRegex, '');
                if (newLoc.startsWith('/') && !newLoc.startsWith(`/${targetIp}`)) {
                    newLoc = `/${targetIp}${newLoc}`;
                }
                res.setHeader('location', newLoc);
            }

            // ── Set-Cookie header ─────────────────────────────────────────────
            const setCookie = proxyRes.headers['set-cookie'];
            if (setCookie) {
                const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
                const rewritten = cookies.map(c => {
                    let rc = c.replace(/Domain=[^;]+;?\s*/gi, '');
                    rc = rc.replace(/Path=([^;]+)(;?\s*)/gi, (_m, p) => {
                        let np = p.trim().replace(/\/$/, ''); // strip trailing slash for concat
                        if (np === '' || np === '/') np = `/${targetIp}`;
                        else if (np.startsWith('/') && !np.startsWith(`/${targetIp}`)) {
                            np = `/${targetIp}${np}`;
                        }
                        return `Path=${np}; `;
                    });
                    if (!/Path=/i.test(rc)) {
                        rc += `; Path=/${targetIp}`;
                    }
                    return rc.trim();
                });
                res.setHeader('set-cookie', rewritten);
            }

            const contentType = proxyRes.headers['content-type'] || '';

            // ── HTML rewriting ────────────────────────────────────────────────
            if (contentType.includes('text/html')) {
                let html = responseBuffer.toString('utf8');

                // Replace hardcoded absolute device URLs
                html = replaceAbsoluteUrls(html, targetIp, targetProtocol);

                const $ = cheerio.load(html, { decodeEntities: false });

                // Inject <base> so relative assets resolve correctly
                const baseHref = `/${targetIp}/`;
                if ($('base').length === 0) {
                    if ($('head').length > 0) {
                        $('head').prepend(`<base href="${baseHref}">`);
                    } else {
                        $.root().prepend(`<head><base href="${baseHref}"></head>`);
                    }
                }

                // Rewrite root-relative URLs
                const prefixRootRelative = (val) => {
                    if (!val || val.startsWith(`/${targetIp}`) || val.startsWith('//') ||
                        val.startsWith('http') || val.startsWith('data:') ||
                        val.startsWith('#') || val.startsWith('javascript:')) return val;
                    if (val.startsWith('/')) return `/${targetIp}${val}`;
                    return val; // relative paths handled by <base>
                };

                $('[href]').each((_, el) => {
                    const v = prefixRootRelative($(el).attr('href'));
                    if (v) $(el).attr('href', v);
                });
                $('[src]').each((_, el) => {
                    const v = prefixRootRelative($(el).attr('src'));
                    if (v) $(el).attr('src', v);
                });
                $('form[action]').each((_, el) => {
                    const v = prefixRootRelative($(el).attr('action'));
                    if (v) $(el).attr('action', v);
                });

                return $.html();
            }

            // ── JS / JSON rewriting (absolute URLs in scripts) ────────────────
            if (contentType.includes('javascript') || contentType.includes('json')) {
                let text = responseBuffer.toString('utf8');
                text = replaceAbsoluteUrls(text, targetIp, targetProtocol);
                return Buffer.from(text, 'utf8');
            }

            return responseBuffer;
        }),

        proxyReq: (proxyReq, req) => {
            // No gzip/br so we can parse the response text
            proxyReq.removeHeader('accept-encoding');

            const target = extractTargetFromUrl(req.originalUrl, getDevices());
            if (!target) return;
            const { ip: targetIp, protocol: targetProtocol } = target;

            proxyReq.setHeader('host', targetIp);

            if (proxyReq.getHeader('origin')) {
                proxyReq.setHeader('origin', `${targetProtocol}://${targetIp}`);
            }
            if (proxyReq.getHeader('referer')) {
                try {
                    const url = new URL(proxyReq.getHeader('referer'));
                    // Strip proxy prefix from the referer path
                    const refPath = url.pathname.replace(new RegExp(`^/${escapeRegex(targetIp)}`), '') || '/';
                    proxyReq.setHeader('referer', `${targetProtocol}://${targetIp}${refPath}`);
                } catch {
                    proxyReq.setHeader('referer', `${targetProtocol}://${targetIp}/`);
                }
            }
        },

        error: (err, req, res) => {
            log('ERROR', `Proxy error for ${req.originalUrl}:`, err.message);
            if (!res.headersSent) {
                res.status(502).json({ error: 'Bad Gateway', message: err.message });
            }
        },
    },
});

// ---------------------------------------------------------------------------
// Utilities used in the proxy
// ---------------------------------------------------------------------------

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Replace `http(s)://targetIp[/path]` occurrences with `/${targetIp}/path`.
 * Works in HTML attribute values, JS strings, JSON values, etc.
 */
const replaceAbsoluteUrls = (text, targetIp, _targetProtocol) => {
    const re = new RegExp(`https?://${escapeRegex(targetIp)}`, 'g');
    return text.replace(re, `/${targetIp}`);
};

// ---------------------------------------------------------------------------
// Routing middleware
// ---------------------------------------------------------------------------

app.use((req, res, next) => {
    // Always let API requests through
    if (req.path.startsWith('/api/')) return next();

    const devices = getDevices();

    // ── Direct proxy path: /192.168.1.1/... ────────────────────────────────
    const firstSegment = req.path.split('/').filter(Boolean)[0] || '';
    if (isValidIp(firstSegment)) {
        if (!devices.some(d => d.ip === firstSegment)) {
            return res.status(403).json({ error: 'Forbidden: device not registered' });
        }
        return proxy(req, res, next);
    }

    // ── Referer-based routing: asset requests without IP prefix ─────────────
    // (e.g. browser fetches /script.js because the router page has <script src="/script.js">
    //  and the <base> tag injection didn't catch it — or a fetch() in JS)
    const sourceUrl = req.headers.referer || req.headers.origin;
    if (sourceUrl) {
        try {
            const refUrl = new URL(sourceUrl);
            const refIp = refUrl.pathname.split('/').filter(Boolean)[0] || '';
            if (isValidIp(refIp) && devices.some(d => d.ip === refIp)) {
                // Only prepend if not already prefixed
                if (!req.originalUrl.startsWith(`/${refIp}`)) {
                    req.originalUrl = `/${refIp}${req.originalUrl}`;
                    req.url = req.originalUrl;
                }
                return proxy(req, res, next);
            }
        } catch {
            // Ignore URL parse errors
        }
    }

    next();
});

// ---------------------------------------------------------------------------
// Static frontend + SPA fallback
// ---------------------------------------------------------------------------

const FRONTEND_DIST = path.join(__dirname, 'frontend/dist');
app.use(express.static(FRONTEND_DIST));

// SPA fallback: any unmatched GET → index.html
// Express 5 uses path-to-regexp v8 which requires named wildcards
app.get('/{*path}', (req, res) => {
    const indexPath = path.join(FRONTEND_DIST, 'index.html');
    if (fs.existsSync(indexPath)) {
        res.sendFile(indexPath);
    } else {
        res.status(404).send('Frontend not built. Run `npm run build` in /frontend.');
    }
});

// ---------------------------------------------------------------------------
// Start server + WebSocket upgrade
// ---------------------------------------------------------------------------

const server = app.listen(PORT, () =>
    log('INFO', `Gateway running on http://0.0.0.0:${PORT}`)
);

// Required for ws: true to work in http-proxy-middleware (deprecated in v3+)
// server.on('upgrade', proxy.upgrade);

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

const shutdown = (signal) => {
    log('INFO', `${signal} received, shutting down gracefully…`);
    server.close(() => {
        log('INFO', 'Server closed.');
        process.exit(0);
    });
    // Force exit if not closed within 10s
    setTimeout(() => process.exit(1), 10_000).unref();
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));