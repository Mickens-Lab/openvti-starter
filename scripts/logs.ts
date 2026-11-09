// Follow the VTA's or the VTC's log: `npm run vta:logs`, `npm run vtc:logs`.
// RUNTIME=docker (default): `docker compose logs -f`. RUNTIME=binary: tail .vta/run/<name>.log (docs/BINARIES.md).
import "./lib/cli.js";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { die, runtime } from "./env.js";
import { logFile } from "./lib/binary-run.js";

const which = process.argv[2] === "vtc" ? "vtc" : "vta";
if (runtime() === "binary") {
  const f = logFile(which);
  if (!existsSync(f)) die(`${f} does not exist: the ${which} has not been started with RUNTIME=binary (npm run ${which === "vta" ? "up" : "vtc:up"}).`);
  spawnSync("tail", ["-n", "100", "-F", f], { stdio: "inherit" });
} else {
  spawnSync("docker", ["compose", ...(which === "vtc" ? ["--profile", "vtc"] : []), "logs", "-f", which], { stdio: "inherit" });
}
