'use strict';

/**
 * src/auth.js
 *
 * Utilities for authentication and Cloudflare Access session management.
 */

function parseJwtPayload(token) {
    if (!token || typeof token !== 'string') return null;
    const parts = token.split('.');
    if (parts.length < 2) return null;
    try {
        const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
        const json = Buffer.from(base64, 'base64').toString('utf8');
        return JSON.parse(json);
    } catch {
        return null;
    }
}

function getAuthDetails(req) {
    const token = req.cookies?.CF_Authorization ||
                  req.cookies?.cf_authorization ||
                  req.headers?.['cf-access-jwt-assertion'];
    const payload = parseJwtPayload(token);
    let teamDomain = null;
    let teamLogoutUrl = null;
    let email = req.headers?.['cf-access-authenticated-user-email'] || null;

    if (payload) {
        if (!email && payload.email) email = payload.email;
        if (payload.iss && typeof payload.iss === 'string') {
            const iss = payload.iss.trim().replace(/\/+$/, '');
            const match = iss.match(/^https?:\/\/([a-zA-Z0-9-]+)(?:\.[a-zA-Z0-9-]+)*\.cloudflareaccess\.com/i);
            if (match) {
                const teamName = match[1];
                teamDomain = `https://${teamName}.cloudflareaccess.com`;
                teamLogoutUrl = `${teamDomain}/cdn-cgi/access/logout`;
            } else {
                teamDomain = iss;
                teamLogoutUrl = `${iss}/cdn-cgi/access/logout`;
            }
        }
    }

    if (!teamDomain && (process.env.CF_TEAM_DOMAIN || process.env.CF_TEAM_NAME)) {
        const t = (process.env.CF_TEAM_DOMAIN || process.env.CF_TEAM_NAME).trim();
        teamDomain = t.startsWith('http') ? t.replace(/\/+$/, '') : `https://${t}.cloudflareaccess.com`;
        teamLogoutUrl = `${teamDomain}/cdn-cgi/access/logout`;
    }

    return {
        teamDomain,
        teamLogoutUrl,
        email,
    };
}

function clearAuthCookies(req, res) {
    const cookieNames = new Set([
        'CF_Authorization',
        'cf_authorization',
        'cf_clearance',
        'CF_AppSession',
        '__cf_bm',
        '__cfwaitingroom',
        'sp_active_device',
    ]);

    if (req.cookies) {
        Object.keys(req.cookies).forEach(k => {
            const kLower = k.toLowerCase();
            if (kLower.startsWith('cf_') || kLower.startsWith('__cf') || kLower.includes('authoriz')) {
                cookieNames.add(k);
            }
        });
    }

    const host = req.hostname;
    const domains = [undefined];
    if (host && host !== 'localhost' && host !== '127.0.0.1') {
        domains.push(host);
        domains.push('.' + host);
        const parts = host.split('.');
        if (parts.length > 2) {
            domains.push('.' + parts.slice(-2).join('.'));
        }
    }

    const cookieOptionsList = [
        { path: '/' },
        { path: '/', secure: true, sameSite: 'none' },
        { path: '/', secure: true, sameSite: 'lax' },
    ];

    cookieNames.forEach(name => {
        domains.forEach(domain => {
            cookieOptionsList.forEach(opts => {
                res.clearCookie(name, { ...opts, ...(domain ? { domain } : {}) });
            });
        });
    });
}

module.exports = {
    parseJwtPayload,
    getAuthDetails,
    clearAuthCookies,
};
