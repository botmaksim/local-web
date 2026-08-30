'use strict';

const deviceCookieKeys = new Map(); // ip -> Set<string>

function trackCookies(ip, setCookieHeader) {
    if (!setCookieHeader) return;
    const cookies = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
    const keys = deviceCookieKeys.get(ip) || new Set();
    
    cookies.forEach(c => {
        const match = c.match(/^([^=;]+)=/);
        if (match) {
            keys.add(match[1].trim());
        }
    });
    
    deviceCookieKeys.set(ip, keys);
}

function getTrackedCookies(ip) {
    const keys = deviceCookieKeys.get(ip);
    return keys ? Array.from(keys) : [];
}

module.exports = { trackCookies, getTrackedCookies };
