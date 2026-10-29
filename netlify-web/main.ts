import './style.css';
import {
	acceptInvite,
	AuthError,
	getSettings,
	getUser,
	handleAuthCallback,
	login,
	logout,
	onAuthChange,
	requestPasswordRecovery,
	signup,
	updateUser
} from '@netlify/identity';
import type { User } from '@netlify/identity';
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import type { Conversation, ConversationSummary, ChatMessage } from './shared.js';

function el<T extends HTMLElement = HTMLElement>(id: string): T {
	const node = document.getElementById(id);
	if (!node) throw new Error(`Missing interface element: ${id}`);
	return node as T;
}
const prompt = el<HTMLTextAreaElement>('prompt');
const authDialog = el<HTMLDialogElement>('auth-dialog');
const manageDialog = el<HTMLDialogElement>('manage-dialog');
let user: User | null = null;
let current: Conversation | null = null;
let history: ConversationSummary[] = [];
let hasMore = false,
	loadingHistory = false,
	busy = false;
let pending: ChatMessage | null = null;
let retry: { conversationId: string; prompt: string; requestId: string } | null = null;
let authMode: 'login' | 'signup' | 'forgot' | 'reset' | 'invite' = 'login';
let inviteToken: string | undefined;
let signupAllowed = false;
let manageMode: 'rename' | 'delete' | 'logout' = 'rename';
let selectionVersion = 0;

