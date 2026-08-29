'use strict';

/**
 * src/proxy.js
 *
 * Reverse-proxy middleware built on http-proxy-middleware.
 *
 * Key responsibilities:
 *   onProxyReq  – strip proxy-added / CDN headers that confuse upstream servers
 *                 (e.g. Home Assistant rejects requests with X-Forwarded-* unless
 *                 the sender is in its `trusted_proxies` list); rewrite the
 *                 outgoing path and JSON body so the upstream receives its own
 *                 URLs back (required for OAuth client_id / redirect_uri checks).
 *
 *   onProxyRes  – rewrite Location headers, Set-Cookie paths, and response
 *                 bodies (HTML / JS / JSON) so that every reference to the
 *                 device's own origin is replaced by the external proxy URL.
 *
 *   onError     – return a clean 502 instead of crashing.
 */

const express = require('express');
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

const log = (level, msg, extra = '') =>
    console.log(`[${new Date().toISOString()}] [${level}] ${msg}${extra ? ' ' + extra : ''}`);

// ---------------------------------------------------------------------------
// Proxy middleware
// ---------------------------------------------------------------------------

const proxy = createProxyMiddleware({
    // Fallback target — overridden dynamically by `router`
    target: 'http://127.0.0.1',

    router: (req) => {
        const url = req.originalUrl || req.url || '';
        let target = extractTargetFromUrl(url, getDevices());
        if (target) return `${target.protocol}://${target.ip}`;
        
        // Handle WebSocket upgrades which bypass Express middleware
        // Try to get target from Referer or Cookie
        let refIp = '';
        const sourceUrl = req.headers.referer || req.headers.origin;
        if (sourceUrl) {
            try {
                refIp = new URL(sourceUrl).pathname.split('/').filter(Boolean)[0] || '';
            } catch { /* ignore */ }
        }
        
        if (!refIp && req.headers.cookie && req.headers.cookie.includes('sp_active_device=')) {
            const match = req.headers.cookie.match(/sp_active_device=([^;]+)/);
            if (match) refIp = match[1];
        }
        
        if (refIp) {
            const devices = getDevices();
            const dev = devices.find(d => d.ip === refIp);
            if (dev) {
                // Do not hijack the root proxy dashboard if routing by referer/cookie
                const isRoot = (req.originalUrl || req.url) === '/';
                if (isRoot && req.method === 'GET') {
                    return undefined; // Let express handle it
                }
                
                // Prepend refIp to req.url so pathRewrite strips it properly
                req.url = `/${refIp}${req.url}`;
                return `${dev.protocol}://${dev.ip}`;
            }
        }
        
        return 'http://127.0.0.1';
    },

    secure:            false,
    changeOrigin:      true,
    selfHandleResponse: true,
    ws:                true,

    // Strip the /{ip} prefix before forwarding to the upstream server
    // Also rewrite URLs in query strings (e.g. OAuth client_id/redirect_uri)
    pathRewrite: (urlPath, req) => {
        if (!urlPath) return '/';
        const segment = urlPath.split('/').filter(Boolean)[0] || '';
        let newPath   = urlPath.slice(segment.length + 1) || '/';
        if (!newPath.startsWith('/')) newPath = '/' + newPath;

        const target = extractTargetFromUrl(req.originalUrl || req.url, getDevices());
        if (target) {
            const pb = proxyBaseUrl(req, target.ip);
            const tb = `${target.protocol}://${target.ip}`;
            const po = proxyBaseUrl(req, '').replace(/\/$/, '');
            newPath = rewriteRequestPath(newPath, pb, tb, po);
        }
        return newPath;
    },

    on: {
        // ── Outgoing request ────────────────────────────────────────────────
        proxyReq: (proxyReq, req) => {
            // Remove headers that could confuse upstream servers.
            // Home Assistant (and many IoT devices) reject requests that include
            // X-Forwarded-* unless the proxying IP is explicitly trusted.
            const headersToStrip = [
                'accept-encoding',   // We read the body ourselves — no compression
                'x-forwarded-for',
                'x-forwarded-host',
                'x-forwarded-proto',
                'cf-connecting-ip',
                'cf-visitor',
                'cf-ray',
                'cf-ipcountry',
            ];
            headersToStrip.forEach(h => proxyReq.removeHeader(h));

            const target = extractTargetFromUrl(req.originalUrl, getDevices());
            if (!target) return;

            const { ip: targetIp, protocol: targetProtocol } = target;
            const targetBase = `${targetProtocol}://${targetIp}`;
            const proxyBase  = proxyBaseUrl(req, targetIp);

            // Set Host to the upstream's own IP so its virtual-host routing works
            proxyReq.setHeader('host', targetIp);

            const proxyOrigin = proxyBaseUrl(req, '').replace(/\/$/, '');
            proxyReq.path = rewriteRequestPath(proxyReq.path, proxyBase, targetBase, proxyOrigin);


            // Rewrite Origin / Referer so CSRF checks pass
            if (proxyReq.getHeader('origin')) {
                proxyReq.setHeader('origin', targetBase);
            }
            if (proxyReq.getHeader('referer')) {
                try {
                    const { escapeRegex } = require('./url-rewriter');
                    const url     = new URL(proxyReq.getHeader('referer'));
                    const refPath = url.pathname.replace(new RegExp(`^/${escapeRegex(targetIp)}`), '') || '/';
                    proxyReq.setHeader('referer', `${targetBase}${refPath}${url.search}`);
                } catch {
                    proxyReq.setHeader('referer', `${targetBase}/`);
                }
            }
        },


        // ── Outgoing WebSocket ─────────────────────────────────────────────
        // ── Outgoing WebSocket ─────────────────────────────────────────────
        proxyReqWs: (proxyReq, req, socket, options, head) => {
            try {
                let targetHost = '';
                let targetProto = '';
                
                if (typeof options.target === 'string') {
                    const u = new URL(options.target);
                    targetHost = u.hostname;
                    targetProto = u.protocol.replace(':', '');
                } else if (options.target && options.target.hostname) {
                    targetHost = options.target.hostname;
                    targetProto = (options.target.protocol || 'http:').replace(':', '');
                } else {
                    console.log('[WS DEBUG] Cannot parse options.target:', options.target);
                    return;
                }
                
                console.log(`[WS DEBUG] Upgrade request for: ${req.url}, resolved target: ${targetProto}://${targetHost}`);
                
                const headersToStrip = [
                    'x-forwarded-for',
                    'x-forwarded-host',
                    'x-forwarded-proto',
                    'cf-connecting-ip',
                    'cf-visitor',
                    'cf-ray',
                    'cf-ipcountry',
                ];
                headersToStrip.forEach(h => proxyReq.removeHeader(h));

                if (targetHost === '127.0.0.1' || targetHost === 'localhost') {
                    console.log(`[WS DEBUG] Target is localhost, aborting header rewrite`);
                    return;
                }

                const targetBase = `${targetProto}://${targetHost}`;
                proxyReq.setHeader('host', targetHost);
                if (proxyReq.getHeader('origin')) {
                    proxyReq.setHeader('origin', targetBase);
                }
                console.log(`[WS DEBUG] Successfully rewrote WS headers for ${targetHost}`);
            } catch (err) {
                console.error('[WS ERROR]', err);
            }
        },

        // ── Incoming response ───────────────────────────────────────────────
        proxyRes: (proxyRes, req, res) => {
            const target = extractTargetFromUrl(req.originalUrl, getDevices());
            if (!target) {
                proxyRes.pipe(res);
                return;
            }
            const { ip: targetIp, protocol: targetProtocol } = target;
            const proxyBase = proxyBaseUrl(req, targetIp);

            log('PROXY', `${req.method} ${req.originalUrl} → ${proxyRes.statusCode}`);

            const headers = { ...proxyRes.headers };

            // Rewrite Location header
            if (headers['location']) {
                headers['location'] = rewriteLocationHeader(
                    headers['location'], targetIp, targetProtocol, proxyBase
                );
            }

            // Rewrite Set-Cookie + append context tracking cookie
            const deviceCookies = headers['set-cookie']
                ? rewriteCookies(headers['set-cookie'], targetIp)
                : [];
            const spCookie = `sp_active_device=${targetIp}; Path=/; Max-Age=2592000; SameSite=Lax`;
            headers['set-cookie'] = [...deviceCookies, spCookie];

            // Pass binary / non-text responses straight through
            const contentType = (headers['content-type'] || '').toLowerCase();
            let isText = contentType.includes('text/html')   ||
                         contentType.includes('javascript')  ||
                         contentType.includes('json');
                         
            if (headers['content-encoding'] && headers['content-encoding'] !== 'identity') {
                isText = false; // Do not corrupt compressed binary payloads
            }

            if (!isText) {
                // Node's http client automatically de-chunks the response.
                // We MUST strip transfer-encoding so we don't send invalid chunked framing!
                delete headers['transfer-encoding'];
                res.writeHead(proxyRes.statusCode, headers);
                proxyRes.pipe(res);
                return;
            }

            // Buffer and rewrite the text body
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
                delete headers['transfer-encoding'];

                res.writeHead(proxyRes.statusCode, headers);
                res.end(rewritten);
            });
        },

        // ── Error handling ──────────────────────────────────────────────────
        error: (err, req, res) => {
            const url = req.originalUrl || req.url || '';
            log('ERROR', `Proxy error for ${url}:`, err.message);
            if (res.status && typeof res.status === 'function') {
                if (!res.headersSent) res.status(502).json({ error: 'Bad Gateway', message: err.message });
            } else if (res.writable) {
                res.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
            }
        },
    },
});

