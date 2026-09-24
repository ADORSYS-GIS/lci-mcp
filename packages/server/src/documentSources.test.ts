import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DocumentSourceSchema } from "./config/schema.js";
import { stageDocumentSources } from "./documentSources.js";
import { Logger } from "./logging.js";

function silentLogger(): Logger {
  return new Logger("error");
}

const tempDirs: string[] = [];
async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("document source staging", () => {
  it("copies only supported files from a local directory and synthesizes a repository entry", async () => {
    const docs = await tempDir("lci-docs-src-");
    const staging = await tempDir("lci-docs-stage-");
    await writeFile(path.join(docs, "architecture.md"), "# Arch\n", "utf8");
    await writeFile(path.join(docs, "diagram.puml"), "@startuml\n@enduml\n", "utf8");
    await writeFile(path.join(docs, "logo.png"), Buffer.from([0x89, 0x50]));
    await mkdir(path.join(docs, "adr"), { recursive: true });
    await writeFile(path.join(docs, "adr", "0001.adoc"), "= ADR\n", "utf8");

    const source = DocumentSourceSchema.parse({ id: "arch-docs", displayName: "Arch Docs", path: docs });
    const entries = await stageDocumentSources([source], staging, { logger: silentLogger() });

    expect(entries).toHaveLength(1);
    expect(entries[0]!.entry.repositoryId).toBe("arch-docs");
    const stageDir = entries[0]!.entry.checkoutPath;
    expect(await readdir(stageDir)).toEqual(expect.arrayContaining(["architecture.md", "diagram.puml", "adr"]));
    expect(await readdir(stageDir)).not.toContain("logo.png");
    expect(await readdir(path.join(stageDir, "adr"))).toEqual(["0001.adoc"]);
  });

  it("stages a single supported file", async () => {
    const docs = await tempDir("lci-docs-file-");
    const staging = await tempDir("lci-docs-stage-");
    const file = path.join(docs, "spec.md");
    await writeFile(file, "# Spec\n", "utf8");

    const source = DocumentSourceSchema.parse({ id: "spec", displayName: "Spec", path: file });
    const entries = await stageDocumentSources([source], staging, { logger: silentLogger() });

    expect(entries).toHaveLength(1);
    expect(await readdir(entries[0]!.entry.checkoutPath)).toEqual(["spec.md"]);
  });

  it("fetches a URL source, names it by content type, and synthesizes an entry", async () => {
    const staging = await tempDir("lci-docs-stage-");
    const fetchMock = async () =>
      new Response("# Remote\n", { status: 200, headers: { "content-type": "text/markdown" } });

    const source = DocumentSourceSchema.parse({
      id: "remote",
      displayName: "Remote",
      url: "https://example.test/handbook",
    });
    const entries = await stageDocumentSources([source], staging, {
      logger: silentLogger(),
      fetch: fetchMock as typeof fetch,
    });

    expect(entries).toHaveLength(1);
    expect(await readdir(entries[0]!.entry.checkoutPath)).toEqual(["handbook.md"]);
    expect(entries[0]!.links).toEqual({ "handbook.md": "https://example.test/handbook" });
  });

  it("skips disabled sources and sources with no indexable files", async () => {
    const empty = await tempDir("lci-docs-empty-");
    const staging = await tempDir("lci-docs-stage-");
    await writeFile(path.join(empty, "image.png"), Buffer.from([0x89]));

    const disabled = DocumentSourceSchema.parse({ id: "off", displayName: "Off", path: empty, enabled: false });
    const noDocs = DocumentSourceSchema.parse({ id: "empty", displayName: "Empty", path: empty });
    const entries = await stageDocumentSources([disabled, noDocs], staging, { logger: silentLogger() });

    expect(entries).toEqual([]);
  });

  it("stages multiple URLs into a single source folder", async () => {
    const staging = await tempDir("lci-docs-stage-");
    const fetchMock = async (input: RequestInfo | URL) => {
      const name = new URL(String(input)).pathname.split("/").pop();
      return new Response(`pdf:${name}`, { status: 200, headers: { "content-type": "application/pdf" } });
    };
    const source = DocumentSourceSchema.parse({
      id: "spec",
      displayName: "Spec",
      urls: ["https://example.test/a.pdf", "https://example.test/b.pdf"],
    });
    const entries = await stageDocumentSources([source], staging, {
      logger: silentLogger(),
      fetch: fetchMock as typeof fetch,
    });

    expect(entries).toHaveLength(1);
    expect((await readdir(entries[0]!.entry.checkoutPath)).sort()).toEqual(["a.pdf", "b.pdf"]);
    expect(entries[0]!.links).toEqual({ "a.pdf": "https://example.test/a.pdf", "b.pdf": "https://example.test/b.pdf" });
  });

  it("includes YAML API specs and skips code/binaries and build dirs from a mixed folder", async () => {
    const docs = await tempDir("lci-docs-mixed-");
    const staging = await tempDir("lci-docs-stage-");
    await writeFile(path.join(docs, "openapi.yaml"), "openapi: 3.0.0\n", "utf8");
    await writeFile(path.join(docs, "Service.java"), "class Service {}\n", "utf8");
    await mkdir(path.join(docs, "target"), { recursive: true });
    await writeFile(path.join(docs, "target", "Service.class"), Buffer.from([0xca, 0xfe]));

    const source = DocumentSourceSchema.parse({ id: "api", displayName: "API", path: docs });
    const entries = await stageDocumentSources([source], staging, { logger: silentLogger() });

    expect(await readdir(entries[0]!.entry.checkoutPath)).toEqual(["openapi.yaml"]);
  });

  it("caches fetched URLs so a restart does not re-download", async () => {
    const staging = await tempDir("lci-docs-stage-");
    let fetches = 0;
    const fetchMock = async () => {
      fetches += 1;
      return new Response("pdf", { status: 200, headers: { "content-type": "application/pdf" } });
    };
    const source = DocumentSourceSchema.parse({
      id: "spec",
      displayName: "Spec",
      urls: ["https://example.test/doc.pdf"],
    });

    await stageDocumentSources([source], staging, { logger: silentLogger(), fetch: fetchMock as typeof fetch });
    await stageDocumentSources([source], staging, { logger: silentLogger(), fetch: fetchMock as typeof fetch });

    expect(fetches).toBe(1);
  });

  it("requires at least one input and accepts combined inputs", () => {
    expect(() => DocumentSourceSchema.parse({ id: "x", displayName: "X" })).toThrow();
    expect(() =>
      DocumentSourceSchema.parse({ id: "x", displayName: "X", path: "/a", urls: ["https://e.test/a.pdf"] }),
    ).not.toThrow();
  });
});
