import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { HttpError, readBody, text, uuid } from '../../netlify/lib/validation.js';

const mocks = vi.hoisted(() => ({
	getUser: vi.fn(),
	getDb: vi.fn(),
	complete: vi.fn(),
	selects: [] as unknown[][],
	updates: [] as unknown[][],
	inserts: [] as unknown[][],
	queries: [] as { kind: string; condition?: unknown; data?: unknown }[]
}));
vi.mock('@netlify/identity', () => ({
	getUser: mocks.getUser,
	verifyRequestOrigin: (req: Request) => {
		if (req.headers.get('origin') !== new URL(req.url).origin) throw new Error('Wrong origin');
	}
}));
vi.mock('../../db/index.js', () => ({ getDb: mocks.getDb }));
vi.mock('openai', () => {
	class APIError extends Error {
		status = 429;
	}
	class OpenAI {
		static APIError = APIError;
		chat = { completions: { create: mocks.complete } };
	}
	return { default: OpenAI };
});
import handler from '../../netlify/functions/workspace.mjs';

const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const requestId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const row = () => ({
	id,
	userId: 'owner-one',
	title: 'Example',
	messages: [],
	pendingRequestId: null,
	busyUntil: null,
	createdAt: new Date(),
	updatedAt: new Date()
});
function builder(kind: string, rows: unknown[]) {
	const query: { kind: string; condition?: unknown; data?: unknown } = { kind };
	mocks.queries.push(query);
	const result = {
		from: () => result,
		where: (condition: unknown) => {
			query.condition = condition;
			return result;
		},
		orderBy: () => result,
		limit: () => result,
		offset: () => result,
		values: (data: unknown) => {
			query.data = data;
			return result;
		},
		set: (data: unknown) => {
			query.data = data;
			return result;
		},
		onConflictDoUpdate: () => result,
		returning: () => result,
		then: (resolve: (value: unknown[]) => unknown) => Promise.resolve(rows).then(resolve)
	};
	return result;
}
function request(path = '', method = 'GET', body?: unknown, origin = 'https://workspace.test') {
	return new Request(`https://workspace.test/api/workspace/conversations${path}`, {
		method,
		headers: { Origin: origin, 'Content-Type': 'application/json' },
		body: body === undefined ? undefined : JSON.stringify(body)
	});
}
function conditionParams(query: { condition?: unknown }) {
	return new PgDialect().sqlToQuery(query.condition as Parameters<PgDialect['sqlToQuery']>[0])
		.params;
}
beforeEach(() => {
	vi.clearAllMocks();
	mocks.selects = [];
	mocks.updates = [];
	mocks.inserts = [];
	mocks.queries = [];
	mocks.getUser.mockResolvedValue({ id: 'owner-one' });
	mocks.getDb.mockReturnValue({
		select: () => builder('select', mocks.selects.shift() ?? []),
		insert: () => builder('insert', mocks.inserts.shift() ?? []),
		update: () => builder('update', mocks.updates.shift() ?? []),
		delete: () => builder('delete', [])
	});
	mocks.complete.mockResolvedValue({ choices: [{ message: { content: 'A helpful answer' } }] });
});

describe('request boundaries', () => {
	it('rejects unsigned requests before database access', async () => {
		mocks.getUser.mockResolvedValue(null);
		const response = await handler(request());
		expect(response.status).toBe(401);
		expect(mocks.getDb).not.toHaveBeenCalled();
	});
	it('rejects cross-origin mutations before authentication or storage', async () => {
		const response = await handler(
			request('', 'POST', { title: 'Hello' }, 'https://elsewhere.test')
		);
		expect(response.status).toBe(403);
		expect(mocks.getUser).not.toHaveBeenCalled();
	});
	it('rejects malformed IDs without a database query', async () => {
		expect((await handler(request('/not-an-id'))).status).toBe(400);
		expect(mocks.queries).toHaveLength(0);
	});
	it('returns 404 for a missing or foreign conversation and scopes the lookup to its owner', async () => {
		const response = await handler(request(`/${id}`));
		expect(response.status).toBe(404);
		expect(conditionParams(mocks.queries[0])).toEqual([id, 'owner-one']);
	});
	it('scopes list queries to the authenticated account', async () => {
		mocks.selects.push([row()]);
		const response = await handler(request());
		expect(response.status).toBe(200);
		expect(conditionParams(mocks.queries[0])).toEqual(['owner-one']);
	});
	it('rejects unsupported methods', async () => {
		expect((await handler(request('', 'PUT'))).status).toBe(405);
	});
	it('rejects malformed JSON, arrays, and oversized text', async () => {
		for (const body of ['{', '[]', JSON.stringify({ prompt: 'x'.repeat(17000) })]) {
			await expect(
				readBody(
					new Request('https://workspace.test', {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body
					})
				)
			).rejects.toBeInstanceOf(HttpError);
		}
		expect(() => text(' ', 10)).toThrow();
		expect(() => uuid('invalid')).toThrow();
	});
});

