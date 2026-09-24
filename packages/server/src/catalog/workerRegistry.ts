import path from "node:path";

import type { EmbeddingClient } from "../embedding/client.js";
import type { CodeIndex } from "../engine.js";
import type { RepositoryCatalogRecord } from "./schema.js";
import type { RepositoryCatalogStore } from "./store.js";

export type WorkerOperation = "query" | "index" | "status";

export interface RepositoryWorkerResources {
  codeIndex: CodeIndex;
  embeddingClient?: EmbeddingClient;
  close?: () => Promise<void> | void;
}

export interface RepositoryWorker extends RepositoryWorkerResources {
  repository: RepositoryCatalogRecord;
  repositoryRoot: string;
  databasePath: string;
}

export type RepositoryWorkerFactory = (
  repository: RepositoryCatalogRecord,
  databasePath: string,
) => Promise<RepositoryWorkerResources>;

export type RepositoryAuthorization = (
  repository: RepositoryCatalogRecord,
  operation: WorkerOperation,
  principal?: string,
) => boolean | Promise<boolean>;

export interface RepositoryWorkerRegistryOptions {
  catalog: RepositoryCatalogStore;
  storageRoot: string;
  factory: RepositoryWorkerFactory;
  authorize?: RepositoryAuthorization;
  maxWorkers?: number;
}

/** Resolves trusted catalog records to one cached CodeIndex worker per repository. */
export class RepositoryWorkerRegistry {
  private readonly workers = new Map<string, RepositoryWorker>();
  private readonly opening = new Map<string, Promise<RepositoryWorker>>();
  // Monotonic use counter per open worker; the smallest value is the least-recently-used worker.
  private readonly lastUsed = new Map<string, number>();
  private useTick = 0;
  private closing = false;
  private readonly storageRoot: string;
  private readonly maxWorkers: number;

  constructor(private readonly options: RepositoryWorkerRegistryOptions) {
    if (!path.isAbsolute(options.storageRoot)) throw new Error("worker storage root must be absolute");
    this.storageRoot = path.resolve(options.storageRoot);
    this.maxWorkers = options.maxWorkers ?? 32;
    if (!Number.isInteger(this.maxWorkers) || this.maxWorkers < 1) {
      throw new Error("worker maxWorkers must be a positive integer");
    }
  }

  get size(): number {
    return this.workers.size;
  }

  get capacity(): number {
    return this.maxWorkers;
  }

  databasePathFor(repositoryId: string): string {
    const databasePath = path.resolve(this.storageRoot, repositoryId, "index.sqlite");
    const storagePrefix = `${this.storageRoot}${path.sep}`;
    if (!databasePath.startsWith(storagePrefix)) {
      throw new Error("repository database path escaped the worker storage root");
    }
    return databasePath;
  }

  async resolve(
    repositoryId: string,
    operation: WorkerOperation = "query",
    principal?: string,
  ): Promise<RepositoryWorker> {
    if (this.closing) throw new Error("repository worker registry is shutting down");
    const repository = await this.options.catalog.get(repositoryId);
    if (!repository) throw new Error(`repository not found: ${repositoryId}`);
    this.assertAvailable(repository, operation);
    if (this.options.authorize && !(await this.options.authorize(repository, operation, principal))) {
      throw new Error(`repository access denied: ${repositoryId}`);
    }

    const cached = this.workers.get(repositoryId);
    if (cached) {
      // Refresh the snapshot so envelopes report live lifecycle/state, not the record captured at open.
      cached.repository = repository;
      this.touch(repositoryId);
      return cached;
    }

    const pending = this.opening.get(repositoryId);
    if (pending !== undefined) return pending;

    // Evict to make room BEFORE registering the open, so the `opening` lookup and its set below are
    // not separated by an await — that keeps concurrent resolves of the same repository deduplicated.
    await this.evictToCapacity();
    const cachedAfterEvict = this.workers.get(repositoryId);
    if (cachedAfterEvict) {
      cachedAfterEvict.repository = repository;
      this.touch(repositoryId);
      return cachedAfterEvict;
    }
    const pendingAfterEvict = this.opening.get(repositoryId);
    if (pendingAfterEvict !== undefined) return pendingAfterEvict;
    if (this.workers.size + this.opening.size >= this.maxWorkers) {
      throw new Error("repository worker capacity reached");
    }

    const opening = this.openWorker(repository);
    this.opening.set(repositoryId, opening);
    try {
      const worker = await opening;
      this.touch(repositoryId);
      return worker;
    } finally {
      this.opening.delete(repositoryId);
    }
  }

  async closeAll(): Promise<void> {
    // Reject new opens and drain any that were already in flight, including opens that settle while
    // we await, so a worker created during teardown is still closed rather than leaked.
    this.closing = true;
    while (this.opening.size > 0) {
      await Promise.all([...this.opening.values()].map(async (opening) => opening.catch(() => undefined)));
    }
    const workers = [...this.workers.values()];
    this.workers.clear();
    this.lastUsed.clear();
    await Promise.all(workers.map(async (worker) => worker.close?.()));
  }

  private touch(repositoryId: string): void {
    this.lastUsed.set(repositoryId, ++this.useTick);
  }

  /** Closes the least-recently-used cached workers until there is room for one more. */
  private async evictToCapacity(): Promise<void> {
    while (this.workers.size + this.opening.size >= this.maxWorkers && this.workers.size > 0) {
      let lruId: string | undefined;
      let lruTick = Number.POSITIVE_INFINITY;
      for (const repositoryId of this.workers.keys()) {
        const tick = this.lastUsed.get(repositoryId) ?? 0;
        if (tick < lruTick) {
          lruTick = tick;
          lruId = repositoryId;
        }
      }
      if (lruId === undefined) return;
      const victim = this.workers.get(lruId)!;
      this.workers.delete(lruId);
      this.lastUsed.delete(lruId);
      await victim.close?.();
    }
  }

  private async openWorker(repository: RepositoryCatalogRecord): Promise<RepositoryWorker> {
    const databasePath = this.databasePathFor(repository.repositoryId);
    const resources = await this.options.factory(repository, databasePath);
    const worker: RepositoryWorker = {
      ...resources,
      repository,
      repositoryRoot: repository.checkoutPath,
      databasePath,
    };
    this.workers.set(repository.repositoryId, worker);
    return worker;
  }

  private assertAvailable(repository: RepositoryCatalogRecord, operation: WorkerOperation): void {
    if (!repository.enabled || repository.lifecycle === "disabled" || repository.lifecycle === "removed") {
      throw new Error(`repository is unavailable: ${repository.repositoryId}`);
    }
    if (operation === "query" && !repository.queryable) {
      throw new Error(`repository is not queryable: ${repository.repositoryId}`);
    }
  }
}
