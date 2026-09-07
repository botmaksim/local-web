'use strict';

/**
 * src/auth.js
 *
 * Utilities for authentication and Cloudflare Access session management.
 */

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

    cookieNames.forEach(name => {
        domains.forEach(domain => {
            res.clearCookie(name, { path: '/', ...(domain ? { domain } : {}) });
        });
    });
}

module.exports = {
    clearAuthCookies,
};
