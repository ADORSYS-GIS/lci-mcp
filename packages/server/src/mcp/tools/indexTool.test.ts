import { describe, expect, it, vi } from "vitest";

import type { AppContext } from "../context.js";
import { extractThenEmbedAndCommit } from "./indexTool.js";

const GENERATION_ID = "gen-1";

function fakeContext(overrides: {
  runStructuralExtraction?: () => Promise<void>;
  commitIndex?: () => Promise<void>;
  nextEmbeddingBatch?: () => Promise<Array<{ id: string; text: string }>>;
  embeddingClient?: AppContext["embeddingClient"];
}): { ctx: AppContext; failIndex: ReturnType<typeof vi.fn>; loggerError: ReturnType<typeof vi.fn> } {
  const failIndex = vi.fn().mockResolvedValue(undefined);
  const loggerError = vi.fn();
  const ctx = {
    codeIndex: {
      runStructuralExtraction: overrides.runStructuralExtraction ?? (() => Promise.resolve()),
      commitIndex: overrides.commitIndex ?? (() => Promise.resolve()),
      nextEmbeddingBatch: overrides.nextEmbeddingBatch ?? (() => Promise.resolve([])),
      putEmbeddings: () => Promise.resolve(),
      failIndex,
    },
    embeddingClient: overrides.embeddingClient,
    config: { embedding: { batchSize: 64, dimensions: 8, model: "fake-model" } },
    logger: { info: vi.fn(), error: loggerError },
  } as unknown as AppContext;
  return { ctx, failIndex, loggerError };
}

describe("extractThenEmbedAndCommit", () => {
  it("commits and never fails the generation when there is no embedding client", async () => {
    const commitIndex = vi.fn().mockResolvedValue(undefined);
    const { ctx, failIndex } = fakeContext({ commitIndex });

    await extractThenEmbedAndCommit(ctx, GENERATION_ID);

    expect(commitIndex).toHaveBeenCalledOnce();
    expect(failIndex).not.toHaveBeenCalled();
  });

  it("fails the generation when commitIndex rejects with no embedding client configured", async () => {
    const commitIndex = vi.fn().mockRejectedValue(new Error("disk full"));
    const { ctx, failIndex, loggerError } = fakeContext({ commitIndex });

    await extractThenEmbedAndCommit(ctx, GENERATION_ID);

    expect(failIndex).toHaveBeenCalledWith(GENERATION_ID, "disk full");
    expect(loggerError).toHaveBeenCalledWith("index generation failed", {
      generationId: GENERATION_ID,
      reason: "disk full",
    });
  });

  it("fails the generation when the embedding loop rejects", async () => {
    const nextEmbeddingBatch = vi.fn().mockRejectedValue(new Error("embedding endpoint unreachable"));
    const { ctx, failIndex } = fakeContext({
      nextEmbeddingBatch,
      embeddingClient: { embed: vi.fn() } as unknown as AppContext["embeddingClient"],
    });

    await extractThenEmbedAndCommit(ctx, GENERATION_ID);

    expect(failIndex).toHaveBeenCalledWith(GENERATION_ID, "embedding endpoint unreachable");
  });

  it("returns without touching commit or fail when structural extraction itself fails", async () => {
    const commitIndex = vi.fn();
    const { ctx, failIndex } = fakeContext({
      runStructuralExtraction: () => Promise.reject(new Error("tree-sitter walk failed")),
      commitIndex,
    });

    await extractThenEmbedAndCommit(ctx, GENERATION_ID);

    expect(commitIndex).not.toHaveBeenCalled();
    // The engine already released the lease and marked the generation FAILED on this path.
    expect(failIndex).not.toHaveBeenCalled();
  });
});
