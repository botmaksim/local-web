const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const app = express();

app.use('/:ip', (req, res, next) => {
    const targetIp = req.params.ip;
    if (!/^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/.test(targetIp)) {
        return next();
    }
    const proxy = createProxyMiddleware({
        target: `http://${targetIp}`,
        changeOrigin: true,
        pathRewrite: { [`^/${targetIp}`]: '' },
        onProxyReq: (proxyReq, req, res) => {
            console.log(`[PROXY] Sending request to: ${proxyReq.protocol}//${proxyReq.host}${proxyReq.path}`);
        }
    });
    proxy(req, res, next);
});

app.listen(9093, () => console.log('test'));
