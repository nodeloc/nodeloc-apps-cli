/**
 * A starting point. Both handlers run on the server, in a sandbox with no
 * network and no disk — everything they can reach arrives through `api`.
 */

function screen(count) {
  return {
    type: "vstack",
    gap: "small",
    align: "center",
    padding: "medium",
    children: [
      { type: "text", value: `Clicked ${count} times`, size: "large", weight: "bold" },
      { type: "button", label: "Click me", action: "bump", variant: "primary" },
    ],
  };
}

export async function render(ctx, api) {
  const count = (await api.kv.get("count")) ?? 0;
  return { blocks: screen(count), state: { count }, effects: [] };
}

export async function onAction(ctx, api) {
  if (ctx.action_id !== "bump") {
    return { blocks: screen(ctx.state?.count ?? 0), state: ctx.state, effects: [] };
  }

  const count = (ctx.state?.count ?? 0) + 1;

  return {
    blocks: screen(count),
    state: { count },
    // Writes are declared, not performed: the site checks each one against the
    // permissions this app was granted before anything is saved.
    effects: [{ type: "kv.set", key: "count", value: count }],
  };
}
