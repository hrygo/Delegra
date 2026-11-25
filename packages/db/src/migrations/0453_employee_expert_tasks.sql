CREATE TABLE IF NOT EXISTS "employee_expert_tasks" (
	"task_id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"instance_id" text NOT NULL,
	"issuer" text NOT NULL,
	"responsible_user_id" text NOT NULL,
	"visibility" text DEFAULT 'private' NOT NULL,
	"origin_client" text DEFAULT 'dsh' NOT NULL,
	"origin_session_ref" text,
	"expert_id" text NOT NULL,
	"delegation_scope" text NOT NULL,
	"request_id" text NOT NULL,
	"payload_digest" text NOT NULL,
	"task_text" text NOT NULL,
	"reuse_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'accepted' NOT NULL,
	"accepted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"run_id" text,
	"run_generation" integer DEFAULT 1 NOT NULL,
	"result_version" integer DEFAULT 0 NOT NULL,
	"cancel_requested" boolean DEFAULT false NOT NULL,
	"result" jsonb,
	"sources" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"artifacts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "employee_expert_tasks_org_owner_vis_idx" ON "employee_expert_tasks" USING btree ("org_id","responsible_user_id","visibility");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "employee_expert_tasks_org_expert_status_idx" ON "employee_expert_tasks" USING btree ("org_id","expert_id","status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "employee_expert_tasks_org_request_idx" ON "employee_expert_tasks" USING btree ("org_id","issuer","responsible_user_id","request_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "employee_expert_idempotency_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"issuer" text NOT NULL,
	"subject" text NOT NULL,
	"op" text NOT NULL,
	"request_id" text NOT NULL,
	"task_id" text NOT NULL REFERENCES "employee_expert_tasks"("task_id") ON DELETE cascade,
	"payload_digest" text NOT NULL,
	"status" text NOT NULL,
	"run_generation" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "employee_expert_idemp_scope_req_uq" ON "employee_expert_idempotency_receipts" USING btree ("org_id","issuer","subject","op","request_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "employee_expert_idemp_task_idx" ON "employee_expert_idempotency_receipts" USING btree ("task_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "employee_expert_dispatch_intents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" text NOT NULL REFERENCES "employee_expert_tasks"("task_id") ON DELETE cascade,
	"org_id" text NOT NULL,
	"expert_id" text NOT NULL,
	"run_generation" integer DEFAULT 1 NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"claimed_at" timestamp with time zone,
	"dispatched_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "employee_expert_dispatch_task_gen_kind_uq" ON "employee_expert_dispatch_intents" USING btree ("task_id","run_generation","kind");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "employee_expert_dispatch_status_idx" ON "employee_expert_dispatch_intents" USING btree ("status","created_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "employee_expert_auth_continuity" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"issuer" text NOT NULL,
	"subject" text NOT NULL,
	"expert_id" text NOT NULL,
	"continuity_digest" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"epoch" integer DEFAULT 1 NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "employee_expert_auth_continuity_uq" ON "employee_expert_auth_continuity" USING btree ("org_id","issuer","subject","expert_id");
