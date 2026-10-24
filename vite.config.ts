import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// In development the page runs on :3140 and the API on :8788 (npm run server).
export default defineConfig({ plugins: [react()], server: { port: 3140, proxy: { "/api": "http://localhost:8788" } } });
