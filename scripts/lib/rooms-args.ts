// Tiny argument helpers for scripts/rooms.ts: `--flag`, `--name value`, and the non-option words.
const VALUE_OPTIONS = new Set(["name", "id", "type"]);

export const flag = (args: string[], name: string): boolean => args.includes(`--${name}`);

export const option = (args: string[], name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

/** The words that are not `--flags` or the value after a value option. */
export function positionals(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith("--")) { if (VALUE_OPTIONS.has(a.slice(2))) i++; continue; }
    out.push(a);
  }
  return out;
}
