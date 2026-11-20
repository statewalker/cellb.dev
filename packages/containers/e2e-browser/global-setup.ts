// Builds the Python example for browsers (cellb build), served at /built/python/.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export default function setup() {
  const pkg = fileURLToPath(new URL("..", import.meta.url));
  const cli = fileURLToPath(new URL("../../cellb/bin/cellb.mjs", import.meta.url));
  execFileSync(
    process.execPath,
    [cli, "build", "examples/python", "--out", "e2e-public/built/python"],
    { cwd: pkg, stdio: "inherit" },
  );
}
