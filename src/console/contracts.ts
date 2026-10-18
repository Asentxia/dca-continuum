export const PUBLIC_GITHUB_PROVIDER = 'github-public-readonly';
export const PUBLIC_GITHUB_RESOURCE =
  'repo:Adaptive-Liquidity/Continuum@9ac4723b5390d22ed2d6aed9cf984cb0a32731ca';
import { z } from 'zod';
export const Identifier = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
export const Availability = z.enum([
  'available',
  'not_configured',
  'requires_setup',
  'temporarily_unavailable',
  'qualification_pending',
  'unsupported',
]);
export const FeatureSchema = z
  .object({
    state: Availability,
    reason: z.string(),
    scope: z.enum(['LOCAL_FIXTURE', 'STAGING', 'HISTORICAL', 'NONE']),
    next_action: z.string().optional(),
  })
  .strict();
export const OperationStateSchema = z.enum([
  'REQUESTED',
  'RESERVED',
  'SENDING',
  'COMMITTED',
  'UNKNOWN',
  'DENIED',
  'FAILED_KNOWN_NO_EFFECT',
]);
const OperationFieldsSchema = z
  .object({
    operation: Identifier,
    effectState: OperationStateSchema,
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    principal: Identifier,
    action: z.string().min(1),
    resource: z.string().min(1),
    parameters: z.unknown().refine((v) => v !== undefined),
    canonicalBinding: z.record(z.unknown()),
    grant: Identifier,
    grantVersion: z.number().int().positive(),
    principalEpoch: z.number().int().positive(),
    principalGeneration: z.number().int().positive(),
    computerId: Identifier.optional(),
    placementGeneration: z.number().int().positive().optional(),
    contextId: Identifier.optional(),
    contextVersion: z.number().int().positive().optional(),
    cognitionRevision: z.number().int().positive().optional(),
    toolId: Identifier.optional(),
    toolRevision: z.number().int().positive().optional(),
    contextQuarantined: z.boolean().optional(),
    contextNote: z.string().optional(),
    deadline: z.string(),
    verificationMethod: z.string(),
    approvalRevision: z.number().int().nonnegative(),
  })
  .passthrough();
export const ItemSchema = z
  .object({
    id: z.string(),
    kind: z.string(),
    title: z.string(),
    version: z.number().int().nonnegative(),
    status: z.string(),
    subtitle: z.string().optional(),
    fields: z.record(z.unknown()),
    eligibility: z
      .object({ allowed: z.boolean(), reason: z.string() })
      .optional(),
  })
  .strict()
  .superRefine((item, ctx) => {
    if (
      item.kind === 'operation' &&
      !OperationFieldsSchema.safeParse(item.fields).success
    )
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Unknown or incomplete operation contract',
      });
  });
export const EnvelopeSchema = z
  .object({
    schema_version: z.literal(1),
    server_time: z.string(),
    observed_at: z.string(),
    fresh_until: z.string(),
    projection_version: z.number().int().nonnegative(),
    source_revision: z.string(),
    completeness: z.enum(['complete', 'partial']),
    cursor: z.string().nullable(),
    total: z.number().int().nonnegative().nullable(),
    items: z.array(ItemSchema),
    features: z.record(FeatureSchema),
    scope: z.enum(['LOCAL_FIXTURE', 'STAGING', 'HISTORICAL']),
    session: z
      .object({
        identity: z.string(),
        tenant: z.string(),
        principal: z.string().nullable(),
        expires: z.number(),
        fresh_mfa: z.boolean(),
      })
      .optional(),
  })
  .strict();
export type ReadEnvelope = z.infer<typeof EnvelopeSchema>;
export type ConsoleItem = z.infer<typeof ItemSchema>;
export const CommandSchema = z
  .object({
    schema_version: z.literal(1),
    idempotency_key: Identifier,
    kind: z.enum([
      'create_vera',
      'update_vera_profile',
      'create_project',
      'link_task_project',
      'create_task',
      'approve',
      'create_grant',
      'revoke_grant',
      'assign',
      'ack_incident',
      'mark_notification_read',
      'export_evidence',
      'create_organization',
      'rename_organization',
      'define_role',
      'add_membership',
      'remove_membership',
      'record_mandate',
      'create_model_connection',
      'set_model_connection_limits',
      'test_model_connection',
      'select_model_connection_model',
      'assign_model_connection',
      'revoke_model_connection',
      'try_vera_text',
    ]),
    target: Identifier,
    expected_version: z.number().int().nonnegative(),
    input: z.record(z.unknown()),
  })
  .strict();
