// SPDX-License-Identifier: Apache-2.0
// The native app's dev server (its devUrl): the same app as vite.config.ts, with no proxy.
// Inside the app the shell is the network (rx: and IPC), so nothing here reaches a
// receiver, and never :7373. `VITE_PORT=7816 npx vite --config web/vite.native.config.ts`.
// It also serves the views the app ships (Canvas, Office) at /themes/<id>/, from
// dist/bundled/views, where the built app has them (apps/desktop/scripts/assemble-frontend.sh).
import { createReadStream, statSync } from "node:fs";
import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const port = Number(process.env.VITE_PORT);
if (!port) throw new Error("set VITE_PORT (the app's devUrl port)");

const VIEWS = path.resolve(__dirname, "../dist/bundled/views");
const TYPES: Record<string, string> = { ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };

/** /themes/{canvas,office}/<file> from dist/bundled/views, as the app bundles them. */
const appViews = (): Plugin => ({
  name: "app-views",
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      const m = /^\/themes\/(canvas|office)\/([^?#]+)/.exec(req.url ?? "");
      if (!m) return next();
      const file = path.resolve(VIEWS, m[1]!, decodeURIComponent(m[2]!));
      if (!file.startsWith(`${VIEWS}${path.sep}`)) return next();
      try {
        if (!statSync(file).isFile()) return next();
      } catch {
        return next();
      }
      res.setHeader("content-type", TYPES[path.extname(file)] ?? "application/octet-stream");
      createReadStream(file).pipe(res);
    });
  },
});

export default defineConfig({
  root: __dirname,
  plugins: [react(), appViews()],
  resolve: { alias: { "@shared": path.resolve(__dirname, "../shared") } },
  build: { outDir: path.resolve(__dirname, "../dist/web"), emptyOutDir: true, sourcemap: true },
  server: { port, strictPort: true, host: "127.0.0.1" },
});
