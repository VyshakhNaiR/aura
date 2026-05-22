import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import basicSsl from "@vitejs/plugin-basic-ssl";

// Two valid Spotify redirect-URI setups for local dev:
//
//   A) http://127.0.0.1:5173/     ← no cert, no warning; loopback IP
//      Run:  pnpm dev          (or PNPM_DEV=http pnpm dev — same thing)
//      Open: http://127.0.0.1:5173/
//
//   B) https://localhost:5173/    ← clean URL but one-time self-signed cert warning
//      Run:  AURA_HTTPS=1 pnpm dev
//      Open: https://localhost:5173/  → click "Advanced → Proceed"
//
// Spotify (since April 2025) rejects `http://localhost` but accepts
// `http://127.0.0.1` (literal loopback IP) over plain HTTP, and any HTTPS.
const useHttps = process.env["AURA_HTTPS"] === "1";

export default defineConfig({
  plugins: [react(), ...(useHttps ? [basicSsl()] : [])],
  server: {
    host: true,
    port: 5173,
    strictPort: false,
    https: useHttps,
  },
  build: {
    target: "es2022",
    sourcemap: true,
  },
});
