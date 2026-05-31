import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";

export default defineConfig({
  server: {
    host: "::",
    port: 8080,
    allowedHosts: true,
    hmr: { overlay: false },
    proxy: {
      "/api": "http://localhost:5050",
      "/mcp": "http://localhost:5050",
    },
  },
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
