import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// When running plain `vite dev`, the /api/* serverless functions aren't
// served by Vite. Use `vercel dev` for the full stack (frontend + token endpoint).
// If you'd rather stay on `vite dev`, point this proxy at a local server that
// implements /api/ably-token.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
  },
});
