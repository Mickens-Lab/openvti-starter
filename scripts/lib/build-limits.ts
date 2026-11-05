// Resource limits for the local image builds (images:build / setup).
//
// `nice docker build` only lowers the priority of the docker *client*; the Rust compile runs inside the Docker
// daemon (or BuildKit), which that nice does not reach, and plain `docker build` has no memory cap. So the builds
// run on a dedicated buildx builder (docker-container driver) whose container carries cgroup limits:
//   memory      hard cap (memory-swap = same, so it cannot spill into swap and thrash the machine)
//   cpu-quota   at most N CPUs
//   cpu-shares  low weight, the cgroup equivalent of `nice`: other work wins whenever the CPU is contended
// Set them (first match wins): flags `--memory 8g --cpus 4 --no-limits`, env BUILD_MEMORY / BUILD_CPUS / BUILD_LIMITS=0,
// or lines in .env. Defaults: 6g, a quarter of the cores (min 1). --no-limits builds on the default builder (the old behaviour).
import { spawnSync } from "node:child_process";

export interface BuildLimits { memory: string; cpus: number }

/** Pure: pull `--memory 8g` / `--memory=8g`, `--cpus 4`, `--no-limits` out of argv. Precedence elsewhere: flag > environment > .env > default. */
export function parseLimitFlags(argv: string[]): { rest: string[]; env: Record<string, string>; error?: string } {
  const rest: string[] = [];
  const env: Record<string, string> = {};
  let error: string | undefined;
  const keys: Record<string, string> = { "--memory": "BUILD_MEMORY", "--cpus": "BUILD_CPUS" };
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].split(/=(.*)/s);
    if (flag === "--no-limits") env.BUILD_LIMITS = "0";
    else if (keys[flag]) {
      const v = inline ?? argv[++i];
      if (!v || v.startsWith("--")) error = `${flag} needs a value (for example ${flag === "--memory" ? "--memory 8g" : "--cpus 4"}).`;
      else env[keys[flag]] = v;
    } else rest.push(argv[i]);
  }
  return { rest, env, error };
}

export const DEFAULT_MEMORY = "6g";
const MEMORY_RE = /^\d+(\.\d+)?[kmg]?b?$/i;

/** Pure: limits from the environment, or undefined when BUILD_LIMITS=0. Throws on a malformed value. */
export function limitsFromEnv(env: Record<string, string | undefined>, cores: number): BuildLimits | undefined {
  if (env.BUILD_LIMITS === "0") return undefined;
  const memory = (env.BUILD_MEMORY ?? DEFAULT_MEMORY).trim().toLowerCase();
  if (!MEMORY_RE.test(memory)) throw new Error(`BUILD_MEMORY=${env.BUILD_MEMORY} is not a size (examples: 6g, 4096m).`);
  const asked = env.BUILD_CPUS === undefined ? Math.max(1, Math.floor(cores / 4)) : Number(env.BUILD_CPUS);
  if (!Number.isFinite(asked) || asked <= 0) throw new Error(`BUILD_CPUS=${env.BUILD_CPUS} must be a positive number.`);
  return { memory, cpus: Math.min(asked, cores) };
}

/** Pure: the builder is named after its limits, so changing them creates a fresh builder rather than reusing a stale one. */
export function builderName(l: BuildLimits): string {
  return `buildathon2-m${l.memory.replace(/b$/, "")}-c${String(l.cpus).replace(".", "_")}`;
}

/** Pure: `docker buildx create` arguments. */
export function builderCreateArgs(l: BuildLimits): string[] {
  const opts = [`memory=${l.memory}`, `memory-swap=${l.memory}`, `cpu-period=100000`, `cpu-quota=${Math.round(l.cpus * 100000)}`, "cpu-shares=64",
    // Pin to the first N cores: cargo sizes its parallel jobs from the cores it can see, and a quota alone leaves it
    // seeing them all (12 rustc in a 6 GB cap ran out of memory), so the cap must also shrink what it sees.
    `cpuset-cpus=0-${Math.max(1, Math.floor(l.cpus)) - 1}`];
  return ["buildx", "create", "--name", builderName(l), "--driver", "docker-container", ...opts.flatMap((o) => ["--driver-opt", o])];
}

/** Pure: turn `docker build <args>` into the limited form: `nice docker buildx build --builder X --load <args>`. */
export function limitedBuildArgv(l: BuildLimits | undefined, args: string[]): string[] {
  if (!l) return ["nice", "-n", "10", "docker", "build", ...args];
  return ["nice", "-n", "10", "docker", "buildx", "build", "--builder", builderName(l), "--load", ...args];
}

/** Create the limited builder if it is not there yet. Returns an error message, or undefined when ready. */
export function ensureBuilder(l: BuildLimits): string | undefined {
  const name = builderName(l);
  if (spawnSync("docker", ["buildx", "inspect", name], { stdio: "ignore" }).status === 0) return undefined;
  const r = spawnSync("docker", builderCreateArgs(l), { encoding: "utf8" });
  if (r.status !== 0) return `could not create the resource-limited buildx builder ${name}: ${(r.stderr || r.stdout || "").trim()}\n(needs docker buildx; --no-limits builds unlimited on the default builder.)`;
  return undefined;
}

export function limitsNote(l: BuildLimits | undefined): string {
  return l ? `build limits: ${l.memory} memory (no swap), ${l.cpus} CPU(s), low CPU priority (change with --memory 8g --cpus 4 --no-limits, or BUILD_MEMORY / BUILD_CPUS in .env).`
           : "build limits: OFF (--no-limits), only the docker client is niced.";
}
