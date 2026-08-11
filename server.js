const express = require('express');
const { createProxyMiddleware, responseInterceptor } = require('http-proxy-middleware');
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

const getDevices = () => {
    if (!fs.existsSync(DB_FILE)) return [];
    try {
        return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    } catch (err) {
        console.error('Error reading DB:', err);
        return [];
    }
};

const saveDevices = (data) => {
    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
};

app.get('/api/devices', (req, res) => res.json(getDevices()));

app.post('/api/devices', (req, res) => {
    const { name, ip } = req.body;
    const devices = getDevices();
    const newDevice = { id: Date.now().toString(), name, ip };
    devices.push(newDevice);
    saveDevices(devices);
    res.json(newDevice);
});

app.put('/api/devices/:id', (req, res) => {
    const { name, ip } = req.body;
    let devices = getDevices();
    const deviceIndex = devices.findIndex(d => d.id === req.params.id);
    if (deviceIndex > -1) {
        devices[deviceIndex] = { ...devices[deviceIndex], name, ip };
        saveDevices(devices);
        res.json(devices[deviceIndex]);
    } else {
        res.status(404).json({ error: 'Device not found' });
    }
});

app.delete('/api/devices/:id', (req, res) => {
    let devices = getDevices();
    devices = devices.filter(d => d.id !== req.params.id);
    saveDevices(devices);
    res.json({ success: true });
});

const proxy = createProxyMiddleware({
    target: 'http://127.0.0.1',
    router: (req) => {
        const ip = req.originalUrl.split('/')[1];
        return `http://${ip}`;
    },
    secure: false,
    changeOrigin: true,
    selfHandleResponse: true,
    pathRewrite: (path, req) => {
        const ip = path.split('/')[1];
        let newPath = path.replace(`/${ip}`, '');
        if (!newPath.startsWith('/')) newPath = '/' + newPath;
        return newPath;
    },
    on: {
        proxyRes: responseInterceptor(async (responseBuffer, proxyRes, req, res) => {
            const targetIp = req.originalUrl.split('/')[1];
            
            // Rewrite Location header if present
            const location = res.getHeader('location') || proxyRes.headers['location'];
            if (location) {
                let newLoc = location;
                const ipRegex = new RegExp(`^https?://${targetIp}(:[0-9]+)?`);
                if (ipRegex.test(newLoc)) {
                    newLoc = newLoc.replace(ipRegex, '');
                }
                if (newLoc.startsWith('/')) {
                    newLoc = `/${targetIp}${newLoc}`;
                }
                res.setHeader('location', newLoc);
            }

            const contentType = proxyRes.headers['content-type'];
            if (contentType && contentType.includes('text/html')) {
                let html = responseBuffer.toString('utf8');
                
                // Replace hardcoded absolute IPs in scripts or HTML
                const absoluteIpRegex = new RegExp(`https?://${targetIp}(:[0-9]+)?`, 'g');
                html = html.replace(absoluteIpRegex, `/${targetIp}`);
                
                const $ = cheerio.load(html);
                
                if ($('head').length > 0) {
                    $('head').prepend(`<base href="/${targetIp}/">`);
                } else {
                    $('html').prepend(`<head><base href="/${targetIp}/"></head>`);
                }

                $('a[href^="/"], link[href^="/"]').each((_, el) => {
                    const href = $(el).attr('href');
                    if (href && !href.startsWith(`/${targetIp}`)) {
                        $(el).attr('href', `/${targetIp}${href}`);
                    }
                });
                $('img[src^="/"], script[src^="/"]').each((_, el) => {
                    const src = $(el).attr('src');
                    if (src && !src.startsWith(`/${targetIp}`)) {
                        $(el).attr('src', `/${targetIp}${src}`);
                    }
                });
                $('form[action^="/"]').each((_, el) => {
                    const action = $(el).attr('action');
                    if (action && !action.startsWith(`/${targetIp}`)) {
                        $(el).attr('action', `/${targetIp}${action}`);
                    }
                });
                return $.html();
            }
            return responseBuffer;
        }),
        proxyReq: (proxyReq, req, res) => {
            proxyReq.removeHeader('accept-encoding');
        },
        error: (err, req, res) => {
            res.status(502).send('Bad Gateway');
        }
    }
});

app.use((req, res, next) => {
    if (req.path.startsWith('/api/')) return next();

    const ipRegex = /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}(?::[0-9]{1,5})?$/;
    const targetIp = req.path.split('/')[1];

    if (ipRegex.test(targetIp)) {
        const devices = getDevices();
        if (!devices.some(d => d.ip === targetIp)) {
            return res.status(403).send('Forbidden: Device IP not registered.');
        }
        return proxy(req, res, next);
    } else {
        const referer = req.headers.referer;
        if (referer) {
            try {
                const refUrl = new URL(referer);
                const refIp = refUrl.pathname.split('/')[1];
                if (ipRegex.test(refIp)) {
                    const devices = getDevices();
                    if (devices.some(d => d.ip === refIp)) {
                        req.originalUrl = `/${refIp}${req.originalUrl}`;
                        req.url = req.originalUrl;
                        return proxy(req, res, next);
                    }
                }
            } catch (e) {
                // Ignore parse errors
            }
        }
    }
    next();
});

app.use(express.static(path.join(__dirname, 'frontend/dist')));
app.listen(PORT, () => console.log(`Gateway running on port ${PORT}`));