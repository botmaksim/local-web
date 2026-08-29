'use strict';

/**
 * src/url-rewriter.js
 *
 * URL, HTML and cookie rewriting utilities for the proxy.
 *
 * The main challenge is that the proxied device's origin (e.g. http://192.168.100.10)
 * appears in responses in multiple encoded forms:
 *   - plain:        http://192.168.100.10/path
 *   - URL-encoded:  http%3A%2F%2F192.168.100.10%2Fpath
 *   - JSON-escaped: http:\/\/192.168.100.10\/path
 *   - Base64 JSON:  state=eyJoYXNzVXJsIjoiaHR0cDovLzE5Mi4xNjguMTAwLjEwIn0=
 *
 * All of these must be rewritten to use the external proxy base URL so that
 * the browser never tries to navigate directly to the unreachable internal IP.
 *
 * On the request side (onProxyReq), the reverse transformation is applied:
 * the external proxy URL is restored to the internal target URL so that the
 * upstream server (e.g. Home Assistant) receives the values it expects.
 */

const cheerio = require('cheerio');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Escape a string for use inside a RegExp literal. */
const escapeRegex = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Derive the external proxy base URL from an incoming request.
 * Honours X-Forwarded-Proto set by a reverse proxy / CDN in front of us.
 * @param {import('http').IncomingMessage} req
 * @param {string} targetIp
 * @returns {string}  e.g. "https://proxy.example.com/192.168.100.10"
 */
function proxyBaseUrl(req, targetIp) {
    const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
    const host  = req.headers.host;
    return `${proto}://${host}/${targetIp}`;
}

// ---------------------------------------------------------------------------
// Base64-state rewriter (used by Home Assistant OAuth)
// ---------------------------------------------------------------------------

/**
 * Replace occurrences of `fromUrl` inside a Base64-encoded JSON state
 * parameter (e.g. `state=eyJ...`).
 *
 * @param {string}   text     - Source text that may contain `state=...`
 * @param {string}   fromUrl  - URL to search for inside the decoded state
 * @param {string}   toUrl    - Replacement URL
 * @returns {string}
 */
function rewriteBase64State(text, fromUrl, toUrl) {
    return text.replace(/state=([a-zA-Z0-9+/=%]+)/g, (match, b64) => {
        try {
            const decoded = Buffer.from(decodeURIComponent(b64), 'base64').toString('utf8');
            if (!decoded.includes(fromUrl)) return match;
            
            let regexStr = escapeRegex(fromUrl);
            if (!fromUrl.startsWith('http')) {
                regexStr = `https?://${regexStr}(:[0-9]+)?`;
            }
            const regex = new RegExp(regexStr, 'g');
            
            const rewritten = decoded.replace(regex, toUrl);
            const rewrittenFallback = rewritten.replace(new RegExp(escapeRegex(fromUrl), 'g'), toUrl);
            return 'state=' + encodeURIComponent(Buffer.from(rewrittenFallback).toString('base64'));
        } catch {
            return match;
        }
    });
}

// ---------------------------------------------------------------------------
// replaceAbsoluteUrls
// ---------------------------------------------------------------------------

/**
 * Rewrite every occurrence of the device's own origin inside a response body
 * (text/html, JS, JSON) so that the browser sees the proxy URL instead.
 *
 * Handles plain, URL-encoded, JSON-escaped, and Base64-embedded forms.
 *
 * @param {string}                          text
 * @param {string}                          targetIp   e.g. "192.168.100.10"
 * @param {import('http').IncomingMessage}  req
 * @returns {string}
 */
