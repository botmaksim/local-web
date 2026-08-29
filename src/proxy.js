'use strict';

/**
 * src/proxy.js
 *
 * Reverse-proxy middleware built on http-proxy-middleware (HPM).
 *
 * Request flow:
 *   1.  proxyRouter (Express middleware) is called first.
 *       - If the URL starts with /{registeredIp}, it passes to `proxy` directly.
 *       - If a cookie/referer tells us the device, we prepend the IP and pass to `proxy`.
 *       - Otherwise, we call next() so Express can serve the SPA frontend.
 *
 *   2.  HPM proxy's `router` reads `req.spTarget` (set by proxyRouter) and
 *       returns the upstream URL. It never does its own target detection.
 *
 *   3.  pathRewrite strips the leading /{ip} from the URL before forwarding.
 *
 *   4.  proxyReq rewrites outgoing headers and body URLs.
 *
 *   5.  proxyRes rewrites Location, Set-Cookie and response bodies (HTML/JS/JSON).
 */

const express = require('express');
const path    = require('path');
const fs      = require('fs');
const { PassThrough }          = require('node:stream');
const { createProxyMiddleware } = require('http-proxy-middleware');
const { getDevices, extractTargetFromUrl, isValidIp } = require('./devices');
const {
    proxyBaseUrl,
    replaceAbsoluteUrls,
    rewriteRequestPath,
    rewriteRequestBody,
    rewriteLocationHeader,
    rewriteCookies,
    rewriteHtml,
} = require('./url-rewriter');

const log = (level, msg) =>
    console.log(`[${new Date().toISOString()}] [${level}] ${msg}`);

// ---------------------------------------------------------------------------
// Headers that must be stripped before forwarding to upstream devices.
// Home Assistant and most IoT devices reject X-Forwarded-* unless the source
// IP is in their trusted_proxies list. accept-encoding is stripped so that
// upstream never compresses responses we need to rewrite as text.
// ---------------------------------------------------------------------------
const STRIP_HEADERS = [
    'accept-encoding',
    'x-forwarded-for',
    'x-forwarded-host',
    'x-forwarded-proto',
    'cf-connecting-ip',
    'cf-visitor',
    'cf-ray',
    'cf-ipcountry',
];

// ---------------------------------------------------------------------------
// Proxy middleware (HPM)
// ---------------------------------------------------------------------------

