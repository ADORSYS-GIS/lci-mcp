import { spawn } from "node:child_process";
import { access, mkdir, realpath } from "node:fs/promises";
import path from "node:path";

import type { RepositoryCatalogRecord } from "./schema.js";
import type { RepositoryCatalogStore } from "./store.js";

export interface RepositoryRegistration {
  repositoryId: string;
  displayName: string;
  remoteUrl: string;
  allowedPrincipals?: string[];
  embeddingProfile?: string;
  structuralOnly?: boolean;
  autoIndex?: boolean;
}

export interface ProvisioningPolicy {
  checkoutRoot: string;
  allowedHosts: string[];
}

export interface GitCheckoutAdapter {
  ensureCheckout(remoteUrl: string, checkoutPath: string): Promise<void>;
}

export class GitCliCheckoutAdapter implements GitCheckoutAdapter {
  async ensureCheckout(remoteUrl: string, checkoutPath: string): Promise<void> {
    try {
      await access(path.join(checkoutPath, ".git"));
      await runGit(["-C", checkoutPath, "fetch", "--prune", "origin"]);
      await runGit(["-C", checkoutPath, "reset", "--hard", "origin/HEAD"]);
    } catch (error) {
      if (!isMissingPath(error)) throw error;
      await mkdir(path.dirname(checkoutPath), { recursive: true });
      await runGit(["clone", "--", remoteUrl, checkoutPath]);
    }
  }
}

export class RepositoryProvisioner {
  private readonly checkoutRoot: string;
  private readonly allowedHosts: Set<string>;

  constructor(
    private readonly catalog: RepositoryCatalogStore,
    policy: ProvisioningPolicy,
    private readonly git: GitCheckoutAdapter,
  ) {
    if (!path.isAbsolute(policy.checkoutRoot)) throw new Error("checkoutRoot must be absolute");
    this.checkoutRoot = path.resolve(policy.checkoutRoot);
    this.allowedHosts = new Set(policy.allowedHosts.map((host) => host.toLowerCase()));
    if (this.allowedHosts.size === 0) throw new Error("at least one allowed Git host is required");
  }

  async register(input: RepositoryRegistration): Promise<RepositoryCatalogRecord> {
    const remoteUrl = validateRemoteUrl(input.remoteUrl, this.allowedHosts);
    const checkoutPath = this.checkoutPathFor(input.repositoryId);
    const now = new Date().toISOString();
    const record: RepositoryCatalogRecord = {
      repositoryId: input.repositoryId,
      displayName: input.displayName,
      remoteUrl,
      checkoutPath,
      enabled: true,
      queryable: false,
      allowedPrincipals: input.allowedPrincipals ?? [],
      embeddingProfile: input.embeddingProfile ?? "default",
      structuralOnly: input.structuralOnly ?? false,
      autoIndex: input.autoIndex ?? false,
      lifecycle: "registered",
      createdAt: now,
      updatedAt: now,
    };
    await this.catalog.add(record);
    return record;
  }

  async provision(repositoryId: string): Promise<RepositoryCatalogRecord> {
    const record = await this.requireRecord(repositoryId);
    validateRemoteUrl(record.remoteUrl, this.allowedHosts);
    await this.catalog.transition(repositoryId, "provisioning");
    try {
      await ensureCheckoutPathIsSafe(record.checkoutPath, this.checkoutRoot);
      await this.git.ensureCheckout(record.remoteUrl, record.checkoutPath);
      await this.catalog.transition(repositoryId, "registered");
    } catch (error) {
      await this.catalog.transition(repositoryId, "failed", { lastError: errorMessage(error) });
      throw error;
    }
    return (await this.catalog.get(repositoryId))!;
  }

  async disable(repositoryId: string): Promise<void> {
    await this.requireRecord(repositoryId);
    await this.catalog.transition(repositoryId, "disabled", { enabled: false, queryable: false });
  }

  async remove(repositoryId: string): Promise<void> {
    await this.requireRecord(repositoryId);
    await this.catalog.transition(repositoryId, "removed", { enabled: false, queryable: false });
  }

  private checkoutPathFor(repositoryId: string): string {
    if (!/^[a-z0-9](?:[a-z0-9._-]{0,62})$/.test(repositoryId) || repositoryId.includes("..")) {
      throw new Error("repositoryId must be a stable opaque identifier");
    }
    return path.join(this.checkoutRoot, repositoryId);
  }

  private async requireRecord(repositoryId: string): Promise<RepositoryCatalogRecord> {
    const record = await this.catalog.get(repositoryId);
    if (!record) throw new Error(`repository not found: ${repositoryId}`);
    return record;
  }
}

function validateRemoteUrl(remoteUrl: string, allowedHosts: Set<string>): string {
  const parsed = new URL(remoteUrl);
  if (!["http:", "https:", "ssh:"].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error("remoteUrl must use http, https, or ssh without embedded credentials");
  }
  if (!allowedHosts.has(parsed.hostname.toLowerCase())) {
    throw new Error(`Git host is not allowed: ${parsed.hostname}`);
  }
  return remoteUrl;
}

async function ensureCheckoutPathIsSafe(checkoutPath: string, checkoutRoot: string): Promise<void> {
  const relative = path.relative(checkoutRoot, checkoutPath);
  if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("checkout path escaped the approved checkout root");
  }
  try {
    const existing = await realpath(checkoutPath);
    const resolvedRoot = await realpath(checkoutRoot).catch(() => checkoutRoot);
    const existingRelative = path.relative(resolvedRoot, existing);
    if (existingRelative.startsWith(`..${path.sep}`) || path.isAbsolute(existingRelative)) {
      throw new Error("existing checkout path escaped the approved checkout root");
    }
  } catch (error) {
    if (!isMissingPath(error)) throw error;
  }
}

function runGit(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const gitCommand = process.platform === "win32" ? "git.exe" : "/usr/bin/git";
    const child = spawn(gitCommand, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(0, 4_096);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else {
        const details = stderr ? `: ${stderr}` : "";
        reject(new Error(`git command failed with code ${code}${details}`));
      }
    });
  });
}

function isMissingPath(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : JSON.stringify(error);
}
