/**
 * A multiplayer round: whoever presses first claims it.
 *
 * The thing worth copying here is where the decision is made. The client sends
 * "I pressed", never "I won" and never a score — the handler reads the shared
 * round from storage, decides, and declares what should change. A player who
 * edits anything in their browser is still only sending "I pressed".
 */

function screen({ round, holder, you, scores }) {
  const leaderboard = Object.entries(scores ?? {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name, score]) => ({
      type: "text",
      value: `${name}: ${score}`,
      size: "small",
    }));

  return {
    type: "vstack",
    gap: "small",
    padding: "medium",
    children: [
      { type: "text", value: `Round ${round}`, weight: "bold", size: "large" },
      {
        type: "text",
        value: holder ? `${holder} took this round` : "Nobody has taken this round yet",
      },
      {
        type: "button",
        label: holder ? "Wait for the next round" : "Take it",
        action: "press",
        variant: "primary",
        disabled: Boolean(holder),
      },
      { type: "divider" },
      { type: "text", value: `Your wins: ${you}`, size: "small" },
      ...leaderboard,
    ],
  };
}

async function load(api) {
  const shared = await api.kv.listPublic();
  const state = shared.find((entry) => entry.key === "round")?.value ?? {
    round: 1,
    holder: null,
    scores: {},
  };
  const you = (await api.kv.get("wins")) ?? 0;
  return { state, you };
}

export async function render(ctx, api) {
  const { state, you } = await load(api);

  return {
    blocks: screen({ ...state, you }),
    state: { round: state.round },
    effects: [],
  };
}

export async function onAction(ctx, api) {
  const { state, you } = await load(api);

  if (ctx.action_id !== "press" || state.holder) {
    return { blocks: screen({ ...state, you }), state: { round: state.round }, effects: [] };
  }

  const name = ctx.user?.username ?? "someone";
  const scores = { ...state.scores, [name]: (state.scores?.[name] ?? 0) + 1 };
  const next = { round: state.round, holder: name, scores };

  return {
    blocks: screen({ ...next, you: you + 1 }),
    state: { round: state.round },
    effects: [
      { type: "kv.set", key: "wins", value: you + 1 },
      { type: "points.award", amount: 1, reason: "took a round" },
      // Everyone else's screen re-renders through the server; this only says
      // that something changed, never what to display.
      { type: "rt.publish", room: "main", data: { round: state.round } },
      // The next round opens on its own, so a stalled game recovers without
      // anyone having to press anything.
      { type: "schedule.add", job_key: "next-round", in_seconds: 60 },
    ],
  };
}

export async function onSchedule(ctx, api) {
  const shared = await api.kv.listPublic();
  const state = shared.find((entry) => entry.key === "round")?.value ?? { round: 1, scores: {} };

  return {
    blocks: null,
    state: null,
    effects: [{ type: "rt.publish", room: "main", data: { round: state.round + 1 } }],
  };
}