// ---------------------------------------------------------------------------
// Routing middleware
// ---------------------------------------------------------------------------

/**
 * Express middleware that decides whether a request should be proxied.
 *
 * Routing priority:
 *   1. Requests starting with /{registeredIp} → proxy directly.
 *   2. Requests whose Referer / cookie indicate a device context
 *      → 307 redirect to add the IP prefix (preserves POST bodies).
 *   3. Everything else → pass through to the SPA fallback.
 *
 * @param {import('express').Request}  req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
function proxyRouter(req, res, next) {
    if (req.path.startsWith('/__smartproxy_api/')) return next();

    const devices       = getDevices();
    const firstSegment  = req.path.split('/').filter(Boolean)[0] || '';

    // Direct proxy: /192.168.x.x/…
    if (isValidIp(firstSegment)) {
        if (!devices.some(d => d.ip === firstSegment)) {
            return res.status(403).json({ error: 'Forbidden: device not registered' });
        }
        // For JSON requests, parse the body so we can rewrite proxy URLs in it
        // (e.g. Home Assistant login_flow client_id / redirect_uri).
        //
        // Problem: express.json() consumes the req stream. HPM then tries to
        // req.pipe(proxyReq) and gets an empty stream → upstream gets no body.
        //
        // Solution: capture the raw bytes with verify(), rewrite URLs in them,
        // then rebuild req as a Readable so HPM pipes the correct data.
        const ct = (req.headers['content-type'] || '').toLowerCase();
        if (
            ct.includes('application/json') || 
            ct.includes('+json') || 
            ct.includes('application/x-www-form-urlencoded') ||
            ct.includes('multipart/form-data') ||
            req.originalUrl.includes('/auth/login_flow') ||
            req.originalUrl.includes('/auth/token')
        ) {
            let parser;
            if (ct.includes('json')) {
                parser = express.json({ verify: (req, _res, buf) => { req._rawBody = buf; } });
            } else if (ct.includes('application/x-www-form-urlencoded')) {
                parser = express.urlencoded({ extended: true, verify: (req, _res, buf) => { req._rawBody = buf; } });
            } else {
                parser = express.raw({ type: () => true, limit: '50mb', verify: (req, _res, buf) => { req._rawBody = buf; } });
            }

            return parser(req, res, () => {
                // Rewrite URLs inside the raw body buffer (e.g. HA OAuth client_id)
                let target = extractTargetFromUrl(req.originalUrl || req.url, getDevices());
                if (!target && req.cookies && req.cookies.sp_active_device) {
                    target = getDevices().find(d => d.ip === req.cookies.sp_active_device);
                }
                if (!target && req.headers.referer) {
                    const match = req.headers.referer.match(/https?:\/\/[^\/]+\/([0-9]+\.[0-9]+\.[0-9]+\.[0-9]+(:[0-9]+)?)/);
                    if (match) target = getDevices().find(d => d.ip === match[1]);
                }

                let bodyBuf     = req._rawBody || Buffer.alloc(0);
                
                if (req.originalUrl.includes('/auth/login_flow') || req.originalUrl.includes('/auth/token')) {
                    console.log(`[DEBUG-PRE-REWRITE] URL: ${req.originalUrl}, target: ${!!target}, hasBody: ${!!req._rawBody}, length: ${bodyBuf.length}, ct: ${ct}`);
                }

                if (target && bodyBuf.length > 0) {
                    const pb = proxyBaseUrl(req, target.ip);
                    const tb = `${target.protocol}://${target.ip}`;
                    const po = proxyBaseUrl(req, '').replace(/\/$/, ''); // https://proxy.example.com
                    try {
                        const strBody = bodyBuf.toString('utf8');

                        let rewrittenStr = strBody;
                        if (ct.includes('json')) {
                            const parsed    = JSON.parse(strBody);
                            const rewritten = rewriteRequestBody(parsed, pb, tb, po);
                            rewrittenStr = JSON.stringify(rewritten);
                        } else {
                            // URL-encoded or multipart/form-data string replacement
                            rewrittenStr = rewriteRequestPath(strBody, pb, tb, po);
                        }
                        
                        if (req.originalUrl.includes('/auth/token') || req.originalUrl.includes('/auth/login_flow')) {
                            const logLine = "[DEBUG] " + req.method + " " + req.originalUrl + " -> rewritten body:\\n" + rewrittenStr.substring(0, 500) + "\\n==========================\\n";
                            console.log(logLine);
                            require('fs').appendFileSync('auth_debug.log', logLine);
                        }

                        bodyBuf = Buffer.from(rewrittenStr, 'utf8');
                    } catch (e) {
                        console.error("[DEBUG] BODY REWRITE ERROR:", e);
                        require('fs').appendFileSync('auth_debug.log', "\\n[DEBUG] ERROR in rewrite: " + String(e) + "\\n");
                    }
                }

                // httpxy does: (options.buffer || req).pipe(proxyReq)
                // express.json() already consumed req, so we give httpxy a
                // PassThrough stream pre-loaded with our (possibly rewritten) body.
                // PassThrough is a full Duplex implementing the entire Stream API,
                // so httpxy can safely pipe it without hitting missing methods.
                const { PassThrough } = require('node:stream');
                const bodyStream = new PassThrough();
                bodyStream.end(bodyBuf);

                // Redirect all stream-related accesses on req to our buffer stream
                req.pipe   = (...a) => bodyStream.pipe(...a);
                req.on     = (...a) => { bodyStream.on(...a); return req; };
                req.once   = (...a) => { bodyStream.once(...a); return req; };
                req.resume = () => { bodyStream.resume(); return req; };
                req.unpipe = (...a) => { bodyStream.unpipe(...a); return req; };

                // Update Content-Length so upstream uses the correct body size
                req.headers['content-length'] = String(bodyBuf.length);
                delete req.headers['transfer-encoding'];

                return proxy(req, res, next);
            });
        }
        return proxy(req, res, next);
    }

    // Referer / cookie-based routing for asset requests without an IP prefix
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
        // Allow explicit navigation to the proxy dashboard
        // Allow explicit navigation to the proxy dashboard and its assets
        if (req.method === 'GET') {
            if (req.path === '/') return next();
            
            const path = require('path');
            const fs = require('fs');
            const staticPath = path.join(__dirname, '..', 'frontend', 'dist', req.path);
            if (fs.existsSync(staticPath)) {
                return next();
            }
        }

        
        return proxy(req, res, next);
    }

    next();
}

module.exports = { proxyRouter, proxy };
