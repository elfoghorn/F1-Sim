/* F1 SIM on Cloudflare Workers: serves the site from site/ and runs the Discord relay at /api/discord.
   The relay itself is functions/api/discord.js, shared with the Cloudflare Pages set-up. */
import { onRequestGet, onRequestPost } from '../functions/api/discord.js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/discord' || url.pathname === '/api/discord/') {
      if (request.method === 'GET') return onRequestGet({ request, env });
      if (request.method === 'POST') return onRequestPost({ request, env });
      return new Response(JSON.stringify({ error: 'Method not allowed.' }), { status: 405, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.pathname.startsWith('/api/')) return new Response(JSON.stringify({ error: 'Not found.' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
    return env.ASSETS.fetch(request);
  }
};
