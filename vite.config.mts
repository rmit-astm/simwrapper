/// <reference types="vitest" />

import { defineConfig, loadEnv } from 'vite'
import vue from '@vitejs/plugin-vue2'
import markdownPlugin from 'unplugin-vue-markdown/vite'
import history from 'connect-history-api-fallback'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// maplibre-gl 6 loads its worker from a file next to its built chunk
// (assets/maplibre-gl-worker.mjs). Vite bundles maplibre-gl but does not emit
// that worker, so the browser falls back to index.html and the worker fails
// with a non-JavaScript MIME type. Emit the worker alongside the bundle.
function maplibreWorker() {
  return {
    name: 'maplibre-worker',
    generateBundle(this: any) {
      this.emitFile({
        type: 'asset',
        fileName: 'assets/maplibre-gl-worker.mjs',
        source: readFileSync(
          resolve('node_modules/maplibre-gl/dist/maplibre-gl-worker.mjs'),
          'utf8'
        ),
      })
    },
  }
}

// FROM vite-plugin-rewrite-all (deprecated): allow paths that end in .extensions
function redirectAll() {
  return {
    name: 'rewrite-all',
    configureServer(server) {
      return () => {
        const handler = history({
          disableDotRule: true,
          rewrites: [{ from: /\/$/, to: () => '/index.html' }],
        })
        server.middlewares.use((req, res, next) => {
          handler(req, res, next)
        })
      }
    },
  }
}

export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, process.cwd(), '')

  return {
    base: '/simwrapper/',
    build: { sourcemap: false, target: 'esnext' },
    esbuild: { target: 'esnext' },
    optimizeDeps: {
      include: [
        'nanoid',
        'nerdamer',
        'numcodecs',
        'sax-wasm',
        'shapefile',
        'shapefile/dbf/boolean',
        'shapefile/dbf/cancel',
        'shapefile/dbf/date',
        'shapefile/dbf/number',
        'shapefile/dbf/read',
        'shapefile/dbf/string',
      ],
    },
    plugins: [
      // vue
      vue({ include: [/\.vue$/, /\.md$/] }),
      // markdown:
      markdownPlugin({}),
      // redirectAll allows pages ending in http://path/blah.yaml to load:
      redirectAll(),
      // emit the maplibre worker next to the bundled maplibre chunk:
      maplibreWorker(),
    ],
    assetsInclude: ['**/*.so'],
    test: {
      globals: true,
      environment: 'jsdom',
    },
    resolve: {
      alias: {
        '@': '/src',
        '~': '/node_modules',
        path: 'path-browserify',
      },
    },
    define:
      mode === 'test'
        ? {
            'process.env': [],
          }
        : {
            'process.platform': null,
            'process.env': [],
          },
  }
})