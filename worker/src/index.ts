/**
 * MNN Clip Namer — OpenAI proxy worker.
 * Routes: /analyze  /verify  /analyze-name  /websearch
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
  BRAVE_API_KEY: string;
  /** Resend API key — if set, errors are emailed to ERROR_EMAIL. Sign up free at resend.com. */
  RESEND_API_KEY?: string;
  /** Recipient(s) for alerts. One address, or several separated by commas. */
  ERROR_EMAIL?: string;
  /**
   * Sender address. Defaults to Resend's shared onboarding@resend.dev, which can
   * ONLY deliver to your own Resend account email. After verifying a domain at
   * resend.com/domains, set this to an address on that domain (e.g.
   * "MNN Alerts <alerts@yourdomain.com>") to deliver to any recipient.
   */
  MAIL_FROM?: string;
  /**
   * Google Gemini API key (free at aistudio.google.com/apikey). If set, the
   * Worker automatically falls back to Gemini for clip naming whenever OpenAI
   * fails (out of credits, outage, etc.) — true cross-provider redundancy.
   */
  GEMINI_API_KEY?: string;
  /** Gemini model to use for fallback. Defaults to gemini-2.0-flash. */
  GEMINI_MODEL?: string;
}

const DEFAULT_MAIL_FROM = 'MNN Clip Namer <onboarding@resend.dev>';
const DEFAULT_GEMINI_MODEL = 'gemini-2.0-flash';

