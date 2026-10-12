import type { Logger } from "../logging.js";

// `lci_index` returns as soon as the generation record exists; structural extraction and, if
// configured, embedding both keep running in this process after the tool call returns. Status is
// observed by re-reading generation state from SQLite, not through any state kept here — only one
// generation can be BUILDING at a time, so a single in-flight promise is enough bookkeeping. This
// module exists purely so an unhandled rejection from the background job is logged instead of
// crashing.

let inFlight: Promise<void> | undefined;

export function startBackgroundIndexJob(logger: Logger, job: () => Promise<void>): void {
  inFlight = job().catch((err) => {
    logger.error("background indexing job failed", { error: err instanceof Error ? err.message : String(err) });
  });
}

/** Test/shutdown hook — waits for any in-flight background job to settle. */
export async function waitForBackgroundIndexJob(): Promise<void> {
  await inFlight;
}
