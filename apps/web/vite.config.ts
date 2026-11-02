import path from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { readFileSync } from 'node:fs'

const pkg = JSON.parse(readFileSync(path.resolve(__dirname, 'package.json'), 'utf8'))

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: { __SPA_VERSION__: JSON.stringify(pkg.version), __SPA_BUILT_AT__: JSON.stringify(new Date().toISOString()) },
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: path.resolve(__dirname, 'app.html'),
    },
  },
  server: {
    proxy: {
      '/api': {
        target: process.env.VITE_API_PROXY || 'https://mastra-l1.summersmile1984.workers.dev',
        changeOrigin: true,
      },
    },
  },
})
