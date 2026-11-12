/* =====================================================================
   F1 SIM — Discord relay (a Cloudflare Pages Function at /api/discord).
   Discord doesn't accept posts straight from a web page, so the site sends
   them here and this passes them on. The Discord webhook addresses live in
   Cloudflare as encrypted secrets: players never see them, and nothing about
   them is in the code or the database.

   Only Race Control can post: each request carries the signed-in
   person's Supabase session, and Supabase itself confirms the role.

   Webhooks (Cloudflare → your Pages project → Settings → Variables and Secrets):
     DISCORD_WEBHOOK            the default channel
     DISCORD_WEBHOOK_<NAME>     any extra channels, e.g. DISCORD_WEBHOOK_BRIEFINGS
   ===================================================================== */

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
const MAX_FILE = 9.5 * 1024 * 1024;

/* The channels set up in Cloudflare, by name. Webhook addresses never leave this function.
   Forgiving about how the address was pasted: quotes, spaces, a trailing slash or query, an API version. */
const HOOK = /^https:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/api\/(?:v\d+\/)?webhooks\/(\d+)\/([\w-]+)/;
function cleanHook(v) {
  const m = String(v || '').trim().replace(/^["'<]+|["'>]+$/g, '').match(HOOK);
  return m ? `https://discord.com/api/webhooks/${m[1]}/${m[2]}` : null;
}
function channels(env) {
  const out = {};
  for (const [k, v] of Object.entries(env || {})) {
    const key = k.trim().toUpperCase();
    if (typeof v !== 'string' || !key.startsWith('DISCORD_WEBHOOK')) continue;
    const url = cleanHook(v); if (!url) continue;
    const name = key === 'DISCORD_WEBHOOK' ? 'default' : key.replace(/^DISCORD_WEBHOOK_?/, '').toLowerCase().replace(/_/g, '-');
    if (name) out[name] = url;
  }
  return out;
}
/* For "nothing set up" answers: which DISCORD settings this Worker can see and why each was skipped. Names only, never values. */
function diagnose(env) {
  const seen = Object.keys(env || {}).filter(k => /discord/i.test(k));
  if (!seen.length) return 'This site can’t see any setting with DISCORD in its name. Check the secret is on this Worker (the one serving this domain), named DISCORD_WEBHOOK, then redeploy.';
  return 'Settings found: ' + seen.map(k => {
    const v = env[k];
    if (typeof v !== 'string') return `${k} (not text)`;
    if (!/^DISCORD_WEBHOOK/i.test(k.trim())) return `${k} (name must be DISCORD_WEBHOOK)`;
    return cleanHook(v) ? `${k} (OK)` : `${k} (value isn’t a Discord webhook address: copy it again from Discord)`;
  }).join('; ') + '.';
}

/* The site's Supabase address and publishable key, read from the published config.js. */
async function supabaseConfig(env, request) {
  if (env.SUPABASE_URL && env.SUPABASE_KEY) return { url: env.SUPABASE_URL, key: env.SUPABASE_KEY };
  const res = await env.ASSETS.fetch(new URL('/config.js', request.url));
  const text = await res.text();
  const url = (text.match(/supabaseUrl:\s*'([^']+)'/) || [])[1], key = (text.match(/publishableKey:\s*'([^']+)'/) || [])[1];
  if (!url || !key) throw new Error('config.js has no Supabase settings');
  return { url: url.replace(/\/+$/, ''), key };
}

/* Supabase answers is_gm() for the person whose session this is: the Administrator or a Moderator. */
async function isRaceControl(env, request) {
  const auth = request.headers.get('Authorization') || '';
  if (!/^Bearer\s+\S+$/.test(auth)) return false;
  const sb = await supabaseConfig(env, request);
  const r = await fetch(sb.url + '/rest/v1/rpc/is_gm', { method: 'POST', headers: { apikey: sb.key, Authorization: auth, 'Content-Type': 'application/json' }, body: '{}' });
  if (!r.ok) return false;
  return (await r.json()) === true;
}

/* A player named by Discord username becomes a real @mention when a bot is set up
   (DISCORD_BOT_TOKEN and DISCORD_GUILD_ID); otherwise the username is written as plain text. */
async function findMember(env, username) {
  if (!env.DISCORD_BOT_TOKEN || !env.DISCORD_GUILD_ID) return null;
  const q = username.toLowerCase();
  const r = await fetch(`https://discord.com/api/v10/guilds/${encodeURIComponent(env.DISCORD_GUILD_ID)}/members/search?query=${encodeURIComponent(q)}&limit=10`,
    { headers: { Authorization: 'Bot ' + env.DISCORD_BOT_TOKEN } });
  if (!r.ok) return null;
  const list = await r.json().catch(() => []);
  const exact = m => m && m.user && String(m.user.username || '').toLowerCase() === q;
  const named = m => m && m.user && (String(m.user.global_name || '').toLowerCase() === q || String(m.nick || '').toLowerCase() === q);
  const hit = (Array.isArray(list) ? list : []).find(exact) || (Array.isArray(list) ? list : []).find(named);
  return hit && /^\d{15,21}$/.test(String(hit.user.id)) ? String(hit.user.id) : null;
}

export async function onRequestGet({ request, env }) {
  try { if (!(await isRaceControl(env, request))) return reply(403, { error: 'Only Race Control can post to Discord.' }); }
  catch (e) { return reply(500, { error: 'Couldn’t check your access: ' + e.message }); }
  const names = Object.keys(channels(env));
  return reply(200, names.length ? { channels: names } : { channels: [], hint: diagnose(env) });
}

export async function onRequestPost({ request, env }) {
  try { if (!(await isRaceControl(env, request))) return reply(403, { error: 'Only Race Control can post to Discord.' }); }
  catch (e) { return reply(500, { error: 'Couldn’t check your access: ' + e.message }); }
  const hooks = channels(env);
  if (!Object.keys(hooks).length) return reply(503, { error: 'No Discord webhook is set up yet. ' + diagnose(env) });

  let form;
  try { form = await request.formData(); } catch (e) { return reply(400, { error: 'The post couldn’t be read.' }); }
  const name = String(form.get('channel') || 'default');
  const hook = hooks[name];
  if (!hook) return reply(400, { error: `There is no Discord channel called “${name}”.` });

  let payload;
  try { payload = JSON.parse(String(form.get('payload_json') || '{}')); } catch (e) { return reply(400, { error: 'The message isn’t valid.' }); }
  const clean = {
    content: String(payload.content || '').slice(0, 2000),
    username: payload.username ? String(payload.username).slice(0, 80) : undefined,
    embeds: Array.isArray(payload.embeds) ? payload.embeds.slice(0, 4) : [],
    allowed_mentions: { parse: ['everyone', 'roles'] }
  };
  /* Pinging a person needs their numeric Discord user ID, listed explicitly. */
  const users = (Array.isArray(payload.allowed_users) ? payload.allowed_users : []).map(String).filter(u => /^\d{15,21}$/.test(u)).slice(0, 10);
  if (users.length) clean.allowed_mentions.users = users;
  /* Or by Discord username: looked up through the bot when there is one. */
  let mentioned = null;
  const who = String(payload.mention_username || '').trim().replace(/^@+/, '').replace(/#\d{4}$/, '').slice(0, 40);
  if (who) {
    let id = null; try { id = await findMember(env, who); } catch (e) { id = null; }
    if (id) { clean.content = `<@${id}> ` + clean.content; clean.allowed_mentions.users = [id].concat(users).slice(0, 10); mentioned = true; }
    else { clean.content = `@${who} ` + clean.content; mentioned = false; }
    clean.content = clean.content.slice(0, 2000);
  }
  const out = new FormData();
  const file = form.get('file');
  if (file && typeof file === 'object') {
    if (file.size > MAX_FILE) return reply(413, { error: 'The image is too large for Discord (over 9.5 MB).' });
    if (!/^image\/(png|jpeg|webp)$/.test(file.type)) return reply(400, { error: 'Only images can be attached.' });
    const fname = String(file.name || 'image.png').replace(/[^\w.-]+/g, '-').slice(0, 80);
    clean.attachments = [{ id: 0, filename: fname }];
    out.append('files[0]', file, fname);
  }
  out.append('payload_json', JSON.stringify(clean));

  /* Editing a message this webhook posted earlier (the grid kept up to date): the attachments are replaced. */
  const edit = String(form.get('edit') || '');
  const editing = /^\d{15,21}$/.test(edit);
  const r = await fetch(editing ? `${hook}/messages/${edit}?wait=true` : hook + '?wait=true', { method: editing ? 'PATCH' : 'POST', body: out });
  if (editing && r.status === 404) return reply(404, { error: 'That Discord message is gone; post a new one.', gone: true });
  if (r.status === 429) { const j = await r.json().catch(() => ({})); return reply(429, { error: `Discord is rate-limiting posts. Try again in ${Math.ceil(Number(j.retry_after) || 5)} seconds.` }); }
  if (!r.ok) { const t = await r.text().catch(() => ''); return reply(502, { error: `Discord refused the post (${r.status}).`, detail: t.slice(0, 300) }); }
  const msg = await r.json().catch(() => ({}));
  return reply(200, { ok: true, channel: name, messageId: msg.id || null, edited: editing, mentioned, bot: !!(env.DISCORD_BOT_TOKEN && env.DISCORD_GUILD_ID) });
}
