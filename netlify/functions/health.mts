import type { Config } from '@netlify/functions';
import { getDb } from '../../db/index.js';
import { conversations } from '../../db/schema.js';

export default async () => {
	try {
		await getDb().select({ id: conversations.id }).from(conversations).limit(1);
		return Response.json({ ready: true }, { headers: { 'Cache-Control': 'no-store' } });
	} catch {
		return Response.json(
			{
				ready: false,
				error: 'Chat storage is not ready yet. Please try again after deployment completes.'
			},
			{ status: 503, headers: { 'Cache-Control': 'no-store' } }
		);
	}
};

export const config: Config = { path: '/api/health', method: 'GET' };
