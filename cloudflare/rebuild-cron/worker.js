// Triggers a Cloudflare Pages rebuild shortly after each UTC midnight, so the day that
// just ended gets its prerendered sources page and sitemap entry. The deploy hook URL
// is a secret: `npx wrangler secret put DEPLOY_HOOK_URL`.
export default {
  async scheduled(_event, env) {
    const response = await fetch(env.DEPLOY_HOOK_URL, { method: 'POST' });
    if (!response.ok) throw new Error(`Deploy hook failed: ${response.status}`);
  },
};
