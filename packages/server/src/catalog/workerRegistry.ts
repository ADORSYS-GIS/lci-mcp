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

  databasePathFor(repositoryId: string): string {
    const databasePath = path.resolve(this.storageRoot, repositoryId, "index.sqlite");
    const storagePrefix = `${this.storageRoot}${path.sep}`;
    if (!databasePath.startsWith(storagePrefix)) {
      throw new Error("repository database path escaped the worker storage root");
    }
    return databasePath;
  }

  async resolve(repositoryId: string, operation: WorkerOperation = "query"): Promise<RepositoryWorker> {
    const repository = await this.options.catalog.get(repositoryId);
    if (!repository) throw new Error(`repository not found: ${repositoryId}`);
    this.assertAvailable(repository, operation);
    if (this.options.authorize && !(await this.options.authorize(repository, operation))) {
      throw new Error(`repository access denied: ${repositoryId}`);
    }

    const cached = this.workers.get(repositoryId);
    if (cached) return cached;

    const pending = this.opening.get(repositoryId);
    if (pending !== undefined) return pending;
    if (this.workers.size + this.opening.size >= this.maxWorkers) throw new Error("repository worker capacity reached");

    const opening = this.openWorker(repository);
    this.opening.set(repositoryId, opening);
    try {
      return await opening;
    } finally {
      this.opening.delete(repositoryId);
    }
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.opening.values()].map(async (opening) => opening.catch(() => undefined)));
    const workers = [...this.workers.values()];
    this.workers.clear();
    await Promise.all(workers.map(async (worker) => worker.close?.()));
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
