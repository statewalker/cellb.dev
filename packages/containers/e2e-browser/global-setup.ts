// Builds the examples for browsers (cellb build), served at /built/<name>/.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export default function setup() {
  const pkg = fileURLToPath(new URL("..", import.meta.url));
  const cli = fileURLToPath(new URL("../../cellb/bin/cellb.mjs", import.meta.url));
  for (const name of ["python", "php", "node", "pool"])
    execFileSync(
      process.execPath,
      [cli, "build", `examples/${name}`, "--out", `e2e-public/built/${name}`],
      {
        cwd: pkg,
        stdio: "inherit",
      },
    );
}
