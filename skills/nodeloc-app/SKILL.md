---
name: nodeloc-app
description: Build, test and publish a sandboxed app, bot or mini-game for a NodeLoc/Discourse community with the nodeloc-apps CLI. Use whenever writing app handlers (render/onAction/onMessage/onTrigger/onSchedule/onFetch), a blocks component tree, an app.json manifest, or working in a directory that contains app.json.
---

# Writing a community app

An app is a JS module exporting handlers. Handlers run **server-side in a sandbox**: no network, no disk, no `window`, no author account, no `process`. Everything readable arrives through `api`; everything writable is *declared* as `effects` and committed by the site after per-effect validation.

**Nothing the page claims is trusted.** This is the whole design. Never write a handler that accepts a score, a result, or a permission decision from the client.

## Before writing code

Read `app.json` if it exists. If starting fresh: `nodeloc-apps init <slug> --template counter` (`--template race` for a shared-state example, `--template bot` for an app with no interface). Do not hand-roll the project layout.

```jsonc
{
  "slug": "my-game",         // lowercase letters, digits, dashes only
  "name": "My game",
  "entry": "src/main.js",
  "scopes": ["kv"],          // request the minimum; extra scopes slow review
  "surface": "blocks",       // blocks | webview | service
  "placement": "single",     // single | many
  "triggers": [],            // post_created | post_edited | topic_created
                             // | post_liked | user_created | post_flagged
  "domains": []              // exact hostnames, each approved one at a time
}
```

**A topic's first post arrives as `topic_created`, never as `post_created`.** The two do not both fire for it, so an app that wants opening posts *and* replies has to subscribe to both. Subscribing to `post_created` alone silently misses every opening post on the forum, with nothing in the logs to say so.

`surface: "service"` is an app with no interface — a bot. It never renders and
nobody presses anything: it is woken by the events in `triggers`, acts under an
account of its own, and an **admin** installs it against the site or one
category rather than a member embedding it in a post. `placement` and the blocks
section below do not apply to it.

`placement` is a real decision, not boilerplate. **Each install has its own separate shared area.** An app with a site-wide leaderboard must be `single`, or the board splits in half the moment someone adds it to a second post. Use `many` only when one copy per post is the point (polls, countdowns, dice, converters).

## Handlers

All handlers are `(ctx, api)` and may be async. `render` is **required for an app with an interface** — the bundler rejects such a module without it.

| Handler | Fires when |
|---|---|
| `render` | The app is shown |
| `onAction` | A member presses a `button` (`ctx.action_id`) |
| `onMessage` | A webview page calls `window.community.call(method, params)` |
| `webview` | Building the page (webview surface only) |
| `onTrigger` | A site event declared in `triggers` |
| `onSchedule` | A task registered with `schedule.add` |
| `onFetch` | An `http.fetch` the app declared has come back |
| `onInstall` | The app is put to work, once per install |

`onTrigger`, `onSchedule`, `onFetch` and `onInstall` run as the app's own bot account and **cannot read any member's private data**. Their reads and writes address the app's shared area, so `api.kv.get` in a background run reads back what a background run stored.

A service app must export at least one of `onTrigger` / `onSchedule` / `onFetch` / `onInstall`; `render` is not required and is never called.

**An app that only works on a schedule must have `onInstall`.** `onSchedule` fires for a job that already exists, and a job only exists because an effect asked for one — so the first `schedule.add` has nowhere else to come from. `onInstall` runs again on every re-install and every playtest push, so what it does must be idempotent (`schedule.add` is: it is keyed by `job_key` and rewritten in place).

### Background ctx

```jsonc
{
  "background": true, "install_id": 12, "config": {},
  "event": "post_created",                          // onTrigger
  "data": { "topic_id": 481, "post_id": 1902, "user_id": 7 },
  "job_key": "daily", "payload": {},                // onSchedule
  "request_id": "weather", "ok": true,              // onFetch
  "status": 200, "headers": {}, "body": "..."
}
```

### ctx

```jsonc
{
  "install_id": 12, "version": 3, "locale": "zh_CN", "config": {},
  "topic_id": 481, "post_id": 1902, "category_id": 5,
  "user": { "id": 7, "username": "ada", "avatar_url": "..." },  // null when anonymous
  "state": {},                          // whatever the last handler returned
  "action_id": "bump", "inputs": {},    // onAction only
  "method": "submit", "params": {}      // onMessage only
}
```

That list is the privacy boundary — nothing else about the member is available. Always handle `ctx.user === null`.

### Return shape

```js
return { blocks, state, effects };
```

