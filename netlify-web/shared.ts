export interface ChatMessage {
	id: string;
	role: 'user' | 'assistant';
	content: string;
	createdAt: string;
}

export interface ConversationSummary {
	id: string;
	title: string;
	updatedAt: string;
}

export interface Conversation extends ConversationSummary {
	messages: ChatMessage[];
}

export const MODEL = 'gpt-4.1-mini';
export const MAX_PROMPT = 6000;
export const DAILY_LIMIT = 50;
