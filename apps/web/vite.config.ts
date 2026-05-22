import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import basicSsl from "@vitejs/plugin-basic-ssl";

// HTTPS-by-default dev server. Spotify's OAuth (and `getDisplayMedia` in
// stricter browsers) requires HTTPS — Spotify dropped plain http://localhost
// support for new apps in 2025. basicSsl generates a self-signed cert on
// first boot; the browser will warn once, then accept for the session.
export default defineConfig({
  plugins: [react(), basicSsl()],
  server: {
    host: true,
    port: 5173,
    strictPort: false,
    https: true,
  },
  build: {
    target: "es2022",
    sourcemap: true,
  },
});
