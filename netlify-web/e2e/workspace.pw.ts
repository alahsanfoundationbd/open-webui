import { test, expect, type Page } from '@playwright/test';
import type { Conversation } from '../shared.js';

// These isolated browser tests intercept both services. They never register real users,
// contact AI providers, or write application records to the deployed database.
async function services(page: Page, options: { failFirst?: boolean; denyLogin?: boolean } = {}) {
	const chats: Conversation[] = [];
	const calls: { prompt: string; requestId: string }[] = [];
	const identity = {
		id: 'browser-test-user',
		email: 'reader@example.test',
		user_metadata: { full_name: 'পরীক্ষার পাঠক' },
		app_metadata: {},
		confirmed_at: new Date().toISOString(),
		aud: 'authenticated',
		role: 'authenticated'
	};
	await page.route('**/.netlify/identity/**', async (route) => {
		const url = new URL(route.request().url());
		if (url.pathname.endsWith('/settings'))
			return route.fulfill({
				json: { external: { email: true }, disable_signup: false, autoconfirm: false }
			});
		if (url.pathname.endsWith('/token')) {
			if (options.denyLogin) {
				options.denyLogin = false;
				return route.fulfill({
					status: 400,
					json: { error: 'invalid_grant', error_description: 'Invalid login credentials' }
				});
			}
			const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
			const synthetic = `${encode({ alg: 'none' })}.${encode({ sub: identity.id, exp: Math.floor(Date.now() / 1000) + 3600, user_metadata: identity.user_metadata })}.fixture`;
			return route.fulfill({
				json: {
					access_token: synthetic,
					refresh_token: crypto.randomUUID(),
					expires_in: 3600,
					token_type: 'bearer',
					user: identity
				}
			});
		}
		if (url.pathname.endsWith('/logout') || url.pathname.endsWith('/recover'))
			return route.fulfill({ status: 200, json: {} });
		if (url.pathname.endsWith('/signup'))
			return route.fulfill({ json: { ...identity, confirmed_at: undefined } });
		return route.fulfill({ json: identity });
	});
	await page.route('**/api/workspace/**', async (route) => {
		const request = route.request(),
			url = new URL(request.url());
		const parts = url.pathname.split('/').filter(Boolean),
			id = parts[3];
		if (!id && request.method() === 'GET')
			return route.fulfill({
				json: {
					conversations: chats.map(({ id, title, updatedAt }) => ({ id, title, updatedAt })),
					hasMore: false
				}
			});
		if (!id && request.method() === 'POST') {
			const chat: Conversation = {
				id: crypto.randomUUID(),
				title: request.postDataJSON().title,
				updatedAt: new Date().toISOString(),
				messages: []
			};
			chats.unshift(chat);
			return route.fulfill({ status: 201, json: { conversation: chat } });
		}
		const chat = chats.find((item) => item.id === id);
		if (!chat) return route.fulfill({ status: 404, json: { error: 'Conversation not found.' } });
		if (parts[4] === 'messages') {
			const body = request.postDataJSON();
			calls.push(body);
			if (options.failFirst) {
				options.failFirst = false;
				return route.fulfill({ status: 502, json: { error: 'Please retry this request.' } });
			}
			chat.messages.push(
				{
					id: body.requestId,
					role: 'user',
					content: body.prompt,
					createdAt: new Date().toISOString()
				},
				{
					id: crypto.randomUUID(),
					role: 'assistant',
					content:
						'**সহায়ক উত্তর**\n\n<script>window.unsafeRender = true</script>\n\nবাংলায় একটি পরিষ্কার উত্তর।',
					createdAt: new Date().toISOString()
				}
			);
			return route.fulfill({ json: { conversation: chat } });
		}
		if (request.method() === 'PATCH') chat.title = request.postDataJSON().title;
		if (request.method() === 'DELETE') {
			chats.splice(chats.indexOf(chat), 1);
			return route.fulfill({ json: { deleted: true } });
		}
		return route.fulfill({ json: { conversation: chat } });
	});
	return { chats, calls };
}
async function signIn(page: Page) {
	await page.locator('#account').click();
	await page.locator('#auth-email').fill('reader@example.test');
	await page.locator('#auth-password').fill(crypto.randomUUID());
	await page.locator('#auth-submit').click();
	await expect(page.locator('#auth-dialog')).not.toBeVisible();
}

