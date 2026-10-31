import type { Config } from '@netlify/functions';
import { getUser, verifyRequestOrigin } from '@netlify/identity';
import OpenAI from 'openai';
import { and, desc, eq, isNull, lt, or, sql } from 'drizzle-orm';
import { getDb } from '../../db/index.js';
import { conversations, dailyUsage } from '../../db/schema.js';
import { DAILY_LIMIT, MAX_PROMPT, MODEL } from '../../netlify-web/shared.js';
import type { ChatMessage } from '../../netlify-web/shared.js';
import { HttpError, readBody, text, uuid } from '../lib/validation.js';

export default async (req: Request) => {
	const json = (data: unknown, status = 200) =>
		Response.json(data, {
			status,
			headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }
		});
	try {
		if (!['GET', 'POST', 'PATCH', 'DELETE'].includes(req.method)) {
			return new Response('Method not allowed', {
				status: 405,
				headers: { Allow: 'GET, POST, PATCH, DELETE' }
			});
		}
		if (req.method !== 'GET') {
			try {
				verifyRequestOrigin(req);
			} catch {
				throw new HttpError(403, 'Please use this website to send requests.');
			}
		}
		const user = await getUser();
		if (!user) throw new HttpError(401, 'Please sign in to continue.');
		const url = new URL(req.url);
		const path = url.pathname
			.replace(/^\/api\/workspace\/?/, '')
			.split('/')
			.filter(Boolean);
		if (path[0] !== 'conversations') throw new HttpError(404, 'Not found.');
		const db = getDb();
		const id = path[1] ? uuid(path[1]) : null;
		if (path.length > 3 || (path.length === 3 && path[2] !== 'messages'))
			throw new HttpError(404, 'Not found.');
		if (!id) {
			if (req.method === 'GET') {
				const offset = Number(url.searchParams.get('offset') ?? 0);
				if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100000)
					throw new HttpError(400, 'Invalid page.');
				const rows = await db
					.select({
						id: conversations.id,
						title: conversations.title,
						updatedAt: conversations.updatedAt
					})
					.from(conversations)
					.where(eq(conversations.userId, user.id))
					.orderBy(desc(conversations.updatedAt), desc(conversations.id))
					.limit(51)
					.offset(offset);
				return json({ conversations: rows.slice(0, 50), hasMore: rows.length > 50 });
			}
			if (req.method === 'POST') {
				const body = await readBody(req);
				const title = text(body.title ?? 'নতুন কথোপকথন', 120);
				const [created] = await db
					.insert(conversations)
					.values({ id: crypto.randomUUID(), userId: user.id, title })
					.returning();
				return json(
					{
						conversation: {
							id: created.id,
							title: created.title,
							updatedAt: created.updatedAt,
							messages: created.messages
						}
					},
					201
				);
			}
			throw new HttpError(405, 'Method not allowed.');
		}
		const owned = and(eq(conversations.id, id), eq(conversations.userId, user.id));
		const [conversation] = await db.select().from(conversations).where(owned).limit(1);
		if (!conversation) throw new HttpError(404, 'Conversation not found.');
		const serialize = (row: typeof conversation) => ({
			id: row.id,
			title: row.title,
			updatedAt: row.updatedAt,
			messages: row.messages
		});
		if (path.length === 2) {
			if (req.method === 'GET') return json({ conversation: serialize(conversation) });
			if (req.method === 'DELETE') {
				const deleted = await db
					.delete(conversations)
					.where(
						and(owned, or(isNull(conversations.busyUntil), lt(conversations.busyUntil, new Date())))
					)
					.returning({ id: conversations.id });
				if (!deleted.length)
					throw new HttpError(409, 'Wait for the current reply before deleting.');
				return json({ deleted: true });
			}
			if (req.method === 'PATCH') {
				const body = await readBody(req);
				const [updated] = await db
					.update(conversations)
					.set({ title: text(body.title, 120), updatedAt: new Date() })
					.where(owned)
					.returning();
				return json({ conversation: serialize(updated) });
			}
			throw new HttpError(405, 'Method not allowed.');
		}
		if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed.');
		const body = await readBody(req);
		const requestId = uuid(body.requestId);
		const prompt = text(body.prompt, MAX_PROMPT);
		// A retry after a lost HTTP response returns the saved turn without another AI charge.
		if (
			conversation.messages.some((message) => message.id === requestId && message.role === 'user')
		) {
			return json({ conversation: serialize(conversation) });
		}
		if (conversation.messages.length >= 200)
			throw new HttpError(400, 'This conversation is full. Please start a new chat.');
		const now = new Date();
		const [locked] = await db
			.update(conversations)
			.set({ pendingRequestId: requestId, busyUntil: new Date(now.getTime() + 55000) })
			.where(and(owned, or(isNull(conversations.busyUntil), lt(conversations.busyUntil, now))))
			.returning();
		if (!locked)
			throw new HttpError(409, 'A reply is already being prepared. Please wait and try again.');
		let quotaReserved = false;
		const day = now.toISOString().slice(0, 10);
		try {
			// Recheck after taking the lock: concurrent retries may have completed since the initial read.
			if (locked.messages.some((message) => message.id === requestId && message.role === 'user')) {
				await db
					.update(conversations)
					.set({ pendingRequestId: null, busyUntil: null })
					.where(and(owned, eq(conversations.pendingRequestId, requestId)));
				return json({ conversation: serialize(locked) });
			}
			if (locked.messages.length >= 200)
				throw new HttpError(400, 'This conversation is full. Please start a new chat.');
			const [usage] = await db
				.insert(dailyUsage)
				.values({ userId: user.id, day, requests: 1 })
				.onConflictDoUpdate({
					target: [dailyUsage.userId, dailyUsage.day],
					set: { requests: sql`${dailyUsage.requests} + 1` },
					setWhere: lt(dailyUsage.requests, DAILY_LIMIT)
				})
				.returning();
			if (!usage)
				throw new HttpError(
					429,
					`Daily limit reached (${DAILY_LIMIT} requests). Please return tomorrow (UTC).`
				);
			quotaReserved = true;
			const ai = new OpenAI({ timeout: 35000, maxRetries: 0 });
			const completion = await ai.chat.completions.create(
				{
					model: MODEL,
					max_completion_tokens: 1500,
					messages: [
						{
							role: 'system',
							content:
								'You are a helpful assistant in Open WebUI for Al Ahsan. Respond in the language used by the user. Be accurate, clear, and candid about uncertainty. You cannot access live websites or execute code.'
						},
						...locked.messages.slice(-20).map(({ role, content }) => ({ role, content })),
						{ role: 'user', content: prompt }
					]
				},
				{ signal: req.signal }
			);
			const reply = completion.choices[0]?.message;
			const content = reply?.content?.trim() || reply?.refusal?.trim();
			if (!content)
				throw new HttpError(502, 'The assistant returned an empty reply. Please retry.');
			const messages: ChatMessage[] = [
				...locked.messages,
				{ id: requestId, role: 'user', content: prompt, createdAt: now.toISOString() },
				{ id: crypto.randomUUID(), role: 'assistant', content, createdAt: new Date().toISOString() }
			];
			const [saved] = await db
				.update(conversations)
				.set({ messages, updatedAt: new Date(), pendingRequestId: null, busyUntil: null })
				.where(and(owned, eq(conversations.pendingRequestId, requestId)))
				.returning();
			if (!saved) throw new HttpError(409, 'This conversation changed. Reopen it before retrying.');
			return json({ conversation: serialize(saved) });
		} catch (error) {
			await db
				.update(conversations)
				.set({ pendingRequestId: null, busyUntil: null })
				.where(and(owned, eq(conversations.pendingRequestId, requestId)));
			if (quotaReserved)
				await db
					.update(dailyUsage)
					.set({ requests: sql`greatest(0, ${dailyUsage.requests} - 1)` })
					.where(and(eq(dailyUsage.userId, user.id), eq(dailyUsage.day, day)));
			if (error instanceof HttpError) throw error;
			if (error instanceof OpenAI.APIError && error.status === 429)
				throw new HttpError(
					429,
					'The AI service is busy or its credit limit was reached. Please try later.'
				);
			throw new HttpError(
				502,
				'The AI service could not complete the reply. Your saved conversation is unchanged; please retry.'
			);
		}
	} catch (error) {
		if (error instanceof HttpError) return json({ error: error.message }, error.status);
		// Do not return SDK/database errors: they may contain connection details.
		return json(
			{ error: 'The service is temporarily unavailable. Please try again shortly.' },
			503
		);
	}
};

export const config: Config = { path: ['/api/workspace', '/api/workspace/*'] };
