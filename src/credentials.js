/**
 * Where the CLI keeps the credential `login` obtained.
 *
 * On disk under the user's config directory rather than in the project, so a
 * token can never be committed by accident. Environment variables still win
 * when set, which keeps CI and scripts working without a login step.
 */

import { mkdir, readFile, writeFile, rm, chmod } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export const CONFIG_DIR = path.join(
  process.env.XDG_CONFIG_HOME || path.join(homedir(), ".config"),
  "nodeloc-apps"
);
export const CREDENTIALS_FILE = path.join(CONFIG_DIR, "credentials.json");

export async function save({ site, key, username }) {
  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(
    CREDENTIALS_FILE,
    `${JSON.stringify({ site, key, username }, null, 2)}\n`,
    "utf8"
  );
  // Readable by its owner only; this file is a live credential.
  await chmod(CREDENTIALS_FILE, 0o600);
}

export async function load() {
  try {
    return JSON.parse(await readFile(CREDENTIALS_FILE, "utf8"));
  } catch {
    return null;
  }
}

export async function forget() {
  await rm(CREDENTIALS_FILE, { force: true });
}
