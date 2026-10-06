import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import path from "node:path";

export default defineConfig({
  // 4874 = "HUSH" on a phone keypad — unlikely to collide with anything else.
  server: {
    port: 4874,
    strictPort: true,
  },
  preview: {
    port: 4874,
    strictPort: true,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",

      devOptions: {
        enabled: true
      },
      workbox: {
        // Cap precache size so the multi-MB WebLLM chunk is skipped — it
        // loads on demand when AI is enabled and caches itself separately.
        maximumFileSizeToCacheInBytes: 3 * 1024 * 1024,
      },

      manifest: {
        name: "Secure Notes",
        short_name: "Notes",
        description: "Encrypted offline notes app",
        theme_color: "#121212",
        background_color: "#121212",
        display: "standalone",
        start_url: "/",
        icons: [
          {
            src: "/hushwrite-192.png",
            sizes: "192x192",
            type: "image/png",
            purpose: "any",
          },
          {
            src: "/hushwrite-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "any",
          },
          {
            src: "/hushwrite-maskable-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
      },
    }),
  ],
});