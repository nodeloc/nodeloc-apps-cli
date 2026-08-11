/**
 * Where the CLI gets its credentials and which site it talks to.
 *
 * Credentials come from the environment, never from the project directory: an
 * app's source is meant to be shared and reviewed, and a token committed by
 * accident is the kind of mistake that is hard to take back.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

export const CONFIG_FILE = "app.json";

export class ConfigError extends Error {}

export async function readManifest(cwd = process.cwd()) {
  const file = path.join(cwd, CONFIG_FILE);

  let raw;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    throw new ConfigError(
      `No ${CONFIG_FILE} here. Run \`nodeloc-apps init\` first, or change to your app directory.`
    );
  }

  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch (error) {
    throw new ConfigError(`${CONFIG_FILE} is not valid JSON: ${error.message}`);
  }

  if (!manifest.slug) {
    throw new ConfigError(`${CONFIG_FILE} needs a "slug".`);
  }
  if (!manifest.entry) {
    throw new ConfigError(`${CONFIG_FILE} needs an "entry" pointing at your source file.`);
  }

  return manifest;
}

/**
 * Environment first so CI and scripts keep working, then whatever `login`
 * stored. Nothing is ever read from the project directory: an app's source is
 * meant to be shared, and a token committed by accident is hard to take back.
 */
export function readCredentials(env = process.env, stored = null) {
  const site = env.NODELOC_APPS_SITE || stored?.site;
  const key = env.NODELOC_APPS_API_KEY || stored?.key;
  const username = env.NODELOC_APPS_API_USERNAME || stored?.username;

  if (!site || !key || !username) {
    throw new ConfigError("Not signed in. Run `nodeloc-apps login` first.");
  }

  return { site: site.replace(/\/$/, ""), key, username };
}
