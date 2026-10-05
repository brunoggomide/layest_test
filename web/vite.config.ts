import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The dashboard calls the API on the same origin; in development Vite forwards /api to the Node server.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/api': 'http://127.0.0.1:3000' },
  },
});