function replaceAbsoluteUrls(text, targetIp, req) {
    const proxyBase   = proxyBaseUrl(req, targetIp);
    const targetRe    = new RegExp(`https?://${escapeRegex(targetIp)}(:[0-9]+)?`, 'g');
    const jsonSlashed = new RegExp(`https?:\\\\/\\\\/${escapeRegex(targetIp)}(:[0-9]+)?`, 'g');
    const proxySlash  = proxyBase.replace(/\//g, '\\/');

    let out = text;

    // 1. Plain: http://192.168.x.x → proxyBase
    out = out.replace(targetRe, proxyBase);

    // 2. URL-encoded: http%3A%2F%2F192.168.x.x → encodeURIComponent(proxyBase)
    const encodedTarget  = encodeURIComponent(targetIp);
    const encodedTargetRe = new RegExp(`https?%3A%2F%2F${encodedTarget}(%3A[0-9]+)?`, 'gi');
    out = out.replace(encodedTargetRe, encodeURIComponent(proxyBase));

    // 3. JSON-escaped: http:\/\/192.168.x.x → JSON-escaped proxyBase
    out = out.replace(jsonSlashed, proxySlash);

    // 4. Base64-encoded JSON state parameter (Home Assistant OAuth)
    out = rewriteBase64State(out, targetIp, proxyBase);

    // 5. Inline JS root redirects: location.href = "/" → location.href = "/{ip}/"
    out = out.replace(
        /(location\.href|location\.replace|location\.assign|window\.location|top\.location\.href|top\.location|parent\.location|window\.top\.location)\s*(=|\()\s*(['"])\/(["'])/g,
        `$1$2$3/${targetIp}/$4`
    );

    return out;
}

// ---------------------------------------------------------------------------
// rewriteRequestBody / rewriteRequestPath
// ---------------------------------------------------------------------------

/**
 * Restore the proxy's external URL back to the internal target URL inside a
 * request URL path (query string, OAuth parameters).
 *
 * @param {string} urlPath
 * @param {string} proxyBase   e.g. "https://proxy.example.com/192.168.100.10"
 * @param {string} targetBase  e.g. "http://192.168.100.10"
 * @param {string} proxyOrigin e.g. "https://proxy.example.com"
 * @returns {string}
 */
function rewriteRequestPath(urlPath, proxyBase, targetBase, proxyOrigin = '') {
    let out = urlPath;

    // Plain
    out = out.replace(new RegExp(escapeRegex(proxyBase), 'g'), targetBase);
    if (proxyOrigin) {
        out = out.replace(new RegExp(escapeRegex(proxyOrigin) + '(?=[/&?=\\r\\n"\' ]|$)', 'g'), targetBase);
    }

    // URL-encoded
    out = out.replace(
        new RegExp(encodeURIComponent(proxyBase), 'gi'),
        encodeURIComponent(targetBase)
    );
    if (proxyOrigin) {
        out = out.replace(
            new RegExp(encodeURIComponent(proxyOrigin) + '(?=[a-zA-Z0-9%])', 'gi'),
            encodeURIComponent(targetBase)
        );
        // Also just replace the exact origin encoded
        out = out.replace(
            new RegExp(encodeURIComponent(proxyOrigin) + '$', 'gi'),
            encodeURIComponent(targetBase)
        );
    }

    // Base64 state
    out = rewriteBase64State(out, proxyBase, targetBase);
    if (proxyOrigin) out = rewriteBase64State(out, proxyOrigin, targetBase);

    return out;
}

/**
 * Restore the proxy's external URL back to the internal target URL inside a
 * parsed request body object (mutates `body` in place, returns new object).
 *
 * @param {object} body
 * @param {string} proxyBase
 * @param {string} targetBase
 * @param {string} proxyOrigin
 * @returns {object}
 */
function rewriteRequestBody(body, proxyBase, targetBase, proxyOrigin = '') {
    let str = JSON.stringify(body).replace(
        new RegExp(escapeRegex(proxyBase), 'g'),
        targetBase
    );
    if (proxyOrigin) {
        str = str.replace(
            new RegExp(escapeRegex(proxyOrigin) + '(?=[/&"\'?=]|$)', 'g'),
            targetBase
        );
    }
    return JSON.parse(str);
}

// ---------------------------------------------------------------------------
// rewriteLocationHeader
// ---------------------------------------------------------------------------

/**
 * Rewrite the `Location` response header so the browser stays on the proxy.
 *
 * @param {string} loc        Original Location value
 * @param {string} targetIp
 * @param {string} targetProto
 * @param {string} proxyBase
 * @returns {string}
 */
function rewriteLocationHeader(loc, targetIp, targetProto, proxyBase) {
    const absRe = new RegExp(`^https?://${escapeRegex(targetIp)}(:[0-9]+)?`);

    // Absolute self-URL → proxyBase
    loc = loc.replace(absRe, proxyBase);

    // Relative URL without device prefix → prepend /{targetIp}
    if (loc.startsWith('/') && !loc.startsWith(`/${targetIp}`)) {
        loc = `/${targetIp}${loc}`;
    }

    // URL-encoded query params
    loc = loc.replace(
        new RegExp(encodeURIComponent(`${targetProto}://${targetIp}`), 'gi'),
        encodeURIComponent(proxyBase)
    );

    // Base64 state
    loc = rewriteBase64State(loc, `${targetProto}://${targetIp}`, proxyBase);

    return loc;
}

// ---------------------------------------------------------------------------
// rewriteCookies
// ---------------------------------------------------------------------------

/**
 * Rewrite Set-Cookie headers from the device:
 *   - Strip `Domain` attribute (the cookie must be scoped to the proxy domain)
 *   - Prefix `Path` with `/{targetIp}` so cookies don't bleed between devices
 *
 * @param {string|string[]} setCookie
 * @param {string}          targetIp
 * @returns {string[]}
 */
function rewriteCookies(setCookie, targetIp) {
    const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
    return cookies.map(c => {
        // Strip the device's own Domain so the cookie is scoped to the proxy domain.
        let rc = c.replace(/Domain=[^;]+;?\s*/gi, '');
        // Reset Path to / — the cookie must be sent with ALL requests to the proxy,
        // not just those under /{ip}/. (HA auth tokens, for example, are sent to
        // /auth/token which in our proxy becomes /{ip}/auth/token.)
        rc = rc.replace(/Path=[^;]+(;?\s*)/gi, 'Path=/; ');
        if (!/Path=/i.test(rc)) rc += '; Path=/';
        return rc.trim();
    });
}

// ---------------------------------------------------------------------------
// rewriteHtml
// ---------------------------------------------------------------------------

/**
 * Post-process an HTML response body with Cheerio:
 *   - Inject / overwrite a `<base>` tag so relative URLs resolve correctly
 *   - Rewrite root-relative hrefs, srcs, actions and srcsets
 *   - Rewrite meta-refresh URLs
 *
 * @param {string} html
 * @param {string} targetIp
 * @param {string} [originalUrl]
 * @returns {string}
 */
function rewriteHtml(html, targetIp, originalUrl = '') {
    const $ = cheerio.load(html, { decodeEntities: false });

    // Compute dynamic base path from the current request URL
    const urlPath = originalUrl.split('?')[0];
    let basePath = `/${targetIp}/`;
    if (urlPath.startsWith(`/${targetIp}/`)) {
        basePath = urlPath.substring(0, urlPath.lastIndexOf('/') + 1);
    }

    // Intercept client-side routing and API calls
    const interceptorScript = `
    <script>
    (function() {
        const prefix = '/${targetIp}';
        const proxyOrigin = window.location.origin;
        const targetOrigin = 'http://' + '${targetIp}';

        function rewriteUrl(url) {
            if (!url) return url;
            try {
                if (typeof url === 'string' && url.startsWith('/') && !url.startsWith(prefix)) {
                    return prefix + url;
                }
                const u = new URL(url, window.location.href);
                if (u.origin === targetOrigin || u.host === '${targetIp}') {
                    u.host = window.location.host;
                    u.protocol = window.location.protocol;
                    if (!u.pathname.startsWith(prefix)) {
                        u.pathname = prefix + (u.pathname === '/' ? '' : u.pathname);
                    }
                    return u.href;
                }
                if (u.origin === proxyOrigin && !u.pathname.startsWith(prefix) && !u.pathname.startsWith('/__smartproxy')) {
                    u.pathname = prefix + u.pathname;
                    return u.href;
                }
            } catch (e) {}
            return url;
        }

        
        const originalFetch = window.fetch;
        window.fetch = function() {
            if (arguments[0]) arguments[0] = rewriteUrl(arguments[0]);
            return originalFetch.apply(this, arguments);
        };

        const originalOpen = XMLHttpRequest.prototype.open;
        XMLHttpRequest.prototype.open = function() {
            if (arguments[1]) arguments[1] = rewriteUrl(arguments[1]);
            return originalOpen.apply(this, arguments);
        };
        
        // Also intercept ServiceWorker registration if any
        if (navigator.serviceWorker) {
            const originalRegister = navigator.serviceWorker.register;
            navigator.serviceWorker.register = function(url, options) {
                return originalRegister.call(this, rewriteUrl(url), options);
            };
        }
    })();
    </script>
    `;

    // Overwrite existing <base> or inject one at the top of <head>
    if ($('base').length > 0) {
        $('base').attr('href', basePath);
        $('base').after(interceptorScript);
    } else {
        const baseTag = `<base href="${basePath}">`;
        if ($('head').length > 0) $('head').prepend(baseTag + interceptorScript);
        else $.root().prepend(`<head>${baseTag}${interceptorScript}</head>`);
    }

    const rewrite = val => {
        if (!val || val.startsWith(`/${targetIp}`) ||
            /^(https?:|\/\/|data:|#|javascript:)/i.test(val)) return val;
        if (val.startsWith('/')) return `/${targetIp}${val}`;
        return val;
    };

    $('[href]').each((_, el)      => { const v = rewrite($(el).attr('href'));   if (v) $(el).attr('href', v); });
    $('[src]').each((_, el)       => { const v = rewrite($(el).attr('src'));    if (v) $(el).attr('src', v); });
    $('form[action]').each((_, el) => { const v = rewrite($(el).attr('action')); if (v) $(el).attr('action', v); });

    // Rewrite srcset (responsive images: "url descriptor, url descriptor, …")
    $('[srcset]').each((_, el) => {
        const srcset = $(el).attr('srcset');
        if (!srcset) return;
        const rewritten = srcset.split(',').map(part => {
            const trimmed = part.trim();
            const spaceIdx = trimmed.search(/\s/);
            if (spaceIdx === -1) return rewrite(trimmed);
            return rewrite(trimmed.slice(0, spaceIdx)) + trimmed.slice(spaceIdx);
        }).join(', ');
        $(el).attr('srcset', rewritten);
    });

    // Rewrite meta refresh tags
    $('meta[http-equiv="refresh" i]').each((_, el) => {
        let content = $(el).attr('content');
        if (content) {
            content = content.replace(
                /(url\s*=\s*)(['"]?)\/(.*?)(['"]?)/i,
                (m, p1, p2, p3, p4) => p3
                    ? `${p1}${p2}/${targetIp}/${p3}${p4}`
                    : `${p1}${p2}/${targetIp}/${p4}`
            );
            $(el).attr('content', content);
        }
    });

    return $.html();
}

module.exports = {
    escapeRegex,
    proxyBaseUrl,
    replaceAbsoluteUrls,
    rewriteRequestPath,
    rewriteRequestBody,
    rewriteLocationHeader,
    rewriteCookies,
    rewriteHtml,
};
