import type { ClipMetadata, NameParts, Settings } from '../../shared/types';
import { CLIENT_SHARED_SECRET } from './buildConfig';

interface AnalyzeArgs {
  frames: Buffer[];
  metadata: ClipMetadata;
  settings: Settings;
  apiKey?: string | null;
  /**
   * Optional progress hook the caller can use to surface intermediate state
   * (e.g. "rate limited — retrying in 8s") while we wait inside retry sleeps.
   */
  onProgress?: (message: string) => void;
}

/**
 * Hard cap on total retry/wait time per clip. Beyond this we give up and let
 * the user click ↻ themselves rather than spending minutes silently looking
 * "analyzing" while a quota is exhausted.
 */
const MAX_TOTAL_RETRY_MS = 90_000;

// gpt-4o-mini supports vision + structured outputs (json_schema) and is the
// cheapest tier-suitable vision model: $0.15/M input, $0.60/M output.
// Tier-1 limits are 500 RPM / 200K TPM — effectively unlimited for clip naming.
const OPENAI_MODEL = 'gpt-4o-mini';
const OPENAI_API_URL = 'https://api.openai.com/v1/chat/completions';

const SYSTEM_INSTRUCTION = `You generate concise, distinctive filenames for video clips.
You will receive N keyframes sampled evenly across a clip, plus technical metadata.
Return strictly valid JSON matching the provided schema.

Guiding principle: the proposed name must be specific enough to distinguish THIS clip
from 100 visually similar clips on the same drive. Generic, reusable names are wrong.

Rules for each field:
- subject: 2 to 3 short words, hyphen-separated, lowercase. Follow [actor]-[action] or
  [object]-[state] when humans are visible: "mayor-budget-speech", "chef-plating-dish",
  "goalie-saves-shot", "ribbon-cutting-ceremony", "fans-rushing-field". For non-human
  subjects, prefer [thing]-[notable-quality]: "skyline-night-traffic",
  "harvest-pumpkin-display", "construction-crane-lift". Avoid bare 1-word subjects unless
  they are a distinctive proper noun (e.g. "granicus", a brand name visible on screen).
- technique: 1 to 2 words, lowercase. One of: "wide-shot", "closeup", "medium-shot",
  "handheld", "tripod-locked", "tracking", "dolly", "drone-aerial", "timelapse", "slowmo",
  "interview", "podium-mounted", "bts" (behind-the-scenes), "broll", "static",
  "selfie-facing", "over-shoulder".
- setting: 2 to 3 words, hyphen-separated, lowercase. Name a recognizable venue,
  neighborhood, or geographic feature when visible: "city-hall-steps", "home-kitchen-counter",
  "highway-overpass-sunset", "stadium-end-zone", "school-gym-floor", "downtown-storefront".
  Do not use bare "indoors", "outdoors", "park", "office", "studio" — always pair with a
  qualifier. If the location is genuinely unidentifiable, use the dominant visual feature
  ("brick-wall-mural", "tree-lined-street", "open-water-horizon").
- confidence: "high" if the frames clearly show what each field describes, "medium" if you
  inferred some parts, "low" if mostly guessing.
- notes: empty string unless the clip is ambiguous or you spotted something important the
  user might want to know (e.g. "no audio cues — names guessed from jersey colors").

Method:
1. Read EVERY piece of visible text first: chyron lower-thirds, scoreboards, banners,
   signs, jerseys, name plates, on-screen graphics, logos. Names of people, places, and
   events from text are gold — use them.
2. Identify the single most distinctive element in the frames and put it in "subject".
3. Use uniforms, props, architecture, time-of-day, and weather as setting cues.
4. Drop filler words: "the", "a", "and", "of", "in", "with", "at".

Forbidden in any field (these are all too generic when used alone):
"people", "person", "video", "clip", "footage", "scene", "shot", "moment", "thing",
"stuff", "view", "general", "various", "misc". They may appear only as part of a
specific compound (e.g. "wide-shot" is fine because "wide" qualifies it).

Never include spaces, underscores, file extensions, or any punctuation other than hyphens.`;

