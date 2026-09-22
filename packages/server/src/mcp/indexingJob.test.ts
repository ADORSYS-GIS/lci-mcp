import { describe, expect, it } from "vitest";
import type { Logger } from "../logging.js";
import { startBackgroundIndexJob, waitForBackgroundIndexJob } from "./indexingJob.js";

const logger = {
  error: () => undefined,
} as unknown as Logger;

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

describe("repository-keyed indexing jobs", () => {
  it("tracks independent repositories and waits for both during shutdown", async () => {
    const first = deferred();
    const second = deferred();
    let settled = 0;

    startBackgroundIndexJob(logger, "repo-a", async () => {
      await first.promise;
      settled++;
    });
    startBackgroundIndexJob(logger, "repo-b", async () => {
      await second.promise;
      settled++;
    });

    const shutdown = waitForBackgroundIndexJob();
    first.resolve();
    await Promise.resolve();
    expect(settled).toBe(1);
    second.resolve();
    await shutdown;
    expect(settled).toBe(2);
  });

  it("rejects a second background job for the same repository", async () => {
    const first = deferred();
    startBackgroundIndexJob(logger, "repo-a", () => first.promise);
    expect(() => startBackgroundIndexJob(logger, "repo-a", async () => undefined)).toThrow(
      "indexing is already in progress for repository: repo-a",
    );
    first.resolve();
    await waitForBackgroundIndexJob();
  });
});
