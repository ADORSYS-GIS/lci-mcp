import { createHash } from "node:crypto";
import { cp, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { type DocumentSource, type RepositoryManifestEntry, RepositoryManifestEntrySchema } from "./config/schema.js";
import type { Logger } from "./logging.js";

// Synthetic remote host for staged document sources. Also the marker used to classify a repository
// as a background document source (vs a real code repository) when building summaries.
export const DOCUMENT_SOURCE_REMOTE_HOST = "documents.local";

// Formats the indexing engine already turns into searchable text: plain-text docs (incl. AsciiDoc,
// PlantUML, Markdown, OpenAPI YAML/JSON) are windowed and PDFs are extracted. Other files in a local
// source are skipped so a docs folder that also holds code/binaries is filtered down to just docs.
// (.docx needs a converter — tracked as a follow-up.)
const SUPPORTED_EXTENSIONS = new Set([
  ".md",
  ".markdown",
  ".adoc",
  ".asciidoc",
  ".puml",
  ".txt",
  ".pdf",
  ".yaml",
  ".yml",
  ".json",
]);
// Never descended into when copying a local tree — build output and VCS metadata hold no docs and
// can be enormous.
const IGNORED_DIRS = new Set(["node_modules", "target", "build", "dist", "out", ".git"]);
const MAX_FETCH_BYTES = 25_000_000;
// A single unreachable/slow URL must never wedge startup (the MCP server only reports ready once
// staging returns), so every fetch is bounded and failures are isolated.
const FETCH_TIMEOUT_MS = 20_000;

const CONTENT_TYPE_EXTENSIONS: Record<string, string> = {
  "application/pdf": ".pdf",
  "text/markdown": ".md",
  "text/x-asciidoc": ".adoc",
  "text/plain": ".txt",
  "application/yaml": ".yaml",
  "text/yaml": ".yaml",
  "application/json": ".json",
};

export interface StageDeps {
  logger: Logger;
  fetch?: typeof globalThis.fetch;
}

// A staged source plus the map of staged filename → original URL for its remote inputs, so citations
// can link a document chunk back to the source it was fetched from.
export interface StagedSource {
  entry: RepositoryManifestEntry;
  links: Record<string, string>;
}

// Stages each enabled document source into its own folder under `stagingRoot` and returns synthesized
// repository entries pointing at those folders, so the existing indexing pipeline treats documents
// exactly like a repository checkout. A source that fails to stage is logged and skipped rather than
// aborting startup.
export async function stageDocumentSources(
  sources: DocumentSource[],
  stagingRoot: string,
  deps: StageDeps,
): Promise<StagedSource[]> {
  const cacheDir = path.join(stagingRoot, "document-cache");
  const staged: StagedSource[] = [];
  for (const source of sources) {
    if (!source.enabled) continue;
    const stageDir = path.join(stagingRoot, "document-sources", source.id);
    try {
      const { count, links } = await stageSource(source, stageDir, cacheDir, deps);
      if (count === 0) {
        deps.logger.warn("document source produced no indexable files", { id: source.id });
        continue;
      }
      staged.push({ entry: synthesizeRepositoryEntry(source, stageDir), links });
      deps.logger.info("document source staged", { id: source.id, files: count });
    } catch (error) {
      deps.logger.warn("document source staging failed", { id: source.id, error: String(error) });
    }
  }
  return staged;
}

async function stageSource(
  source: DocumentSource,
  stageDir: string,
  cacheDir: string,
  deps: StageDeps,
): Promise<{ count: number; links: Record<string, string> }> {
  await rm(stageDir, { recursive: true, force: true });
  await mkdir(stageDir, { recursive: true });
  const links: Record<string, string> = {};
  let count = 0;
  // Local files are re-copied every run so edits are picked up; remote files are cached (see
  // stageUrlCached) so restarts don't re-download. Each input is isolated: one missing path or
  // unreachable URL never drops the rest of the set.
  for (const localPath of localInputs(source)) {
    try {
      count += await stageLocalPath(localPath, stageDir);
    } catch (error) {
      deps.logger.warn("document path staging failed", { id: source.id, path: localPath, error: String(error) });
    }
  }
  const fetched = await Promise.all(
    remoteInputs(source).map(async (url) => {
      try {
        const fileName = await stageUrlCached(url, stageDir, cacheDir, deps);
        links[fileName] = url;
        return 1;
      } catch (error) {
        deps.logger.warn("document fetch failed", { id: source.id, url, error: String(error) });
        return 0;
      }
    }),
  );
  return { count: count + fetched.reduce<number>((sum, staged) => sum + staged, 0), links };
}

function localInputs(source: DocumentSource): string[] {
  return [...(source.path ? [source.path] : []), ...(source.paths ?? [])];
}

function remoteInputs(source: DocumentSource): string[] {
  return [...(source.url ? [source.url] : []), ...(source.urls ?? [])];
}

async function stageLocalPath(sourcePath: string, stageDir: string): Promise<number> {
  const resolved = path.resolve(sourcePath);
  const info = await stat(resolved);
  if (info.isFile()) {
    if (!isSupported(resolved)) return 0;
    await cp(resolved, path.join(stageDir, path.basename(resolved)));
    return 1;
  }
  return copySupportedTree(resolved, stageDir);
}

async function copySupportedTree(dir: string, stageDir: string): Promise<number> {
  let copied = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || IGNORED_DIRS.has(entry.name)) continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      copied += await copySupportedTree(abs, path.join(stageDir, entry.name));
    } else if (entry.isFile() && isSupported(abs)) {
      await mkdir(stageDir, { recursive: true });
      await cp(abs, path.join(stageDir, entry.name));
      copied += 1;
    }
  }
  return copied;
}