/**
 * JSON Schema for OpenAI Structured Outputs. `strict: true` means the model is
 * guaranteed to return a value matching this schema exactly — no JSON parsing
 * surprises, no missing fields.
 */
const RESPONSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    subject: { type: 'string' },
    technique: { type: 'string' },
    setting: { type: 'string' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    notes: { type: 'string' },
  },
  // OpenAI strict mode requires every key to be in `required`. `notes` is
  // optional in spirit, so we let the model emit an empty string for it.
  required: ['subject', 'technique', 'setting', 'confidence', 'notes'],
} as const;

class RateLimitError extends Error {
  retryAfterSec: number | null;
  constructor(message: string, retryAfterSec: number | null) {
    super(message);
    this.retryAfterSec = retryAfterSec;
  }
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Sleep but emit countdown progress every second so the UI can show
 * "rate limited — retrying in Xs". Returns when ms elapse.
 */
async function sleepWithCountdown(
  ms: number,
  label: string,
  onProgress?: (m: string) => void,
): Promise<void> {
  const end = Date.now() + ms;
  while (true) {
    const remaining = end - Date.now();
    if (remaining <= 0) return;
    const secs = Math.ceil(remaining / 1000);
    onProgress?.(`${label} ${secs}s`);
    await sleep(Math.min(1000, remaining));
  }
}

// --- Light pacing --------------------------------------------------------
// OpenAI tier-1 is 500 RPM (~8/sec). With concurrency=3 and ~1-2s per call
// we won't come close, so a tiny floor (200ms) is enough to avoid microbursts.
const MIN_REQUEST_GAP_MS = 200;
let nextAvailableAt = 0;
let pacingChain: Promise<void> = Promise.resolve();

async function paceRequest(onProgress?: (m: string) => void): Promise<void> {
  const wait = pacingChain.then(async () => {
    const now = Date.now();
    if (now < nextAvailableAt) {
      const ms = nextAvailableAt - now;
      if (ms > 1500) {
        await sleepWithCountdown(ms, 'waiting for rate-limit window', onProgress);
      } else {
        await sleep(ms);
      }
    }
    nextAvailableAt = Math.max(Date.now(), nextAvailableAt) + MIN_REQUEST_GAP_MS;
  });
  pacingChain = wait.catch(() => undefined);
  return wait;
}

function validate(parsed: Partial<NameParts>): NameParts {
  if (!parsed.subject || !parsed.technique || !parsed.setting) {
    throw new Error('Response missing required fields (subject/technique/setting)');
  }
  const confidence: NameParts['confidence'] =
    parsed.confidence && ['high', 'medium', 'low'].includes(parsed.confidence)
      ? parsed.confidence
      : 'medium';
  return {
    subject: parsed.subject,
    technique: parsed.technique,
    setting: parsed.setting,
    confidence,
    // Treat empty-string notes (forced by strict schema) as undefined.
    notes: parsed.notes && parsed.notes.length > 0 ? parsed.notes : undefined,
  };
}

/** Parse Retry-After from header or body. Returns seconds. */
function extractRetryAfter(headerVal: string | null, body: string): number | null {
  if (headerVal) {
    const n = parseFloat(headerVal);
    if (!isNaN(n)) return Math.ceil(n);
  }
  // OpenAI sometimes embeds "Please try again in 1.234s." in the error message.
  const m = body.match(/try again in ([\d.]+)\s*s/i);
  if (m) return Math.ceil(parseFloat(m[1]));
  // Worker-forwarded shape: { retryAfterSec: number }
  try {
    const j = JSON.parse(body) as { retryAfterSec?: number; detail?: string };
    if (typeof j.retryAfterSec === 'number') return j.retryAfterSec;
    if (typeof j.detail === 'string') return extractRetryAfter(null, j.detail);
  } catch {
    /* not JSON */
  }
  return null;
}

/**
 * Retry wrapper. Honors Retry-After (from server) when present and bails out
 * once total retry/wait time exceeds MAX_TOTAL_RETRY_MS — better to fail fast
 * and let the user re-trigger than to spin invisibly for minutes.
 */
async function withRetry<T>(
  fn: () => Promise<T>,
  onProgress?: (message: string) => void,
  attempts = 6,
): Promise<T> {
  let lastErr: unknown;
  const startedAt = Date.now();
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err: unknown) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      const isRateLimit = err instanceof RateLimitError;
      const is429 = isRateLimit || /\b429\b|rate[- ]?limit|quota/i.test(msg);
      const is5xx = /\b5\d\d\b|overloaded|temporarily|upstream/i.test(msg);
      const isNetwork =
        /fetch failed|ENOTFOUND|ECONNRESET|ECONNREFUSED|ETIMEDOUT|socket hang up|network/i.test(
          msg,
        );
      if (!is429 && !is5xx && !isNetwork) throw err;

