import { defineConfig, type ProxyOptions } from "vite";
import { fileURLToPath } from "node:url";
import { rename } from "node:fs/promises";
import { join } from "node:path";

const PORTAL = process.env.PORTAL_URL ?? "http://localhost:8129";
const GATEWAY = (process.env.PARTNER_GATEWAY_URL ?? "http://localhost:8209").replace(/\/+$/, "");
const PORT = Number(process.env.CHAT_WEB_PORT ?? process.env.VITE_PORT ?? 5175);

const here = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url));

function gatewayPublicOrigin(gatewayUrl: string): string {
  const explicit = process.env.PARTNER_PUBLIC_URL?.trim();
  if (explicit) return new URL(explicit.replace(/\/+$/, "")).origin;
  const host = process.env.PARTNER_PUBLIC_HOST?.trim();
  if (host) {
    const parsed = new URL(gatewayUrl);
    const port = parsed.port || (parsed.protocol === "https:" ? "443" : "80");
    return `${parsed.protocol}//${host}:${port}`;
  }
  return new URL(gatewayUrl).origin;
}

const GATEWAY_ORIGIN = gatewayPublicOrigin(GATEWAY);

const proxyTo = (target: string): ProxyOptions => ({
  target,
  changeOrigin: true,
  configure(proxy) {
    proxy.on("proxyReq", (proxyReq) => {
      proxyReq.setHeader("origin", GATEWAY_ORIGIN);
    });
  },
});

export default defineConfig({
  base: process.env.PARTNER_WEB_BASE ?? "/chat/",
  resolve: {
    alias: [
      { find: /^katex$/, replacement: here("src/lazy-katex.ts") },
      { find: "katex-real", replacement: here("node_modules/katex/dist/katex.mjs") },
      { find: /^highlight\.js\/lib\/core$/, replacement: here("src/lazy-hljs.ts") },
      { find: "hljs-real-javascript", replacement: here("node_modules/highlight.js/lib/languages/javascript.js") },
      { find: "hljs-real-typescript", replacement: here("node_modules/highlight.js/lib/languages/typescript.js") },
      { find: "hljs-real-python", replacement: here("node_modules/highlight.js/lib/languages/python.js") },
      { find: "hljs-real-xml", replacement: here("node_modules/highlight.js/lib/languages/xml.js") },
      { find: "hljs-real-css", replacement: here("node_modules/highlight.js/lib/languages/css.js") },
      { find: "hljs-real-json", replacement: here("node_modules/highlight.js/lib/languages/json.js") },
      { find: "hljs-real-bash", replacement: here("node_modules/highlight.js/lib/languages/bash.js") },
      { find: "hljs-real-sql", replacement: here("node_modules/highlight.js/lib/languages/sql.js") },
      { find: "hljs-real-markdown", replacement: here("node_modules/highlight.js/lib/languages/markdown.js") },
      { find: "hljs-real", replacement: here("node_modules/highlight.js/lib/core.js") },
      { find: /^highlight\.js\/lib\/languages\/.*$/, replacement: here("src/hljs-lang-stub.ts") },
    ],
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      output: {
        entryFileNames: "assets/[name].js",
        chunkFileNames: "assets/[name].js",
        assetFileNames: "assets/[name][extname]",
      },
    },
  },
  plugins: [
    {
      name: "partner-chat-html-name",
      async closeBundle() {
        await rename(join("dist", "index.html"), join("dist", "chat.html"));
      },
    },
  ],
  server: {
    host: true,
    allowedHosts: true,
    port: PORT,
    strictPort: true,
    fs: { allow: [fileURLToPath(new URL("..", import.meta.url))] },
    proxy: {
      "/signin": proxyTo(PORTAL),
      "/signout": proxyTo(PORTAL),
      "/me": proxyTo(PORTAL),
      "/api": proxyTo(PORTAL),
      "/auth": proxyTo(GATEWAY),
    },
  },
  preview: {
    host: true,
    allowedHosts: true,
    port: PORT,
    strictPort: true,
  },
});
