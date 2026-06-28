import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// In production, point /api at your backend proxy that holds the vendor API keys
// (Amilia, Hik-Connect, ProCare). The browser never sees those secrets.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Forward /api calls to the backend proxy (server/index.js) that holds the keys.
    proxy: { "/api": "http://localhost:8787" },
  },
});
