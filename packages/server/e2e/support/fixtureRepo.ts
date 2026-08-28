import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/** A tiny real git checkout with a resolvable cross-file call chain. */
export function createFixtureRepo(): string {
  const root = mkdtempSync(path.join(tmpdir(), "lci-mcp-e2e-"));
  mkdirSync(path.join(root, "src"));
  writeFileSync(
    path.join(root, "src", "math.rs"),
    'fn add(a: i32, b: i32) -> i32 {\n    a + b\n}\n\nfn print_result() {\n    let value = log();\n    println!("{}", value);\n}\n\nfn log() -> i32 {\n    add(1, 2)\n}\n',
  );
  writeFileSync(path.join(root, "src", "main.rs"), "mod math;\n\nfn main() {\n    print_result();\n}\n");

  const run = (args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
  run(["init", "-q"]);
  run(["add", "-A"]);
  run(["-c", "user.email=e2e@test.local", "-c", "user.name=e2e", "commit", "-q", "-m", "init"]);

  return root;
}
