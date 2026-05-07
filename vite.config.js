import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

const devServerPort = Number(process.env.VITE_DEV_SERVER_PORT || 5173);

export default defineConfig({
  plugins: [react()],
  base: './',
  root: 'src/renderer',
  publicDir: '../../public',
  build: {
    outDir: '../../dist/renderer',
    emptyOutDir: true,
  },
  server: {
    port: devServerPort,
    strictPort: true,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src/renderer')
    }
  }
});
