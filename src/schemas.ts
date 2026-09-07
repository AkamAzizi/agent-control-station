import { z } from 'zod';
const text = z.string().trim().min(1);
export const policySchema = z.object({
  maxBytes: z
    .number()
    .int()
    .min(256)
    .max(1024 * 1024)
    .optional(),
  maxPackBytes: z
    .number()
    .int()
    .min(0)
    .max(64 * 1024)
    .optional(),
  dependencyDepth: z.number().int().min(0).max(3).optional(),
  maxToolCalls: z.number().int().min(1).max(200).optional(),
  timeoutMs: z.number().int().min(100).max(3_600_000).optional(),
});
export const requestSchema = z
  .object({
    repoId: text,
    base: text.max(250),
    head: text.max(250),
    task: text.max(16000),
    runtime: z.enum(['pi', 'scripted']),
    provider: text.optional(),
    model: text.optional(),
    policy: policySchema.optional(),
    scopePaths: z.array(text.max(500)).max(100).optional(),
    demo: z.boolean().optional(),
  })
  .refine(
    (v) => v.runtime !== 'pi' || (v.provider && v.model),
    'Select a provider and model for Pi.',
  );
export const findingSchema = z
  .object({
    id: text.max(100),
    title: text.max(250),
    body: text.max(10000),
    severity: z.enum(['critical', 'high', 'medium', 'low']),
    path: text.max(1000),
    side: z.enum(['base', 'head']),
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
    evidence: z
      .array(z.object({ contextItemId: text, quote: text.max(6000) }))
      .min(1)
      .max(12),
    disposition: z.enum(['pending', 'supported', 'rejected', 'uncertain']).default('pending'),
    verification: z.string().max(10000).optional(),
  })
  .refine((v) => v.endLine >= v.startLine, 'Invalid line range');
export const resultSchema = z.object({
  findings: z.array(findingSchema).max(50),
  incomplete: text.max(2000).optional(),
});
export const feedbackSchema = z.object({
  findingId: text,
  verdict: z.enum(['useful', 'incorrect', 'unclear']),
  note: z.string().trim().max(4000).default(''),
});
export const packSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,79}$/),
  version: z.number().int().positive(),
  name: text.max(160),
  active: z.boolean(),
  globs: z.array(text.max(500)).min(1).max(30),
  roles: z.array(z.enum(['reviewer', 'verifier'])).min(1),
  rules: z
    .array(
      z.object({
        id: text.max(100),
        text: text.max(6000),
        goodExample: z.string().max(6000).optional(),
        badExample: z.string().max(6000).optional(),
        source: z.string().max(2000).optional(),
      }),
    )
    .min(1)
    .max(50),
});
