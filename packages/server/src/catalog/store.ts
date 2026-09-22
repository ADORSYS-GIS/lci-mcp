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
  constructor(private readonly filePath: string) {
    if (!path.isAbsolute(filePath)) throw new Error("catalog path must be absolute");
  }

  async load(): Promise<CatalogDocument> {
    try {
      const raw = JSON.parse(await readFile(this.filePath, "utf8")) as unknown;
      return migrateCatalogDocument(raw);
    } catch (error) {
      if (isMissingFile(error)) return EMPTY_CATALOG;
      throw new Error(`failed to read catalog "${this.filePath}": ${errorMessage(error)}`);
    }
  }

  async save(document: CatalogDocument): Promise<void> {
    const validated = parseCatalogDocument(document);

    await mkdir(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(validated, null, 2)}\n`, { mode: 0o600 });
    await rename(temporaryPath, this.filePath);
  }

  async get(repositoryId: string): Promise<RepositoryCatalogRecord | undefined> {
    const catalog = await this.load();
    return catalog.repositories.find((repository) => repository.repositoryId === repositoryId);
  }

  async add(repository: RepositoryCatalogRecord): Promise<void> {
    const validated = RepositoryCatalogRecordSchema.parse(repository);
    const catalog = await this.load();
    if (catalog.repositories.some((item) => item.repositoryId === validated.repositoryId)) {
      throw new Error(`repository ID already exists: ${validated.repositoryId}`);
    }
    await this.save({ ...catalog, repositories: [...catalog.repositories, validated] });
  }

  async transition(
    repositoryId: string,
    lifecycle: RepositoryLifecycle,
    patch: Partial<RepositoryCatalogRecord> = {},
  ): Promise<void> {
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
  }
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : JSON.stringify(error);
}