      let delay: number;
      if (isRateLimit && err.retryAfterSec != null) {
        delay = err.retryAfterSec * 1000 + 500;
      } else {
        const base = is429 ? 2000 : 800;
        delay = Math.min(base * Math.pow(2, i), 30_000) + Math.random() * 500;
      }

      const elapsed = Date.now() - startedAt;
      const budgetLeft = MAX_TOTAL_RETRY_MS - elapsed;
      const isLastAttempt = i === attempts - 1;

      if (isLastAttempt || delay > budgetLeft) {
        if (is429) {
          throw new Error(
            `OpenAI rate limited — could not get a slot within ${Math.round(MAX_TOTAL_RETRY_MS / 1000)}s. ` +
              `Check your usage/billing at platform.openai.com, then click ↻.`,
          );
        }
        throw err;
      }

      nextAvailableAt = Math.max(nextAvailableAt, Date.now() + delay);
      const label = is429 ? 'rate limited — retrying in' : 'retrying in';
      await sleepWithCountdown(delay, label, onProgress);
    }
  }
  throw lastErr;
}

/** Build the `messages` array OpenAI expects for a vision + JSON request. */
function buildMessages(
  frames: Buffer[],
  metadata: ClipMetadata,
): Array<{ role: 'system' | 'user'; content: unknown }> {
  const rec =
    metadata.recordedAtUtc != null ? `, recorded(UTC)=${metadata.recordedAtUtc}` : '';
  const metaLine = `Metadata: duration=${metadata.durationSec.toFixed(1)}s, ${metadata.width}x${metadata.height}, ${metadata.fps.toFixed(1)}fps, codec=${metadata.codec}${rec}.`;
  const framesLine = `Frames provided: ${frames.length}, sampled evenly across the timeline (earliest first).`;

  const userContent: Array<
    | { type: 'text'; text: string }
    | { type: 'image_url'; image_url: { url: string; detail?: 'low' | 'high' | 'auto' } }
  > = [
    {
      type: 'text',
      text: `${metaLine}\n${framesLine}\n\nAnalyze the clip and produce the filename parts.`,
    },
  ];
  for (const buf of frames) {
    userContent.push({
      type: 'image_url',
      image_url: {
        url: `data:image/jpeg;base64,${buf.toString('base64')}`,
        // `low` = 85 tokens fixed cost per image. Plenty of detail for naming
        // and keeps cost predictable at ~$0.0006/clip with 4 frames.
        detail: 'low',
      },
    });
  }

  return [
    { role: 'system', content: SYSTEM_INSTRUCTION },
    { role: 'user', content: userContent },
  ];
}