// Fetches a URL once and reuses it on later runs: a cache entry keyed by the URL means a restart
// never re-downloads, and a warm cache keeps startup fast even when a source has many documents.
// Returns the staged filename so the caller can map it back to the source URL.
async function stageUrlCached(url: string, stageDir: string, cacheDir: string, deps: StageDeps): Promise<string> {
  const cacheKey = createHash("sha256").update(url).digest("hex").slice(0, 32);
  const knownName = supportedBasenameFromUrl(url);
  if (knownName) {
    const cachePath = path.join(cacheDir, `${cacheKey}-${knownName}`);
    if (await fileExists(cachePath)) {
      await cp(cachePath, path.join(stageDir, knownName));
      return knownName;
    }
  }
  const { fileName, buffer } = await fetchDocument(url, deps);
  await mkdir(cacheDir, { recursive: true });
  await writeFile(path.join(cacheDir, `${cacheKey}-${fileName}`), buffer);
  await cp(path.join(cacheDir, `${cacheKey}-${fileName}`), path.join(stageDir, fileName));
  return fileName;
}

async function fetchDocument(url: string, deps: StageDeps): Promise<{ fileName: string; buffer: Buffer }> {
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`fetch failed: HTTP ${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > MAX_FETCH_BYTES) throw new Error("document exceeds maximum fetch size");
    const fileName = fileNameForUrl(url, response.headers.get("content-type"));
    if (!isSupported(fileName)) throw new Error(`unsupported document type for ${url}`);
    return { fileName, buffer };
  } finally {
    clearTimeout(timeout);
  }
}

function supportedBasenameFromUrl(url: string): string | undefined {
  const base = path.basename(new URL(url).pathname);
  return base && isSupported(base) ? base : undefined;
}

function fileNameForUrl(url: string, contentType: string | null): string {
  const base = path.basename(new URL(url).pathname);
  if (base && isSupported(base)) return base;
  const extension = CONTENT_TYPE_EXTENSIONS[(contentType ?? "").split(";")[0]!.trim().toLowerCase()];
  return extension ? `${base || "document"}${extension}` : base || "document";
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

function isSupported(filePath: string): boolean {
  return SUPPORTED_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

// A staged source is indexed exactly like a repository checkout: parsed through the schema so the
// synthetic remoteUrl/checkoutPath are validated and defaults are applied.
function synthesizeRepositoryEntry(source: DocumentSource, stageDir: string): RepositoryManifestEntry {
  return RepositoryManifestEntrySchema.parse({
    repositoryId: source.id,
    displayName: source.displayName,
    remoteUrl: `https://${DOCUMENT_SOURCE_REMOTE_HOST}/${source.id}`,
    checkoutPath: path.resolve(stageDir),
    autoIndex: source.autoIndex,
  });
}
