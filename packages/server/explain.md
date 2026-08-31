# packages/server — explained

The MCP-facing shell. TypeScript, published as `@vymalo/lightbridge-code-intelligence-mcp`. Owns
everything the engine deliberately doesn't: the MCP protocol itself, config loading, and the one
piece of networking the whole system does — the embeddings HTTP call.

## What lives here

```text
src/
├── cli.ts                    entry point: parse args, load config, wire everything, connect stdio
├── engine.ts                   re-exports the compiled native addon
├── logging.ts                   stderr-only structured JSON logger
├── config/
│   ├── schema.ts                  the zod LciConfig shape
│   ├── load.ts                     defaults -> file -> env -> --config-json -> CLI flags
│   └── template.ts                  {{repoRoot}}/{{repoKey}}/{{headSha}}/... expansion
├── embedding/
│   ├── client.ts                    the OpenAI-compatible /embeddings HTTP call
│   └── retry.ts                      backoff + retryable-status logic
├── auth/
│   ├── helper.ts                     spawns a configured command, parses its stdout as headers
│   └── cache.ts                       in-memory header cache with absolute expiry
└── mcp/
    ├── server.ts                       registers all seven tools on one McpServer
    ├── context.ts                       AppContext — the one bag of shared state every tool gets
    ├── indexingJob.ts                    fire-and-forget wrapper for the background embed loop
    ├── toolResult.ts                      textResult() — the one response-shaping helper
    └── tools/*.ts                          one file per MCP tool
```

## Startup, in order

```ts
// cli.ts
async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = path.resolve(args.root ?? process.cwd());
  const config = loadConfig({ configFile: args.config, configJson: args.configJson, cliOverrides: cliOverridesFrom(args) });
  const templateContext = await buildTemplateContext(repoRoot);
  const databasePath = expandTemplate(config.storage.database, templateContext);

  const codeIndex = await CodeIndex.open({ repository: repoRoot, database: databasePath });

  const embeddingClient = config.embedding.baseUrl
    ? new EmbeddingClient({ baseUrl: config.embedding.baseUrl, model: config.embedding.model, ..., headersProvider: async () => {...} })
    : undefined;

  const server = createServer({ codeIndex, embeddingClient, config, logger, repoRoot, databasePath });
  await server.connect(new StdioServerTransport());
}
```

`repoRoot` — `path.resolve(args.root ?? process.cwd())` — is the single most important input: it's
an arbitrary filesystem directory, not necessarily a git repository. Args are hand-parsed
deliberately (see the comment in `cli.ts`): the flag set is small enough that a third-party parser
isn't earning its keep, and it keeps secret-bearing flags (embedding auth) impossible to leak through
a dependency's own debug logging.

## The tool surface

```ts
// mcp/server.ts
export function createServer(ctx: AppContext): McpServer {
  const server = new McpServer({ name: "lightbridge-code-intelligence", version: "0.1.0" });
  registerIndexTool(server, ctx);
  registerIndexStatusTool(server, ctx);
  registerSearchTool(server, ctx);
  registerFindSymbolTool(server, ctx);
  registerCallersTool(server, ctx);
  registerCalleesTool(server, ctx);
  registerExploreSymbolTool(server, ctx);
  return server;
}
```

Every tool handler gets the same `AppContext` — `{ codeIndex, embeddingClient, config, logger,
repoRoot, databasePath }` — built once in `cli.ts` and passed straight through. `lci_index` is the
one with real structure: it triggers extraction synchronously, then only if an embedding client is
configured does it hand off to a background loop:

```ts
// mcp/tools/indexTool.ts
async () => {
  const handle = await ctx.codeIndex.beginIndex({ embeddingFingerprint, embeddingDimensions });
  if (!ctx.embeddingClient) {
    await ctx.codeIndex.commitIndex(handle.generationId);
    return textResult({ generationId: handle.generationId, state: "done" });
  }
  startBackgroundIndexJob(ctx.logger, () => runEmbeddingLoopAndCommit(ctx, handle.generationId));
  return textResult({ generationId: handle.generationId, state: "in_progress" });
}

async function runEmbeddingLoopAndCommit(ctx: AppContext, generationId: string): Promise<void> {
  for (;;) {
    const batch = await ctx.codeIndex.nextEmbeddingBatch(generationId, ctx.config.embedding.batchSize);
    if (batch.length === 0) break;
    const vectors = await ctx.embeddingClient!.embed(batch.map((item) => item.text));
    await ctx.codeIndex.putEmbeddings(generationId, batch.map((item, i) => ({ id: item.id, vector: vectors[i]! })), dimensions);
  }
  await ctx.codeIndex.commitIndex(generationId);
}
```

This is the only place the embedding endpoint ever gets called from — batch by batch, strictly
*after* the structural extraction has already committed its data (see the root `WALKTHROUGH.md` for
the full sequencing story).

## The one HTTP call this whole system makes

```ts
// embedding/client.ts
const response = await fetch(`${this.opts.baseUrl.replace(/\/+$/, "")}/embeddings`, {
  method: "POST",
  headers: { "content-type": "application/json", ...headers },
  body: JSON.stringify({
    model: this.opts.model, input: texts, encoding_format: "float",
    ...(this.opts.dimensions ? { dimensions: this.opts.dimensions } : {}),
  }),
  signal: controller.signal,
});
```

Wrapped in a retry loop (`embedding/retry.ts`) that only retries connect errors, timeouts, 429, and
5xx — a bad request or a bad model name fails immediately rather than retrying a config error into a
longer wait. Responses get reordered by their own `index` field and validated as a true permutation
before being trusted, since the spec doesn't guarantee order is preserved.

## Config: one object, several sources

```ts
// config/schema.ts
export const EmbeddingConfigSchema = z.object({
  baseUrl: z.string().optional(),
  model: z.string().default("text-embedding-3-small"),
  dimensions: z.number().int().positive().optional(),
  batchSize: z.number().int().positive().default(64),
  maxRetries: z.number().int().nonnegative().default(3),
  auth: EmbeddingAuthSchema.default({}),
});
```

`loadConfig` merges, in increasing precedence: built-in defaults → `~/.config/lci/config.json` →
`--config <file>` → `LCI_CONFIG_CONTENT` env → `--config-json` → individual CLI flags. Storage paths
go through `config/template.ts`'s `{{repoRoot}}`/`{{repoKey}}`/`{{headSha}}`/... expansion before
ever touching disk.

## Auth: static key or an external helper

```ts
// auth/helper.ts
const child = spawn(config.command, config.args, { stdio: ["ignore", "pipe", "pipe"] });
// ...stdout parsed as JSON: either a bare header map, or {headers, expiresAt}
```

No implicit shell, bounded stdout (64KB), stdout piped straight to `JSON.parse` and never to the
logger. `auth/cache.ts` holds the result in memory with an absolute expiry, and `embedding/client.ts`
invalidates it and retries exactly once on a 401/403 — see
[ADR-0006](../../docs/adr/0006-generic-external-auth-helper.md) for why this is a generic escape
hatch rather than a fixed set of built-in auth methods.

## Testing

```bash
pnpm typecheck   # tsc --noEmit
pnpm test        # vitest — unit tests next to the source they cover (*.test.ts)
pnpm test:e2e    # spawns the real built dist/cli.js, drives it over actual MCP JSON-RPC stdio
```

`e2e/mcp-roundtrip.test.ts` is the one that proves the whole stack together: index → poll status →
find_symbol → callers → callees → explore_symbol → search, against a real fixture repo and a fake
local embeddings server.
