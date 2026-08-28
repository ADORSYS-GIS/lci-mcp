import { z } from "zod";

export const AuthHelperSchema = z.object({
  command: z.string(),
  args: z.array(z.string()).default([]),
  timeoutMs: z.number().int().positive().default(10_000),
  cacheTtlSeconds: z.number().int().positive().default(300),
});
export type AuthHelperConfig = z.infer<typeof AuthHelperSchema>;

export const EmbeddingAuthSchema = z.object({
  apiKey: z.string().optional(),
  helper: AuthHelperSchema.optional(),
});

export const EmbeddingConfigSchema = z.object({
  baseUrl: z.string().optional(),
  model: z.string().default("text-embedding-3-small"),
  dimensions: z.number().int().positive().optional(),
  requestTimeoutMs: z.number().int().positive().default(30_000),
  batchSize: z.number().int().positive().default(64),
  maxRetries: z.number().int().nonnegative().default(3),
  auth: EmbeddingAuthSchema.default({}),
});

export const StorageConfigSchema = z.object({
  database: z.string().default("{{repoRoot}}/.lci/index.sqlite"),
});

export const IndexConfigSchema = z.object({
  autoIndex: z.boolean().default(false),
});

export const LoggingConfigSchema = z.object({
  level: z.enum(["error", "warn", "info", "debug", "trace"]).default("info"),
});

// Not `.default({})` on these four: each field's own leaf-level default makes its output type
// required, so `{}` no longer satisfies it. `resolveConfig` seeds `merged` with an empty object per
// section instead, letting each field's own default apply during parsing.
export const LciConfigSchema = z
  .object({
    embedding: EmbeddingConfigSchema,
    storage: StorageConfigSchema,
    index: IndexConfigSchema,
    logging: LoggingConfigSchema,
  })
  .strict();

export type LciConfig = z.infer<typeof LciConfigSchema>;
