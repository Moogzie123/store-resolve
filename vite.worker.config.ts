import { defineConfig } from 'vite'
export default defineConfig({
  build: {
    lib: { entry: 'worker/index.ts', formats: ['es'], fileName: () => 'worker.js' },
    outDir: 'work/worker',
    emptyOutDir: true,
    rollupOptions: { external: [] },
    minify: false,
  },
})