test('signed-out page, account validation, chat CRUD, export, reload and safe markdown', async ({
	page
}) => {
	const errors: string[] = [];
	page.on('pageerror', (error) => errors.push(error.message));
	await services(page, { denyLogin: true });
	await page.goto('/');
	await expect(page.locator('#welcome-title')).toBeVisible();
	await page.locator('[data-prompt]').first().click();
	await expect(page.locator('#prompt')).not.toHaveValue('');
	await page.locator('#send').click();
	await expect(page.locator('#auth-dialog')).toBeVisible();
	await page.locator('#auth-email').fill('reader@example.test');
	await page.locator('#auth-password').fill(crypto.randomUUID());
	await page.locator('#auth-submit').click();
	await expect(page.locator('#auth-message')).toContainText('Invalid login credentials');
	await page.locator('#auth-submit').click();
	await expect(page.locator('#auth-dialog')).not.toBeVisible();
	await page.locator('#prompt').fill('বাংলায় শেখার একটি পরিকল্পনা দিন।');
	await page.locator('#send').click();
	await expect(page.locator('.message.assistant')).toContainText('সহায়ক উত্তর');
	expect(await page.evaluate(() => 'unsafeRender' in window)).toBe(false);
	await expect(page.locator('.message.assistant script')).toHaveCount(0);
	await page.locator('#rename').click();
	await page.locator('#rename-input').fill('আমার শেখার পরিকল্পনা');
	await page.locator('#manage-submit').click();
	await expect(page.locator('#chat-title')).toHaveText('আমার শেখার পরিকল্পনা');
	const downloadPromise = page.waitForEvent('download');
	await page.locator('#export').click();
	const download = await downloadPromise;
	expect(download.suggestedFilename()).toMatch(/^conversation-.*\.json$/);
	await page.reload();
	await expect(page.locator('.message.assistant')).toContainText('সহায়ক উত্তর');
	await page.locator('#delete').click();
	await page.locator('#manage-submit').click();
	await expect(page.locator('.history-item')).toHaveCount(0);
	await expect(page.locator('#welcome')).toBeVisible();
	await page.locator('#account').click();
	await page.locator('#manage-submit').click();
	await expect(page.locator('#account-label')).toHaveText('অ্যাকাউন্টে প্রবেশ করুন');
	expect(errors).toEqual([]);
});

test('failed AI request restores the draft and retry uses the same request ID', async ({
	page
}) => {
	const service = await services(page, { failFirst: true });
	await page.goto('/');
	await signIn(page);
	await page.locator('#prompt').fill('একটি প্রশ্ন');
	await page.locator('#send').click();
	await expect(page.locator('#error')).toContainText('Please retry');
	await expect(page.locator('#prompt')).toHaveValue('একটি প্রশ্ন');
	await page.locator('#send').click();
	await expect(page.locator('.message.assistant')).toBeVisible();
	expect(service.calls).toHaveLength(2);
	expect(service.calls[0].requestId).toBe(service.calls[1].requestId);
});

test('signup confirmation and password recovery report their next steps', async ({ page }) => {
	await services(page);
	await page.goto('/');
	await page.locator('#account').click();
	await page.locator('#auth-toggle').click();
	await page.locator('#auth-name').fill('পাঠক');
	await page.locator('#auth-email').fill('reader@example.test');
	await page.locator('#auth-password').fill(crypto.randomUUID());
	await page.locator('#auth-submit').click();
	await expect(page.locator('#auth-message')).toContainText('নিশ্চিতকরণের ইমেইল');
	await page.locator('#auth-toggle').click();
	await page.locator('#auth-forgot').click();
	await page.locator('#auth-submit').click();
	await expect(page.locator('#auth-message')).toContainText('পাসওয়ার্ড পরিবর্তনের লিংক');
});

test('mobile navigation, composer and account dialog fit the viewport', async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await services(page);
	await page.goto('/');
	await expect(page.locator('#menu')).toBeVisible();
	await page.locator('#menu').click();
	await expect(page.locator('#sidebar')).toHaveClass(/open/);
	await page.locator('#sidebar-shade').click({ position: { x: 350, y: 400 } });
	await expect(page.locator('#sidebar')).not.toHaveClass(/open/);
	const overflow = await page.evaluate(
		() => document.documentElement.scrollWidth > window.innerWidth
	);
	expect(overflow).toBe(false);
	await page.locator('#prompt').fill('মোবাইলে একটি প্রশ্ন');
	await page.locator('#send').click();
	await expect(page.locator('#auth-dialog')).toBeVisible();
});