/** Pull the JSON string out of an OpenAI Chat Completion response. */
function extractContent(data: unknown): string | null {
  const d = data as {
    choices?: Array<{ message?: { content?: string | null; refusal?: string | null } }>;
  };
  const choice = d.choices?.[0]?.message;
  if (!choice) return null;
  if (choice.refusal) {
    throw new Error(`OpenAI refused: ${choice.refusal.slice(0, 200)}`);
  }
  return choice.content ?? null;
}

async function analyzeViaProxy(
  frames: Buffer[],
  metadata: ClipMetadata,
  proxyUrl: string,
  onProgress?: (m: string) => void,
): Promise<NameParts> {
  const url = `${proxyUrl.replace(/\/$/, '')}/analyze`;
  return withRetry(async () => {
    await paceRequest(onProgress);
    onProgress?.('contacting analyzer');
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shared-Secret': CLIENT_SHARED_SECRET,
      },
      body: JSON.stringify({
        frames: frames.map((f) => f.toString('base64')),
        metadata: {
          durationSec: metadata.durationSec,
          width: metadata.width,
          height: metadata.height,
          fps: metadata.fps,
          codec: metadata.codec,
          ...(metadata.recordedAtUtc ? { recordedAtUtc: metadata.recordedAtUtc } : {}),
        },
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      if (res.status === 429) {
        const retryAfter = extractRetryAfter(res.headers.get('Retry-After'), text);
        throw new RateLimitError(
          `Rate limited (429). ${retryAfter ? `Retrying in ${retryAfter}s.` : ''}`,
          retryAfter,
        );
      }
      throw new Error(`Proxy error ${res.status}: ${text.slice(0, 200)}`);
    }
    const parsed = (await res.json()) as Partial<NameParts>;
    return validate(parsed);
  }, onProgress);
}

async function analyzeViaDirect(
  frames: Buffer[],
  metadata: ClipMetadata,
  apiKey: string,
  onProgress?: (m: string) => void,
): Promise<NameParts> {
  return withRetry(async () => {
    await paceRequest(onProgress);
    onProgress?.('contacting analyzer');
    const messages = buildMessages(frames, metadata);
    const res = await fetch(OPENAI_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        // Low temperature pushes the model toward the most-supported, specific name
        // rather than creative variants. Repeated runs on the same clip will be stable.
        temperature: 0.2,
        messages,
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'clip_name_parts',
            strict: true,
            schema: RESPONSE_SCHEMA,
          },
        },
      }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      if (res.status === 429) {
        const retryAfter = extractRetryAfter(res.headers.get('Retry-After'), text);
        throw new RateLimitError(
          `Rate limited (429). ${retryAfter ? `Retrying in ${retryAfter}s.` : ''}`,
          retryAfter,
        );
      }
      if (res.status === 401) {
        throw new Error('OpenAI rejected the API key (401). Open Settings to update it.');
      }
      throw new Error(`OpenAI error ${res.status}: ${text.slice(0, 200)}`);
    }

    const data = await res.json();
    const content = extractContent(data);
    if (!content) {
      throw new Error('OpenAI returned an empty response.');
    }
    let parsed: Partial<NameParts>;
    try {
      parsed = JSON.parse(content) as Partial<NameParts>;
    } catch {
      throw new Error(`OpenAI returned unparseable JSON: ${content.slice(0, 200)}`);
    }
    return validate(parsed);
  }, onProgress);
}

export async function analyzeClip({
  frames,
  metadata,
  settings,
  apiKey,
  onProgress,
}: AnalyzeArgs): Promise<NameParts> {
  if (settings.backendMode === 'proxy') {
    if (!settings.proxyUrl) {
      throw new Error('Proxy URL not set. Open Settings to configure.');
    }
    return analyzeViaProxy(frames, metadata, settings.proxyUrl, onProgress);
  }
  if (!apiKey) {
    throw new Error('No OpenAI API key set. Open Settings to add one.');
  }
  return analyzeViaDirect(frames, metadata, apiKey, onProgress);
}
