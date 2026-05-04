# MNN Clip Namer — Cloudflare Worker

This tiny Cloudflare Worker is the "backend" that lets the Electron app be **zero-setup for end users**. It proxies requests from the app to OpenAI's `gpt-4o-mini` (vision) API. Your OpenAI API key lives on the worker, never on users' machines.

## One-time deploy (~5 min)

You'll do this **once**. Everyone who installs the desktop app will automatically use your worker.

### 1. Install wrangler (Cloudflare's CLI)

```bash
cd worker
npm install
```

### 2. Log into Cloudflare

```bash
npx wrangler login
```

A browser window opens → sign in → allow → you're back in the terminal.

### 3. Set your two secrets

**Get an OpenAI API key:** <https://platform.openai.com/api-keys> — requires a card on file. Free $5 trial credit on new accounts; after that pay-as-you-go.

**Generate a shared secret** (anything random, but the app will need to match it):
```bash
openssl rand -hex 32
```
Copy both values, then:

```bash
npx wrangler secret put OPENAI_API_KEY
# paste your OpenAI API key (sk-...)

npx wrangler secret put SHARED_SECRET
# paste your random 64-char hex string
```

> **Migrating from the old Gemini-based worker?** Delete the now-unused secret with `npx wrangler secret delete GOOGLE_API_KEY`.

### 4. Deploy

```bash
npx wrangler deploy
```

Output looks like:
```
Published mnn-clip-namer (1.23 sec)
  https://mnn-clip-namer.YOUR-SUBDOMAIN.workers.dev
```

Save that URL. You'll bake it into the Electron app.

### 5. Test it

```bash
curl https://mnn-clip-namer.YOUR-SUBDOMAIN.workers.dev/health
# → {"ok":true,"model":"gpt-4o-mini","provider":"openai"}
```

## Connecting the Electron app

In the `mnn-clip-namer/` directory, set two env vars when you build:

```bash
export MNN_DEFAULT_PROXY_URL="https://mnn-clip-namer.YOUR-SUBDOMAIN.workers.dev"
export MNN_CLIENT_SHARED_SECRET="the-same-hex-string-from-step-3"

npm run build:mac   # produces release/*.dmg
npm run build:win   # produces release/*.exe (run on Windows)
```

End users download the installer, open it, drop clips. Zero config.

## Costs

**Cloudflare Workers free tier:**
- 100,000 requests/day (1 request per clip)
- Unlimited bandwidth
- 99.99% uptime globally

**OpenAI `gpt-4o-mini` (vision):**
- $0.15 per 1M input tokens, $0.60 per 1M output tokens
- ~$0.001 per clip with 4 keyframes at `detail: low` (~$1 per 1,000 clips)
- Tier 1 (default after first payment): 500 RPM, 200K TPM — effectively unlimited for clip naming

## Abuse protection

The `SHARED_SECRET` header prevents random people from finding the URL and burning your quota. A determined attacker could extract the secret from the `.dmg`/`.exe` (it's baked in), so for stronger protection you can also:

1. Add Cloudflare's built-in per-IP rate limiting (see the commented section in `wrangler.toml`)
2. Add a Cloudflare Access policy to require authentication
3. Restrict the Worker to specific IP ranges (if your users are all on your corporate network)

For normal MNN-internal sharing, the shared secret is plenty.

## Updating later

Edit `src/index.ts`, then:

```bash
npx wrangler deploy
```

Changes take ~10 seconds to roll out globally.

## Rotating the OpenAI API key

If your OpenAI key leaks or you want to rotate:

```bash
npx wrangler secret put OPENAI_API_KEY
# paste the new one
```

No need to rebuild or redistribute the desktop app — the worker is the only thing that needs updating.
