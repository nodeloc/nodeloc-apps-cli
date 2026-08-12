/**
 * Thin wrapper over the authoring endpoints.
 *
 * Every failure is turned into a message an author can act on. A CLI that
 * prints a raw 422 body is a CLI people stop using.
 */

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export function createClient({ site, key, username }, fetchImpl = fetch) {
  async function request(method, path, body) {
    let response;
    try {
      response = await fetchImpl(`${site}${path}`, {
        method,
        headers: {
          "Api-Key": key,
          "Api-Username": username,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (error) {
      throw new ApiError(`Could not reach ${site}: ${error.message}`);
    }

    if (response.status === 204) {
      return null;
    }

    const text = await response.text();
    let payload = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = null;
      }
    }

    if (!response.ok) {
      throw new ApiError(explain(response.status, payload), response.status);
    }

    return payload;
  }

  return {
    listApps: () => request("GET", "/apps/authoring.json"),
    getApp: (id) => request("GET", `/apps/authoring/apps/${id}.json`),
    createApp: (app) => request("POST", "/apps/authoring/apps.json", { ...app }),
    submitVersion: (appId, version) =>
      request("POST", `/apps/authoring/apps/${appId}/versions.json`, version),
    logs: (appId, limit) => request("GET", `/apps/authoring/apps/${appId}/logs.json?limit=${limit}`),
    upsertPlaytest: (appId, versionId) =>
      request("POST", `/apps/authoring/apps/${appId}/playtest.json`, {
        version_id: versionId,
      }),
    // One request per save. It writes a draft version and aims the author's
    // playtest at it, which is a different thing from submitting for review —
    // see `playtest` in commands.js.
    pushPlaytest: (appId, version) =>
      request("POST", `/apps/authoring/apps/${appId}/push.json`, version),
  };
}

function explain(status, payload) {
  const errors = payload?.errors;
  if (Array.isArray(errors) && errors.length) {
    return errors.join("\n");
  }

  switch (status) {
    case 403:
      return "Your account is not allowed to publish apps on this site.";
    case 404:
      return "Not found. Check the app slug and that you own it.";
    case 409:
      return "This app already has a version waiting for review.";
    case 429:
      return "Rate limited, or you have hit the app limit for your account.";
    default:
      return `Request failed with status ${status}.`;
  }
}
