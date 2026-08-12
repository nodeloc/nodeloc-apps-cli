import { mkdir, writeFile, watch } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { bundle, inspect, BundleError } from "./bundle.js";
import { createClient } from "./api.js";
import { readManifest, readCredentials, CONFIG_FILE } from "./config.js";
import * as store from "./credentials.js";

const TEMPLATES = fileURLToPath(new URL("../templates/", import.meta.url));

const TEMPLATE_NAMES = { counter: "counter.js", race: "race.js" };
const TEMPLATE_PLACEMENT = { counter: "many", race: "single" };
const TEMPLATE_SCOPES = {
  counter: ["kv"],
  race: ["kv", "kv.shared", "points", "realtime", "schedule"],
};

export async function init(args, io) {
  const slug = args[0];
  if (!slug) {
    throw new Error("Usage: nodeloc-apps init <slug> [--template counter|race]");
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
    throw new Error("A slug may only contain lowercase letters, numbers and dashes.");
  }

  const template = templateFrom(args);
  if (!TEMPLATE_NAMES[template]) {
    throw new Error(`Unknown template "${template}". Available: counter, race.`);
  }

  const dir = path.resolve(process.cwd(), slug);
  await mkdir(path.join(dir, "src"), { recursive: true });

  const manifest = {
    slug,
    name: slug.replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase()),
    entry: "src/main.js",
    scopes: TEMPLATE_SCOPES[template],
    // "blocks" draws through the site's components; "webview" ships your own
    // HTML and needs an admin to grant it.
    surface: "blocks",
    // "single" means the app lives in one post; "many" lets anyone add it to
    // theirs. Apps with a shared leaderboard want "single".
    placement: TEMPLATE_PLACEMENT[template],
  };

  await writeFile(
    path.join(dir, CONFIG_FILE),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8"
  );
  await writeFile(
    path.join(dir, "src/main.js"),
    await readFile(path.join(TEMPLATES, TEMPLATE_NAMES[template]), "utf8"),
    "utf8"
  );

  io.log(`Created ${slug}/`);
  io.log("");
  io.log("Next:");
  io.log(`  cd ${slug}`);
  io.log("  nodeloc-apps dev        # check it builds");
  io.log("  nodeloc-apps playtest   # run it on the site, only you can see it");
}

export async function dev(_args, io, cwd = process.cwd()) {
  const manifest = await readManifest(cwd);
  const code = await bundle(path.join(cwd, manifest.entry));
  const { problems, warnings } = inspect(code);

  for (const warning of warnings) {
    io.warn(`warning: ${warning}`);
  }
  if (problems.length) {
    throw new BundleError(problems.join("\n"));
  }

  io.log(`Built ${manifest.slug}: ${Buffer.byteLength(code, "utf8")} bytes, no problems found.`);
  return code;
}

export async function upload(args, io, cwd = process.cwd()) {
  const manifest = await readManifest(cwd);
  const client = createClient(readCredentials(process.env, await store.load()));
  const code = await dev([], io, cwd);
  const note = noteFrom(args);

  const app = await resolveApp(client, manifest, io);
  const version = await client.submitVersion(app.id, {
    version: {
      bundle: code,
      requested_scopes: manifest.scopes ?? [],
      change_note: note,
      manifest: declaredFrom(manifest),
    },
  });

  io.log(`Submitted v${version.version.version_number} for review.`);
  if (manifest.scopes?.length) {
    io.log(`Requested permissions: ${manifest.scopes.join(", ")}`);
  }
  return version;
}

export async function playtest(_args, io, cwd = process.cwd(), { watchFn = watch } = {}) {
  const manifest = await readManifest(cwd);
  const client = createClient(readCredentials(process.env, await store.load()));
  const app = await resolveApp(client, manifest, io);

  // A push is not a submission. It used to be sent as one, which queued a
  // review and notified every moderator on the site — and then the one-open-
  // submission rule refused every save after the first, so a watch session
  // stopped reaching the site without saying so.
  const push = async () => {
    const code = await bundle(path.join(cwd, manifest.entry));
    const { problems } = inspect(code);
    if (problems.length) {
      io.warn(problems.join("\n"));
      return null;
    }

    const pushed = await client.pushPlaytest(app.id, {
      version: {
        bundle: code,
        requested_scopes: manifest.scopes ?? [],
        change_note: "playtest",
        manifest: declaredFrom(manifest),
      },
    });
    return pushed.install;
  };

  const install = await push();
  if (install) {
    io.log(`Playtest ready: only you can see it. Install #${install.id}`);
    io.log("Watching for changes. Press Ctrl+C to stop.");
  }

  const watcher = watchFn(path.join(cwd, path.dirname(manifest.entry)), { recursive: true });
  for await (const event of watcher) {
    if (!event.filename?.endsWith(".js")) {
      continue;
    }
    try {
      await push();
      io.log(`Pushed ${event.filename} at ${new Date().toLocaleTimeString()}`);
    } catch (error) {
      io.warn(error.message);
    }
  }
}

async function resolveApp(client, manifest, io) {
  const apps = await client.listApps();
  const existing = apps?.find?.((candidate) => candidate.slug === manifest.slug);
  if (existing) {
    return existing;
  }

  io.log(`No app named "${manifest.slug}" yet — creating it.`);
  const created = await client.createApp({
    app: { slug: manifest.slug, name: manifest.name ?? manifest.slug },
  });
  return created.app;
}

function noteFrom(args) {
  const index = args.indexOf("--note");
  return index === -1 ? "" : (args[index + 1] ?? "");
}

/**
 * The parts of app.json the platform reads. Sent explicitly rather than posting
 * the whole file, so a manifest can carry an author's own notes without them
 * ending up stored on the server.
 */
function declaredFrom(manifest) {
  return {
    surface: manifest.surface ?? "blocks",
    placement: manifest.placement ?? "single",
    triggers: manifest.triggers ?? [],
  };
}

function templateFrom(args) {
  const index = args.indexOf("--template");
  return index === -1 ? "counter" : (args[index + 1] ?? "counter");
}

export async function logs(args, io, cwd = process.cwd()) {
  const manifest = await readManifest(cwd);
  const client = createClient(readCredentials(process.env, await store.load()));
  const app = await resolveApp(client, manifest, io);

  const { logs: runs } = await client.logs(app.id, limitFrom(args));

  if (!runs.length) {
    io.log("No runs recorded yet.");
    return runs;
  }

  for (const run of runs.slice().reverse()) {
    const when = new Date(run.created_at).toLocaleTimeString();
    const detail = run.error_code ? `  ${run.error_code}` : "";
    io.log(
      `${when}  ${run.handler.padEnd(9)} ${run.outcome.padEnd(11)} ${String(run.duration_ms).padStart(5)}ms${detail}`
    );
  }

  return runs;
}

function limitFrom(args) {
  const index = args.indexOf("--limit");
  return index === -1 ? 50 : Number(args[index + 1]) || 50;
}
