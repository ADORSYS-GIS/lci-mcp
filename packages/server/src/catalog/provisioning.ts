import { spawn } from "node:child_process";
import { access, mkdir, realpath } from "node:fs/promises";
import path from "node:path";

import { isValidRemoteUrl, REMOTE_URL_MESSAGE, remoteUrlHost } from "./remoteUrl.js";
import type { RepositoryCatalogRecord } from "./schema.js";
import type { RepositoryCatalogStore } from "./store.js";

export interface RepositoryRegistration {
  repositoryId: string;
  displayName: string;
  remoteUrl: string;
  allowedPrincipals?: string[];
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
  // Resolve `git` from PATH by default (respects nvm/Homebrew/Windows installs); allow an explicit
  // absolute override for locked-down environments via the LCI_GIT_PATH env var or the constructor.
  private readonly gitCommand: string;

  constructor(gitCommand?: string) {
    this.gitCommand = gitCommand ?? process.env.LCI_GIT_PATH ?? "git";
  }

  async ensureCheckout(remoteUrl: string, checkoutPath: string): Promise<void> {
    try {
      await access(path.join(checkoutPath, ".git"));
      await this.runGit(["-C", checkoutPath, "fetch", "--prune", "origin"]);
      await this.runGit(["-C", checkoutPath, "reset", "--hard", "origin/HEAD"]);
    } catch (error) {
      if (!isMissingPath(error)) throw error;
      await mkdir(path.dirname(checkoutPath), { recursive: true });
      await this.runGit(["clone", "--", remoteUrl, checkoutPath]);
    }
  }

  private runGit(args: string[]): Promise<void> {
    return runGit(this.gitCommand, args);
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
  if (!isValidRemoteUrl(remoteUrl)) throw new Error(REMOTE_URL_MESSAGE);
  const host = remoteUrlHost(remoteUrl);
  if (host === undefined) throw new Error(REMOTE_URL_MESSAGE);
  if (!allowedHosts.has(host)) {
    throw new Error(`Git host is not allowed: ${host}`);
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

const GIT_COMMAND_TIMEOUT_MS = 120_000;

function runGit(gitCommand: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    // Kill (not just signal) after the timeout so a hung clone/fetch cannot wedge startup forever.
    const child = spawn(gitCommand, args, {
      stdio: ["ignore", "ignore", "pipe"],
      timeout: GIT_COMMAND_TIMEOUT_MS,
      killSignal: "SIGKILL",
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(0, 4_096);
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code === 0) resolve();
      else if (signal === "SIGKILL") reject(new Error(`git command timed out after ${GIT_COMMAND_TIMEOUT_MS}ms`));
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
