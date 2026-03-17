import { defineConfig } from 'vite'
import path from 'node:path'

export default defineConfig({
  esbuild: {
    jsx: 'automatic',
    jsxImportSource: 'preact',
  },
  root: __dirname,
  server: {
    proxy: {
      '/health': 'http://localhost:3000',
      '/runs': 'http://localhost:3000',
      '/graph': 'http://localhost:3000',
      '/emit': 'http://localhost:3000',
      '/api': 'http://localhost:3000',
    },
  },
  build: {
    lib: {
      entry: {
        ui: './index.ts',
        app: './app.tsx',
      },
      formats: ['es'],
      fileName: (_, entryName) => `${entryName}.js`,
    },
    rollupOptions: {
      external: ['preact', 'preact/hooks', 'preact/jsx-runtime'],
      output: {
        assetFileNames: 'style.css',
        chunkFileNames: 'shared.js',
      },
    },
    outDir: path.resolve(__dirname, '../../dist/ui'),
    emptyOutDir: true,
    cssCodeSplit: false,
  },
})