interface AnalyzeBody {
  frames: string[]; // base64-encoded JPEGs
  originalName?: string;
  /** Optional; default gpt-4o-mini. Must be allowlisted. */
  model?: string;
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

interface VerifyBody {
  draft: {
    subject: string;
    technique: string;
    setting: string;
    confidence: string;
    notes: string;
    locationHint?: string;
  };
  originalName?: string;
  model?: string;
  metadata: AnalyzeBody['metadata'];
}

interface AnalyzeNameBody {
  originalName: string;
  model?: string;
  metadata?: {
    durationSec?: number;
    width?: number;
    height?: number;
    fps?: number;
    codec?: string;
    recordedAtUtc?: string;
  };
}

const ALLOWED_MODELS = ['gpt-4o-mini', 'gpt-4o'] as const;

function normalizeModel(input: unknown): (typeof ALLOWED_MODELS)[number] {
  const s = typeof input === 'string' ? input : '';
  return (ALLOWED_MODELS as readonly string[]).includes(s)
    ? (s as (typeof ALLOWED_MODELS)[number])
    : 'gpt-4o-mini';
}

/** Vision calls may take longer — bounded upstream wait per Cloudflare limits */
const OPENAI_FETCH_MS = 240_000;

// High-detail frames cost tokens but improve OCR-style cues.
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
  If a title card, lower-third, agenda slide, caption, or readable graphic identifies the
  event/topic/person, prefer that over generic visual descriptions like "person-speaking".
  If the original filename contains a meaningful event label that matches the frames, use it
  as a clue (e.g. "Ribbon Cutting Full.MOV" should become "ribbon-cutting-ceremony", not
  "group-photo-event").
- technique: 1 to 2 words, lowercase. One of: "wide-shot", "closeup", "medium-shot",
  "handheld", "tripod-locked", "tracking", "dolly", "drone-aerial", "timelapse", "slowmo",
  "interview", "podium-mounted", "bts" (behind-the-scenes), "broll", "static",
  "selfie-facing", "over-shoulder".
- setting: 2 to 3 words, hyphen-separated, lowercase. Name a recognizable venue,
  neighborhood, or geographic feature when visible: "city-hall-steps", "home-kitchen-counter",
  "highway-overpass-sunset", "stadium-end-zone", "school-gym-floor", "downtown-storefront".
  If on-screen text, signage, a podium seal, a wall plaque, a map label, a logo, or a room
  label identifies the location or organization, use that clue before generic scenery.
  Do not use bare "indoors", "outdoors", "park", "office", "studio" — always pair with a
  qualifier. If the location is genuinely unidentifiable, use the dominant visual feature
  ("brick-wall-mural", "tree-lined-street", "open-water-horizon").
- confidence: "high" if the frames clearly show what each field describes, "medium" if you
  inferred some parts, "low" if mostly guessing.
- notes: empty string unless the clip is ambiguous or you spotted an important cue the
  user might want to know (e.g. "used lower-third: budget hearing" or
  "signage partially readable").
- locationHint: Write the most specific location identifier you can extract. Priority:
  (1) If you recognize a specific named place, use its official name (e.g. "Centennial
  Park", "Nissan Stadium", "Metro Nashville Courthouse", "Germantown", "Music Row").
  (2) If you see street signs, addresses, or partial names, write those (e.g. "Second
  Avenue North downtown", "Church Street and Fifth Avenue").
  (3) If you cannot name the specific place, describe the BUILDING OR LOCATION ITSELF
  in detail — its architecture, materials, age, and physical features — NOT the
  activity happening in front of it. For a demolition scene: describe the building being
  demolished ("historic multi-story arched brick building Second Avenue downtown"), NOT
  the crane or the workers. For a park: describe the landscaping and structures. For a
  mural: describe the artwork. Include street or neighborhood cues if visible.
  IMPORTANT: if you recognize the location from a known news event, landmark, or history
  (e.g. a bombing site, disaster aftermath, famous venue), mention that event — e.g.
  "Nashville Christmas bombing Second Avenue demolition site" is far more useful than
  "downtown construction site".
  Empty string ONLY if there are zero location cues: featureless solid-color backdrop,
  black screen, or completely generic indoor space with no windows or signage.

Method:
1. Scan frames earliest-to-latest for in-video cues: title cards, agenda slides, chyron
   lower-thirds, captions, scoreboards, banners, signs, jerseys, name plates, podium seals,
   wall plaques, room labels, maps, logos, watermarks, and on-screen graphics.
2. Treat readable cue text as primary evidence for what the clip is and where it is. Names
   of people, places, organizations, programs, events, committees, schools, teams, venues,
   streets, neighborhoods, and dates are gold. Use the most reliable distinctive words.
3. Use the original filename as secondary context when it describes the clip, but ignore
   production/status words like "full", "final", "edited", "clip", "video", "copy", "new",
   and camera/card numbers.
4. If a cue conflicts with a generic visual guess, trust the cue. For example, a generic
   meeting room with a "Metro Nashville Council" lower-third should become something like
   "metro-council-meeting" in subject and "nashville-council-chambers" in setting.
5. Never use vague fallback names such as "group-photo-event", "office-reception-area",
   "people-gathering", "indoor-event", "outdoor-event", "public-event", or
   "community-event" when a more specific cue or filename clue exists.
6. Identify the single most distinctive event, person, object, or action and put it in
   "subject"; fold the best cue-derived location/organization into "setting".
7. Use uniforms, props, architecture, time-of-day, and weather as secondary setting cues.
8. If cue text is partially readable, only use words you can read with confidence and note
   the uncertainty in "notes".
9. When subject or setting comes from readable on-screen text, echo the shortest verbatim
   cue in "notes" (e.g. "cue: METRO COUNCIL") so the user can verify without guessing.
10. Drop filler words: "the", "a", "and", "of", "in", "with", "at".

Forbidden in any field (these are all too generic when used alone):
"people", "person", "video", "clip", "footage", "scene", "shot", "moment", "thing",
"stuff", "view", "general", "various", "misc". They may appear only as part of a
specific compound (e.g. "wide-shot" is fine because "wide" qualifies it).

Never include spaces, underscores, file extensions, or any punctuation other than hyphens.`;

const FILENAME_SYSTEM_INSTRUCTION = `You generate filename parts for a video clip based ONLY on the original filename and any available technical metadata. No video frames are provided.

Parse the original filename to extract meaningful words. Remove noise: file extensions, production tags ("full", "final", "edit", "raw", "copy", "new", "v1", "v2"), camera card codes (A001C002, C0001, DJI_), standalone numbers and timestamps.

Rules:
- subject: 2–3 hyphen-separated lowercase words from the filename's meaningful content. Use the most specific words available (e.g. "Ribbon Cutting Full.MOV" → "ribbon-cutting-ceremony", "MayorsOffice_Budget.mp4" → "mayor-budget-meeting"). Never use bare generic tokens: "clip", "video", "footage", "file".
- technique: Infer from metadata only. Portrait video (height > width) → "selfie-facing". Duration < 5 seconds → "broll". Default → "wide-shot".
- setting: Always return "unknown-location" — no frames available to identify the setting.
- confidence: Always return "low".
- notes: Always include exactly: "Named from filename only — frames couldn't be extracted (H.265/HEVC or unsupported codec). Re-upload as H.264 MP4 for AI vision."
- locationHint: Always return empty string.`;

const VERIFY_SYSTEM_INSTRUCTION = `You verify filename parts for a video clip. You do NOT see the video — only a draft JSON from a vision model, technical metadata, and the original filename.

Return strictly valid JSON matching the provided schema (same fields as the draft).

Rules:
- Keep the draft unchanged when subject, technique, setting, confidence, and notes are mutually consistent with metadata and filename cues.
- Fix contradictions minimally. Never invent proper nouns absent from the draft, draft notes, or meaningful words in the original filename.
- Preserve hyphenated-lowercase slugs. Avoid bare generic tokens: "people", "person", "video", "clip", "scene", "moment", etc.
- If ambiguous, lower confidence and explain briefly in notes rather than guessing specifics.
- Pass locationHint through from the draft unchanged — you cannot see the frames.`;

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
    locationHint: { type: 'string' },
  },
  required: ['subject', 'technique', 'setting', 'confidence', 'notes', 'locationHint'],
};

// ─── Gemini fallback ───────────────────────────────────────────────────────────
// Gemini's structured-output schema uses OpenAPI-style UPPERCASE type names and
// does not accept additionalProperties.
const GEMINI_SCHEMA = {
  type: 'OBJECT',
  properties: {
    subject:      { type: 'STRING' },
    technique:    { type: 'STRING' },
    setting:      { type: 'STRING' },
    confidence:   { type: 'STRING', enum: ['high', 'medium', 'low'] },
    notes:        { type: 'STRING' },
    locationHint: { type: 'STRING' },
  },
  required: ['subject', 'technique', 'setting', 'confidence', 'notes', 'locationHint'],
};

type GeminiPart =
  | { text: string }
  | { inline_data: { mime_type: string; data: string } };

/**
 * Call Gemini with a system instruction + user parts (text and/or inline images)
 * and return the parsed JSON object matching RESPONSE_SCHEMA. Throws on failure
 * so the caller can fall through to the original OpenAI error.
 */
async function callGeminiJSON(env: Env, systemText: string, userParts: GeminiPart[]): Promise<unknown> {
  const model = env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL;
  const endpoint =
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent` +
    `?key=${env.GEMINI_API_KEY}`;

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: systemText }] },
      contents: [{ role: 'user', parts: userParts }],
      generationConfig: {
        temperature: 0.1,
        responseMimeType: 'application/json',
        responseSchema: GEMINI_SCHEMA,
      },
    }),
    signal: AbortSignal.timeout(OPENAI_FETCH_MS),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`gemini ${res.status}: ${detail.slice(0, 200)}`);
  }

  const data = (await res.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const text = data.candidates?.[0]?.content?.parts?.map(p => p.text ?? '').join('') ?? '';
  if (!text.trim()) throw new Error('gemini returned empty response');
  return JSON.parse(text);
}

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
 * ERROR_EMAIL may hold one address or several, separated by commas / semicolons
 * / whitespace. Returns a de-duplicated list of recipient addresses.
 * NOTE: Resend only delivers to arbitrary recipients once you've verified a
 * sending domain. Until then it accepts ONLY your own account email; any other
 * recipient makes the whole send fail.
 */
