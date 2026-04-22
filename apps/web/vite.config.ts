import { defineConfig, splitVendorChunkPlugin } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  plugins: [splitVendorChunkPlugin()],

  resolve: {
    alias: {
      '@kinetic/core':         resolve(__dirname, '../../packages/core/src/index.ts'),
      '@kinetic/adapters-web': resolve(__dirname, '../../packages/adapter-web/src/index.ts'),
    },
  },

  build: {
    target:      'es2022',
    outDir:      'dist',
    emptyOutDir: true,
    sourcemap:   false,
    minify:      'esbuild',
    cssMinify:   true,

    rollupOptions: {
      input: { main: resolve(__dirname, 'index.html') },
      output: {
        manualChunks(id) {
          if (id.includes('alpinejs')) return 'alpine';
          if (id.includes('@supabase/supabase-js')) return 'supabase';
          if (id.includes('idb-keyval')) return 'idb';
        },
        assetFileNames: 'static/assets/[name]-[hash][extname]',
        chunkFileNames: 'static/chunks/[name]-[hash].js',
        entryFileNames: 'static/[name]-[hash].js',
      },
    },
  },

  server: {
    port: 3000,
  },

  preview: {
    port: 4173,
    headers: { 'Cache-Control': 'no-store' },
  },

  optimizeDeps: {
    include: ['alpinejs', 'idb-keyval'],
  },

  esbuild: {
    drop: process.env['NODE_ENV'] === 'production' ? ['console', 'debugger'] : [],
    legalComments: 'none',
  },
});
