import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { bundle, inspect, BundleError } from "../src/bundle.js";
import { createClient, ApiError } from "../src/api.js";
import { readManifest, readCredentials, ConfigError } from "../src/config.js";
import { init, dev, playtest } from "../src/commands.js";
import { createServer } from "node:http";

const silentIo = { log() {}, warn() {} };

async function scratch() {
  return await mkdtemp(path.join(tmpdir(), "apps-cli-"));
}

describe("bundle", () => {
  test("inlines relative imports", async () => {
    const dir = await scratch();
    await writeFile(path.join(dir, "helper.js"), "export const gap = 'small';\n");
    await writeFile(
      path.join(dir, "main.js"),
      "import { gap } from './helper.js';\nexport async function render() { return gap; }\n"
    );

    const code = await bundle(path.join(dir, "main.js"));

    assert.match(code, /export const gap/, "the imported module is inlined");
    assert.doesNotMatch(code, /from '\.\/helper/, "the import statement is gone");
  });

  test("refuses a circular import instead of hanging", async () => {
    const dir = await scratch();
    await writeFile(path.join(dir, "a.js"), "import './b.js';\nexport function render() {}\n");
    await writeFile(path.join(dir, "b.js"), "import './a.js';\n");

    await assert.rejects(() => bundle(path.join(dir, "a.js")), BundleError);
  });

  test("refuses a bundle over the size limit", async () => {
    const dir = await scratch();
    await writeFile(path.join(dir, "main.js"), `export function render() {}\n// ${"x".repeat(2000)}`);

    await assert.rejects(
      () => bundle(path.join(dir, "main.js"), { maxBytes: 512 }),
      /limit is 512/
    );
  });
});

describe("inspect", () => {
  test("requires a render export", () => {
    const { problems } = inspect("export function onAction() {}");
    assert.equal(problems.length, 1);
    assert.match(problems[0], /render/);
  });

  test("warns about things the sandbox will refuse", () => {
    const { warnings } = inspect(
      "export async function render() { await fetch('/x'); eval('1'); }"
    );
    assert.equal(warnings.length, 2, "network and eval are both flagged");
  });

  for (const template of ["counter.js", "race.js"]) {
    test(`accepts the shipped ${template} template`, async () => {
      const code = await readFile(
        new URL(`../templates/${template}`, import.meta.url),
        "utf8"
      );
      const { problems, warnings } = inspect(code);

      assert.deepEqual(problems, [], "the template we hand people must pass");
      assert.deepEqual(warnings, [], "and must not warn");
    });
  }
});

describe("config", () => {
  test("explains a missing manifest instead of throwing ENOENT", async () => {
    const dir = await scratch();
    await assert.rejects(() => readManifest(dir), ConfigError);
  });

  test("refuses a manifest without a slug", async () => {
    const dir = await scratch();
    await writeFile(path.join(dir, "app.json"), JSON.stringify({ entry: "src/main.js" }));

    await assert.rejects(() => readManifest(dir), /needs a "slug"/);
  });

  test("reads credentials only from the environment", () => {
    assert.throws(() => readCredentials({}), ConfigError);

    const creds = readCredentials({
      NODELOC_APPS_SITE: "https://forum.example/",
      NODELOC_APPS_API_KEY: "k",
      NODELOC_APPS_API_USERNAME: "ada",
    });
    assert.equal(creds.site, "https://forum.example", "the trailing slash is normalised away");
  });
});

describe("api", () => {
  test("turns a 409 into an explanation an author can act on", async () => {
    const client = createClient(
      { site: "https://x", key: "k", username: "u" },
      async () => new Response("{}", { status: 409 })
    );

    await assert.rejects(() => client.listApps(), (error) => {
      assert.ok(error instanceof ApiError);
      assert.match(error.message, /waiting for review/);
      return true;
    });
  });

  test("surfaces server-side validation messages verbatim", async () => {
    const client = createClient(
      { site: "https://x", key: "k", username: "u" },
      async () => new Response(JSON.stringify({ errors: ["Slug has already been taken"] }), { status: 422 })
    );

    await assert.rejects(() => client.listApps(), /Slug has already been taken/);
  });

  test("sends the author's identity on every call", async () => {
    let seen;
    const client = createClient(
      { site: "https://x", key: "secret", username: "ada" },
      async (_url, options) => {
        seen = options.headers;
        return new Response("{}", { status: 200 });
      }
    );

    await client.listApps();

    assert.equal(seen["Api-Key"], "secret");
    assert.equal(seen["Api-Username"], "ada");
  });
});

describe("commands", () => {
  test("init scaffolds a project that dev accepts", async () => {
    const dir = await scratch();
    const cwd = process.cwd();
    process.chdir(dir);

    try {
      await init(["dice-roller"], silentIo);

      const manifest = JSON.parse(
        await readFile(path.join(dir, "dice-roller/app.json"), "utf8")
      );
      assert.equal(manifest.slug, "dice-roller");
      assert.equal(manifest.entry, "src/main.js");

      // The point of the scaffold is that it builds unmodified.
      const code = await dev([], silentIo, path.join(dir, "dice-roller"));
      assert.match(code, /export async function render/);
    } finally {
      process.chdir(cwd);
    }
  });

  test("init refuses a slug the server would reject", async () => {
    await assert.rejects(() => init(["Not A Slug"], silentIo), /lowercase/);
  });

  test("playtest pushes once per save and never queues a review", async () => {
    // The bug this covers: a push used to be sent as a submission, which put a
    // version in the review queue and then blocked every later save on the
    // one-open-submission rule.
    const dir = await scratch();
    const cwd = process.cwd();
    process.chdir(dir);

    const seen = [];
    const server = createServer((req, res) => {
      seen.push(req.url);
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        res.setHeader("content-type", "application/json");
        if (req.url === "/apps/authoring.json") {
          res.end(JSON.stringify([{ id: 7, slug: "dice-roller" }]));
        } else {
          res.end(JSON.stringify({ install: { id: 3 }, version: { id: 9, version_number: 1 } }));
        }
      });
    });

    try {
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      process.env.NODELOC_APPS_SITE = `http://127.0.0.1:${server.address().port}`;
      process.env.NODELOC_APPS_API_KEY = "k";
      process.env.NODELOC_APPS_API_USERNAME = "u";

      await init(["dice-roller"], silentIo);
      // A watcher that ends immediately, so the command returns after one push.
      const noWatch = async function* () {};
      await playtest([], silentIo, path.join(dir, "dice-roller"), { watchFn: noWatch });

      assert.deepEqual(
        seen.filter((url) => url !== "/apps/authoring.json"),
        ["/apps/authoring/apps/7/push.json"],
        "one request, to the push endpoint"
      );
      assert.ok(
        !seen.some((url) => url.endsWith("/versions.json")),
        "nothing is submitted for review"
      );
    } finally {
      server.close();
      process.chdir(cwd);
      delete process.env.NODELOC_APPS_SITE;
      delete process.env.NODELOC_APPS_API_KEY;
      delete process.env.NODELOC_APPS_API_USERNAME;
    }
  });

  test("dev fails when the entry file is missing", async () => {
    const dir = await scratch();
    await mkdir(path.join(dir, "src"), { recursive: true });
    await writeFile(
      path.join(dir, "app.json"),
      JSON.stringify({ slug: "x", entry: "src/missing.js" })
    );

    await assert.rejects(() => dev([], silentIo, dir), BundleError);
  });
});
