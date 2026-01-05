// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
declare global {
	interface Window {
		__grrArenaDone?: boolean;
		__grrArenaReport?: unknown;
		__grrArenaSuggestedFilename?: string;
		__grrArenaGetCheckpoint?: () => unknown;
		__grrArenaRestore?: unknown;
	}

	namespace App {
		// interface Error {}
		// interface Locals {}
		// interface PageData {}
		// interface PageState {}
		// interface Platform {}
	}
}

export {};
