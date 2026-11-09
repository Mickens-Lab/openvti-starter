// Helpers for `vta:call` and `repl`: task names, search, and the offline payload schema.
import { TT } from "@starter/vta-client";

/** `vta/memory/put/0.1` or a full URI -> the full Trust Task type URI. */
export const taskType = (slug: string): string => (slug.startsWith("http") ? slug : `${TT}/${slug}`);

/** Strip the common prefix so lists read as slugs. */
export const slugOf = (type: string): string => type.replace(`${TT}/`, "");

/** Tasks whose slug contains every word (case-insensitive). */
export function searchTasks(types: string[], words: string): string[] {
  const parts = words.toLowerCase().split(/\s+/).filter(Boolean);
  return types.filter((t) => parts.every((p) => slugOf(t).toLowerCase().includes(p)));
}

/**
 * The request and response interfaces from a generated `payload.ts` (shipped in @openvtc/trust-tasks), without the file header,
 * the shared-definitions tail and the constants. Returns undefined if the text has no interface.
 */
export function extractPayloadInterfaces(text: string): string | undefined {
  const start = text.search(/^export (interface|type) /m);
  if (start < 0) return undefined;
  const end = text.search(/^\/\*\* Shared definitions/m);
  return text.slice(start, end > start ? end : undefined).trimEnd();
}

export interface CallArgs { slug?: string; json?: string; search?: string; schema?: string; error?: string }

/** `vta:call [slug] [json] [--search words] [--schema slug]` */
export function parseCallArgs(argv: string[]): CallArgs {
  const out: CallArgs = {};
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--search" || a === "--schema") {
      const v = argv[++i];
      if (!v) return { error: `${a} needs a value (${a === "--search" ? "a word, e.g. --search memory" : "a task, e.g. --schema vta/memory/put/0.1"}).` };
      if (a === "--search") out.search = v; else out.schema = v;
    } else rest.push(a);
  }
  [out.slug, out.json] = rest;
  return out;
}
