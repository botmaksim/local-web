# Smart Proxy Gateway (netmap)

Smart Proxy Gateway is a lightweight, containerized reverse proxy designed to provide centralized, secure access to local network web interfaces (such as routers, smart home appliances, NAS systems, and printers) through a unified entry point.

It eliminates the overhead of managing multiple subdomains or complex VPN routes by combining dynamic path rewriting, HTML/JS asset rewriting, device-scoped cookie isolation, and Referer-based request recovery.

---

## Key Features

- **Centralized Gateway**: Route to any registered local device via `http://<gateway-host>:9091/<ip>/`.
- **Drag-and-Drop Reordering**: Rearrange device cards on the dashboard via intuitive drag-and-drop; device order is automatically synchronized with the backend.
- **Cloudflare Access & Zero Trust Integration**:
  - Native logout workflow that revokes active sessions and clears `CF_Authorization`, `CF_AppSession`, and auxiliary verification cookies.
  - Dedicated `/cdn-cgi/access/logout` integration with fallback redirection to origin.
- **Dynamic Content & Link Rewriting**:
  - Automatically rewrites root-relative (`/`), absolute, and relative URLs within HTML, CSS, JavaScript, and JSON payloads.
  - Injects dynamic `<base>` tags to preserve relative asset loading.
- **Cookie Isolation & Management**:
  - Strips upstream `Domain` restrictions to enforce device cookie isolation.
  - Tracks active sessions using device context cookies (`sp_active_device`).
  - Per-device cookie reset to resolve stale upstream authentication states without clearing global sessions.
  - Client-side storage cleaner to purge local and session storage safely.
- **SSRF & Host Header Protection**:
  - Strict input validation preventing SSRF attacks, directory traversal, credentials in IP fields (`user:pass@host`), and unauthorized private subnet probes.
  - Proxy requests are restricted strictly to devices registered in the configuration store.
- **HTTPS Upstream Support**: Seamlessly proxies both plain HTTP and self-signed HTTPS device interfaces.

---

## Architecture

```
                    ┌─────────────────────────┐
                    │    Cloudflare Access    │
                    │   (Identity & Tunnel)   │
                    └───────────┬─────────────┘
                                │
                                ▼
                     Smart Proxy Gateway (:9091)
         ┌──────────────────────┴──────────────────────┐
         │                                             │
         ▼                                             ▼
  Management API & SPA                          Reverse Proxy
  - /__smartproxy_api/devices                   - /<device-ip>/...
  - /__smartproxy_api/logout                    - Dynamic URL Rewriter
  - /cdn-cgi/access/logout                      - Cookie Stripper / Tracker
  - Vite / React Dashboard (netmap)             - Referer Fallback Handler
         │                                             │
         ▼                                             ▼
   devices.json                            Target Device (LAN / IoT)
```

- **Backend (`server.js`)**: Express-based application with `http-proxy-middleware`, custom streaming response transformers, and file-backed persistence (`data/devices.json`).
- **Dashboard (`frontend/`)**: Vite-powered React single page application with modern glassmorphic styling, responsive layout, drag-and-drop controls, and status notifications.

---

## Installation & Deployment

### Prerequisites

- [Docker](https://docs.docker.com/get-docker/) & [Docker Compose](https://docs.docker.com/compose/install/), or
- [Node.js](https://nodejs.org/) (v18 or newer) and `npm`.

### Production Deployment via Docker Compose

```bash
docker compose up -d --build
```

The gateway dashboard will be accessible at `http://localhost:9091`.

### Local Development Setup

1. **Install Backend Dependencies**:
   ```bash
   npm install
   ```

2. **Start Backend Server**:
   ```bash
   npm run dev
   ```

3. **Install Frontend Dependencies & Build**:
   ```bash
   cd frontend
   npm install
   npm run build
   cd ..
   ```

---

## Management API Reference

All management endpoints require same-origin requests.

| Method   | Endpoint                                      | Description                                                    |
| :------- | :-------------------------------------------- | :------------------------------------------------------------- |
| `GET`    | `/__smartproxy_api/devices`                   | Lists all registered devices.                                  |
| `POST`   | `/__smartproxy_api/devices`                   | Registers a new device (`{ name, ip, protocol }`).             |
| `POST`   | `/__smartproxy_api/devices/reorder`           | Reorders devices based on an array of device IDs.              |
| `PUT`    | `/__smartproxy_api/devices/:id`               | Updates an existing device's name, IP, or protocol.            |
| `DELETE` | `/__smartproxy_api/devices/:id`               | Deletes a device by ID.                                        |
| `POST`   | `/__smartproxy_api/devices/:id/clear-cookies`  | Clears stored cookies associated with a specific device.       |
| `POST`   | `/__smartproxy_api/logout`                    | Clears Cloudflare Access and proxy session cookies.            |
| `ALL`    | `/cdn-cgi/access/logout`                      | Cloudflare logout fallback route; clears auth and redirects.  |

---

## Automated Testing

The project includes an end-to-end integration test suite covering API validation, proxying, URL and asset rewriting, redirect chains, cookie isolation, and authentication token removal:

Run the full integration test suite:
```bash
node test/run_tests.js --spawn
```

Run the standalone authentication token deletion test:
```bash
node test/test_auth_token_deletion.js
```

---

## Security & Best Practices

1. **Cloudflare Zero Trust / Access**: When exposing the gateway externally, place it behind Cloudflare Access. The built-in logout button cleanly terminates the session across both the proxy and edge access layers.
2. **Device Whitelisting**: Connections to devices not listed in `devices.json` are rejected with `403 Forbidden`.
3. **Internal Subnet Safety**: Input validation ensures all device definitions conform strictly to IPv4 and standard port semantics, disallowing unexpected protocol schemes or embedded user credentials.
