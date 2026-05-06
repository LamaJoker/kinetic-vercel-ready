import { defineConfig, splitVendorChunkPlugin, type Plugin } from 'vite';
import { resolve } from 'path';
import { readFileSync, writeFileSync } from 'fs';

/**
 * Injects a build-time cache-busting version into dist/sw.js.
 * public/sw.js is copied verbatim by Vite (not run through Rollup) so we
 * post-process the output file in closeBundle instead.
 * Replaces __SW_BUILD__ with a unique timestamp on every production build.
 */
function injectSwVersion(): Plugin {
  const version = `kinetic-v${Date.now()}`;
  return {
    name: 'inject-sw-version',
    closeBundle() {
      const swOut = resolve(__dirname, 'dist/sw.js');
      try {
        const src = readFileSync(swOut, 'utf8');
        writeFileSync(swOut, src.replace(/__SW_BUILD__/g, version), 'utf8');
      } catch {
        // Not a production build (e.g. vite dev) — silently skip.
      }
    },
  };
}

export default defineConfig({
  plugins: [splitVendorChunkPlugin(), injectSwVersion()],

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
    // Garder console.error et console.warn en prod : ces logs sont
    // vitaux pour diagnostiquer les bugs APK qui n'ont pas de DevTools.
    // Le global handler de main.ts persiste aussi les erreurs en localStorage.
    pure: process.env['NODE_ENV'] === 'production'
      ? ['console.log', 'console.debug', 'console.info', 'console.trace']
      : [],
    drop: process.env['NODE_ENV'] === 'production' ? ['debugger'] : [],
    legalComments: 'none',
  },
});
