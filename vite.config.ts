import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const apiPort = Number(process.env.PORT ?? 5180);

export default defineConfig({
  root: "client",
  plugins: [react()],
  build: {
    outDir: "../build/client",
    emptyOutDir: true,
    sourcemap: false,
    chunkSizeWarningLimit: 900,
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: { "/api": `http://127.0.0.1:${apiPort}` },
  },
});
