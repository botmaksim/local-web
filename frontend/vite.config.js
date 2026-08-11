import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // In dev mode, proxy /api requests to the backend server
    // so App.jsx never needs to hardcode http://localhost:9091
    proxy: {
      '/api': {
        target: 'http://localhost:9091',
        changeOrigin: true,
      },
    },
  },
});
