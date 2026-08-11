---
name: nodeloc-app
description: Build, test and publish a sandboxed app or mini-game for a NodeLoc/Discourse community with the nodeloc-apps CLI. Use whenever writing app handlers (render/onAction/onMessage), a blocks component tree, an app.json manifest, or working in a directory that contains app.json.
---

# Writing a community app

An app is a JS module exporting handlers. Handlers run **server-side in a sandbox**: no network, no disk, no `window`, no author account, no `process`. Everything readable arrives through `api`; everything writable is *declared* as `effects` and committed by the site after per-effect validation.

**Nothing the page claims is trusted.** This is the whole design. Never write a handler that accepts a score, a result, or a permission decision from the client.

## Before writing code

Read `app.json` if it exists. If starting fresh: `nodeloc-apps init <slug> --template counter` (or `--template race` for a shared-state example). Do not hand-roll the project layout.

```jsonc
{
  "slug": "my-game",         // lowercase letters, digits, dashes only
  "name": "My game",
  "entry": "src/main.js",
  "scopes": ["kv"],          // request the minimum; extra scopes slow review
  "surface": "blocks",       // blocks | webview
  "placement": "single",     // single | many
  "triggers": []             // post_created | topic_created | post_liked
}
```

`placement` is a real decision, not boilerplate. **Each install has its own separate shared area.** An app with a site-wide leaderboard must be `single`, or the board splits in half the moment someone adds it to a second post. Use `many` only when one copy per post is the point (polls, countdowns, dice, converters).

## Handlers

All handlers are `(ctx, api)` and may be async. `render` is **required** — the bundler rejects a module without it.

| Handler | Fires when |
|---|---|
| `render` | The app is shown |
| `onAction` | A member presses a `button` (`ctx.action_id`) |
| `onMessage` | A webview page calls `window.community.call(method, params)` |
| `webview` | Building the page (webview surface only) |
| `onTrigger` | A site event declared in `triggers` |
| `onSchedule` | A task registered with `schedule.add` |

`onTrigger` and `onSchedule` run as the app's own bot account and **cannot read any member's private data**.

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

Writes — returned as effects, validated one by one, committed in a single transaction:

| Effect | Scope |
|---|---|
| `kv.set` / `kv.delete` | `kv` |
| `kv.shared.set` / `kv.shared.delete` | `kv.shared` |
| `ui.toast` / `ui.navigate` | `ui` |
| `points.award` | `points` |
| `rt.publish` | `realtime` |
| `schedule.add` / `schedule.cancel` | `schedule` |

Two rules that decide whether a leaderboard is worth anything:

- **Only a handler can write the shared area.** A member's `kv.set` always lands in their own namespace. This is why `kv.shared` can be trusted.
- **A broadcast is a signal, never state.** Clients receiving `rt.publish` re-render through the permission-checked path; the broadcast payload is never used as data.

`context` is implicit. `post.read` / `post.write` / `notify` are registered but **not wired up** — do not request them.

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

## Checklist before upload

- [ ] `render` exported; every handler returns `{ blocks, state, effects }`
- [ ] `ctx.user === null` handled
- [ ] No `fetch`, no `node:` imports, no `window`/`document`/`localStorage`
- [ ] Every attribute value is inside the allowed enumeration
- [ ] `scopes` lists exactly what the effects need — nothing more
- [ ] Anything competitive is decided by the handler, never sent by the client
- [ ] `placement` matches whether the app has shared state
- [ ] `nodeloc-apps dev` is clean