- `blocks` — a component tree, or `null` to leave the screen as it is
- `state` — carried into the next call, signed by the server; safe to trust
- `effects` — declared writes, `[]` when there are none

## Blocks

The site renders the tree natively. **Unknown types and unknown attributes are rejected, not ignored** — a typo produces an error, not a silently missing button. Text is never parsed as markup, so XSS is not possible here.

| Type | Attributes |
|---|---|
| `vstack` `hstack` | `gap` `align` `padding`, plus `children` |
| `zstack` | `align`, plus `children` |
| `text` | `value` `size` `weight` `align` |
| `button` | `label` `icon` `variant` `action` `disabled` |
| `image` | `url` `width` `height` `fit` `alt` |
| `icon` | `name` `size` |
| `spacer` | `size` |
| `divider` | — |
| `progress` | `value` `max` |
| `input` | `name` `placeholder` `value` |
| `select` | `name` `value` `options` |

Enumerations — using any other value is an error:

- `size` / `gap` / `padding`: `xs` `small` `medium` `large` `xl`
- `align`: `start` `center` `end` `stretch`
- `weight`: `regular` `medium` `bold`
- `variant`: `primary` `secondary` `danger` `flat`
- `fit`: `contain` `cover` `fill`

Limits: 500 nodes, 32 levels deep, 256 KB serialised. Bundle limit is 512 KB.

Build the tree in one `screen(...)` function called from every handler, as the templates do. Duplicating the tree across handlers is how they drift apart.

## Reads and writes

Reads — always `await`; the data was prefetched before the sandbox started, so nothing queries a database here:

| Call | Scope |
|---|---|
| `api.kv.get(key)` / `api.kv.list()` | `kv` — this member's data in this install |
| `api.kv.listPublic()` | `kv.shared` — the shared area |
| `api.points.balance()` | `points` |
| `api.post.get(id)` / `api.topic.get(id)` | `post.read` — the post and topic this run is about |

`api.post.get` answers for the post the invocation concerns and **null for any other id**. That is not a bug to work around: prefetching is what stops an app installed in one place reading across the site.

Writes — returned as effects, validated one by one, committed in a single transaction:

| Effect | Scope |
|---|---|
| `kv.set` / `kv.delete` | `kv` |
| `kv.shared.set` / `kv.shared.delete` | `kv.shared` |
| `ui.toast` / `ui.navigate` | `ui` |
| `points.award` | `points` |
| `rt.publish` | `realtime` |
| `schedule.add` / `schedule.cancel` | `schedule` |
| `post.create` / `post.reply` | `post.write` |
| `notify.user` | `notify` |
| `http.fetch` | `http` |

```js
{ type: "post.reply", topic_id: 481, raw: "..." }
{ type: "post.create", category_id: 5, title: "...", raw: "..." }
{ type: "notify.user", user_id: 7, message: "...", path: "/t/481" }
{ type: "http.fetch", request_id: "weather", url: "https://api.example.com/now",
  method: "GET", headers: {}, body: "" }
```

Three things bound what a bot can say. **Where**: an app installed against a
category may only post in it and its subcategories; against the site, anywhere
its own account may post. **How often**: a daily ceiling per app, and a second
one per topic counted across every app, so two bots cannot fill a thread between
them. **Who**: `notify.user` reaches only the member whose action woke this run —
anyone else is `E_NOTIFY_DENIED`.

`http.fetch` is not a fetch. The sandbox has no network and does not get one: the
effect asks the **site** to make the request, and the answer arrives later as a
separate `onFetch` invocation carrying the same `request_id`. Only https, only
hostnames a reviewer approved for this app, and the response body is capped.
Credentials belong in the install's `config` (an admin sets it), never in the
bundle a reviewer reads.

Two rules that decide whether a leaderboard is worth anything:

- **Only a handler can write the shared area.** A member's `kv.set` always lands in their own namespace. This is why `kv.shared` can be trusted.
- **A broadcast is a signal, never state.** Clients receiving `rt.publish` re-render through the permission-checked path; the broadcast payload is never used as data.

`context` is implicit. `post.write` and `webview` are **privileged**: only an admin grants them, and each has a site setting that has to be on as well. In a playtest, `post.write` effects are checked in full and then thrown away — a playtest can say what it would post, but never posts.

## Helping to moderate

An app installed against a node joins that node's moderation group, and that
one fact is the whole permission model: from then on core's own category-scoped
checks decide what it may do, so it can act there exactly as far as that node's
moderators can and nowhere else at all. A node's owner installs it themselves;
only an admin installs anything against the whole site.