function parseRecipients(raw: string | undefined): string[] {
  if (!raw) return [];
  return [...new Set(
    raw.split(/[,;\s]+/).map(s => s.trim()).filter(s => s.includes('@')),
  )];
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
      return json({
        ok: true,
        provider: 'openai',
        models: [...ALLOWED_MODELS],
        defaultModel: 'gpt-4o-mini',
      });
    }

    const isAnalyze = url.pathname === '/analyze' && request.method === 'POST';
    const isVerify = url.pathname === '/verify' && request.method === 'POST';
    const isAnalyzeName = url.pathname === '/analyze-name' && request.method === 'POST';
    const isWebSearch = url.pathname === '/websearch' && request.method === 'POST';

    // POST /report-error — no auth required; fires from PWA error handlers.
    // Accepts either a single error (legacy) or { errors: [...] } batch so a
    // whole naming run sends ONE summary email instead of one per clip.
    if (url.pathname === '/report-error' && request.method === 'POST') {
      interface ErrItem { type?: string; message?: string; clipName?: string | null }
      interface ErrBody extends ErrItem { errors?: ErrItem[]; userAgent?: string; timestamp?: string }
      let body: ErrBody;
      try { body = (await request.json()) as ErrBody; }
      catch { return json({ ok: false }, { status: 400 }); }

      // Normalise to a list of errors (batch or single).
      const rawList: ErrItem[] = Array.isArray(body.errors) && body.errors.length
        ? body.errors
        : [{ type: body.type, message: body.message, clipName: body.clipName }];

      const items = rawList.slice(0, 100).map(e => ({
        type:     String(e.type ?? 'unknown').slice(0, 50),
        message:  String(e.message ?? '').slice(0, 500),
        clipName: e.clipName ? String(e.clipName).slice(0, 200) : null,
      }));
      const userAgent = String(body.userAgent ?? '').slice(0, 200);
      const timestamp = String(body.timestamp ?? new Date().toISOString());

      // Count by type for the summary line.
      const counts: Record<string, number> = {};
      for (const it of items) counts[it.type] = (counts[it.type] ?? 0) + 1;
      const countSummary = Object.entries(counts).map(([t, n]) => `${n}×${t}`).join(', ');

      console.error(`[MNN Error] batch n=${items.length} (${countSummary}) ua=${userAgent} t=${timestamp}`);

      const recipients = parseRecipients(env.ERROR_EMAIL);
      if (env.RESEND_API_KEY && recipients.length) {
        const n = items.length;
        const subject = n === 1
          ? `[MNN Clip Namer] ${items[0].type}: ${items[0].message.slice(0, 60)}`
          : `[MNN Clip Namer] ${n} errors in last batch (${countSummary})`;

        const lines = [
          n === 1 ? `1 error reported.` : `${n} errors reported in one batch.`,
          `Summary : ${countSummary}`,
          `Time    : ${timestamp}`,
          `Browser : ${userAgent}`,
          ``,
          `─────────── errors ───────────`,
          ...items.map((it, i) =>
            `${String(i + 1).padStart(2, ' ')}. [${it.type}] ${it.clipName ? it.clipName + ' — ' : ''}${it.message}`),
        ];

        try {
          await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${env.RESEND_API_KEY}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              from: env.MAIL_FROM || DEFAULT_MAIL_FROM,
              to: recipients,
              subject,
              text: lines.join('\n'),
            }),
            signal: AbortSignal.timeout(8_000),
          });
        } catch {
          // Email failure should not block the response
        }
      }

      return json({ ok: true, count: items.length });
    }

    // POST /report-feedback — user-submitted bug report from the in-app Help page.
    // No auth (the PWA can't safely hold a secret); blast radius is admin email.
    if (url.pathname === '/report-feedback' && request.method === 'POST') {
      interface FeedbackBody {
        name?: string;
        email?: string;
        message?: string;
        screenshot?: string | null; // data URL
        diagnostics?: unknown;
      }
      let body: FeedbackBody;
      try { body = (await request.json()) as FeedbackBody; }
      catch { return json({ ok: false, error: 'invalid json' }, { status: 400 }); }

      const message = String(body.message ?? '').trim();
      if (message.length < 3) {
        return json({ ok: false, error: 'message too short' }, { status: 400 });
      }
      const name  = String(body.name  ?? '').slice(0, 120);
      const email = String(body.email ?? '').slice(0, 200);

      // Build a readable diagnostics block.
      let diagText = '';
      try { diagText = JSON.stringify(body.diagnostics ?? {}, null, 2).slice(0, 8000); }
      catch { diagText = '(unreadable diagnostics)'; }

      console.error(`[MNN Feedback] from=${name || 'anon'} <${email || 'no-email'}> msg=${message.slice(0, 200)}`);

      const recipients = parseRecipients(env.ERROR_EMAIL);
      if (!env.RESEND_API_KEY || !recipients.length) {
        // Logged but not emailed — still a success from the user's perspective.
        return json({ ok: true, emailed: false });
      }

      // Parse the screenshot data URL into a Resend attachment, if present.
      const attachments: Array<{ filename: string; content: string }> = [];
      if (typeof body.screenshot === 'string' && body.screenshot.startsWith('data:image/')) {
        const comma = body.screenshot.indexOf(',');
        if (comma > 0) {
          const b64 = body.screenshot.slice(comma + 1);
          // Cap attachment size (~6MB base64) to stay within email limits.
          if (b64.length <= 6_000_000) {
            const ext = body.screenshot.slice(11, body.screenshot.indexOf(';')) || 'png';
            attachments.push({ filename: `screenshot.${ext === 'jpeg' ? 'jpg' : ext}`, content: b64 });
          }
        }
      }

      const subjectName = name || 'Someone';
      const text = [
        `New help report from the MNN Clip Namer app.`,
        ``,
        `From    : ${name || '(no name)'}`,
        `Reply to: ${email || '(no email given)'}`,
        ``,
        `Message:`,
        message,
        ``,
        `──────────── diagnostics ────────────`,
        diagText,
      ].join('\n');

      try {
        const res = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${env.RESEND_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            from: env.MAIL_FROM || DEFAULT_MAIL_FROM,
            to: recipients,
            ...(email ? { reply_to: email } : {}),
            subject: `[MNN Help] ${subjectName}: ${message.slice(0, 60)}`,
            text,
            ...(attachments.length ? { attachments } : {}),
          }),
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) {
          const detail = await res.text().catch(() => '');
          console.error(`[MNN Feedback] resend failed ${res.status}: ${detail.slice(0, 200)}`);
          return json({ ok: false, error: 'email send failed' }, { status: 502 });
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[MNN Feedback] resend error: ${msg.slice(0, 200)}`);
        return json({ ok: false, error: 'email send error' }, { status: 502 });
      }

      return json({ ok: true, emailed: true });
    }

    if (isWebSearch) {
      const wsSecret = request.headers.get('X-Shared-Secret');
      if (!env.SHARED_SECRET || wsSecret !== env.SHARED_SECRET) {
        return json({ error: 'unauthorized' }, { status: 401 });
      }
      if (!env.BRAVE_API_KEY) {
        return json({ error: 'BRAVE_API_KEY not configured' }, { status: 500 });
      }
      let body: { query: string };
      try {
        body = (await request.json()) as { query: string };
      } catch {
        return json({ error: 'invalid json' }, { status: 400 });
      }
      if (!body.query || body.query.trim().length < 3) {
        return json({ error: 'query too short' }, { status: 400 });
      }
      try {
        const searchUrl =
          `https://api.search.brave.com/res/v1/web/search` +
          `?q=${encodeURIComponent(body.query + ' Nashville Tennessee')}` +
          `&count=5&country=us&search_lang=en&result_filter=web`;
        const res = await fetch(searchUrl, {
          headers: {
            Accept: 'application/json',
            'Accept-Encoding': 'gzip',
            'X-Subscription-Token': env.BRAVE_API_KEY,
          },
          signal: AbortSignal.timeout(8000),
        });
        if (!res.ok) {
          return json({ error: 'brave search failed', status: res.status }, { status: 502 });
        }
        const data = (await res.json()) as {
          web?: { results?: Array<{ title: string; description?: string; url: string }> };
        };
        const results = (data.web?.results ?? []).slice(0, 5).map((r) => ({
          title: r.title,
          description: r.description ?? '',
          url: r.url,
        }));
        return json({ results });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return json({ error: 'brave search error', detail: msg.slice(0, 200) }, { status: 502 });
      }
    }

    if (!isAnalyze && !isVerify && !isAnalyzeName) {
      return json({ error: 'not found' }, { status: 404 });
    }

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

    if (isVerify) {
      let body: VerifyBody;
      try {
        body = (await request.json()) as VerifyBody;
      } catch {
        return json({ error: 'invalid json' }, { status: 400 });
      }
      const d = body.draft;
      if (
        !d ||
        typeof d.subject !== 'string' ||
        typeof d.technique !== 'string' ||
        typeof d.setting !== 'string' ||
        typeof d.confidence !== 'string' ||
        typeof d.notes !== 'string' ||
        !body.metadata
      ) {
        return json({ error: 'missing draft or metadata' }, { status: 400 });
      }

      const model = normalizeModel(body.model);
      const m = body.metadata;
      const rec = m.recordedAtUtc != null ? `, recorded(UTC)=${m.recordedAtUtc}` : '';
      const metaLine = `Metadata: duration=${m.durationSec.toFixed(1)}s, ${m.width}x${m.height}, ${m.fps.toFixed(1)}fps, codec=${m.codec}${rec}.`;
      const originalNameLine = body.originalName ? `Original filename: ${body.originalName}.` : '';

      const openaiReq = {
        model,
        temperature: 0.1,
        messages: [
          { role: 'system', content: VERIFY_SYSTEM_INSTRUCTION },
          {
            role: 'user',
            content: `${metaLine}\n${originalNameLine}\nDraft JSON from vision model:\n${JSON.stringify(d)}\n\nReturn corrected JSON only.`,
          },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'clip_name_parts_verify',
            strict: true,
            schema: RESPONSE_SCHEMA,
          },
        },
      };

      let res: Response;
      try {
        res = await fetch(OPENAI_API_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${env.OPENAI_API_KEY}`,
          },
          body: JSON.stringify(openaiReq),
          signal: AbortSignal.timeout(OPENAI_FETCH_MS),
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return json({ error: 'openai fetch failed', model, detail: msg.slice(0, 200) }, { status: 502 });
      }

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
            model,
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
        return json({ error: 'openai refusal', model, refusal: choice.refusal.slice(0, 300) }, { status: 502 });
      }
      const text = choice?.content;
      if (!text) {
        return json({ error: 'empty openai response', model }, { status: 502 });
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        return json({ error: 'unparseable openai response', model, raw: text.slice(0, 300) }, { status: 502 });
      }

      return json(parsed);
    }

    // POST /analyze-name  (filename-only fallback — no frames required)
    if (isAnalyzeName) {
      let body: AnalyzeNameBody;
      try {
        body = (await request.json()) as AnalyzeNameBody;
      } catch {
        return json({ error: 'invalid json' }, { status: 400 });
      }
      if (!body.originalName || typeof body.originalName !== 'string') {
        return json({ error: 'missing originalName' }, { status: 400 });
      }

      const model = normalizeModel(body.model);
      const m = body.metadata ?? {};
      const width = m.width ?? 0;
      const height = m.height ?? 0;
      const durationSec = m.durationSec ?? 0;
      const codec = m.codec ?? 'unknown';
      const rec = m.recordedAtUtc ? `, recorded(UTC)=${m.recordedAtUtc}` : '';
      const metaLine = `Metadata: duration=${durationSec.toFixed(1)}s, ${width}x${height}, codec=${codec}${rec}.`;

      const openaiReq = {
        model,
        temperature: 0.1,
        messages: [
          { role: 'system', content: FILENAME_SYSTEM_INSTRUCTION },
          {
            role: 'user',
            content: `Original filename: ${body.originalName}\n${metaLine}\n\nGenerate filename parts from the filename and metadata only. No frames are available.`,
          },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'clip_name_from_filename',
            strict: true,
            schema: RESPONSE_SCHEMA,
          },
        },
      };

      // Cross-provider failover for filename-only naming (text, no frames).
      const nameUserText = `Original filename: ${body.originalName}\n${metaLine}\n\nGenerate filename parts from the filename and metadata only. No frames are available.`;
      const tryGeminiName = async (): Promise<Response | null> => {
        if (!env.GEMINI_API_KEY) return null;
        try {
          const g = await callGeminiJSON(env, FILENAME_SYSTEM_INSTRUCTION, [{ text: nameUserText }]);
          console.log('[MNN] /analyze-name served by Gemini fallback');
          return json(g, { headers: { 'X-Served-By': 'gemini' } });
        } catch (ge) {
          console.error('[MNN] Gemini name fallback failed:', ge instanceof Error ? ge.message : String(ge));
          return null;
        }
      };

      let res: Response;
      try {
        res = await fetch(OPENAI_API_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${env.OPENAI_API_KEY}`,
          },
          body: JSON.stringify(openaiReq),
          signal: AbortSignal.timeout(OPENAI_FETCH_MS),
        });
      } catch (e) {
        const g = await tryGeminiName();
        if (g) return g;
        const msg = e instanceof Error ? e.message : String(e);
        return json({ error: 'openai fetch failed', model, detail: msg.slice(0, 200) }, { status: 502 });
      }

      if (!res.ok) {
        const text = await res.text();
        const g = await tryGeminiName();
        if (g) return g;
        const isRateLimited = res.status === 429;
        const retryAfterSec = isRateLimited
          ? extractRetryAfterSeconds(res.headers.get('Retry-After'), text)
          : null;
        const headers: Record<string, string> = {};
        if (retryAfterSec != null) headers['Retry-After'] = String(retryAfterSec);
        return json(
          { error: 'openai upstream error', status: res.status, model, retryAfterSec, detail: text.slice(0, 500) },
          { status: isRateLimited ? 429 : 502, headers },
        );
      }

      const nameData = (await res.json()) as {
        choices?: Array<{ message?: { content?: string | null; refusal?: string | null } }>;
      };
      const nameChoice = nameData.choices?.[0]?.message;
      if (nameChoice?.refusal) {
        return json({ error: 'openai refusal', model, refusal: nameChoice.refusal.slice(0, 300) }, { status: 502 });
      }
      const nameText = nameChoice?.content;
      if (!nameText) {
        return json({ error: 'empty openai response', model }, { status: 502 });
      }
      let nameParsed: unknown;
      try {
        nameParsed = JSON.parse(nameText);
      } catch {
        return json({ error: 'unparseable openai response', model, raw: nameText.slice(0, 300) }, { status: 502 });
      }
      return json(nameParsed);
    }

    // POST /analyze
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

    const model = normalizeModel(body.model);

    const m = body.metadata;
    const rec = m.recordedAtUtc != null ? `, recorded(UTC)=${m.recordedAtUtc}` : '';
    const metaLine = `Metadata: duration=${m.durationSec.toFixed(1)}s, ${m.width}x${m.height}, ${m.fps.toFixed(1)}fps, codec=${m.codec}${rec}.`;
    const originalNameLine = body.originalName ? `Original filename: ${body.originalName}.` : '';
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
        text: `${metaLine}\n${originalNameLine}\n${framesLine}\n\nAnalyze the clip, read any in-video cues carefully, use the original filename only when it matches the frames, and produce specific filename parts.`,
      },
    ];
    for (const b64 of body.frames) {
      userContent.push({
        type: 'image_url',
        image_url: {
          url: `data:image/jpeg;base64,${b64}`,
          detail: 'high',
        },
      });
    }

    const openaiReq = {
      model,
      temperature: 0.1,
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

    // Cross-provider failover: if OpenAI can't serve (out of credits, outage,
    // rate limit), retry the same frames through Gemini. Returns a Response on
    // success, or null so the caller falls through to the original OpenAI error.
    const geminiParts: GeminiPart[] = [
      {
        text: `${metaLine}\n${originalNameLine}\n${framesLine}\n\nAnalyze the clip, read any in-video cues carefully, use the original filename only when it matches the frames, and produce specific filename parts.`,
      },
      ...body.frames.map(b64 => ({ inline_data: { mime_type: 'image/jpeg', data: b64 } })),
    ];
    const tryGemini = async (): Promise<Response | null> => {
      if (!env.GEMINI_API_KEY) return null;
      try {
        const g = await callGeminiJSON(env, SYSTEM_INSTRUCTION, geminiParts);
        console.log('[MNN] /analyze served by Gemini fallback');
        return json(g, { headers: { 'X-Served-By': 'gemini' } });
      } catch (ge) {
        console.error('[MNN] Gemini fallback failed:', ge instanceof Error ? ge.message : String(ge));
        return null;
      }
    };

    let res: Response;
    try {
      res = await fetch(OPENAI_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${env.OPENAI_API_KEY}`,
        },
        body: JSON.stringify(openaiReq),
        signal: AbortSignal.timeout(OPENAI_FETCH_MS),
      });
    } catch (e) {
      const g = await tryGemini();
      if (g) return g;
      const msg = e instanceof Error ? e.message : String(e);
      return json({ error: 'openai fetch failed', model, detail: msg.slice(0, 200) }, { status: 502 });
    }

    if (!res.ok) {
      const text = await res.text();
      const g = await tryGemini();
      if (g) return g;
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
          model,
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
      return json({ error: 'openai refusal', model, refusal: choice.refusal.slice(0, 300) }, { status: 502 });
    }
    const text = choice?.content;
    if (!text) {
      return json({ error: 'empty openai response', model }, { status: 502 });
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return json({ error: 'unparseable openai response', model, raw: text.slice(0, 300) }, { status: 502 });
    }

    return json(parsed);
  },
};
