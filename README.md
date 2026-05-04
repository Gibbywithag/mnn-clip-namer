# MNN Clip Namer

Drag-and-drop desktop app (Mac + Windows) that uses **OpenAI gpt-4o-mini** to analyze video clips and propose descriptive filenames like `granicus-wide-shot-council-chambers`.

**End-user experience:** Download → open → drop clips → done. No accounts, no API keys, no setup.

## How it works

```
Desktop App (Mac/Win)
     │  sends ~4 keyframe JPEGs per clip
     ▼
Cloudflare Worker (free, yours)
     │  holds the OpenAI API key
     ▼
gpt-4o-mini (vision)  →  subject-technique-setting
```

The Cloudflare Worker is the "zero-setup" magic — your OpenAI API key lives there, not in the app. End users never touch a key.

**Cost:** ~$0.001 per clip with 4 keyframes (~$1 per 1,000 clips). Tier-1 OpenAI accounts get 500 RPM and 200K TPM — effectively unlimited for clip naming.

## Quick start — two one-time setups

### A. Deploy the Worker (5 minutes, once)

See [`worker/README.md`](./worker/README.md). Output: a URL like `https://mnn-clip-namer.you.workers.dev` and a random shared secret.

### B. Build the desktop app with your Worker baked in

```bash
npm install

export MNN_DEFAULT_PROXY_URL="https://mnn-clip-namer.YOUR-SUBDOMAIN.workers.dev"
export MNN_CLIENT_SHARED_SECRET="the-secret-from-worker-setup"

# Mac installer (.dmg):
npm run build:mac

# Windows installer (.exe) — can be built on Mac or Windows:
npm run build:win

# Both end up in ./release/
```

Share the `.dmg` (Mac) or `.exe` (Windows) with anyone. Installer included — no Node, Python, or other deps required. ffmpeg is bundled per-OS.

### C. Push to GitHub + download Windows build on another PC

1. Install GitHub CLI once: `brew install gh`
2. Build the Windows installer (works from Mac too): `npm run build:win`
3. Run:

```bash
chmod +x scripts/github-publish.sh
./scripts/github-publish.sh
```

The script logs you into GitHub in the browser (first time only), creates a **private** repo, pushes this source tree, and attaches **`release/MNN Clip Namer Setup <version>.exe`** to **Releases**.

Optional — skip the repo-name prompt:

```bash
GITHUB_REPO_NAME=my-org-mnn-clip-namer ./scripts/github-publish.sh
```

On your work laptop: open the repo in the browser → **Releases** → download the `.exe`.

> **Privacy:** `electron/services/buildConfig.ts` contains your Worker URL and shared client secret baked into installers. Treat the repo as **private** unless you rotate those values.

## Development

```bash
# Start in dev mode (hot reload):
npm run dev
```

In Settings you can toggle between "Use the MNN proxy" (default) and "Use my own OpenAI API key" (for local testing without the worker).

## Features

- **Drag-drop** from Finder/Explorer, or drop files onto the app icon
- **Live thumbnails** from first keyframe
- **Inline name editing** with live template preview
- **Confidence badges** (high/medium/low) from gpt-4o-mini
- **Concurrency control** (1–5 parallel clips, configurable)
- **Retry with exponential backoff** for 429/5xx
- **Undo last rename batch** (persisted history ledger)
- **Rename in place** OR **Copy to folder** modes
- **CSV export** of rename map
- **Backend health indicator** in the title bar
- **Automatic fallback** to a user-provided key if the proxy is down

## Project structure

```
mnn-clip-namer/
├── electron/              Main process (Node)
│   ├── main.ts            App lifecycle, IPC, p-limit concurrency
│   ├── preload.ts         contextBridge API
│   └── services/
│       ├── ffmpeg.ts      Keyframe + thumbnail extraction
│       ├── ffprobe.ts     Metadata probe
│       ├── openai.ts      Proxy + direct-API client with retry
│       ├── namer.ts       Filename template + sanitization
│       ├── renamer.ts     Atomic rename + history ledger + CSV
│       ├── keychain.ts    keytar wrapper
│       ├── settings.ts    JSON persistence
│       └── buildConfig.ts Reads env vars at build time
├── shared/
│   └── types.ts           Shared IPC contract
├── src/                   Renderer (React + TS)
│   ├── App.tsx
│   └── components/        DropZone, ClipTable, ClipRow, SettingsPanel, OnboardingModal, Toast
├── worker/                Cloudflare Worker
│   ├── src/index.ts
│   ├── wrangler.toml
│   └── README.md          ← deploy instructions
└── README.md              you are here
```

## Privacy

- Video files never leave your machine except for 4 small (~50 KB each) keyframe JPEGs per clip.
- Those JPEGs go to your Worker → OpenAI gpt-4o-mini. OpenAI processes and returns a filename.
- API key and shared secret are build-time constants baked into the installer — they never appear in user settings, logs, or on disk in plain text. They are theoretically extractable from the installer by a determined attacker; for more sensitive deployments add Cloudflare Access in front of the Worker.
- No telemetry.

## Code signing (optional, recommended for wide sharing)

Without code signing, users will see:
- **Mac**: "cannot be opened because it is from an unidentified developer" — workaround: right-click → Open the first time.
- **Windows**: SmartScreen warning — workaround: "More info" → "Run anyway".

For frictionless distribution:
- **Apple Developer account** ($99/year) + `electron-builder` notarization config
- **Windows code signing certificate** (~$200/year from Sectigo, DigiCert, etc.)

Not required for internal MNN sharing.

## License

UNLICENSED — internal MNN use.
