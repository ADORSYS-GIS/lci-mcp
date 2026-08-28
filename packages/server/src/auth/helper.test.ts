import { describe, expect, it } from "vitest";

import { runAuthHelper } from "./helper.js";

const node = process.execPath;

function helper(script: string, timeoutMs = 5000) {
  return { command: node, args: ["-e", script], timeoutMs };
}

describe("runAuthHelper", () => {
  it("accepts the minimal bare-header-map shape", async () => {
    const result = await runAuthHelper(helper('console.log(JSON.stringify({Authorization: "Bearer abc"}))'));
    expect(result.headers).toEqual({ Authorization: "Bearer abc" });
    expect(result.expiresAt).toBeUndefined();
  });

  it("accepts the extended {headers, expiresAt} shape and parses an absolute expiry", async () => {
    const result = await runAuthHelper(
      helper('console.log(JSON.stringify({headers:{Authorization:"Bearer abc"}, expiresAt:"2030-01-01T00:00:00Z"}))'),
    );
    expect(result.headers).toEqual({ Authorization: "Bearer abc" });
    expect(result.expiresAt).toBe(Date.parse("2030-01-01T00:00:00Z"));
  });

  it("rejects malformed JSON as an authentication failure", async () => {
    await expect(runAuthHelper(helper('console.log("not json")'))).rejects.toThrow(/not valid JSON/);
  });

  it("rejects a non-zero exit code", async () => {
    await expect(runAuthHelper(helper("process.exit(1)"))).rejects.toThrow(/exited with code 1/);
  });

  it("rejects header values that are not strings", async () => {
    await expect(runAuthHelper(helper("console.log(JSON.stringify({Authorization: 123}))"))).rejects.toThrow(
      /did not match the expected/,
    );
  });

  it("kills a helper that exceeds its timeout", async () => {
    await expect(runAuthHelper(helper("setTimeout(() => {}, 60000)", 200))).rejects.toThrow(/timed out/);
  });

  it("rejects stdout that exceeds the bounded size", async () => {
    await expect(runAuthHelper(helper('process.stdout.write("x".repeat(200000))'))).rejects.toThrow(/exceeded/);
  });

  it("never surfaces stderr as credentials, only as diagnostic text on failure", async () => {
    await expect(runAuthHelper(helper('console.error("diagnostic line"); process.exit(1)'))).rejects.toThrow(
      /diagnostic line/,
    );
  });
});
