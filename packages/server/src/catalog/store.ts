import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  assertLifecycleTransition,
  type CatalogDocument,
  migrateCatalogDocument,
  parseCatalogDocument,
  type RepositoryCatalogRecord,
  RepositoryCatalogRecordSchema,
  type RepositoryLifecycle,
} from "./schema.js";

const EMPTY_CATALOG: CatalogDocument = { schemaVersion: 1, repositories: [] };

export class RepositoryCatalogStore {
  // Serializes read-modify-write mutations so concurrent index-lifecycle transitions cannot clobber
  // each other or collide on the temp file.
  private mutations: Promise<unknown> = Promise.resolve();
  private tempSeq = 0;
  // This process is the sole writer, so an in-memory snapshot is authoritative between saves and
  // avoids re-reading/re-parsing the whole catalog on every resolve().
  private cached: CatalogDocument | undefined;

  constructor(private readonly filePath: string) {
    if (!path.isAbsolute(filePath)) throw new Error("catalog path must be absolute");
  }

  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const result = this.mutations.then(task, task);
    this.mutations = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async load(): Promise<CatalogDocument> {
    if (this.cached) return this.cached;
    try {
      const raw = JSON.parse(await readFile(this.filePath, "utf8")) as unknown;
      this.cached = migrateCatalogDocument(raw);
      return this.cached;
    } catch (error) {
      if (isMissingFile(error)) {
        this.cached = EMPTY_CATALOG;
        return this.cached;
      }
      throw new Error(`failed to read catalog "${this.filePath}": ${errorMessage(error)}`);
    }
  }

  async save(document: CatalogDocument): Promise<void> {
    const validated = parseCatalogDocument(document);

    await mkdir(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.${++this.tempSeq}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(validated, null, 2)}\n`, { mode: 0o600 });
    await rename(temporaryPath, this.filePath);
    this.cached = validated;
  }

  async get(repositoryId: string): Promise<RepositoryCatalogRecord | undefined> {
    const catalog = await this.load();
    return catalog.repositories.find((repository) => repository.repositoryId === repositoryId);
  }

  async add(repository: RepositoryCatalogRecord): Promise<void> {
    const validated = RepositoryCatalogRecordSchema.parse(repository);
    return this.serialize(async () => {
      const catalog = await this.load();
      if (catalog.repositories.some((item) => item.repositoryId === validated.repositoryId)) {
        throw new Error(`repository ID already exists: ${validated.repositoryId}`);
      }
      await this.save({ ...catalog, repositories: [...catalog.repositories, validated] });
    });
  }

  /**
   * Aligns the persisted catalog with the current manifest: adds new repositories, refreshes the
   * config-derived fields of existing ones (without disturbing their index lifecycle/state), and
   * marks repositories dropped from the manifest as `removed` so they stop being queryable.
   */
  async reconcileManifest(desired: RepositoryCatalogRecord[]): Promise<void> {
    return this.serialize(async () => {
      const catalog = await this.load();
      const existingById = new Map(catalog.repositories.map((record) => [record.repositoryId, record]));
      const desiredIds = new Set(desired.map((record) => record.repositoryId));
      const now = new Date().toISOString();
      const next: RepositoryCatalogRecord[] = [];

      for (const want of desired) {
        const existing = existingById.get(want.repositoryId);
        if (!existing) {
          next.push(RepositoryCatalogRecordSchema.parse(want));
          continue;
        }
        // A repository resurrected from `removed` restarts its lifecycle; otherwise keep index state.
        const resurrected = existing.lifecycle === "removed" && want.enabled;
        next.push(
          RepositoryCatalogRecordSchema.parse({
            ...existing,
            displayName: want.displayName,
            remoteUrl: want.remoteUrl,
            remoteIdentity: want.remoteIdentity,
            checkoutPath: want.checkoutPath,
            enabled: want.enabled,
            allowedPrincipals: want.allowedPrincipals,
            structuralOnly: want.structuralOnly,
            autoIndex: want.autoIndex,
            queryable: want.enabled ? (resurrected ? false : existing.queryable) : false,
            lifecycle: resurrected ? "registered" : existing.lifecycle,
            updatedAt: now,
          }),
        );
      }

      for (const existing of catalog.repositories) {
        if (desiredIds.has(existing.repositoryId)) continue;
        if (existing.lifecycle === "removed") {
          next.push(existing);
          continue;
        }
        next.push(
          RepositoryCatalogRecordSchema.parse({
            ...existing,
            enabled: false,
            queryable: false,
            lifecycle: "removed",
            updatedAt: now,
          }),
        );
      }

      await this.save({ ...catalog, repositories: next });
    });
  }

  async transition(
    repositoryId: string,
    lifecycle: RepositoryLifecycle,
    patch: Partial<RepositoryCatalogRecord> = {},
  ): Promise<void> {
    return this.serialize(async () => {
      const catalog = await this.load();
      const index = catalog.repositories.findIndex((repository) => repository.repositoryId === repositoryId);
      if (index < 0) throw new Error(`repository not found: ${repositoryId}`);

      const current = catalog.repositories[index]!;
      assertLifecycleTransition(current.lifecycle, lifecycle);
      const updated = RepositoryCatalogRecordSchema.parse({
        ...current,
        ...patch,
        lifecycle,
        updatedAt: new Date().toISOString(),
      });
      const repositories = [...catalog.repositories];
      repositories[index] = updated;
      await this.save({ ...catalog, repositories });
    });
  }
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : JSON.stringify(error);
}