describe('AI turn lifecycle', () => {
	it('does not charge or call AI for a retried saved request', async () => {
		mocks.selects.push([
			{ ...row(), messages: [{ id: requestId, role: 'user', content: 'Hello' }] }
		]);
		expect(
			(await handler(request(`/${id}/messages`, 'POST', { prompt: 'Hello', requestId }))).status
		).toBe(200);
		expect(mocks.complete).not.toHaveBeenCalled();
		expect(mocks.queries).toHaveLength(1);
	});
	it('rejects simultaneous turns before quota reservation', async () => {
		mocks.selects.push([row()]);
		mocks.updates.push([]);
		expect(
			(await handler(request(`/${id}/messages`, 'POST', { prompt: 'Hello', requestId }))).status
		).toBe(409);
		expect(mocks.complete).not.toHaveBeenCalled();
		expect(mocks.queries.some((q) => q.kind === 'insert')).toBe(false);
	});
	it('enforces daily quota before AI and releases its conversation lock', async () => {
		mocks.selects.push([row()]);
		mocks.updates.push([row()], []);
		mocks.inserts.push([]);
		expect(
			(await handler(request(`/${id}/messages`, 'POST', { prompt: 'Hello', requestId }))).status
		).toBe(429);
		expect(mocks.complete).not.toHaveBeenCalled();
		expect(mocks.queries.at(-1)?.data).toEqual({ pendingRequestId: null, busyUntil: null });
	});
	it('saves both messages in one guarded update and uses stored context', async () => {
		const old = {
			id: 'older',
			role: 'user',
			content: 'Earlier context',
			createdAt: new Date().toISOString()
		};
		const existing = { ...row(), messages: [old] };
		mocks.selects.push([existing]);
		mocks.updates.push([existing], [existing]);
		mocks.inserts.push([{ requests: 1 }]);
		const response = await handler(
			request(`/${id}/messages`, 'POST', { prompt: 'Hello', requestId })
		);
		expect(response.status).toBe(200);
		const saved = mocks.queries.at(-1)!;
		expect(conditionParams(saved)).toEqual([id, 'owner-one', requestId]);
		expect((saved.data as { messages: unknown[] }).messages).toHaveLength(3);
		expect(mocks.complete.mock.calls[0][0].messages[1].content).toBe('Earlier context');
	});
	it('preserves saved history and releases quota/lock if AI fails without exposing provider details', async () => {
		mocks.selects.push([row()]);
		mocks.updates.push([row()], [], []);
		mocks.inserts.push([{ requests: 1 }]);
		mocks.complete.mockRejectedValue(new Error('private provider internals'));
		const response = await handler(
			request(`/${id}/messages`, 'POST', { prompt: 'Hello', requestId })
		);
		expect(response.status).toBe(502);
		expect(await response.text()).not.toContain('private');
		expect(
			mocks.queries.filter((q) => q.kind === 'update').some((q) => 'messages' in (q.data as object))
		).toBe(false);
		expect(mocks.queries.at(-1)?.kind).toBe('update');
	});
	it('cannot delete a conversation whose lock was acquired after reading it', async () => {
		mocks.selects.push([row()]);
		const response = await handler(request(`/${id}`, 'DELETE'));
		expect(response.status).toBe(409);
		expect(conditionParams(mocks.queries.at(-1)!)).toContain('owner-one');
	});
});
