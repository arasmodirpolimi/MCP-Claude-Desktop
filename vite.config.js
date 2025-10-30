import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Use BUILD_BASE env var if provided (GitHub Actions) otherwise default '/'
// For GitHub Pages under a repository (user.github.io/repo), set BUILD_BASE to '/repo/'.
const buildBase = process.env.BUILD_BASE || "/"; // e.g. '/mcp_HTTP/'

export default defineConfig({
  base: buildBase,
  plugins: [react()],
  server: {
    proxy: {
      "/mcp": { target: "http://localhost:3100", changeOrigin: true },
      "/anthropic": { target: "http://localhost:3100", changeOrigin: true },
      "/api": { target: "http://localhost:3100", changeOrigin: true },
      "/admin": { target: "http://localhost:3100", changeOrigin: true },
      // Memory endpoints were not proxied previously; without this Vite returns index.html
      // causing Unexpected token '<' when client expects JSON.
      "/memory": { target: "http://localhost:3100", changeOrigin: true }
    }
  },
});
