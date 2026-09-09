import { homedir, tmpdir } from "node:os";
import path from "node:path";

import { repositoryIdentity } from "../engine.js";

// repoKey is computed once, natively, and never reimplemented here — this module only assembles
// the rest of the template context around it.

export interface TemplateContext {
  repoRoot: string;
  repoName: string;
  repoKey: string;
  headSha: string;
  shortHeadSha: string;
  homeDir: string;
  tmpDir: string;
  dataDir: string;
}

/** The OS-conventional per-user application data directory: `XDG_DATA_HOME` (or its `~/.local/share`
 * default) on Linux, `~/Library/Application Support` on macOS, `%LOCALAPPDATA%` on Windows. */
export function platformDataDir(): string {
  if (process.platform === "win32") {
    return process.env.LOCALAPPDATA ?? path.join(homedir(), "AppData", "Local");
  }
  if (process.platform === "darwin") {
    return path.join(homedir(), "Library", "Application Support");
  }
  return process.env.XDG_DATA_HOME ?? path.join(homedir(), ".local", "share");
}

export async function buildTemplateContext(repoRoot: string): Promise<TemplateContext> {
  const identity = await repositoryIdentity(repoRoot);
  const parts = identity.canonicalRoot.split(/[\\/]/).filter(Boolean);
  return {
    repoRoot: identity.canonicalRoot,
    repoName: parts[parts.length - 1] ?? identity.canonicalRoot,
    repoKey: identity.repoKey,
    headSha: identity.headSha,
    shortHeadSha: identity.headSha.slice(0, 8),
    homeDir: homedir(),
    tmpDir: tmpdir(),
    dataDir: platformDataDir(),
  };
}

const TEMPLATE_PATTERN = /\{\{(\w+)\}\}/g;

/** Unknown template variables are a hard configuration error, never left unresolved. */
export function expandTemplate(input: string, ctx: TemplateContext): string {
  return input.replace(TEMPLATE_PATTERN, (_match, name: string) => {
    const value = (ctx as unknown as Record<string, string>)[name];
    if (value === undefined) {
      throw new Error(`lci-mcp: unknown template variable "{{${name}}}" in "${input}"`);
    }
    return value;
  });
}