function showError(message: string) {
	el('error-text').textContent = message;
	el('error').hidden = !message;
}
function notice(message: string) {
	el('notice').textContent = message;
	el('notice').hidden = !message;
}
function setMenu(open: boolean) {
	el('sidebar').classList.toggle('open', open);
	el('sidebar-shade').hidden = !open;
	el('menu').setAttribute('aria-expanded', String(open));
}
function route() {
	return location.pathname.match(/^\/c\/([a-f\d-]{36})\/?$/i)?.[1] ?? null;
}
function updatePath(id: string | null, replace = false) {
	const path = id ? `/c/${id}` : '/';
	if (location.pathname !== path)
		window.history[replace ? 'replaceState' : 'pushState']({}, '', path);
}
async function api<T>(path: string, method = 'GET', data?: unknown): Promise<T> {
	if (!(await getUser())) {
		await syncUser(null);
		openAuth();
		throw new Error('আপনার সেশন শেষ হয়েছে। আবার প্রবেশ করুন।');
	}
	let response: Response;
	try {
		response = await fetch(`/api/workspace/conversations${path}`, {
			method,
			credentials: 'same-origin',
			cache: 'no-store',
			headers: data === undefined ? {} : { 'Content-Type': 'application/json' },
			body: data === undefined ? undefined : JSON.stringify(data)
		});
	} catch {
		throw new Error('সংযোগ পাওয়া যায়নি। ইন্টারনেট সংযোগ দেখে আবার চেষ্টা করুন।');
	}
	if (!response.headers.get('content-type')?.includes('application/json'))
		throw new Error('সার্ভার সঠিক উত্তর দেয়নি। কিছুক্ষণ পর আবার চেষ্টা করুন।');
	const result = await response.json();
	if (!response.ok) {
		if (response.status === 401) openAuth();
		throw new Error(
			typeof result.error === 'string' ? result.error : 'কাজটি সম্পন্ন হয়নি। আবার চেষ্টা করুন।'
		);
	}
	return result as T;
}
function renderAccount() {
	el('account-label').textContent = user
		? user.name || user.email || 'আপনার অ্যাকাউন্ট'
		: 'অ্যাকাউন্টে প্রবেশ করুন';
	el('avatar').textContent = (user?.name || user?.email || 'A').slice(0, 1).toUpperCase();
}
function renderHistory() {
	const root = el('history');
	root.replaceChildren();
	const search = el<HTMLInputElement>('search').value.trim().toLocaleLowerCase();
	const filtered = history.filter((chat) => chat.title.toLocaleLowerCase().includes(search));
	el('history-count').textContent = String(history.length);
	if (!filtered.length) {
		const empty = document.createElement('p');
		empty.className = 'history-empty';
		empty.textContent = loadingHistory
			? 'কথোপকথন লোড হচ্ছে…'
			: search
				? 'মিলে যায় এমন কথোপকথন পাওয়া যায়নি।'
				: user
					? 'আপনার প্রথম প্রশ্নটি লিখুন। কথোপকথন এখানে সংরক্ষিত থাকবে।'
					: 'প্রবেশ করলে আপনার সংরক্ষিত কথোপকথন এখানে দেখাবে।';
		root.append(empty);
	}
	for (const chat of filtered) {
		const button = document.createElement('button');
		button.className = 'history-item';
		button.disabled = busy;
		button.title = chat.title;
		if (chat.id === current?.id) button.setAttribute('aria-current', 'page');
		button.innerHTML =
			'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><path d="M20 15a3 3 0 0 1-3 3H8l-5 3V6a3 3 0 0 1 3-3h11a3 3 0 0 1 3 3z"/></svg><span></span>';
		button.querySelector('span')!.textContent = chat.title;
		button.addEventListener('click', () => void selectChat(chat.id));
		root.append(button);
	}
	el('load-more').hidden = !hasMore || !!search;
	el<HTMLButtonElement>('load-more').disabled = loadingHistory || busy;
}
async function loadHistory(append = false) {
	if (!user || loadingHistory) return;
	loadingHistory = true;
	renderHistory();
	const ownerId = user.id;
	try {
		const result = await api<{ conversations: ConversationSummary[]; hasMore: boolean }>(
			`?offset=${append ? history.length : 0}`
		);
		if (user?.id !== ownerId) return;
		history = append
			? [
					...history,
					...result.conversations.filter((item) => !history.some((row) => row.id === item.id))
				]
			: result.conversations;
		hasMore = result.hasMore;
	} catch (error) {
		showError(error instanceof Error ? error.message : 'কথোপকথন লোড করা যায়নি।');
	} finally {
		loadingHistory = false;
		renderHistory();
	}
}
function renderMessages() {
	const root = el('messages');
	root.replaceChildren();
	const messages = [...(current?.messages ?? []), ...(pending ? [pending] : [])];
	el('welcome').hidden = messages.length > 0;
	root.hidden = !messages.length;
	for (const message of messages) {
		const article = document.createElement('article');
		article.className = `message ${message.role}${message === pending ? ' pending' : ''}`;
		const heading = document.createElement('div');
		heading.className = 'message-role';
		const name = document.createElement('span');
		name.textContent = message.role === 'user' ? 'আপনি' : 'Open WebUI';
		const time = document.createElement('time');
		time.dateTime = message.createdAt;
		time.textContent = new Date(message.createdAt).toLocaleTimeString('bn-BD', {
			hour: '2-digit',
			minute: '2-digit'
		});
		heading.append(name, time);
		if (message.role === 'assistant') {
			const copy = document.createElement('button');
			copy.className = 'quiet';
			copy.textContent = 'কপি করুন';
			copy.addEventListener('click', async () => {
				try {
					await navigator.clipboard.writeText(message.content);
					copy.textContent = 'কপি হয়েছে';
				} catch {
					showError('কপি করা যায়নি। লেখাটি নির্বাচন করে কপি করুন।');
				}
			});
			heading.append(copy);
		}
		const content = document.createElement('div');
		content.className = 'message-content';
		if (message.role === 'assistant') {
			content.innerHTML = DOMPurify.sanitize(
				marked.parse(message.content, { async: false, breaks: true }) as string
			);
			for (const link of content.querySelectorAll('a')) {
				link.target = '_blank';
				link.rel = 'noopener noreferrer';
			}
		} else content.textContent = message.content;
		article.append(heading, content);
		root.append(article);
	}
	el('thinking').hidden = !busy;
	el('chat-title').textContent = current?.title || 'নতুন কথোপকথন';
	for (const id of ['rename', 'export', 'delete']) {
		el(id).hidden = !current;
		el<HTMLButtonElement>(id).disabled = busy;
	}
	for (const id of ['send', 'new-chat', 'account']) el<HTMLButtonElement>(id).disabled = busy;
	prompt.disabled = busy;
	el('composer-hint').textContent = busy
		? 'উত্তর সংরক্ষণ হওয়া পর্যন্ত অপেক্ষা করুন…'
		: 'Enter চাপলে পাঠাবে · Shift + Enter নতুন লাইন';
	renderHistory();
	if (messages.length)
		requestAnimationFrame(() => {
			root.scrollTop = root.scrollHeight;
		});
}
async function selectChat(id: string, replace = false) {
	if (busy) return;
	if (!user) {
		openAuth();
		return;
	}
	const version = ++selectionVersion;
	showError('');
	notice('কথোপকথন লোড হচ্ছে…');
	setMenu(false);
	try {
		const result = await api<{ conversation: Conversation }>(`/${id}`);
		if (version !== selectionVersion) return;
		current = result.conversation;
		retry = null;
		prompt.value = '';
		updatePath(id, replace);
		renderMessages();
	} catch (error) {
		if (version === selectionVersion)
			showError(error instanceof Error ? error.message : 'কথোপকথন খোলা যায়নি।');
	} finally {
		if (version === selectionVersion) notice('');
	}
}
function newChat() {
	if (busy) return;
	selectionVersion++;
	current = null;
	pending = null;
	retry = null;
	prompt.value = '';
	showError('');
	notice('');
	updatePath(null);
	setMenu(false);
	renderMessages();
	prompt.focus();
}
async function send() {
	const content = prompt.value.trim();
	if (!content || busy) return;
	if (!user) {
		openAuth();
		return;
	}
	const ownerId = user.id;
	busy = true;
	showError('');
	notice('');
	selectionVersion++;
	pending = { id: 'pending', role: 'user', content, createdAt: new Date().toISOString() };
	prompt.value = '';
	renderMessages();
	try {
		if (!current) {
			const result = await api<{ conversation: Conversation }>('', 'POST', {
				title: content.slice(0, 80)
			});
			if (user?.id !== ownerId) return;
			current = result.conversation;
			updatePath(current.id);
		}
		if (!retry || retry.conversationId !== current.id || retry.prompt !== content)
			retry = { conversationId: current.id, prompt: content, requestId: crypto.randomUUID() };
		const result = await api<{ conversation: Conversation }>(
			`/${current.id}/messages`,
			'POST',
			retry
		);
		if (user?.id !== ownerId) return;
		current = result.conversation;
		retry = null;
		await loadHistory();
	} catch (error) {
		if (user?.id === ownerId) {
			prompt.value = content;
			showError(
				error instanceof Error ? error.message : 'উত্তর পাওয়া যায়নি। আবার পাঠানোর চেষ্টা করুন।'
			);
		}
	} finally {
		pending = null;
		busy = false;
		renderMessages();
		prompt.focus();
	}
}
function authMessage(message: string, error = false) {
	const node = el('auth-message');
	node.textContent = message;
	node.hidden = !message;
	node.dataset.error = String(error);
}
function openAuth(mode: typeof authMode = 'login') {
	authMode = mode;
	authMessage('');
	const resetting = mode === 'reset' || mode === 'invite';
	el('auth-title').textContent = {
		login: 'স্বাগতম।',
		signup: 'আপনার জায়গা তৈরি করুন।',
		forgot: 'অ্যাকাউন্ট ফিরে পান।',
		reset: 'নতুন পাসওয়ার্ড দিন।',
		invite: 'আমন্ত্রণ গ্রহণ করুন।'
	}[mode];
	el('auth-description').textContent = resetting
		? 'অন্তত ৮ অক্ষরের একটি নতুন পাসওয়ার্ড দিন।'
		: mode === 'forgot'
			? 'ইমেইলে পাসওয়ার্ড পরিবর্তনের লিংক পাঠানো হবে।'
			: 'কথোপকথন সংরক্ষণ করতে অ্যাকাউন্টে প্রবেশ করুন।';
	el('name-field').hidden = mode !== 'signup';
	el('email-field').hidden = resetting;
	el<HTMLInputElement>('auth-email').required = !resetting;
	el<HTMLInputElement>('auth-email').disabled = resetting;
	el('password-field').hidden = mode === 'forgot';
	const password = el<HTMLInputElement>('auth-password');
	password.value = '';
	password.required = mode !== 'forgot';
	password.disabled = mode === 'forgot';
	password.autocomplete = mode === 'login' ? 'current-password' : 'new-password';
	el('auth-submit').textContent = {
		login: 'প্রবেশ করুন',
		signup: 'অ্যাকাউন্ট তৈরি করুন',
		forgot: 'লিংক পাঠান',
		reset: 'পাসওয়ার্ড সংরক্ষণ করুন',
		invite: 'আমন্ত্রণ গ্রহণ করুন'
	}[mode];
	el('auth-toggle').textContent =
		mode === 'login' ? 'নতুন অ্যাকাউন্ট তৈরি করুন' : 'অ্যাকাউন্টে প্রবেশ করুন';
	el('auth-toggle').hidden = resetting || (mode === 'login' && !signupAllowed);
	el('auth-forgot').hidden = mode !== 'login';
	if (!authDialog.open) authDialog.showModal();
}
async function syncUser(next: User | null) {
	const changed = user?.id !== next?.id;
	user = next;
	renderAccount();
	if (!next || changed) {
		selectionVersion++;
		current = null;
		history = [];
		hasMore = false;
		retry = null;
		pending = null;
		renderMessages();
	}
	if (next) {
		await loadHistory();
		const id = route();
		if (id && !current) await selectChat(id, true);
	}
}
el<HTMLFormElement>('auth-form').addEventListener('submit', async (event) => {
	event.preventDefault();
	const submit = el<HTMLButtonElement>('auth-submit');
	submit.disabled = true;
	authMessage('অনুরোধটি সম্পন্ন হচ্ছে…');
	try {
		const email = el<HTMLInputElement>('auth-email').value.trim(),
			password = el<HTMLInputElement>('auth-password').value;
		if (authMode === 'forgot') {
			await requestPasswordRecovery(email);
			authMessage('ইমেইলটি নিবন্ধিত থাকলে পাসওয়ার্ড পরিবর্তনের লিংক পাবেন।');
			return;
		}
		if (authMode === 'signup') {
			await signup(email, password, { full_name: el<HTMLInputElement>('auth-name').value.trim() });
			const session = await getUser();
			if (!session) {
				el<HTMLInputElement>('auth-password').value = '';
				authMessage('নিশ্চিতকরণের ইমেইল পাঠানো হয়েছে। ইমেইলের লিংক খুলে অ্যাকাউন্ট সক্রিয় করুন।');
				return;
			}
			await syncUser(session);
		} else if (authMode === 'reset') {
			await updateUser({ password });
			await syncUser(await getUser());
		} else if (authMode === 'invite') {
			if (!inviteToken) throw new Error('Invalid invite');
			await syncUser(await acceptInvite(inviteToken, password));
			inviteToken = undefined;
		} else await syncUser(await login(email, password));
		el<HTMLInputElement>('auth-password').value = '';
		authDialog.close();
		notice('আপনি প্রবেশ করেছেন। এখন আপনার প্রশ্নটি পাঠাতে পারেন।');
	} catch (error) {
		authMessage(
			error instanceof AuthError
				? error.message
				: 'কাজটি সম্পন্ন হয়নি। ইন্টারনেট সংযোগ দেখে আবার চেষ্টা করুন।',
			true
		);
	} finally {
		submit.disabled = false;
	}
});
function openManage(mode: typeof manageMode) {
	if (busy || (mode !== 'logout' && !current)) return;
	manageMode = mode;
	el('manage-title').textContent =
		mode === 'rename'
			? 'কথোপকথনের নাম'
			: mode === 'delete'
				? 'কথোপকথন মুছে দেবেন?'
				: 'অ্যাকাউন্ট থেকে বের হবেন?';
	el('manage-description').textContent =
		mode === 'delete'
			? 'এই কথোপকথন স্থায়ীভাবে মুছে যাবে। এটি ফিরিয়ে আনা যাবে না।'
			: mode === 'logout'
				? 'আপনার সংরক্ষিত কথোপকথন অ্যাকাউন্টে থাকবে।'
				: 'সহজে খুঁজে পাওয়ার মতো একটি নাম দিন।';
	el('rename-field').hidden = mode !== 'rename';
	el<HTMLInputElement>('rename-input').value = current?.title ?? '';
	el<HTMLInputElement>('rename-input').required = mode === 'rename';
	el('manage-error').hidden = true;
	el('manage-submit').textContent =
		mode === 'delete' ? 'মুছে দিন' : mode === 'logout' ? 'বের হোন' : 'সংরক্ষণ করুন';
	manageDialog.showModal();
}
el<HTMLFormElement>('manage-form').addEventListener('submit', async (event) => {
	event.preventDefault();
	const button = el<HTMLButtonElement>('manage-submit');
	button.disabled = true;
	try {
		if (manageMode === 'logout') {
			await logout();
			await syncUser(null);
			newChat();
		} else if (current && manageMode === 'delete') {
			await api(`/${current.id}`, 'DELETE');
			newChat();
			await loadHistory();
		} else if (current) {
			const result = await api<{ conversation: Conversation }>(`/${current.id}`, 'PATCH', {
				title: el<HTMLInputElement>('rename-input').value
			});
			current = result.conversation;
			renderMessages();
			await loadHistory();
		}
		manageDialog.close();
	} catch (error) {
		el('manage-error').textContent = error instanceof Error ? error.message : 'কাজটি সম্পন্ন হয়নি।';
		el('manage-error').hidden = false;
	} finally {
		button.disabled = false;
	}
});
el('export').addEventListener('click', () => {
	if (!current) return;
	const url = URL.createObjectURL(
		new Blob([JSON.stringify({ title: current.title, messages: current.messages }, null, 2)], {
			type: 'application/json'
		})
	);
	const link = document.createElement('a');
	link.href = url;
	link.download = `conversation-${current.id}.json`;
	link.click();
	setTimeout(() => URL.revokeObjectURL(url), 1000);
});
el('composer').addEventListener('submit', (event) => {
	event.preventDefault();
	void send();
});
prompt.addEventListener('keydown', (event) => {
	if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
		event.preventDefault();
		void send();
	}
});
el('new-chat').addEventListener('click', newChat);
el('search').addEventListener('input', renderHistory);
el('load-more').addEventListener('click', () => void loadHistory(true));
el('rename').addEventListener('click', () => openManage('rename'));
el('delete').addEventListener('click', () => openManage('delete'));
el('account').addEventListener('click', () => (user ? openManage('logout') : openAuth()));
el('close-auth').addEventListener('click', () => authDialog.close());
authDialog.addEventListener('close', () => {
	el<HTMLInputElement>('auth-password').value = '';
});
el('cancel-manage').addEventListener('click', () => manageDialog.close());
el('auth-toggle').addEventListener('click', () =>
	openAuth(authMode === 'login' ? 'signup' : 'login')
);
el('auth-forgot').addEventListener('click', () => openAuth('forgot'));
el('dismiss-error').addEventListener('click', () => showError(''));
el('menu').addEventListener('click', () => setMenu(!el('sidebar').classList.contains('open')));
el('sidebar-shade').addEventListener('click', () => setMenu(false));
for (const button of document.querySelectorAll<HTMLButtonElement>('[data-prompt]'))
	button.addEventListener('click', () => {
		if (!busy) {
			prompt.value = button.dataset.prompt ?? '';
			prompt.focus();
		}
	});
