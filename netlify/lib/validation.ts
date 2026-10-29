export class HttpError extends Error {
	constructor(
		public status: number,
		message: string
	) {
		super(message);
	}
}

export function uuid(value: unknown): string {
	if (
		typeof value !== 'string' ||
		!/^[a-f\d]{8}-[a-f\d]{4}-[1-8][a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i.test(value)
	) {
		throw new HttpError(400, 'Invalid conversation or request ID.');
	}
	return value;
}

export function text(value: unknown, max: number): string {
	if (typeof value !== 'string' || !value.trim() || value.trim().length > max) {
		throw new HttpError(400, `Please enter between 1 and ${max} characters.`);
	}
	return value.trim();
}

export async function readBody(req: Request): Promise<Record<string, unknown>> {
	if (!req.headers.get('content-type')?.includes('application/json')) {
		throw new HttpError(415, 'Send JSON data.');
	}
	if (Number(req.headers.get('content-length')) > 16000) {
		throw new HttpError(413, 'Request is too large.');
	}
	const body = await req.text();
	if (body.length > 16000) throw new HttpError(413, 'Request is too large.');
	let value: unknown;
	try {
		value = JSON.parse(body);
	} catch {
		throw new HttpError(400, 'Invalid JSON.');
	}
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new HttpError(400, 'Send a JSON object.');
	}
	return value as Record<string, unknown>;
}
