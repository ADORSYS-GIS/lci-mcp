import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { type LciConfig, LciConfigSchema } from "./schema.js";

// Precedence chain, lowest to highest priority. Expressed as an ordered list of layers rather than
// an imperative if/else chain, so the merge order itself is a data structure that can be unit
// tested independent of where each layer's raw input came from.

export interface ConfigLayer {
  name: string;
  value: unknown;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Objects deep-merge; arrays replace wholesale. */
export function deepMergeReplacingArrays(base: unknown, patch: unknown): unknown {
  if (patch === undefined) return base;
  if (!isPlainObject(patch) || !isPlainObject(base)) return patch;
  const result: Record<string, unknown> = { ...base };
  for (const key of Object.keys(patch)) {
    result[key] = deepMergeReplacingArrays(base[key], patch[key]);
  }
  return result;
}

export function resolveConfig(layers: ConfigLayer[]): LciConfig {
  // Seeded so every top-level section is present before parsing (see the comment on
  // `LciConfigSchema` in schema.ts for why the schema itself can no longer default these in zod v4).
  let merged: unknown = { embedding: {}, storage: {}, index: {}, logging: {} };
  for (const layer of layers) {
    if (layer.value === undefined) continue;
    merged = deepMergeReplacingArrays(merged, layer.value);
  }
  const parsed = LciConfigSchema.safeParse(merged);
  if (!parsed.success) {
    throw new Error(
      `lci-mcp: invalid configuration (layer chain: ${layers.map((l) => l.name).join(" -> ")}): ${parsed.error.message}`,
    );
  }
  return parsed.data;
}

function readJsonFile(filePath: string): unknown {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch (err) {
    throw new Error(`lci-mcp: failed to read/parse config file "${filePath}": ${(err as Error).message}`);
  }
}

function parseJsonLayer(name: string, raw: string | undefined): ConfigLayer {
  if (raw === undefined || raw === "") return { name, value: undefined };
  try {
    return { name, value: JSON.parse(raw) };
  } catch (err) {
    throw new Error(`lci-mcp: layer "${name}" is not valid JSON: ${(err as Error).message}`);
  }
}

/**
 * A credential carried by a command-line argument is visible to every other process on the
 * machine and lingers in shell history — a config *file* path or an environment variable are the
 * only inputs meant to hold one. Layers built from process arguments are checked against this
 * before they ever reach `resolveConfig`.
 */
export function rejectInlineCredential(layerName: string, value: unknown): void {
  if (!isPlainObject(value)) return;
  const auth = isPlainObject(value.embedding) ? value.embedding.auth : undefined;
  const apiKey = isPlainObject(auth) ? auth.apiKey : undefined;
  if (typeof apiKey === "string" && apiKey.length > 0) {
    throw new Error(
      `lci-mcp: embedding.auth.apiKey must not be set via ${layerName} — command-line arguments are visible to ` +
        "other processes and shell history on this machine. Use --config <file> or the LCI_CONFIG_CONTENT " +
        "environment variable instead.",
    );
  }
}

export interface LoadConfigArgs {
  configFile?: string;
  configJson?: string;
  cliOverrides?: Record<string, unknown>;
  /** Overridable for tests; defaults to `~/.config/lci/config.json`. */
  globalConfigPath?: string;
}

export function loadConfig(args: LoadConfigArgs): LciConfig {
  const globalConfigPath = args.globalConfigPath ?? path.join(homedir(), ".config", "lci", "config.json");
  const globalConfig: ConfigLayer = {
    name: "global",
    value: existsSync(globalConfigPath) ? readJsonFile(globalConfigPath) : undefined,
  };
  const fileConfig: ConfigLayer = {
    name: "file",
    value: args.configFile ? readJsonFile(args.configFile) : undefined,
  };
  const envContent = parseJsonLayer("env-content", process.env.LCI_CONFIG_CONTENT);
  const inlineJson = parseJsonLayer("inline-json", args.configJson);
  rejectInlineCredential("--config-json", inlineJson.value);

  return resolveConfig([
    { name: "defaults", value: {} },
    globalConfig,
    fileConfig,
    envContent,
    inlineJson,
    { name: "cli-flags", value: args.cliOverrides ?? {} },
  ]);
}