export type HumanCommand = z.infer<typeof CommandSchema>;
const VeraProfileFields = {
  name: z
    .string()
    .min(1)
    .max(200)
    .refine((value) => value.trim().length > 0, 'nonblank VERA name required'),
  description: z.string().max(8000),
};
export const CommandInputs = {
  create_vera: z.object(VeraProfileFields).strict(),
  update_vera_profile: z.object(VeraProfileFields).strict(),
  create_project: z
    .object({
      name: z.string().min(1).max(200),
      objective: z.string().max(8000),
    })
    .strict(),
  link_task_project: z.object({ project: Identifier }).strict(),
  create_task: z
    .object({
      principal: Identifier,
      objective: z.string().min(1).max(8000),
      deadline: z.string().datetime(),
      organization: Identifier,
      mandate: Identifier,
      mandateVersion: z.number().int().safe().gte(1),
    })
    .strict(),
  approve: z
    .object({
      digest: z.string().regex(/^[a-f0-9]{64}$/),
      expires: z.string().datetime(),
      approvalRevision: z.number().int().safe().nonnegative(),
    })
    .strict(),
  create_grant: z
    .object({
      principal: Identifier,
      action: z.enum(['write', 'readCommit']),
      resource: z.string().min(1).max(1024),
      expires: z.string().datetime(),
      maxCost: z.number().int().safe().nonnegative(),
      budget: z.number().int().safe().nonnegative(),
    })
    .strict(),
  revoke_grant: z.object({}).strict(),
  assign: z
    .object({ identity: Identifier, expires: z.string().datetime() })
    .strict(),
  ack_incident: z.object({}).strict(),
  mark_notification_read: z.object({}).strict(),
  export_evidence: z
    .object({
      sequences: z.array(z.number().int().positive()).min(1).max(60),
      snapshot: z.number().int().nonnegative(),
    })
    .strict(),
  create_organization: z.object({ name: z.string().min(1).max(200) }).strict(),
  rename_organization: z.object({ name: z.string().min(1).max(200) }).strict(),
  define_role: z
    .object({ organization: Identifier, name: z.string().min(1).max(80) })
    .strict(),
  add_membership: z
    .object({
      organization: Identifier,
      subjectKind: z.enum(['human', 'vera']),
      roleId: Identifier,
      ownerSeat: z.boolean(),
    })
    .strict(),
  remove_membership: z
    .object({
      organization: Identifier,
      subjectKind: z.enum(['human', 'vera']),
    })
    .strict(),
  record_mandate: z
    .object({
      organization: Identifier,
      title: z.string().min(1).max(200),
      body: z.string().min(1).max(8000),
    })
    .strict(),
  create_model_connection: z
    .object({ name: z.string().trim().min(1).max(200) })
    .strict(),
  set_model_connection_limits: z
    .object({
      maxRequests: z.number().int().min(1).max(20),
      maxInputChars: z.number().int().min(1).max(4000),
      maxOutputChars: z.number().int().min(1).max(4000),
      maxConcurrent: z.literal(1),
      timeoutMs: z.number().int().min(1000).max(10000),
    })
    .strict(),
  test_model_connection: z.object({}).strict(),
  select_model_connection_model: z
    .object({
      model: z.string().regex(/^models\/[A-Za-z0-9][A-Za-z0-9._:-]{0,120}$/),
    })
    .strict(),
  assign_model_connection: z.object({ principal: Identifier }).strict(),
  revoke_model_connection: z.object({}).strict(),
  try_vera_text: z
    .object({
      principal: Identifier,
      text: z.string().trim().min(1).max(4000),
    })
    .strict(),
};
export const SECTIONS = [
  'work',
  'projects',
  'governance',
  'agents',
  'computers',
  'approvals',
  'authority',
  'context',
  'evidence',
  'recovery',
  'integrations',
  'incidents',
  'notifications',
  'usage',
  'security',
  'settings',
  'setup',
] as const;

export const CommandReceiptSchema = z
  .object({
    schema_version: z.literal(1),
    command_id: z.string().uuid(),
    idempotency_key: Identifier,
    status: z.enum(['PENDING', 'APPLIED', 'DENIED']),
    result_ref: z.string().uuid(),
    result: z.unknown(),
    error_code: z.string().nullable(),
    reused: z.boolean(),
    external_effect: z.literal(false),
  })
  .strict();
export type CommandReceipt = z.infer<typeof CommandReceiptSchema>;
