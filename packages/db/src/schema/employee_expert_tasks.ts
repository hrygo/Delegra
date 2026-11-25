import {
  pgTable,
  uuid,
  text,
  integer,
  boolean,
  timestamp,
  jsonb,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";

export const employeeExpertTasks = pgTable(
  "employee_expert_tasks",
  {
    taskId: text("task_id").primaryKey(),
    orgId: text("org_id").notNull(),
    instanceId: text("instance_id").notNull(),
    issuer: text("issuer").notNull(),
    responsibleUserId: text("responsible_user_id").notNull(),
    visibility: text("visibility").notNull().default("private"),
    originClient: text("origin_client").notNull().default("dsh"),
    originSessionRef: text("origin_session_ref"),
    expertId: text("expert_id").notNull(),
    delegationScope: text("delegation_scope").notNull(),
    requestId: text("request_id").notNull(),
    payloadDigest: text("payload_digest").notNull(),
    taskText: text("task_text").notNull(),
    reuseRefs: jsonb("reuse_refs").$type<string[]>().notNull().default([]),
    status: text("status").notNull().default("accepted"),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }).notNull().defaultNow(),
    runId: text("run_id"),
    runGeneration: integer("run_generation").notNull().default(1),
    resultVersion: integer("result_version").notNull().default(0),
    cancelRequested: boolean("cancel_requested").notNull().default(false),
    result: jsonb("result"),
    sources: jsonb("sources").$type<string[]>().notNull().default([]),
    artifacts: jsonb("artifacts")
      .$type<Array<{ id: string; label?: string; url?: string }>>()
      .notNull()
      .default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    orgOwnerVisibilityIdx: index("employee_expert_tasks_org_owner_vis_idx").on(
      table.orgId,
      table.responsibleUserId,
      table.visibility,
    ),
    orgExpertStatusIdx: index("employee_expert_tasks_org_expert_status_idx").on(
      table.orgId,
      table.expertId,
      table.status,
    ),
    orgRequestIdx: index("employee_expert_tasks_org_request_idx").on(
      table.orgId,
      table.issuer,
      table.responsibleUserId,
      table.requestId,
    ),
  }),
);

export const employeeExpertIdempotencyReceipts = pgTable(
  "employee_expert_idempotency_receipts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id").notNull(),
    issuer: text("issuer").notNull(),
    subject: text("subject").notNull(),
    op: text("op").notNull(),
    requestId: text("request_id").notNull(),
    taskId: text("task_id")
      .notNull()
      .references(() => employeeExpertTasks.taskId, { onDelete: "cascade" }),
    payloadDigest: text("payload_digest").notNull(),
    status: text("status").notNull(),
    runGeneration: integer("run_generation").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    scopeReqUq: uniqueIndex("employee_expert_idemp_scope_req_uq").on(
      table.orgId,
      table.issuer,
      table.subject,
      table.op,
      table.requestId,
    ),
    taskIdx: index("employee_expert_idemp_task_idx").on(table.taskId),
  }),
);

export const employeeExpertDispatchIntents = pgTable(
  "employee_expert_dispatch_intents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    taskId: text("task_id")
      .notNull()
      .references(() => employeeExpertTasks.taskId, { onDelete: "cascade" }),
    orgId: text("org_id").notNull(),
    expertId: text("expert_id").notNull(),
    runGeneration: integer("run_generation").notNull().default(1),
    kind: text("kind").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    status: text("status").notNull().default("pending"),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    dispatchedAt: timestamp("dispatched_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    taskGenKindUq: uniqueIndex("employee_expert_dispatch_task_gen_kind_uq").on(
      table.taskId,
      table.runGeneration,
      table.kind,
    ),
    statusIdx: index("employee_expert_dispatch_status_idx").on(table.status, table.createdAt),
  }),
);

export const employeeExpertAuthContinuity = pgTable(
  "employee_expert_auth_continuity",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id").notNull(),
    issuer: text("issuer").notNull(),
    subject: text("subject").notNull(),
    expertId: text("expert_id").notNull(),
    continuityDigest: text("continuity_digest").notNull(),
    active: boolean("active").notNull().default(true),
    epoch: integer("epoch").notNull().default(1),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    principalExpertUq: uniqueIndex("employee_expert_auth_continuity_uq").on(
      table.orgId,
      table.issuer,
      table.subject,
      table.expertId,
    ),
  }),
);
