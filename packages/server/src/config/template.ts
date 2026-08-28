import { homedir, tmpdir } from "node:os";

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
