import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // the agent bridge runs on 8788 (`pnpm serve:agent`)
      "/api/agent": "http://127.0.0.1:8788",
      // the MCP bridge runs on 8787 (`pnpm serve`)
      "/api": "http://127.0.0.1:8787",
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
