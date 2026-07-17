import { z } from "zod";

const recordSchema = z.record(z.string(), z.unknown());
const nonEmptyString = z.string().trim().min(1);

export const trajectoryEventBodySchema = z.looseObject({
  event_type: nonEmptyString,
  actor: nonEmptyString.default("pi-agent"),
  payload: recordSchema.default({}),
  refs: recordSchema.default({}),
});

export const trajectoryProposalBodySchema = z.looseObject({
  next_action: nonEmptyString,
  rationale: nonEmptyString,
  blockers: z.array(recordSchema).default([]),
  evidence_refs: z.array(z.string()).default([]),
});

export const childActivityBodySchema = z.looseObject({
  type: nonEmptyString,
  summary: nonEmptyString,
  model_tier: nonEmptyString,
  model_reason: nonEmptyString,
  prompt_runtime_ref: z.string().nullable().default(null),
  context_pack_refs: z.array(z.string()).default([]),
  evidence_refs: z.array(z.string()).default([]),
  metadata: recordSchema.default({}),
});

export const closeActivityBodySchema = z.looseObject({
  activity_id: nonEmptyString,
  success: z.boolean(),
  summary: nonEmptyString,
  error_message: z.string().nullable().default(null),
});

export class CoordinationBodyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CoordinationBodyError";
  }
}

export function parseCoordinationBody<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new CoordinationBodyError(z.prettifyError(result.error));
  return result.data;
}
