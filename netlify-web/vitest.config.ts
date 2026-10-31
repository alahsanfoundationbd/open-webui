import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: { include: ['netlify-web/tests/**/*.test.ts'], environment: 'node' }
});
