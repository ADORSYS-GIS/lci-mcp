import path from "node:path";

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
  maxInputTokens: z.number().int().positive().default(8_192),
  maxInputChars: z.number().int().positive().optional(),
  maxRetries: z.number().int().nonnegative().default(3),
  auth: EmbeddingAuthSchema.default({}),
});

export const RepositoryManifestEntrySchema = z
  .object({
    repositoryId: z
      .string()
      .regex(/^[a-z0-9](?:[a-z0-9._-]{0,62})$/, "repositoryId must be a stable opaque identifier")
      .refine((value) => !value.includes(".."), "repositoryId must not contain path traversal"),
    displayName: z.string().trim().min(1).max(200),
    remoteUrl: z
      .string()
      .url()
      .refine((value) => {
        const parsed = new URL(value);
        return ["http:", "https:", "ssh:"].includes(parsed.protocol) && !parsed.username && !parsed.password;
      }, "remoteUrl must use http, https, or ssh without embedded credentials"),
    checkoutPath: z
      .string()
      .min(1)
      .refine((value) => path.isAbsolute(value), "checkoutPath must be absolute")
      .refine((value) => !value.includes("\0"), "checkoutPath must not contain a null byte"),
    enabled: z.boolean().default(true),
    allowedPrincipals: z.array(z.string().trim().min(1)).default([]),
    embeddingProfile: z.string().trim().min(1).default("default"),
    structuralOnly: z.boolean().default(false),
    autoIndex: z.boolean().default(false),
    refreshIntervalMinutes: z.number().int().positive().optional(),
  })
  .strict();
export type RepositoryManifestEntry = z.infer<typeof RepositoryManifestEntrySchema>;

// A document source (architecture/spec docs) declared by one or more local paths and/or URLs. It is
// staged into a folder and indexed like a repository, so the existing search/hydration pipeline
// applies unchanged. `attachTo` groups a source with a code repository for scope purposes (consumed
// by clients). Multiple inputs let a logical set (e.g. a spec split across several PDFs) stay one source.
export const DocumentSourceSchema = z
  .object({
    id: z
      .string()
      .regex(/^[a-z0-9](?:[a-z0-9._-]{0,62})$/, "document source id must be a stable opaque identifier")
      .refine((value) => !value.includes(".."), "id must not contain path traversal"),
    displayName: z.string().trim().min(1).max(200),
    path: z.string().min(1).optional(),
    url: z.string().url().optional(),
    paths: z.array(z.string().min(1)).optional(),
    urls: z.array(z.string().url()).optional(),
    attachTo: z.string().trim().min(1).optional(),
    enabled: z.boolean().default(true),
    autoIndex: z.boolean().default(false),
  })
  .strict()
  .refine(
    (source) => (source.path ? 1 : 0) + (source.url ? 1 : 0) + (source.paths?.length ?? 0) + (source.urls?.length ?? 0) >= 1,
    "each document source must set at least one of path, url, paths, or urls",
  );
export type DocumentSource = z.infer<typeof DocumentSourceSchema>;

export const StorageConfigSchema = z.object({
  database: z.string().default("{{dataDir}}/lci-mcp/{{repoKey}}/index.sqlite"),
  catalog: z
    .string()
    .refine((value) => path.isAbsolute(value) || value.startsWith("{{"), "catalog must be absolute or use a template")
    .default("{{dataDir}}/lci-mcp/catalog.json"),
  indexRoot: z
    .string()
    .refine((value) => path.isAbsolute(value) || value.startsWith("{{"), "indexRoot must be absolute or use a template")
    .default("{{dataDir}}/lci-mcp/repos"),
});

export const IndexConfigSchema = z.object({
  autoIndex: z.boolean().default(false),
  maxConcurrentRepositories: z.number().int().positive().default(2),
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
    repositories: z.array(RepositoryManifestEntrySchema).default([]),
    documentSources: z.array(DocumentSourceSchema).default([]),
  })
  .strict();

export type LciConfig = z.infer<typeof LciConfigSchema>;

export function validateRepositoryManifest(entries: RepositoryManifestEntry[]): RepositoryManifestEntry[] {
  const seenIds = new Set<string>();
  const duplicateIds = new Set<string>();
  for (const entry of entries) {
    if (seenIds.has(entry.repositoryId)) duplicateIds.add(entry.repositoryId);
    seenIds.add(entry.repositoryId);
  }
  if (duplicateIds.size > 0) throw new Error(`duplicate repository IDs: ${[...duplicateIds].join(", ")}`);
  return entries;
}

export function toSafeRepositoryConfig(entry: RepositoryManifestEntry) {
  return {
    repositoryId: entry.repositoryId,
    displayName: entry.displayName,
    enabled: entry.enabled,
    embeddingProfile: entry.embeddingProfile,
    structuralOnly: entry.structuralOnly,
    autoIndex: entry.autoIndex,
  };
}
