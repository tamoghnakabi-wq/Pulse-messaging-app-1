import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    allowedHosts: true,
    proxy: {
      '/api': {
        target: process.env.VITE_PROXY_TARGET || 'http://localhost:5050',
        changeOrigin: true,
      },
      '/uploads': {
        target: process.env.VITE_PROXY_TARGET || 'http://localhost:5050',
        changeOrigin: true,
      },
      '/socket.io': {
        target: process.env.VITE_PROXY_TARGET || 'http://localhost:5050',
        changeOrigin: true,
        ws: true,
        // Long-lived call media over Cloudflare — don't time out the WS proxy
        timeout: 0,
        proxyTimeout: 0,
      },
    },
  },
  preview: {
    host: '0.0.0.0',
    port: 5173,
  },
  build: {
    target: 'es2022',
    cssCodeSplit: true,
    minify: 'esbuild',
    // Keep main chat shell lean; heavy libs load on demand
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return;
          if (id.includes('react-dom') || id.includes('/react/') || id.includes('scheduler')) {
            return 'react-vendor';
          }
          if (id.includes('socket.io')) return 'socket';
          if (
            id.includes('react-markdown') ||
            id.includes('remark') ||
            id.includes('unified') ||
            id.includes('mdast') ||
            id.includes('micromark') ||
            id.includes('hast')
          ) {
            return 'markdown';
          }
          if (id.includes('emoji-picker')) return 'emoji';
          if (id.includes('framer-motion')) return 'motion';
          if (id.includes('lucide-react')) return 'icons';
          if (id.includes('axios') || id.includes('date-fns') || id.includes('zustand')) {
            return 'app-utils';
          }
        },
      },
    },
    chunkSizeWarningLimit: 700,
  },
  optimizeDeps: {
    include: [
      'react',
      'react-dom',
      'react-router-dom',
      'zustand',
      'socket.io-client',
      'axios',
    ],
  },
});
