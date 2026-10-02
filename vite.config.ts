import { defineConfig } from 'vite';

// GitHub Pages 會把網站放在 /<repo 名稱>/ 底下
export default defineConfig({
  base: '/badmiton-project/',
  server: { host: true },
  build: { chunkSizeWarningLimit: 800 }, // three.js 本身就約 500 KB
});
