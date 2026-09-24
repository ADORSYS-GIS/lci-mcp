#!/usr/bin/env node
import { access } from "node:fs/promises";
import path from "node:path";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { AuthHeaderCache } from "./auth/cache.js";
import { createRepositoryAuthorizer } from "./catalog/authorization.js";
import { GitCliCheckoutAdapter, RepositoryProvisioner } from "./catalog/provisioning.js";
import type { RepositoryCatalogRecord } from "./catalog/schema.js";
import { repositoryKind, toSafeRepositorySummary } from "./catalog/schema.js";
import { RepositoryCatalogStore } from "./catalog/store.js";
import { RepositoryWorkerRegistry } from "./catalog/workerRegistry.js";
import { loadConfig } from "./config/load.js";
import { type AuthHelperConfig, type LciConfig, toSafeRepositoryConfig } from "./config/schema.js";
import { buildTemplateContext, expandTemplate, type TemplateContext } from "./config/template.js";
import { stageDocumentSources } from "./documentSources.js";
import { EmbeddingClient } from "./embedding/client.js";
import { CodeIndex } from "./engine.js";
import { startHttpMcpServer } from "./http/server.js";
import { Logger } from "./logging.js";
import { waitForBackgroundIndexJob } from "./mcp/indexingJob.js";
import { createServer } from "./mcp/server.js";
import { isUnsafeIndexRoot } from "./rootSafety.js";

// Appendix B's CLI surface, hand-parsed: the flag set is small enough that a dependency isn't
// earning its keep, and this keeps secret-bearing flags impossible to accidentally leak through a
// third-party arg-parser's own debug/verbose logging.
interface Args {
  stdio: boolean;
  http: boolean;
  httpPort?: number;
  httpHost?: string;
  help: boolean;
  root?: string;
  config?: string;
  configJson?: string;
  logLevel?: string;
  embeddingBaseUrl?: string;
  embeddingModel?: string;
  embeddingDimensions?: number;
  database?: string;
  subcommand?: "config-show";
}

const HELP_TEXT = `lightbridge-code-intelligence-mcp — local-first MCP server for repository-aware code retrieval

Usage:
  lightbridge-code-intelligence-mcp --stdio [options]
  lightbridge-code-intelligence-mcp config show [options]

Options:
  --stdio                        Start the MCP server on stdio (required to actually serve)
  --http                         Start the authenticated MCP server over HTTP
  --http-port <n>                HTTP listen port (default: 8787)
  --http-host <host>             HTTP listen host (default: 127.0.0.1)
  --root <path>                  Repository root to index (default: current directory)
  --config <path>                Load a JSON config file
  --config-json <json>           Inline JSON config, merged over --config
  --log-level <level>            error | warn | info | debug | trace (default: info)
  --embedding-base-url <url>     OpenAI-compatible embeddings endpoint (unset disables embeddings)
  --embedding-model <name>       Embedding model name (default: text-embedding-3-small)
  --embedding-dimensions <n>     Expected embedding vector size
  --database <path>              Override the SQLite database path
  -h, --help                     Show this help and exit

Config resolution, lowest to highest precedence:
  built-in defaults -> ~/.config/lci/config.json -> --config -> LCI_CONFIG_CONTENT env
  -> --config-json -> the flags above
`;

function parsePort(raw: string | undefined): number {
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`lci-mcp: invalid --http-port "${raw ?? ""}" (expected an integer 1-65535)`);
  }
  return port;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { stdio: false, http: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    switch (token) {
      case "--help":
      case "-h":
        args.help = true;
        break;
      case "--stdio":
        args.stdio = true;
        break;
      case "--http":
        args.http = true;
        break;
      case "--http-port":
        args.httpPort = parsePort(argv[++i]);
        break;
      case "--http-host":
        args.httpHost = argv[++i];
        break;
      case "--root":
        args.root = argv[++i];
        break;
      case "--config":
        args.config = argv[++i];
        break;
      case "--config-json":
        args.configJson = argv[++i];
        break;
      case "--log-level":
        args.logLevel = argv[++i];
        break;
      case "--embedding-base-url":
        args.embeddingBaseUrl = argv[++i];
        break;
      case "--embedding-model":
        args.embeddingModel = argv[++i];
        break;
      case "--embedding-dimensions":
        args.embeddingDimensions = Number(argv[++i]);
        break;
      case "--database":
        args.database = argv[++i];
        break;
      case "config":
        if (argv[i + 1] === "show") {
          args.subcommand = "config-show";
          i++;
        }
        break;
      default:
        if (token.startsWith("-")) {
          throw new Error(`lci-mcp: unrecognized flag "${token}"`);
        }
    }
  }
  return args;
}

