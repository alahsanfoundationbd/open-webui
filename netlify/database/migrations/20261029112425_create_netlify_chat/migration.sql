CREATE TABLE "netlify_conversations" (
	"id" uuid PRIMARY KEY,
	"user_id" text NOT NULL,
	"title" text NOT NULL,
	"messages" jsonb DEFAULT '[]' NOT NULL,
	"pending_request_id" uuid,
	"busy_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "netlify_daily_usage" (
	"user_id" text,
	"day" text,
	"requests" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "netlify_daily_usage_pkey" PRIMARY KEY("user_id","day")
);
--> statement-breakpoint
CREATE INDEX "netlify_conversations_user_updated" ON "netlify_conversations" ("user_id","updated_at");