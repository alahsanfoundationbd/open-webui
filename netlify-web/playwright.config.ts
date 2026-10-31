import { defineConfig } from '@playwright/test';
export default defineConfig({
	testDir: './e2e',
	testMatch: '*.pw.ts',
	outputDir: '/tmp/alahsan-browser-results',
	fullyParallel: false,
	workers: 1,
	retries: 0,
	use: { baseURL: 'http://localhost:8889', headless: true, trace: 'off', video: 'off' }
});
