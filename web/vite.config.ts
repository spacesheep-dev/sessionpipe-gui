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
const here = import.meta.dirname;

/** The browsers the built app is for: Vite 6's default ("modules"), kept when Vite 8 moved its
 *  own to Safari 16.4 / Chrome 111, so a web view the app ran in before (the desktop app on an
 *  older macOS, an Android WebView) still runs it. The native config builds the same. */
export const TARGET = ["es2020", "edge88", "firefox78", "chrome87", "safari14"];

export default defineConfig({
  root: here,
  plugins: [react()],
  resolve: { alias: { "@shared": path.resolve(here, "../shared") } },
  build: { outDir: path.resolve(here, "../dist/web"), emptyOutDir: true, sourcemap: true, target: TARGET },
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