| Effect | Scope | |
|---|---|---|
| `flag.create` | `flag.create` | Raises a flag. A person settles it. |
| `post.delete` / `post.recover` | `moderate.post` | Privileged |
| `topic.close` / `topic.tag` | `moderate.topic` | Privileged |

```js
{ type: "flag.create", post_id: 1902, reason: "..." }
{ type: "post.delete", post_id: 1902 }
{ type: "topic.close", topic_id: 481, reason: "..." }
{ type: "topic.tag", topic_id: 481, tags: ["resolved"] }
```

**Flag first.** `flag.create` costs an ordinary scope because it ends with a
person deciding; deleting costs a privileged one because it ends with somebody's
post gone. An app that flags is most of the value of one that deletes, and it
fails safe. A post is flagged once per app, however often it is looked at.

`post.delete` will not take the opening post of a topic — that is closing
somebody's whole thread through a door marked "post".

### Knowing things across installs

| Call | Scope |
|---|---|
| `api.kv.app.get(key)` | `kv.app` — what the whole app knows, everywhere it runs |
| `api.post.recentByUser(id)` | `post.read` — that person's recent posts, within the app's reach |

`kv.shared` belongs to **one install**: right for a leaderboard, useless for a
list of judged accounts, which has to be the same in all fifty nodes an app runs
in. `kv.app` is that list.

It cannot be enumerated, and this is deliberate: on a real site the area is a
lookup table with tens of thousands of rows, and handing it over whole on every
post would put it in memory every time anybody writes anything. Both calls above
answer **only for the people this invocation is about** — whoever acted, whoever
wrote the post, whoever was reported. Key entries as `user:<id>` and they will be
there; ask after a stranger and you get `null`, not an error.

## Webview

Only when a component tree genuinely cannot express it — an animation loop, a canvas game. It requires an admin to grant `webview` to this specific app.

```js
export async function webview(ctx, api) {
  return { html: "...", css: "...", js: "..." };
}
```

The page is **untrusted**. To make a score count, the server has to be able to recompute it: issue a seed from the handler, have the page return the input sequence, and replay it in `onMessage` with the same `simulate()` the page used. A cheater then has to actually play well.

The client JS is injected **as a source string, not a closure**. Any module-level constant it references must be emitted into the injected preamble too, or it fails at runtime with `X is not defined`. Keep those constants in one object and generate the preamble from it — do not maintain two copies.

## Workflow

```bash
nodeloc-apps dev        # bundle + static checks, no upload
nodeloc-apps playtest   # private install only you can see; re-pushes on save
nodeloc-apps upload --note "what changed"
nodeloc-apps logs       # handler, outcome, duration, error code per call
```

Run `dev` after every change — it catches what the server would reject anyway (missing `render`, `eval`, `node:` builtins, browser globals, `fetch`) before a review cycle is spent on it. Prefer `playtest` over `upload` while iterating: an app may only have **one version pending review at a time**.

## Error codes

| Code | Meaning |
|---|---|
| `E_SCOPE_DENIED` | An effect needed a scope this app was not granted |
| `E_INVALID_BLOCKS` | Unknown type/attribute, or over the node/depth/size limits |
| `E_APP_TIMEOUT` / `E_APP_OUT_OF_MEMORY` | The sandbox killed the call |
| `E_APP_FAILED` | The handler threw |
| `E_SCOPE_UNAVAILABLE` | The site has that capability switched off entirely |
| `E_POST_OUT_OF_SCOPE` | Posting somewhere the app was not installed |
| `E_POST_DENIED` | The app's own account may not post there |
| `E_POST_QUOTA` / `E_POST_TOPIC_QUOTA` | The day's posts are spent |
| `E_NOTIFY_DENIED` | Notifying somebody this run is not acting for |
| `E_HTTP_DOMAIN_DENIED` | That host is not on the app's approved list |

## Checklist before upload

- [ ] `render` exported (or, for a service app, `onTrigger`/`onSchedule`/`onFetch`); every handler returns `{ blocks, state, effects }`
- [ ] `ctx.user === null` handled
- [ ] No `fetch`, no `node:` imports, no `window`/`document`/`localStorage`
- [ ] Every attribute value is inside the allowed enumeration
- [ ] `scopes` lists exactly what the effects need — nothing more
- [ ] Anything competitive is decided by the handler, never sent by the client
- [ ] `placement` matches whether the app has shared state
- [ ] `domains` lists exact hostnames only — no wildcards, no scheme, no path
- [ ] Nothing a bot posts is written in a loop it could feed itself
- [ ] `nodeloc-apps dev` is clean
