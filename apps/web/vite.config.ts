import { defineConfig, type Plugin } from 'vite';
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
  plugins: [injectSwVersion()],

  resolve: {
    alias: {
      // Use the CSP-safe Alpine build at runtime (removes 'unsafe-eval' from CSP).
      // TypeScript still resolves types from 'alpinejs' (kept in devDependencies).
      alpinejs: '@alpinejs/csp',
      '@kinetic/core': resolve(__dirname, '../../packages/core/src/index.ts'),
      '@kinetic/adapters-web': resolve(__dirname, '../../packages/adapter-web/src/index.ts'),
    },
  },

  build: {
    target: 'es2022',
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    minify: 'esbuild',
    cssMinify: true,
    cssCodeSplit: true,
    reportCompressedSize: true,
    chunkSizeWarningLimit: 250, // KiB — warning si un chunk dépasse

    rollupOptions: {
      input: { main: resolve(__dirname, 'index.html') },
      output: {
        manualChunks(id) {
          // Vendors séparés pour caching long
          if (id.includes('node_modules')) {
            if (id.includes('alpinejs') || id.includes('@alpinejs')) return 'alpine';
            if (id.includes('@supabase/supabase-js')) return 'supabase';
            if (id.includes('idb-keyval')) return 'idb';
            if (id.includes('@capacitor')) return 'capacitor';
            return 'vendor';
          }
          // Domain layer (packages/core) — pure logic, peut être caché agressivement
          if (id.includes('packages/core/')) return 'kinetic-core';
          // Adapters (packages/adapter-web)
          if (id.includes('packages/adapter-web/')) return 'kinetic-adapters';
          // Stores Alpine — partagés entre toutes les pages
          if (id.includes('apps/web/src/stores/')) return 'stores';
          // Libs utilitaires
          if (id.includes('apps/web/src/lib/training/')) return 'lib-training';
          if (id.includes('apps/web/src/lib/user/')) return 'lib-user';
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
    include: ['@alpinejs/csp', 'idb-keyval'],
  },

  esbuild: {
    // console.error + console.warn kept in prod: vital for diagnosing APK bugs
    // without DevTools. The global handler in main.ts also persists them to
    // localStorage so errors surface even on device.
    // console.log/debug/info/trace: marked pure so esbuild drops them as
    // side-effect-free dead code (their return values are always unused).
    pure:
      process.env['NODE_ENV'] === 'production'
        ? ['console.log', 'console.debug', 'console.info', 'console.trace']
        : [],
    drop: process.env['NODE_ENV'] === 'production' ? ['debugger'] : [],
    legalComments: 'none',
  },
});
