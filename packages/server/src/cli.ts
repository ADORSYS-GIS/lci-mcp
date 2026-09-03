#!/usr/bin/env node
import path from "node:path";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { AuthHeaderCache } from "./auth/cache.js";
import { loadConfig } from "./config/load.js";
import type { AuthHelperConfig } from "./config/schema.js";
import { buildTemplateContext, expandTemplate } from "./config/template.js";
import { EmbeddingClient } from "./embedding/client.js";
import { CodeIndex } from "./engine.js";
import { Logger } from "./logging.js";
import { createServer } from "./mcp/server.js";

// Appendix B's CLI surface, hand-parsed: the flag set is small enough that a dependency isn't
// earning its keep, and this keeps secret-bearing flags impossible to accidentally leak through a
// third-party arg-parser's own debug/verbose logging.
interface Args {
  stdio: boolean;
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

function parseArgs(argv: string[]): Args {
  const args: Args = { stdio: false, help: false };
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

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(HELP_TEXT);
    return;
  }
  const repoRoot = path.resolve(args.root ?? process.cwd());
  const config = loadConfig({
    configFile: args.config,
    configJson: args.configJson,
    cliOverrides: cliOverridesFrom(args),
  });
  const templateContext = await buildTemplateContext(repoRoot);
  const databasePath = expandTemplate(config.storage.database, templateContext);

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
          storage: { template: config.storage.database, resolved: databasePath },
          logging: config.logging,
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  if (!args.stdio) {
    process.stderr.write("lci-mcp: no transport selected; pass --stdio\n");
    process.exitCode = 1;
    return;
  }

  const logger = new Logger(config.logging.level);
  logger.info("starting", { repoRoot, databasePath });

  const codeIndex = await CodeIndex.open({ repository: repoRoot, database: databasePath });

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

  const server = createServer({ codeIndex, embeddingClient, config, logger, repoRoot, databasePath });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("MCP server ready");
}

main().catch((err) => {
  process.stderr.write(`lci-mcp: fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exitCode = 1;
});