const proxy = createProxyMiddleware({
    // Real target is always set by proxyRouter via req.spTarget.
    // This fallback should never be hit in practice.
    target: 'http://127.0.0.1',

    router: (req) => {
        if (req.spTarget) {
            return `${req.spTarget.protocol}://${req.spTarget.ip}`;
        }
        // WebSocket upgrades bypass proxyRouter, so try to resolve the target here.
        // For WS, req.url has already been set to /{ip}/... by proxyRouter,
        // but if the WS is a direct /{ip}/path request, use extractTargetFromUrl.
        const url = req.originalUrl || req.url || '';
        const target = extractTargetFromUrl(url, getDevices());
        if (target) {
            req.spTarget = target;
            return `${target.protocol}://${target.ip}`;
        }
        return 'http://127.0.0.1';
    },

    secure:             false,
    changeOrigin:       true,
    selfHandleResponse: true,
    ws:                 true,

    pathRewrite: (urlPath) => {
        // Strip leading /{ip} segment from the URL before forwarding upstream.
        if (!urlPath) return '/';
        const withoutLeadingSlash = urlPath.replace(/^\//, '');
        const slashIdx = withoutLeadingSlash.indexOf('/');
        if (slashIdx === -1) return '/';
        const rest = withoutLeadingSlash.slice(slashIdx);
        return rest || '/';
    },

    on: {
        // ── Outgoing HTTP request ────────────────────────────────────────────
        proxyReq: (proxyReq, req) => {
            STRIP_HEADERS.forEach(h => proxyReq.removeHeader(h));

            const target = req.spTarget;
            if (!target) return;

            const { ip: targetIp, protocol: targetProtocol } = target;
            const targetBase = `${targetProtocol}://${targetIp}`;
            const proxyBase  = proxyBaseUrl(req, targetIp);
            const proxyOrigin = proxyBaseUrl(req, '').replace(/\/$/, '');

            // Set Host to the device's IP so its virtual-host routing works.
            proxyReq.setHeader('host', targetIp);

            // Rewrite the path (query-string OAuth parameters like client_id / redirect_uri).
            proxyReq.path = rewriteRequestPath(proxyReq.path, proxyBase, targetBase, proxyOrigin);

            // Rewrite Origin and Referer so CSRF checks pass.
            if (proxyReq.getHeader('origin')) {
                proxyReq.setHeader('origin', targetBase);
            }
            if (proxyReq.getHeader('referer')) {
                try {
                    const { escapeRegex } = require('./url-rewriter');
                    const u     = new URL(proxyReq.getHeader('referer'));
                    const rPath = u.pathname.replace(new RegExp(`^/${escapeRegex(targetIp)}`), '') || '/';
                    proxyReq.setHeader('referer', `${targetBase}${rPath}${u.search}`);
                } catch {
                    proxyReq.setHeader('referer', `${targetBase}/`);
                }
            }
        },

        // ── Outgoing WebSocket ───────────────────────────────────────────────
        proxyReqWs: (proxyReq, req, socket, options) => {
            STRIP_HEADERS.forEach(h => proxyReq.removeHeader(h));

            let targetHost  = '';
            let targetProto = 'http';

            if (options.target) {
                const t = options.target;
                if (typeof t === 'string') {
                    const u = new URL(t);
                    targetHost  = u.hostname;
                    targetProto = u.protocol.replace(':', '');
                } else if (t.hostname) {
                    targetHost  = t.hostname;
                    targetProto = (t.protocol || 'http:').replace(':', '');
                }
            }

            if (!targetHost || targetHost === '127.0.0.1') {
                log('WS', `No valid WS target — aborting`);
                socket.destroy();
                return;
            }

            proxyReq.setHeader('host', targetHost);
            if (proxyReq.getHeader('origin')) {
                proxyReq.setHeader('origin', `${targetProto}://${targetHost}`);
            }
            log('WS', `Proxying WebSocket to ${targetHost}`);
        },

        // ── Incoming response ────────────────────────────────────────────────
        proxyRes: (proxyRes, req, res) => {
            const target = req.spTarget;
            if (!target) {
                // No device target — pass through as-is.
                res.writeHead(proxyRes.statusCode, proxyRes.headers);
                proxyRes.pipe(res);
                return;
            }

            const { ip: targetIp, protocol: targetProtocol } = target;
            const proxyBase = proxyBaseUrl(req, targetIp);

            log('PROXY', `${req.method} ${req.originalUrl} → ${proxyRes.statusCode}`);

            const headers = { ...proxyRes.headers };

            // Rewrite Location header on redirects.
            if (headers['location']) {
                headers['location'] = rewriteLocationHeader(
                    headers['location'], targetIp, targetProtocol, proxyBase
                );
            }

            // Rewrite device Set-Cookie headers and append our session-tracking cookie.
            const deviceCookies = headers['set-cookie']
                ? rewriteCookies(headers['set-cookie'], targetIp)
                : [];
            const spCookie = `sp_active_device=${targetIp}; Path=/; Max-Age=2592000; SameSite=Lax`;
            headers['set-cookie'] = [...deviceCookies, spCookie];

            // Always remove transfer-encoding — Node's http client already de-chunks,
            // so re-sending it causes protocol violations in the browser.
            delete headers['transfer-encoding'];

            const contentType    = (headers['content-type'] || '').toLowerCase();
            const contentEncoding = (headers['content-encoding'] || '').toLowerCase();
            const isCompressed   = contentEncoding && contentEncoding !== 'identity';

            // Only rewrite uncompressed text payloads.
            // Compressed payloads must pass through as binary — attempting to
            // decode them as UTF-8 text would corrupt the gzip/br stream.
            const isRewritable = !isCompressed && (
                contentType.includes('text/html') ||
                contentType.includes('javascript') ||
                contentType.includes('json')
            );

            if (!isRewritable) {
                res.writeHead(proxyRes.statusCode, headers);
                proxyRes.pipe(res);
                return;
            }

            // Buffer the full response body, rewrite URLs, then send.
            const chunks = [];
            proxyRes.on('data', chunk => chunks.push(chunk));
            proxyRes.on('end', () => {
                let body = Buffer.concat(chunks).toString('utf8');

                body = replaceAbsoluteUrls(body, targetIp, req);

                if (contentType.includes('text/html')) {
                    body = rewriteHtml(body, targetIp, req.originalUrl);
                }

                const rewritten = Buffer.from(body, 'utf8');
                headers['content-length'] = String(rewritten.length);
                res.writeHead(proxyRes.statusCode, headers);
                res.end(rewritten);
            });
        },

        // ── Proxy error ──────────────────────────────────────────────────────
        error: (err, req, res) => {
            log('ERROR', `Proxy error for ${req.originalUrl || req.url || ''}: ${err.message}`);
            if (res.headersSent) return;
            if (typeof res.status === 'function') {
                res.status(502).json({ error: 'Bad Gateway', message: err.message });
            } else if (res.writable) {
                res.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
            }
        },
    },
});

// ---------------------------------------------------------------------------
// Frontend dist directory (used to avoid hijacking the proxy's own assets)
// ---------------------------------------------------------------------------
const FRONTEND_DIST = path.join(__dirname, '..', 'frontend', 'dist');

// ---------------------------------------------------------------------------
// Express routing middleware
// ---------------------------------------------------------------------------

/**
 * proxyRouter decides how each request is handled:
 *
 *  1.  /__smartproxy_api/ → skip to the API router (next())
 *  2.  /{registeredIp}/… → body-parse if needed, then proxy
 *  3.  Referer/cookie identifies a device:
 *        - Path is '/'  OR  file exists in frontend/dist → skip to SPA (next())
 *        - Otherwise → prepend /{ip} to req.url and proxy
 *  4.  No device context → next() (SPA)
 */
function proxyRouter(req, res, next) {
    if (req.path.startsWith('/__smartproxy_api/')) return next();

    const devices      = getDevices();
    const firstSegment = req.path.split('/').filter(Boolean)[0] || '';

    // ── Case 1: explicit /{ip}/… URL ────────────────────────────────────────
    if (isValidIp(firstSegment)) {
        const device = devices.find(d => d.ip === firstSegment);
        if (!device) {
            return res.status(403).json({ error: 'Forbidden: device not registered' });
        }

        req.spTarget = device;

        // Parse the body for requests that may carry proxy URLs in them
        // (e.g. Home Assistant OAuth login_flow / token exchange).
        const ct = (req.headers['content-type'] || '').toLowerCase();
        const needsBodyParse =
            ct.includes('application/json') ||
            ct.includes('+json') ||
            ct.includes('application/x-www-form-urlencoded') ||
            ct.includes('multipart/form-data') ||
            req.path.includes('/auth/login_flow') ||
            req.path.includes('/auth/token');

        if (needsBodyParse) {
            let parser;
            if (ct.includes('json')) {
                parser = express.json({ verify: (r, _res, buf) => { r._rawBody = buf; } });
            } else if (ct.includes('application/x-www-form-urlencoded')) {
                parser = express.urlencoded({ extended: true, verify: (r, _res, buf) => { r._rawBody = buf; } });
            } else {
                parser = express.raw({ type: () => true, limit: '10mb', verify: (r, _res, buf) => { r._rawBody = buf; } });
            }

            return parser(req, res, () => {
                const bodyBuf = rewriteBody(req, device, ct);
                patchReqStream(req, bodyBuf);
                return proxy(req, res, next);
            });
        }

        return proxy(req, res, next);
    }

    // ── Case 2: no IP prefix — check Referer / cookie ───────────────────────
    let refIp = '';

    const sourceUrl = req.headers.referer || req.headers.origin;
    if (sourceUrl) {
        try {
            refIp = new URL(sourceUrl).pathname.split('/').filter(Boolean)[0] || '';
        } catch { /* ignore malformed URLs */ }
    }

    if (!refIp && req.cookies?.sp_active_device) {
        refIp = req.cookies.sp_active_device;
    }

    if (refIp && isValidIp(refIp) && devices.some(d => d.ip === refIp)) {
        // Let the SPA handle the root dashboard and its own static files.
        if (req.method === 'GET') {
            if (req.path === '/') return next();
            const staticPath = path.join(FRONTEND_DIST, req.path);
            if (fs.existsSync(staticPath)) return next();
        }

        // Route to the device: prepend /{ip} so pathRewrite can strip it.
        const device = devices.find(d => d.ip === refIp);
        req.spTarget = device;
        req.url = `/${refIp}${req.url}`;
        return proxy(req, res, next);
    }

    // ── Case 3: no device context — serve SPA ───────────────────────────────
    return next();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Rewrite proxy URLs inside the raw request body buffer.
 * Returns the (possibly modified) buffer.
 */
function rewriteBody(req, device, ct) {
    const bodyBuf = req._rawBody || Buffer.alloc(0);
    if (!bodyBuf.length) return bodyBuf;

    const pb = proxyBaseUrl(req, device.ip);
    const tb = `${device.protocol}://${device.ip}`;
    const po = proxyBaseUrl(req, '').replace(/\/$/, '');

    try {
        const str = bodyBuf.toString('utf8');
        let rewritten;
        if (ct.includes('json')) {
            rewritten = JSON.stringify(rewriteRequestBody(JSON.parse(str), pb, tb, po));
        } else {
            rewritten = rewriteRequestPath(str, pb, tb, po);
        }
        return Buffer.from(rewritten, 'utf8');
    } catch (e) {
        log('ERROR', `Body rewrite failed: ${e.message}`);
        return bodyBuf;
    }
}

/**
 * After express.json() / urlencoded() has consumed req, replace the stream
 * methods on req so that HPM can pipe the (rewritten) body buffer downstream.
 */
function patchReqStream(req, bodyBuf) {
    const stream = new PassThrough();
    stream.end(bodyBuf);

    req.pipe   = (...a) => stream.pipe(...a);
    req.on     = (...a) => { stream.on(...a); return req; };
    req.once   = (...a) => { stream.once(...a); return req; };
    req.resume = ()     => { stream.resume(); return req; };
    req.unpipe = (...a) => { stream.unpipe(...a); return req; };

    req.headers['content-length'] = String(bodyBuf.length);
    delete req.headers['transfer-encoding'];
}

module.exports = { proxyRouter, proxy };
