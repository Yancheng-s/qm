import { defineConfig } from "vite";
import { rename } from "node:fs/promises";
import { join } from "node:path";

const devPort = Number(process.env.CHAT_WEB_PORT ?? process.env.PORT ?? 5175);

export default defineConfig({
  base: "/chat/",
  plugins: [
    {
      name: "chat-html-name",
      async closeBundle() {
        await rename(join("dist", "index.html"), join("dist", "chat.html"));
      },
    },
  ],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    assetsDir: "assets",
    minify: false,
    rollupOptions: {
      output: {
        entryFileNames: "assets/main.js",
        chunkFileNames: "assets/[name].js",
        assetFileNames: "assets/styles[extname]",
      },
    },
  },
  server: {
    host: "127.0.0.1",
    port: devPort,
    strictPort: true,
  },
  preview: {
    host: "127.0.0.1",
    port: devPort,
    strictPort: true,
  },
});
