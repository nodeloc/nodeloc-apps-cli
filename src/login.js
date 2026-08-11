/**
 * `nodeloc-apps login` — the browser does the signing in.
 *
 * A terminal cannot authenticate to a forum, so it asks the site for a short
 * code, the author approves that code in a browser where they are already
 * signed in, and the CLI collects the credential afterwards. Nothing secret is
 * ever typed by hand, and an approval nobody collects simply expires.
 */

import { ConfigError } from "./config.js";
import * as store from "./credentials.js";

const POLL_INTERVAL_MS = 2000;

export async function login(args, io, { fetchImpl = fetch, sleep = wait } = {}) {
  const site = (siteFrom(args) ?? process.env.NODELOC_APPS_SITE ?? "").replace(/\/$/, "");
  if (!site) {
    throw new ConfigError("Usage: nodeloc-apps login --site https://your.forum");
  }

  const started = await request(fetchImpl, `${site}/apps/cli/start.json`, { method: "POST" });

  io.log("");
  io.log(`  Open:  ${started.verify_url}`);
  io.log(`  Code:  ${started.code}`);
  io.log("");
  io.log("Waiting for approval… (Ctrl+C to cancel)");

  const deadline = Date.now() + started.expires_in * 1000;

  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);

    const result = await request(
      fetchImpl,
      `${site}/apps/cli/poll.json?token=${encodeURIComponent(started.poll_token)}`
    );

    if (result.status === "approved") {
      await store.save({ site, key: result.key, username: result.username });
      io.log(`Signed in as ${result.username}.`);
      return result;
    }
    if (result.status === "expired") {
      break;
    }
  }

  throw new ConfigError("That code expired before it was approved. Try again.");
}

export async function logout(_args, io) {
  await store.forget();
  io.log("Signed out. The key on the site was left alone — revoke it there if you meant to.");
}

export async function whoami(_args, io) {
  const stored = await store.load();
  if (!stored) {
    io.log("Not signed in.");
    return null;
  }

  io.log(`${stored.username} at ${stored.site}`);
  return stored;
}

async function request(fetchImpl, url, options = {}) {
  let response;
  try {
    response = await fetchImpl(url, {
      ...options,
      headers: { Accept: "application/json", ...(options.headers ?? {}) },
    });
  } catch (error) {
    throw new ConfigError(`Could not reach the site: ${error.message}`);
  }

  if (!response.ok) {
    throw new ConfigError(`The site refused the login handshake (${response.status}).`);
  }
  return response.json();
}

function siteFrom(args) {
  const index = args.indexOf("--site");
  return index === -1 ? null : args[index + 1];
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
