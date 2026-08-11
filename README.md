# Smart Proxy Gateway

Smart Proxy Gateway is a lightweight, containerized web proxy designed to provide centralized, secure access to various local network web interfaces (such as routers, smart home devices, printers, and NAS) through a single entry point.

It eliminates the need for managing multiple subdomains by leveraging dynamic HTML rewriting and Referer-based request recovery, ensuring that complex web interfaces and their sub-resources load correctly.

## Architecture

The project consists of two main components:
- **Proxy Backend (`server.js`)**: A Node.js and Express application utilizing `http-proxy-middleware`. It acts as a transparent proxy, dynamically inserting `<base>` tags and recovering lost requests for absolute paths.
- **Frontend Dashboard (`frontend/`)**: A React-based Single Page Application (SPA) providing a modern management interface to add, edit, and remove devices from the gateway.

## Features

- **Centralized Access**: Access any device on your local network through a single domain and port (`http://localhost:9091/<ip>/`).
- **Dynamic Link Rewriting**: Automatically rewrites absolute and relative paths in HTML responses to ensure CSS, JavaScript, and images load correctly behind the proxy.
- **Referer-based Request Recovery**: Intelligently intercepts requests for missing assets triggered by JavaScript or hardcoded absolute paths by analyzing the `Referer` header and routing them to the correct device.
- **SSRF Protection**: Hardened proxy routing that restricts connections strictly to the IP addresses registered in the dashboard database.

## Installation and Usage

### Prerequisites

- [Docker](https://docs.docker.com/get-docker/)
- [Docker Compose](https://docs.docker.com/compose/install/)

### Running the Application

The application is fully containerized. To build and start the service in detached mode, run:

```bash
docker compose up -d --build
```

The gateway and dashboard will be available at `http://localhost:9091`.

### Managing Devices

1. Navigate to the dashboard at `http://localhost:9091`.
2. Use the provided form to add a new device by specifying its name and IP address (e.g., `192.168.1.1` or `192.168.1.1:8080`).
3. Click "Открыть" (Open) on the device card to access its web interface securely through the proxy.

## Development

To run the project locally without Docker:

1. Install dependencies for the backend:
   ```bash
   npm install
   ```
2. Start the backend server:
   ```bash
   npm run dev
   ```
3. Install dependencies for the frontend:
   ```bash
   cd frontend
   npm install
   ```
4. Start the frontend development server:
   ```bash
   npm run dev
   ```

## Security Considerations

- **Authorization**: The dashboard currently operates without authentication. It is strongly recommended to place this gateway behind a secure reverse proxy (like Nginx) or a VPN tunnel if exposed to the internet.
- **SSRF Prevention**: The proxy middleware actively checks incoming requests against the registered device list (`devices.json`) and denies unauthorized outbound connections.
