const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
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
            ...d,
            protocol: d.protocol || 'http'
        }));
    } catch {
        _deviceCache = [];
    }
    return _deviceCache;
};

const saveDevices = (devices) => {
    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    fs.writeFileSync(DB_FILE, JSON.stringify(devices, null, 2));
    _deviceCache = devices;
};

const isValidIp = (str) => {
    if (!str) return false;
    const [ipPart] = str.split(':');
    const parts = ipPart.split('.');
    return parts.length === 4 && parts.every(p => {
        const n = parseInt(p, 10);
        return n >= 0 && n <= 255;
    });
};

const extractTargetFromUrl = (url, devices) => {
    const segment = url.split('/').filter(Boolean)[0] || '';
    if (!segment) return null;

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
// Proxy middleware (selfHandleResponse: false — stable, no event-loop drain)
// ---------------------------------------------------------------------------

const proxy = createProxyMiddleware({
    target: 'http://127.0.0.1',
    router: (req) => {
        const target = extractTargetFromUrl(req.originalUrl, getDevices());
        if (!target) return 'http://127.0.0.1';
        return `${target.protocol}://${target.ip}`;
    },
    secure: false,
    changeOrigin: true,
    selfHandleResponse: true,
    pathRewrite: (urlPath) => {
        const segment = urlPath.split('/').filter(Boolean)[0] || '';
        let newPath = urlPath.slice(segment.length + 1) || '/';
        if (!newPath.startsWith('/')) newPath = '/' + newPath;
        return newPath;
    },
    ws: true,
    on: {
        proxyReq: (proxyReq, req) => {
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
                    const refPath = url.pathname.replace(new RegExp(`^/${escapeRegex(targetIp)}`), '') || '/';
                    proxyReq.setHeader('referer', `${targetProtocol}://${targetIp}${refPath}`);
                } catch {
                    proxyReq.setHeader('referer', `${targetProtocol}://${targetIp}/`);
                }
            }
        },
        proxyRes: (proxyRes, req, res) => {
            const target = extractTargetFromUrl(req.originalUrl, getDevices());
            if (!target) {
                proxyRes.pipe(res);
                return;
            }
            const { ip: targetIp, protocol: targetProtocol } = target;

            log('PROXY', `${req.method} ${req.originalUrl} → ${proxyRes.statusCode}`);

            // ── Copy Status & Headers ─────────────────────────────────────────
            const headers = { ...proxyRes.headers };

            if (headers['location']) {
                let loc = headers['location'];
                const re = new RegExp(`^https?://${escapeRegex(targetIp)}(:[0-9]+)?`);
                loc = loc.replace(re, '');
                if (loc.startsWith('/') && !loc.startsWith(`/${targetIp}`)) {
                    loc = `/${targetIp}${loc}`;
                }
                headers['location'] = loc;
            }

            if (headers['set-cookie']) {
                headers['set-cookie'] = rewriteCookies(headers['set-cookie'], targetIp);
            }

            const contentType = (headers['content-type'] || '').toLowerCase();
            const isText = contentType.includes('text/html') ||
                           contentType.includes('javascript') ||
                           contentType.includes('json');

            if (!isText) {
                res.writeHead(proxyRes.statusCode, headers);
                proxyRes.pipe(res);
                return;
            }

            // ── Read and Rewrite Body ─────────────────────────────────────────
            const chunks = [];
            proxyRes.on('data', chunk => chunks.push(chunk));
            proxyRes.on('end', () => {
                let body = Buffer.concat(chunks).toString('utf8');

                body = replaceAbsoluteUrls(body, targetIp);

                if (contentType.includes('text/html')) {
                    body = rewriteHtml(body, targetIp, req.originalUrl);
                }

                const rewritten = Buffer.from(body, 'utf8');
                headers['content-length'] = String(rewritten.length);
                delete headers['transfer-encoding'];

                res.writeHead(proxyRes.statusCode, headers);
                res.end(rewritten);
            });
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
// Utilities
// ---------------------------------------------------------------------------

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const replaceAbsoluteUrls = (text, targetIp) => {
    const re = new RegExp(`https?://${escapeRegex(targetIp)}(:[0-9]+)?`, 'g');
    let replaced = text.replace(re, `/${targetIp}`);
    
    // Also rewrite common JS redirects that point exactly to root "/"
    replaced = replaced.replace(/(location\.href|location\.replace|location\.assign|window\.location|top\.location\.href|top\.location|parent\.location|window\.top\.location)\s*(=|\()\s*(['"])\/(['"])/g, `$1$2$3/${targetIp}/$4`);
    
    return replaced;
};

const rewriteCookies = (setCookie, targetIp) => {
    const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
    return cookies.map(c => {
        let rc = c.replace(/Domain=[^;]+;?\s*/gi, '');
        rc = rc.replace(/Path=([^;]+)(;?\s*)/gi, (_m, p) => {
            let np = p.trim().replace(/\/$/, '');
            if (np === '' || np === '/') np = `/${targetIp}`;
            else if (np.startsWith('/') && !np.startsWith(`/${targetIp}`)) {
                np = `/${targetIp}${np}`;
            }
            return `Path=${np}; `;
        });
        if (!/Path=/i.test(rc)) rc += `; Path=/${targetIp}`;
        return rc.trim();
    });
};

const rewriteHtml = (html, targetIp, originalUrl = '') => {
    const $ = cheerio.load(html, { decodeEntities: false });
    
    // Compute dynamic base path from the current request URL
    const urlPath = originalUrl.split('?')[0];
    let basePath = `/${targetIp}/`;
    if (urlPath.startsWith(`/${targetIp}/`)) {
        basePath = urlPath.substring(0, urlPath.lastIndexOf('/') + 1);
    }
    
    if ($('base').length === 0) {
        const baseTag = `<base href="${basePath}">`;
        if ($('head').length > 0) $('head').prepend(baseTag);
        else $.root().prepend(`<head>${baseTag}</head>`);
    }
    const rewrite = (val) => {
        if (!val || val.startsWith(`/${targetIp}`) ||
            /^(https?:|\/\/|data:|#|javascript:)/i.test(val)) return val;
        if (val.startsWith('/')) return `/${targetIp}${val}`;
        return val;
    };
    $('[href]').each((_, el) => { const v = rewrite($(el).attr('href')); if (v) $(el).attr('href', v); });
    $('[src]').each((_, el)  => { const v = rewrite($(el).attr('src'));  if (v) $(el).attr('src', v);  });
    $('form[action]').each((_, el) => { const v = rewrite($(el).attr('action')); if (v) $(el).attr('action', v); });
    
    // Rewrite meta refresh tags
    $('meta[http-equiv="refresh" i]').each((_, el) => {
        let content = $(el).attr('content');
        if (content) {
            content = content.replace(/(url\s*=\s*)(['"]?)\/([^/']*)(['"]?)/i, (match, p1, p2, p3, p4) => {
                if (!p3) return `${p1}${p2}/${targetIp}/${p4}`; // it was just "/"
                return `${p1}${p2}/${targetIp}/${p3}${p4}`;
            });
            $(el).attr('content', content);
        }
    });
    
    return $.html();
};

// ---------------------------------------------------------------------------
// Routing middleware
// ---------------------------------------------------------------------------

app.use((req, res, next) => {
    if (req.path.startsWith('/api/')) return next();

    const devices = getDevices();
    const firstSegment = req.path.split('/').filter(Boolean)[0] || '';

    // ── Direct proxy: /192.168.1.1/... ──────────────────────────────────────
    if (isValidIp(firstSegment)) {
        if (!devices.some(d => d.ip === firstSegment)) {
            return res.status(403).json({ error: 'Forbidden: device not registered' });
        }
        return proxy(req, res, next);
    }

    // ── Referer-based routing: asset requests without IP prefix ──────────────
    const sourceUrl = req.headers.referer || req.headers.origin;
    if (sourceUrl) {
        try {
            const refUrl = new URL(sourceUrl);
            const refIp = refUrl.pathname.split('/').filter(Boolean)[0] || '';
            if (isValidIp(refIp) && devices.some(d => d.ip === refIp)) {
                
                // If a script dynamically redirects the browser to the root (e.g. window.location = "/"),
                // it's a top-level HTML navigation. We intercept it and issue a 302 redirect back to the device.
                if (req.path === '/' && req.method === 'GET') {
                    const accept = req.headers.accept || '';
                    if (accept.includes('text/html')) {
                        return res.redirect(`/${refIp}/`);
                    }
                }

                if (!req.originalUrl.startsWith(`/${refIp}`)) {
                    // Force the browser to update its address bar and context 
                    // by issuing a 307 Temporary Redirect (preserves POST bodies).
                    // This ensures subsequent JS redirects have the correct referer.
                    return res.redirect(307, `/${refIp}${req.originalUrl}`);
                }
                return proxy(req, res, next);
            }
        } catch { /* ignore URL parse errors */ }
    }

    next();
});

// ---------------------------------------------------------------------------
// Static frontend + SPA fallback
// ---------------------------------------------------------------------------

const FRONTEND_DIST = path.join(__dirname, 'frontend/dist');
app.use(express.static(FRONTEND_DIST));

app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
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
    setTimeout(() => process.exit(1), 10_000).unref();
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
