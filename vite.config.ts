import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "path";

export default defineConfig({
  plugins: [react()],
  base: "/OpenEVT/",
  server: {
    port: 5173,
    open: true,
  },
  build: {
    target: "es2020",
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        evt2d: resolve(__dirname, "evt2d.html"),
      },
    },
  },
});
