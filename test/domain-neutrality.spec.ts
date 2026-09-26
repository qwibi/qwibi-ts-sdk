import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sourceRoot = path.join(root, "src");

const forbiddenWords = new Set([
  "station", "stations", "line", "lines", "transfer", "transfers", "fare", "fares",
  "stop", "stops", "metro", "mtr", "subway", "transit", "route", "routes", "article", "articles",
]);

// Generated bindings mirror the canonical protocol and are never edited here. The
// remaining entries are the generic Result vocabulary or LineString/stream control APIs.
const excludedPathPrefixes = ["src/gen/"] as const;
const excludedWordsByPath: Readonly<Record<string, readonly string[]>> = {
  "src/declarativeResult.ts": ["line", "lines"],
  "src/geometry.ts": ["line", "lines"],
  "src/l1.ts": ["line", "lines", "route", "routes"],
  "src/livelayer.ts": ["stop", "stops"],
};

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const full = path.join(directory, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return entry.endsWith(".ts") ? [full] : [];
  });
}

function codeWords(source: string): string[] {
  const withoutComments = source
    .replace(/\/\*[\s\S]*?\*\//gu, " ")
    .replace(/(^|[^:])\/\/.*$/gmu, "$1");
  return (withoutComments.match(/[A-Za-z][A-Za-z0-9_-]*/gu) ?? [])
    .flatMap(token => token.replace(/([a-z0-9])([A-Z])/gu, "$1 $2").split(/[-_\s]+/u))
    .map(word => word.toLowerCase());
}

describe("generic TypeScript SDK vocabulary", () => {
  it("recognizes guarded words in identifiers and defaults", () => {
    const words = codeWords('const stationLabel = "Metro stops"; const routeArticle = true;');
    expect(words.filter(word => forbiddenWords.has(word))).toEqual([
      "station", "metro", "stops", "route", "article",
    ]);
  });

  it("keeps authored SDK identifiers and defaults free of App-domain nouns", () => {
    const findings: string[] = [];
    for (const file of sourceFiles(sourceRoot)) {
      const relative = path.relative(root, file);
      if (excludedPathPrefixes.some(prefix => relative.startsWith(prefix))) continue;
      const excluded = new Set(excludedWordsByPath[relative] ?? []);
      const matches = [...new Set(codeWords(readFileSync(file, "utf8"))
        .filter(word => forbiddenWords.has(word) && !excluded.has(word)))];
      if (matches.length) findings.push(`${relative}: ${matches.join(", ")}`);
    }
    expect(findings).toEqual([]);
  });
});
