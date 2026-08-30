'use strict';

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'cookies.json');

let deviceCookieKeys = new Map(); // ip -> Set<string>

// Load from disk
try {
    if (fs.existsSync(DB_FILE)) {
        const data = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
        for (const [ip, keys] of Object.entries(data)) {
            deviceCookieKeys.set(ip, new Set(keys));
        }
    }
} catch (e) {
    console.error('Failed to load cookie tracker:', e);
}

function save() {
    try {
        if (!fs.existsSync(DATA_DIR)) {
            fs.mkdirSync(DATA_DIR, { recursive: true });
        }
        const data = {};
        for (const [ip, keys] of deviceCookieKeys.entries()) {
            data[ip] = Array.from(keys);
        }
        fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
    } catch (e) {
        console.error('Failed to save cookie tracker:', e);
    }
}

function trackCookies(ip, setCookieHeader) {
    if (!setCookieHeader) return;
    const cookies = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
    const keys = deviceCookieKeys.get(ip) || new Set();
    let changed = false;
    
    cookies.forEach(c => {
        const match = c.match(/^([^=;]+)=/);
        if (match) {
            const key = match[1].trim();
            if (!keys.has(key)) {
                keys.add(key);
                changed = true;
            }
        }
    });
    
    if (changed) {
        deviceCookieKeys.set(ip, keys);
        save();
    }
}

function getTrackedCookies(ip) {
    const keys = deviceCookieKeys.get(ip);
    return keys ? Array.from(keys) : [];
}

module.exports = { trackCookies, getTrackedCookies };
