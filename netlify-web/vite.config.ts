import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
	root: fileURLToPath(new URL('.', import.meta.url)),
	publicDir: 'public',
	css: { postcss: { plugins: [] } },
	server: { host: '127.0.0.1', port: 5173, strictPort: true },
	build: { outDir: '../build', emptyOutDir: true }
});
