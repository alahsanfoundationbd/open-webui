import {
	pgTable,
	text,
	timestamp,
	uuid,
	jsonb,
	integer,
	index,
	primaryKey
} from 'drizzle-orm/pg-core';
import type { ChatMessage } from '../netlify-web/shared.js';

export const conversations = pgTable(
	'netlify_conversations',
	{
		id: uuid('id').primaryKey(),
		userId: text('user_id').notNull(),
		title: text('title').notNull(),
		messages: jsonb('messages').$type<ChatMessage[]>().notNull().default([]),
		pendingRequestId: uuid('pending_request_id'),
		busyUntil: timestamp('busy_until', { withTimezone: true }),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
		updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
	},
	(table) => [index('netlify_conversations_user_updated').on(table.userId, table.updatedAt)]
);

export const dailyUsage = pgTable(
	'netlify_daily_usage',
	{
		userId: text('user_id').notNull(),
		day: text('day').notNull(),
		requests: integer('requests').notNull().default(0)
	},
	(table) => [primaryKey({ columns: [table.userId, table.day] })]
);