function cliOverridesFrom(args: Args): Record<string, unknown> {
  const overrides: Record<string, unknown> = {};
  if (args.logLevel) overrides.logging = { level: args.logLevel };
  const embedding: Record<string, unknown> = {};
  if (args.embeddingBaseUrl) embedding.baseUrl = args.embeddingBaseUrl;
  if (args.embeddingModel) embedding.model = args.embeddingModel;
  if (args.embeddingDimensions) embedding.dimensions = args.embeddingDimensions;
  if (Object.keys(embedding).length > 0) overrides.embedding = embedding;
  if (args.database) overrides.storage = { database: args.database };
  return overrides;
}

function redactHelper(helper: AuthHelperConfig | undefined) {
  if (!helper) return undefined;
  return { type: "helper" as const, command: helper.command };
}

// When provisioning is configured, clone/refresh any freshly registered code repository whose local
// checkout is missing. Best-effort and opt-in: failures are logged and never block startup, and a
// manifest that ships its own checkouts (no `provisioning` block) is untouched.
async function ensureProvisionedCheckouts(
  config: LciConfig,
  catalog: RepositoryCatalogStore,
  templateContext: TemplateContext,
  logger: Logger,
): Promise<void> {
  if (!config.provisioning) return;
  const checkoutRoot = expandTemplate(config.provisioning.checkoutRoot, templateContext);
  const provisioner = new RepositoryProvisioner(
    catalog,
    { checkoutRoot, allowedHosts: config.provisioning.allowedHosts },
    new GitCliCheckoutAdapter(config.provisioning.gitPath),
  );
  const document = await catalog.load();
  for (const record of document.repositories) {
    if (record.lifecycle !== "registered" || repositoryKind(record.remoteUrl) === "document") continue;
    try {
      await access(path.join(record.checkoutPath, ".git"));
      continue;
    } catch {
      // Missing checkout — fall through to provision it.
    }
    try {
      await provisioner.provision(record.repositoryId);
      logger.info("repository checkout provisioned", { repositoryId: record.repositoryId });
    } catch (error) {
      logger.error("repository provisioning failed", {
        repositoryId: record.repositoryId,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(HELP_TEXT);
    return;
  }
  const repoRoot = path.resolve(args.root ?? process.cwd());
  if (isUnsafeIndexRoot(repoRoot)) {
    process.stderr.write(
      `lci-mcp: refusing to index "${repoRoot}" — it resolves to a home directory or filesystem root. Pass --root at a specific repository instead.\n`,
    );
    process.exitCode = 1;
    return;
  }
  const config = loadConfig({
    configFile: args.config,
    configJson: args.configJson,
    cliOverrides: cliOverridesFrom(args),
  });
  const templateContext = await buildTemplateContext(repoRoot);
  const databasePath = expandTemplate(config.storage.database, templateContext);
  const catalogPath = expandTemplate(config.storage.catalog, templateContext);
  const indexRoot = expandTemplate(config.storage.indexRoot, templateContext);

  if (args.subcommand === "config-show") {
    process.stdout.write(
      `${JSON.stringify(
        {
          repository: {
            root: templateContext.repoRoot,
            name: templateContext.repoName,
            repoKey: templateContext.repoKey,
            headSha: templateContext.headSha,
          },
          embedding: config.embedding.baseUrl
            ? {
                baseUrl: config.embedding.baseUrl,
                model: config.embedding.model,
                auth: config.embedding.auth.helper
                  ? redactHelper(config.embedding.auth.helper)
                  : config.embedding.auth.apiKey
                    ? { type: "api-key" }
                    : { type: "none" },
              }
            : undefined,
          storage: {
            template: config.storage.database,
            resolved: databasePath,
            catalog: catalogPath,
            indexRoot,
          },
          repositories: config.repositories.map(toSafeRepositoryConfig),
          logging: config.logging,
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  if (!args.stdio && !args.http) {
    process.stderr.write("lci-mcp: no transport selected; pass --stdio or --http\n");
    process.exitCode = 1;
    return;
  }
  if (args.stdio && args.http) {
    process.stderr.write("lci-mcp: choose a single transport; pass either --stdio or --http, not both\n");
    process.exitCode = 1;
    return;
  }

  const logger = new Logger(config.logging.level);
  logger.info("starting", { repoRoot, databasePath });

  // filename → source URL per document repository, kept in memory (recomputed each startup from
  // staging) and attached to summaries at list time so citations can link back to the document.
  const documentLinksByRepo = new Map<string, Record<string, string>>();
  if (config.documentSources.length > 0) {
    const staged = await stageDocumentSources(config.documentSources, indexRoot, { logger });
    for (const { entry, links } of staged) {
      config.repositories.push(entry);
      if (Object.keys(links).length > 0) documentLinksByRepo.set(entry.repositoryId, links);
    }
  }

  const multiRepository = config.repositories.length > 0;

  // Apply the same home-directory / filesystem-root refusal to every manifest checkoutPath that the
  // CLI already enforces for --root. Without this, a checkoutPath of "~" or "/" would be indexed and
  // served (including over the HTTP transport), exposing SSH keys, dotfiles, and unrelated checkouts.
  const unsafeRepository = config.repositories.find((entry) => isUnsafeIndexRoot(entry.checkoutPath));
  if (unsafeRepository) {
    process.stderr.write(
      `lci-mcp: refusing to index repository "${unsafeRepository.repositoryId}" — its checkoutPath "${unsafeRepository.checkoutPath}" resolves to a home directory or filesystem root. Point it at a specific repository directory instead.\n`,
    );
    process.exitCode = 1;
    return;
  }

  const codeIndex = multiRepository
    ? undefined
    : await CodeIndex.open({ repository: repoRoot, database: databasePath });

  const authHelperConfig = config.embedding.auth.helper;
  const authCache = authHelperConfig
    ? new AuthHeaderCache(authHelperConfig, authHelperConfig.cacheTtlSeconds * 1000)
    : undefined;

  const embeddingClient = config.embedding.baseUrl
    ? new EmbeddingClient({
        baseUrl: config.embedding.baseUrl,
        model: config.embedding.model,
        dimensions: config.embedding.dimensions,
        requestTimeoutMs: config.embedding.requestTimeoutMs,
        maxRetries: config.embedding.maxRetries,
        maxInputTokens: config.embedding.maxInputTokens,
        maxInputChars: config.embedding.maxInputChars,
        logger,
        headersProvider: async () => {
          const headers: Record<string, string> = {};
          if (config.embedding.auth.apiKey) headers.authorization = `Bearer ${config.embedding.auth.apiKey}`;
          if (authCache) Object.assign(headers, await authCache.getHeaders());
          return headers;
        },
        onAuthFailure: authCache
          ? async () => {
              authCache.invalidate();
              await authCache.getHeaders();
            }
          : undefined,
      })
    : undefined;

  const catalog = new RepositoryCatalogStore(catalogPath);
  const authorize = createRepositoryAuthorizer((event) => {
    if (event.allowed) {
      logger.trace("repository access granted", {
        repositoryId: event.repositoryId,
        operation: event.operation,
        principal: event.principal,
      });
    } else {
      logger.warn("repository access denied", {
        repositoryId: event.repositoryId,
        operation: event.operation,
        principal: event.principal,
      });
    }
  });
  if (multiRepository) {
    // Reconcile every boot so manifest edits (renames, allowedPrincipals, removals) take effect and
    // repositories dropped from the manifest stop being queryable. New repositories start
    // non-queryable and only become queryable once an index run completes.
    const now = new Date().toISOString();
    const desired: RepositoryCatalogRecord[] = config.repositories.map((entry) => ({
      ...entry,
      queryable: false,
      lifecycle: "registered",
      createdAt: now,
      updatedAt: now,
    }));
    await catalog.reconcileManifest(desired);
    await ensureProvisionedCheckouts(config, catalog, templateContext, logger);
  }

  let workerRegistry: RepositoryWorkerRegistry | undefined;
  let defaultRepositoryId: string | undefined;
  let allowImplicitRepository = true;
  let listRepositories: ((principal?: string) => Promise<ReturnType<typeof toSafeRepositorySummary>[]>) | undefined;
  if (multiRepository) {
    workerRegistry = new RepositoryWorkerRegistry({
      catalog,
      storageRoot: indexRoot,
      maxWorkers: config.index.maxConcurrentRepositories,
      authorize,
      factory: async (repository, repositoryDatabasePath) => {
        // Defense in depth: never open an index on a home/root checkout, even if one somehow reaches the catalog.
        if (isUnsafeIndexRoot(repository.checkoutPath)) {
          throw new Error(`repository checkout path is unsafe to index: ${repository.repositoryId}`);
        }
        return {
          codeIndex: await CodeIndex.open({ repository: repository.checkoutPath, database: repositoryDatabasePath }),
          // A structural-only repository must never receive an embedding client, or it would be
          // re-embedded and answer semantic queries it was explicitly opted out of.
          embeddingClient: repository.structuralOnly ? undefined : embeddingClient,
        };
      },
    });
    defaultRepositoryId = undefined;
    allowImplicitRepository = false;
    listRepositories = async (principal) => {
      const document = await catalog.load();
      const visible = document.repositories.filter(
        (record) => record.lifecycle !== "removed" && authorize(record, "query", principal),
      );
      return visible.map((record) => {
        const summary = toSafeRepositorySummary(record);
        const links = documentLinksByRepo.get(record.repositoryId);
        return links ? { ...summary, documentLinks: links } : summary;
      });
    };
  }

  const baseContext = {
    codeIndex,
    embeddingClient,
    config,
    logger,
    repoRoot,
    databasePath,
    workerRegistry,
    catalog: multiRepository ? catalog : undefined,
    defaultRepositoryId,
    allowImplicitRepository,
    listRepositories,
  };
  if (args.http) {
    const bearerToken = process.env.LCI_HTTP_BEARER_TOKEN;
    if (!bearerToken) throw new Error("LCI_HTTP_BEARER_TOKEN is required for --http");
    // The bearer token is shared, so an empty allowlist authorizes every HTTP client for that repo.
    for (const repository of config.repositories) {
      if (repository.allowedPrincipals.length === 0) {
        logger.warn("repository has an empty allowlist; every authenticated HTTP client can query it", {
          repositoryId: repository.repositoryId,
        });
      }
    }
    const httpServer = startHttpMcpServer({
      host: args.httpHost ?? "127.0.0.1",
      port: args.httpPort ?? 8787,
      bearerToken,
      // Each session is bound to the principal the trusted gateway asserts, so clients over one
      // shared bearer token no longer collapse into a single identity.
      createMcpServer: (principal) => createServer({ ...baseContext, principal }),
      onReady: (address) => logger.info("MCP HTTP server ready", { address }),
      // A bind failure arrives asynchronously; report it and exit non-zero rather than crashing.
      onError: (error) => {
        logger.error("MCP HTTP server error", { reason: error.message });
        process.exit(1);
      },
    });
    const shutdown = () => {
      void Promise.all([workerRegistry?.closeAll(), waitForBackgroundIndexJob()]).finally(() => {
        httpServer.close();
        // close() waits for in-flight connections; long-lived SSE GET streams would otherwise keep
        // the process alive, so force them shut. The server's 'close' handler tears down sessions.
        httpServer.closeAllConnections();
      });
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
    return;
  }
  // Over stdio the principal is fixed for the process lifetime.
  const context = { ...baseContext, principal: process.env.LCI_PRINCIPAL };
  const server = createServer(context);
  const transport = new StdioServerTransport();
  const shutdown = () => {
    void Promise.all([workerRegistry?.closeAll(), waitForBackgroundIndexJob()]).finally(() => process.exit(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  await server.connect(transport);
  logger.info("MCP server ready");
}

main().catch((err) => {
  process.stderr.write(`lci-mcp: fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exitCode = 1;
});
