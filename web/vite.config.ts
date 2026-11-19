// SPDX-License-Identifier: Apache-2.0
import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Dev: `npm run dev` runs this beside the server on :7373 and proxies the API to it
// (`SPGUI_API=http://127.0.0.1:7924` points it at another server).
// Build: static files land in dist/web, served by the server itself.
const api = process.env.SPGUI_API ?? "http://127.0.0.1:7373";
// The server is told the Host the browser asked for (Vite's short form would put its own
// address there): it answers a write whose Origin names the host it was sent to.
const toApi = { target: api, changeOrigin: false };

export default defineConfig({
  root: __dirname,
  plugins: [react()],
  resolve: { alias: { "@shared": path.resolve(__dirname, "../shared") } },
  build: { outDir: path.resolve(__dirname, "../dist/web"), emptyOutDir: true, sourcemap: true },
  server: {
    port: 5173,
    host: true,
    proxy: {
      "/api": toApi,
      "/.well-known": toApi,
      "/themes": toApi,
      "/skins": toApi,
      "/attachments": toApi,
    },
  },
});
