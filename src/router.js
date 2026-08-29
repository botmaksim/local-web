'use strict';

/**
 * src/router.js
 *
 * Express Router for the /__smartproxy_api/ management REST API.
 * This API is intentionally NOT exposed with CORS — it must remain same-origin.
 *
 * Endpoints:
 *   GET    /__smartproxy_api/devices          – list all devices
 *   POST   /__smartproxy_api/devices          – add a device
 *   PUT    /__smartproxy_api/devices/:id      – update a device (partial)
 *   DELETE /__smartproxy_api/devices/:id      – remove a device
 */

const express = require('express');
const { getDevices, saveDevices, isValidIp, isBlockedIp } = require('./devices');

const router = express.Router();

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function validateDeviceFields({ name, ip, protocol }, isUpdate = false) {
    if (!isUpdate || name !== undefined) {
        if (!name || typeof name !== 'string' || name.trim().length === 0)
            return 'Invalid name';
    }
    if (!isUpdate || ip !== undefined) {
        if (!isValidIp(ip))  return 'Invalid IP address';
        if (isBlockedIp(ip)) return 'Blocked IP address';
    }
    if (!isUpdate || protocol !== undefined) {
        if (!['http', 'https'].includes(protocol))
            return 'Protocol must be http or https';
    }
    return null;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

router.get('/', (_req, res) => res.json(getDevices()));

router.post('/', (req, res) => {
    const { name, ip, protocol = 'http' } = req.body;

    const err = validateDeviceFields({ name, ip, protocol });
    if (err) return res.status(400).json({ error: err });

    const devices   = getDevices();
    const newDevice = { id: Date.now().toString(), name: name.trim(), ip, protocol };
    devices.push(newDevice);
    try { saveDevices(devices); } catch { return res.status(500).json({ error: 'Failed to save device' }); }

    res.status(201).json(newDevice);
});

router.put('/:id', (req, res) => {
    const { name, ip, protocol } = req.body;

    const err = validateDeviceFields({ name, ip, protocol }, true);
    if (err) return res.status(400).json({ error: err });

    const devices = getDevices();
    const idx     = devices.findIndex(d => d.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Device not found' });

    devices[idx] = {
        ...devices[idx],
        ...(name     !== undefined && { name: name.trim() }),
        ...(ip       !== undefined && { ip }),
        ...(protocol !== undefined && { protocol }),
    };
    try { saveDevices(devices); } catch { return res.status(500).json({ error: 'Failed to save device' }); }

    res.json(devices[idx]);
});

router.delete('/:id', (req, res) => {
    const devices = getDevices().filter(d => d.id !== req.params.id);
    try { saveDevices(devices); } catch { return res.status(500).json({ error: 'Failed to save' }); }
    res.json({ success: true });
});

module.exports = router;
