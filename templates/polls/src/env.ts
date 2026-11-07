// Read KEY=value from the process environment, else from the nearest .env above this folder (the repo root's, written by `npm run up`).
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Parse the text of a .env file (KEY=value lines; # comments and blanks ignored). */
export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2];
  }
  return out;
}

export function loadEnv(from: string = process.cwd()): Record<string, string | undefined> {
  for (let dir = from; ; dir = dirname(dir)) {
    const f = join(dir, ".env");
    if (existsSync(f)) return { ...parseEnv(readFileSync(f, "utf8")), ...process.env };
    if (dirname(dir) === dir) return { ...process.env };
  }
}
