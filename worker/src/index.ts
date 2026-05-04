/**
 * MNN Clip Namer — OpenAI proxy worker.
 *
 * Accepts POST /analyze with { frames: string[] (base64 JPEG), metadata: {...} }
 * and returns OpenAI's structured JSON response. The OpenAI API key never leaves
 * the Worker — the Electron app just calls this endpoint.
 *
 * Required secrets (set via `wrangler secret put`):
 *   - OPENAI_API_KEY   Your OpenAI API key (starts with sk-...)
 *   - SHARED_SECRET    A random string; the Electron app sends it as X-Shared-Secret
 */

interface Env {
  OPENAI_API_KEY: string;
  SHARED_SECRET: string;
}

interface AnalyzeBody {
  frames: string[]; // base64-encoded JPEGs
  metadata: {
    durationSec: number;
    width: number;
    height: number;
    fps: number;
    codec: string;
    /** ISO instant from client ffprobe (creation_time etc.) */
    recordedAtUtc?: string;
  };
}

// gpt-4o-mini supports vision + structured outputs (json_schema).
// Pricing: $0.15/M input, $0.60/M output. Tier-1 limits: 500 RPM / 200K TPM.
// With 4 keyframes at detail=low (~85 tokens each) we land at ~$0.001/clip.
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
 * JSON Schema for OpenAI Structured Outputs (strict mode). Strict mode requires
 * every property to be present in `required`, so `notes` is required but the
 * model is told to use empty string when it has nothing.
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
  required: ['subject', 'technique', 'setting', 'confidence', 'notes'],
};

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Shared-Secret',
  'Access-Control-Expose-Headers': 'Retry-After',
  'Access-Control-Max-Age': '86400',
};

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
}

/**
 * Parse Retry-After from the response. OpenAI's 429s include a `Retry-After`
 * header (in seconds), and may also embed "Please try again in 1.234s" in the
 * error body.
 */
function extractRetryAfterSeconds(headerVal: string | null, body: string): number | null {
  if (headerVal) {
    const n = parseFloat(headerVal);
    if (!isNaN(n)) return Math.ceil(n);
  }
  const m = body.match(/try again in ([\d.]+)\s*s/i);
  if (m) return Math.ceil(parseFloat(m[1]));
  return null;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);

    if (url.pathname === '/health' && request.method === 'GET') {
      return json({ ok: true, model: OPENAI_MODEL, provider: 'openai' });
    }

    if (url.pathname !== '/analyze' || request.method !== 'POST') {
      return json({ error: 'not found' }, { status: 404 });
    }

    // Auth
    const provided = request.headers.get('X-Shared-Secret');
    if (!env.SHARED_SECRET || provided !== env.SHARED_SECRET) {
      return json({ error: 'unauthorized' }, { status: 401 });
    }

    if (!env.OPENAI_API_KEY) {
      return json(
        { error: 'OPENAI_API_KEY not configured on worker' },
        { status: 500 },
      );
    }

    // Parse body
    let body: AnalyzeBody;
    try {
      body = (await request.json()) as AnalyzeBody;
    } catch {
      return json({ error: 'invalid json' }, { status: 400 });
    }
    if (!body.frames?.length || !body.metadata) {
      return json({ error: 'missing frames or metadata' }, { status: 400 });
    }
    if (body.frames.length > 8) {
      return json({ error: 'too many frames (max 8)' }, { status: 400 });
    }

    // Build OpenAI request
    const m = body.metadata;
    const rec = m.recordedAtUtc != null ? `, recorded(UTC)=${m.recordedAtUtc}` : '';
    const metaLine = `Metadata: duration=${m.durationSec.toFixed(1)}s, ${m.width}x${m.height}, ${m.fps.toFixed(1)}fps, codec=${m.codec}${rec}.`;
    const framesLine = `Frames provided: ${body.frames.length}, sampled evenly across the timeline (earliest first).`;

    const userContent: Array<
      | { type: 'text'; text: string }
      | {
          type: 'image_url';
          image_url: { url: string; detail?: 'low' | 'high' | 'auto' };
        }
    > = [
      {
        type: 'text',
        text: `${metaLine}\n${framesLine}\n\nAnalyze the clip and produce the filename parts.`,
      },
    ];
    for (const b64 of body.frames) {
      userContent.push({
        type: 'image_url',
        image_url: {
          url: `data:image/jpeg;base64,${b64}`,
          // Fixed 85-token cost per image. Plenty for filename naming.
          detail: 'low',
        },
      });
    }

    const openaiReq = {
      model: OPENAI_MODEL,
      // Low temperature pushes the model toward the most-supported, specific name
      // rather than creative variants. Repeated runs on the same clip will be stable.
      temperature: 0.2,
      messages: [
        { role: 'system', content: SYSTEM_INSTRUCTION },
        { role: 'user', content: userContent },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'clip_name_parts',
          strict: true,
          schema: RESPONSE_SCHEMA,
        },
      },
    };

    const res = await fetch(OPENAI_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify(openaiReq),
    });

    if (!res.ok) {
      const text = await res.text();
      const isRateLimited = res.status === 429;
      const retryAfterSec = isRateLimited
        ? extractRetryAfterSeconds(res.headers.get('Retry-After'), text)
        : null;
      const headers: Record<string, string> = {};
      if (retryAfterSec != null) headers['Retry-After'] = String(retryAfterSec);
      return json(
        {
          error: 'openai upstream error',
          status: res.status,
          model: OPENAI_MODEL,
          retryAfterSec,
          detail: text.slice(0, 500),
        },
        { status: isRateLimited ? 429 : 502, headers },
      );
    }

    const data = (await res.json()) as {
      choices?: Array<{
        message?: { content?: string | null; refusal?: string | null };
      }>;
    };
    const choice = data.choices?.[0]?.message;
    if (choice?.refusal) {
      return json(
        { error: 'openai refusal', model: OPENAI_MODEL, refusal: choice.refusal.slice(0, 300) },
        { status: 502 },
      );
    }
    const text = choice?.content;
    if (!text) {
      return json(
        { error: 'empty openai response', model: OPENAI_MODEL },
        { status: 502 },
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return json(
        { error: 'unparseable openai response', model: OPENAI_MODEL, raw: text.slice(0, 300) },
        { status: 502 },
      );
    }

    return json(parsed);
  },
};
