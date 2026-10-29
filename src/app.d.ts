// See https://kit.svelte.dev/docs/types#app
// for information about these interfaces
declare global {
	class AudioWorkletProcessor {
		readonly port: MessagePort;
	}
	function registerProcessor(name: string, processor: typeof AudioWorkletProcessor): void;

	const APP_VERSION: string;
	const APP_BUILD_HASH: string;
	const APP_BUILD_CHANNEL: 'main' | 'dev' | 'unknown';

	namespace App {
		// interface Error {}
		// interface Locals {}
		// interface PageData {}
		// interface Platform {}
	}
}

// The root layout provides this writable store to translated components.
// Preserve its type when consumers retrieve the shared context by its key.
declare module 'svelte' {
	export function getContext(key: 'i18n'): typeof import('$lib/i18n').default;
}

export {};
