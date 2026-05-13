import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    // Proxy /api to the server during local dev
    proxy: {
      "/api": "http://localhost:8080",
    },
  },
});
