'use strict';

/**
 * src/devices.js
 *
 * Device registry — persistence, validation, and SSRF guards.
 * Devices are stored as JSON in data/devices.json with an in-memory cache
 * that is invalidated only on writes.
 */

const fs   = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_FILE  = path.join(DATA_DIR, 'devices.json');

// ---------------------------------------------------------------------------
// In-memory cache — invalidated on every write
// ---------------------------------------------------------------------------

let _cache = null;

/**
 * Return the current list of devices, reading from disk on first access.
 * Migrates legacy entries that are missing the `protocol` field.
 * @returns {Array<{id: string, name: string, ip: string, protocol: string}>}
 */
function getDevices() {
    if (_cache !== null) return _cache;

    if (!fs.existsSync(DB_FILE)) {
        _cache = [];
        return _cache;
    }

    try {
        _cache = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
        // Migrate legacy entries that lack `protocol` field
        _cache = _cache.map(d => ({ ...d, protocol: d.protocol || 'http' }));
    } catch {
        _cache = [];
    }

    return _cache;
}

/**
 * Persist devices to disk and update the in-memory cache.
 * @param {Array} devices
 */
function saveDevices(devices) {
    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    fs.writeFileSync(DB_FILE, JSON.stringify(devices, null, 2));
    _cache = devices;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

// Each octet must be a decimal 0-255 with no leading zeros.
const OCTET_RE = /^(25[0-5]|2[0-4]\d|1\d{2}|[1-9]\d|\d)$/;

/**
 * Return true when `str` is a valid IPv4 address, optionally with a port.
 * Rejects leading zeros, octets > 255, invalid ports, and extra colons.
 * @param {string} str
 * @returns {boolean}
 */
function isValidIp(str) {
    if (!str) return false;
    const [ipPart, portPart, ...rest] = str.split(':');
    if (rest.length > 0) return false; // More than one colon → invalid

    const parts = ipPart.split('.');
    if (parts.length !== 4 || !parts.every(p => OCTET_RE.test(p))) return false;

    if (portPart !== undefined) {
        if (!/^\d+$/.test(portPart)) return false;
        const port = parseInt(portPart, 10);
        if (port <= 0 || port > 65535) return false;
    }

    return true;
}

// Block loopback / link-local addresses to prevent SSRF.
// Set ALLOW_LOOPBACK=true to bypass this check in test/dev environments.
const BLOCKED_PREFIXES = ['127.', '169.254.'];

/**
 * Return true when the IP should be blocked to prevent SSRF.
 * @param {string} str
 * @returns {boolean}
 */
function isBlockedIp(str) {
    if (process.env.ALLOW_LOOPBACK === 'true') return false;
    if (!str) return false;
    const [ipPart] = str.split(':');
    return ipPart === '0.0.0.0' || BLOCKED_PREFIXES.some(p => ipPart.startsWith(p));
}

/**
 * Given the full request URL, extract the target device.
 * The first URL segment is expected to be the device IP.
 * @param {string} url
 * @param {Array} devices
 * @returns {{ ip: string, protocol: string } | null}
 */
function extractTargetFromUrl(url, devices) {
    const segment = url.split('/').filter(Boolean)[0] || '';
    if (!segment) return null;
    const device = devices.find(d => d.ip === segment);
    if (!device) return null;
    return { ip: segment, protocol: device.protocol || 'http' };
}

module.exports = { getDevices, saveDevices, isValidIp, isBlockedIp, extractTargetFromUrl };
