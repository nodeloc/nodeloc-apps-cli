/**
 * Turning a source directory into the single module the platform runs.
 *
 * The platform never runs a build, so bundling happens here, on the author's
 * machine, where a failure is theirs to see and fix immediately.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

// What a module has to export to be runnable at all, per surface. A bot has no
// interface, so requiring `render` of one would mean shipping a function that
// is never called; what it must have instead is at least one way in.
const REQUIRED_EXPORTS = ["render"];
const SERVICE_ENTRY_POINTS = ["onTrigger", "onSchedule", "onFetch", "onInstall"];

// Both forms have to be caught: `import x from "./y.js"` and the side-effect
// `import "./y.js"`. Missing the second would ship an import statement the
// sandbox cannot resolve, since nothing outside the bundle exists there.
const IMPORT_PATTERN = /^\s*import\s+(?:[^;'"]*?\sfrom\s+)?["'](\.[^"']+)["'];?/gm;

export class BundleError extends Error {}

/**
 * Inlines relative imports depth-first. This is deliberately not a general
 * bundler: apps are small, and a dependency graph an author cannot read in one
 * sitting is a dependency graph a reviewer cannot check.
 */
export async function bundle(entryPath, { maxBytes = 512 * 1024, seen = new Set() } = {}) {
  const resolved = path.resolve(entryPath);

  if (seen.has(resolved)) {
    throw new BundleError(`Circular import through ${path.basename(resolved)}`);
  }
  seen.add(resolved);

  let source;
  try {
    source = await readFile(resolved, "utf8");
  } catch {
    throw new BundleError(`Cannot read ${resolved}`);
  }

  const dir = path.dirname(resolved);
  const parts = [];
  let lastIndex = 0;

  for (const match of source.matchAll(IMPORT_PATTERN)) {
    const target = path.resolve(dir, match[1]);
    const withExtension = target.endsWith(".js") ? target : `${target}.js`;

    parts.push(source.slice(lastIndex, match.index));
    parts.push(await bundle(withExtension, { maxBytes, seen }));
    lastIndex = match.index + match[0].length;
  }

  parts.push(source.slice(lastIndex));

  const output = parts.join("\n");

  if (Buffer.byteLength(output, "utf8") > maxBytes) {
    throw new BundleError(
      `Bundle is ${Buffer.byteLength(output, "utf8")} bytes; the limit is ${maxBytes}.`
    );
  }

  return output;
}

/**
 * Checks the things the server would reject anyway, but here, before an author
 * spends a review cycle finding out.
 */
export function inspect(code, manifest = {}) {
  const problems = [];
  const warnings = [];
  const exported = (name) =>
    new RegExp(`export\\s+(async\\s+)?function\\s+${name}\\b`).test(code);

  if (manifest.surface === "service") {
    if (!SERVICE_ENTRY_POINTS.some(exported)) {
      problems.push(
        `A service app needs at least one of: ${SERVICE_ENTRY_POINTS.map((name) => `export function ${name}`).join(", ")}.`
      );
    }
    for (const trigger of manifest.triggers ?? []) {
      if (!exported("onTrigger")) {
        problems.push(`Subscribes to "${trigger}" but exports no onTrigger.`);
        break;
      }
    }
  } else {
    for (const name of REQUIRED_EXPORTS) {
      if (!exported(name)) {
        problems.push(`Missing \`export function ${name}\`.`);
      }
    }
  }

  if (/\bfetch\s*\(/.test(code)) {
    warnings.push(
      "Calls fetch(). The sandbox has no network. To reach an approved host, return an http.fetch effect and read the answer in onFetch."
    );
  }
  if (/\b(eval|new\s+Function)\s*\(/.test(code)) {
    warnings.push("Uses eval or new Function. Reviewers will almost certainly reject this.");
  }
  if (/\bimport\s*\(\s*["']node:/.test(code)) {
    warnings.push("Imports a node: builtin. These are blocked in the sandbox.");
  }
  if (/\blocalStorage\b|\bdocument\b|\bwindow\b/.test(code)) {
    warnings.push("References browser globals. Apps run on the server, not in the page.");
  }

  return { problems, warnings };
}
