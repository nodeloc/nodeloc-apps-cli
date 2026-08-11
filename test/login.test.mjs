import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.XDG_CONFIG_HOME = await mkdtemp(path.join(tmpdir(), "apps-cfg-"));

const { login, whoami, logout } = await import("../src/login.js");
const store = await import("../src/credentials.js");
const { readCredentials } = await import("../src/config.js");

const silent = { log() {}, warn() {} };
const noWait = () => Promise.resolve();

function respond(body, ok = true, status = 200) {
  return Promise.resolve({ ok, status, json: () => Promise.resolve(body) });
}

describe("login", () => {
  test("stores the credential once the code is approved", async () => {
    let polls = 0;
    const fetchImpl = (url, options) => {
      if (options?.method === "POST") {
        return respond({
          code: "ABCD2345",
          poll_token: "tok",
          verify_url: "https://forum.example/apps/cli?code=ABCD2345",
          expires_in: 600,
        });
      }
      polls += 1;
      return polls < 2
        ? respond({ status: "pending" })
        : respond({ status: "approved", key: "secret", username: "ada" });
    };

    const lines = [];
    await login(["--site", "https://forum.example/"], { log: (m) => lines.push(m), warn() {} }, {
      fetchImpl,
      sleep: noWait,
    });

    const stored = await store.load();
    assert.equal(stored.key, "secret");
    assert.equal(stored.username, "ada");
    assert.equal(stored.site, "https://forum.example", "the trailing slash is normalised away");
    assert.ok(
      lines.some((line) => line.includes("ABCD2345")),
      "the code is shown so the member can check it matches"
    );
  });

  test("the stored credential satisfies the other commands", async () => {
    const creds = readCredentials({}, await store.load());
    assert.equal(creds.username, "ada");
  });

  test("the environment still wins, so CI needs no login", async () => {
    const creds = readCredentials(
      {
        NODELOC_APPS_SITE: "https://ci.example",
        NODELOC_APPS_API_KEY: "ci-key",
        NODELOC_APPS_API_USERNAME: "ci",
      },
      await store.load()
    );
    assert.equal(creds.site, "https://ci.example");
  });

  test("whoami reports the signed-in account", async () => {
    const lines = [];
    await whoami([], { log: (m) => lines.push(m), warn() {} });
    assert.match(lines.join(" "), /ada/);
  });

  test("logout forgets it", async () => {
    await logout([], silent);
    assert.equal(await store.load(), null);
    assert.throws(() => readCredentials({}, null), /login/);
  });

  test("gives up when the code is never approved", async () => {
    const fetchImpl = (url, options) =>
      options?.method === "POST"
        ? respond({ code: "X", poll_token: "t", verify_url: "u", expires_in: 0 })
        : respond({ status: "pending" });

    await assert.rejects(
      () => login(["--site", "https://forum.example"], silent, { fetchImpl, sleep: noWait }),
      /expired/
    );
  });

  test("stops polling once the site says the session expired", async () => {
    let polls = 0;
    const fetchImpl = (url, options) => {
      if (options?.method === "POST") {
        return respond({ code: "X", poll_token: "t", verify_url: "u", expires_in: 600 });
      }
      polls += 1;
      return respond({ status: "expired" });
    };

    await assert.rejects(
      () => login(["--site", "https://forum.example"], silent, { fetchImpl, sleep: noWait }),
      /expired/
    );
    assert.equal(polls, 1, "an expired session is not polled again");
  });

  test("needs a site to talk to", async () => {
    await assert.rejects(() => login([], silent, { fetchImpl: () => {}, sleep: noWait }), /--site/);
  });
});
