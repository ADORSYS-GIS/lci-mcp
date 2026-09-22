import type { Logger } from "../logging.js";

// `lci_index` returns once structural extraction completes; it does not block on the embedding
// loop, which keeps running in this process after the tool call returns. Status is observed by
// re-reading generation state from SQLite, not through state kept here.

const inFlightByRepositoryId = new Map<string, Promise<void>>();

export function startBackgroundIndexJob(logger: Logger, repositoryId: string, job: () => Promise<void>): void {
  if (inFlightByRepositoryId.has(repositoryId)) {
    throw new Error(`indexing is already in progress for repository: ${repositoryId}`);
  }
  const inFlight = job().catch((err) => {
    logger.error("background indexing job failed", {
      repositoryId,
      error: err instanceof Error ? err.message : String(err),
    });
  });
  inFlightByRepositoryId.set(repositoryId, inFlight);
  void inFlight.finally(() => {
    if (inFlightByRepositoryId.get(repositoryId) === inFlight) inFlightByRepositoryId.delete(repositoryId);
  });
}

/** Test/shutdown hook — waits for any in-flight background job to settle. */
export async function waitForBackgroundIndexJob(): Promise<void> {
  await Promise.all(inFlightByRepositoryId.values());
}
