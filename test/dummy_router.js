const express = require('express');
const https = require('https');
const fs = require('fs');
const path = require('path');
const app = express();
const port = 8080;

// Load generated certificates
const options = {
    key: fs.readFileSync(path.join(__dirname, 'key.pem')),
    cert: fs.readFileSync(path.join(__dirname, 'cert.pem'))
};

app.get('/', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Dummy Router (HTTPS)</title>
            <link rel="stylesheet" href="/styles.css">
        </head>
        <body>
            <h1>Welcome to the Dummy Router (HTTPS)</h1>
            <p>This is a simulated device interface for testing.</p>
            <form action="/login" method="POST">
                <input type="text" name="username" placeholder="admin">
                <input type="password" name="password" placeholder="password">
                <button type="submit">Login</button>
            </form>
            <script src="/script.js"></script>
            <img src="/logo.png" alt="logo" style="width: 50px; height: 50px; background-color: #ccc;">
        </body>
        </html>
    `);
});

app.get('/styles.css', (req, res) => {
    res.setHeader('Content-Type', 'text/css');
    res.send('body { font-family: sans-serif; background-color: #f0f0f0; } h1 { color: #333; }');
});

app.get('/script.js', (req, res) => {
    res.setHeader('Content-Type', 'application/javascript');
    res.send('console.log("Dummy Router Script Loaded!");');
});

app.post('/login', (req, res) => {
    res.send('<h1>Login Attempt Received</h1><a href="/">Go back</a>');
});

app.get('/logo.png', (req, res) => {
    // Return a dummy transparent pixel for the image
    const img = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
    res.writeHead(200, {
        'Content-Type': 'image/png',
        'Content-Length': img.length
    });
    res.end(img);
});

https.createServer(options, app).listen(port, () => {
    console.log(`Dummy router (HTTPS) is listening on port ${port}`);
    console.log(`To test the proxy, add a device with IP: 127.0.0.1:${port}`);
});
