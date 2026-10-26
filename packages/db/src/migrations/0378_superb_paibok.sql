CREATE TABLE "model_reference_rates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"input_usd_per_million" numeric(18, 9),
	"cached_input_usd_per_million" numeric(18, 9),
	"output_usd_per_million" numeric(18, 9),
	"cache_write_usd_per_million" numeric(18, 9),
	"source_url" text,
	"verified_at" text NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"updated_by_user_id" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "model_reference_rates_nonnegative" CHECK ("model_reference_rates"."revision" >= 0 and ("model_reference_rates"."input_usd_per_million" is null or "model_reference_rates"."input_usd_per_million" >= 0) and ("model_reference_rates"."cached_input_usd_per_million" is null or "model_reference_rates"."cached_input_usd_per_million" >= 0) and ("model_reference_rates"."output_usd_per_million" is null or "model_reference_rates"."output_usd_per_million" >= 0) and ("model_reference_rates"."cache_write_usd_per_million" is null or "model_reference_rates"."cache_write_usd_per_million" >= 0))
);
--> statement-breakpoint
ALTER TABLE "model_reference_rates" ADD CONSTRAINT "model_reference_rates_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "model_reference_rates_company_model_idx" ON "model_reference_rates" USING btree ("company_id","provider","model");