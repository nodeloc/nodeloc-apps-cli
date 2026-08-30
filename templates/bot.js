/**
 * A bot that welcomes the first topic each member opens.
 *
 * There is no `render` here and nothing to press: a service app has no
 * interface. It is woken by the site events named in app.json, runs under an
 * account of its own, and everything it wants to change comes back as effects
 * for the site to check and commit.
 *
 * Reads are prefetched. `api.post.get` and `api.topic.get` answer for the post
 * and topic this run is about; any other id comes back null, which is what
 * keeps a bot installed in one place from reading its way across the site.
 */

const GREETED = "greeted:";

export async function onTrigger(ctx, api) {
  if (ctx.event !== "topic_created") {
    return { effects: [] };
  }

  const topic = await api.topic.get(ctx.data.topic_id);
  const post = await api.post.get(ctx.data.post_id);
  if (!topic || !post) {
    return { effects: [] };
  }

  // A background run reads and writes the app's own shared area, so this is
  // the bot's memory rather than any one member's.
  const key = `${GREETED}${post.user_id}`;
  if (await api.kv.get(key)) {
    return { effects: [] };
  }

  return {
    effects: [
      { type: "kv.set", key, value: topic.id },
      {
        type: "post.reply",
        topic_id: topic.id,
        raw: `Welcome, @${post.username}. This is your first topic here — someone will be along shortly.`,
      },
    ],
  };
}
