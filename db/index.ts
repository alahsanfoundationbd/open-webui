import { drizzle } from 'drizzle-orm/netlify-db';
import * as schema from './schema.js';

// Create the client inside the invocation so platform connection context is available.
export function getDb() {
	return drizzle({ schema });
}
