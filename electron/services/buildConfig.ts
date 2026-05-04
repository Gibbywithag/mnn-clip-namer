/**
 * Build-time defaults baked into the Electron app.
 *
 * These values are hardcoded. To rotate, edit here AND update the
 * Cloudflare Worker secret via:
 *   wrangler secret put SHARED_SECRET
 */
export const DEFAULT_PROXY_URL = 'https://mnn-clip-namer.gilbranlaureano0417.workers.dev';
export const CLIENT_SHARED_SECRET =
  'd4cd8e0877808df9eb61a1340dff9a9799c5e1b78a2371c256134db8bf196a6c';