document.addEventListener('keydown', (event) => {
	if (
		(event.metaKey || event.ctrlKey) &&
		event.key.toLowerCase() === 'k' &&
		!authDialog.open &&
		!manageDialog.open
	) {
		event.preventDefault();
		newChat();
	}
});
window.addEventListener('popstate', () => {
	if (busy) {
		updatePath(current?.id ?? null, true);
		return;
	}
	const id = route();
	if (id) void selectChat(id, true);
	else newChat();
});
window.addEventListener('beforeunload', (event) => {
	if (busy || prompt.value.trim()) event.preventDefault();
});
onAuthChange((event, next) => {
	if (event === 'logout') {
		void syncUser(null);
		prompt.value = '';
		updatePath(null, true);
	} else if (event === 'login' && next && user?.id !== next.id) {
		void syncUser(next);
	} else if (event === 'token_refresh' && next) {
		user = next;
		renderAccount();
	}
});
async function init() {
	renderAccount();
	renderMessages();
	try {
		const settings = await getSettings();
		signupAllowed = !settings.disableSignup;
		const callback = await handleAuthCallback();
		await syncUser(await getUser());
		if (callback?.type === 'recovery') openAuth('reset');
		else if (callback?.type === 'invite') {
			inviteToken = callback.token;
			openAuth('invite');
		} else if (callback) notice('আপনার অ্যাকাউন্টের পরিবর্তন সম্পন্ন হয়েছে।');
		else if (location.pathname === '/auth' || (!user && route())) openAuth();
	} catch {
		showError('অ্যাকাউন্ট সেবার সঙ্গে সংযোগ পাওয়া যায়নি। কিছুক্ষণ পরে পেজটি আবার খুলুন।');
	}
}
void init();
