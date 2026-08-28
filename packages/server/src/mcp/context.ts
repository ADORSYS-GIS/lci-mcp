import type { LciConfig } from "../config/schema.js";
import type { EmbeddingClient } from "../embedding/client.js";
import type { CodeIndex } from "../engine.js";
import type { Logger } from "../logging.js";

/** Shared state every tool handler needs — built once in cli.ts, passed into createServer. */
export interface AppContext {
  codeIndex: CodeIndex;
  embeddingClient: EmbeddingClient | undefined;
  config: LciConfig;
  logger: Logger;
  repoRoot: string;
  databasePath: string;
}
