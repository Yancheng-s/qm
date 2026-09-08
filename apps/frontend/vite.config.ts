import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5173,
    proxy: {
      "/api": { target: "http://localhost:8300", changeOrigin: true },
      "/healthz": { target: "http://localhost:8300", changeOrigin: true },
    },
  },
});
