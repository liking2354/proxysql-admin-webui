import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import { visualizer } from 'rollup-plugin-visualizer'

export default defineConfig({
  plugins: [
    react(),
    // Bundle visualization — generates stats.html on build.
    // Run `npm run build:analyze` to open the treemap after building.
    visualizer({
      filename: 'dist/stats.html',
      open: false,
      gzipSize: true,
      brotliSize: true,
      template: 'treemap', // interactive treemap view
    }),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:5174',
        changeOrigin: true,
      },
      '/ws': {
        target: 'ws://localhost:5174',
        ws: true,
      },
    },
  },
  build: {
    // Enable CSS code splitting so styles are loaded per-page, not all upfront.
    cssCodeSplit: true,
    // Generate sourcemaps for production debugging (lightweight hidden maps).
    sourcemap: 'hidden',
    rollupOptions: {
      output: {
        // Manual chunk splitting: group vendor libraries into separate chunks
        // for better caching. When app code changes, users still have cached
        // vendor chunks, reducing re-download size on updates.
        //
        // Route-level chunks are auto-named via the /* webpackChunkName: "page-*" */
        // comments in App.tsx lazy() imports, which Vite/Rollup respects.
        // This manualChunks config only handles vendor deps that don't have
        // explicit chunk names.
        manualChunks(id) {
          // Group node_modules by package
          if (id.includes('node_modules')) {
            // React core + router + react ecosystem deps
            // Group ALL react-related deps together to prevent circular
            // dependencies between vendor-react and vendor-misc chunks.
            // (e.g. scheduler depends on react, @remix-run/router depends on react)
            if (id.includes('/react/') || id.includes('/react-dom/')
                || id.includes('/react-router-dom/') || id.includes('/react-router/')
                || id.includes('/@remix-run/') || id.includes('/scheduler/')) {
              return 'vendor-react'
            }
            // TanStack Query
            if (id.includes('/@tanstack/react-query') || id.includes('/@tanstack/query-core')) {
              return 'vendor-query'
            }
            // Lucide icons
            if (id.includes('/lucide-react/')) {
              return 'vendor-icons'
            }
            // Axios
            if (id.includes('/axios/')) {
              return 'vendor-axios'
            }
            // Zustand
            if (id.includes('/zustand/')) {
              return 'vendor-state'
            }
            // Everything else lumped together (small libs)
            return 'vendor-misc'
          }
        },
      },
    },
    // Use esbuild for minification (built into Vite, no extra dep needed)
    minify: 'esbuild',
    esbuild: {
      drop: ['console', 'debugger'],
    },
  },
})
