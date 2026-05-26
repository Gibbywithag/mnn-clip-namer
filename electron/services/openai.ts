import type { ClipMetadata, NameParts, Settings } from '../../shared/types';
import { ANALYSIS_MODELS } from '../../shared/types';
import { CLIENT_SHARED_SECRET } from './buildConfig';
import { resolveLocation, resolveLocationFromGps } from './geocoder';
import { monitorError, monitorWarn } from './monitorLog';

interface AnalyzeArgs {
  frames: Buffer[];
  metadata: ClipMetadata;
  settings: Settings;
  originalName?: string;
  apiKey?: string | null;
  /**
   * Optional progress hook the caller can use to surface intermediate state
   * (e.g. "rate limited — retrying in 8s") while we wait inside retry sleeps.
   */
  onProgress?: (message: string) => void;
}

/**
 * Hard cap on total retry/wait time per clip. Big batches can legitimately
 * need to sit through a rate-limit window, but we still avoid hanging forever.
 */
const MAX_TOTAL_RETRY_MS = 180_000;

const OPENAI_API_URL = 'https://api.openai.com/v1/chat/completions';

function resolveOpenAiModel(settings: Settings): string {
  const m = settings.analysisModel;
  return (ANALYSIS_MODELS as readonly string[]).includes(m) ? m : 'gpt-4o-mini';
}

function resolveRequestGapMs(settings: Settings): number {
  const n = Number(settings.requestGapMs);
  if (!Number.isFinite(n)) return 5000;
  return Math.max(2000, Math.min(60_000, Math.round(n)));
}

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
    locationHint: { type: 'string' },
  },
  // OpenAI strict mode requires every key to be in `required`. Optional fields
  // get an empty string when the model has nothing to say.
  required: ['subject', 'technique', 'setting', 'confidence', 'notes', 'locationHint'],
} as const;

const VERIFY_SYSTEM_INSTRUCTION = `You verify filename parts for a video clip. You do NOT see the video — only a draft JSON from a vision model, technical metadata, and the original filename.

Return strictly valid JSON matching the provided schema (same fields as the draft).

Rules:
- Keep the draft unchanged when subject, technique, setting, confidence, and notes are mutually consistent with metadata and filename cues.
- Fix contradictions minimally (e.g. vague subject vs specific notes). Never invent proper nouns, venues, or events absent from the draft, draft notes, or meaningful words in the original filename.
- Preserve hyphenated-lowercase slugs. Same generic-token bans as vision naming: avoid bare "people", "person", "video", "clip", "scene", "moment", etc.
- If still ambiguous, use lower confidence and explain briefly in notes rather than guessing specifics.
- Pass locationHint through from the draft unchanged — you cannot see the frames.`;

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

// --- Batch-safe pacing ---------------------------------------------------
// High-detail vision can trip TPM limits long before RPM limits. Gap is configurable
// in Settings (requestGapMs).
let nextAvailableAt = 0;
let pacingChain: Promise<void> = Promise.resolve();

async function paceRequest(gapMs: number, onProgress?: (m: string) => void): Promise<void> {
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
    nextAvailableAt = Math.max(Date.now(), nextAvailableAt) + gapMs;
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
    notes: parsed.notes && parsed.notes.length > 0 ? parsed.notes : undefined,
    locationHint: parsed.locationHint && parsed.locationHint.length > 0 ? parsed.locationHint : undefined,
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

/** Safety valve so a permanently broken network cannot loop forever. */
const MAX_RETRY_ITERATIONS = 60;

/**
 * Retry wrapper. Honors Retry-After when present. For 429/5xx/network errors,
 * keeps backing off until either success, time budget is too tight for the next
 * wait, or iteration cap — avoids the old bug where only six tries ran while the
 * error text implied the full 180s budget had been used.
 */
async function withRetry<T>(
  fn: () => Promise<T>,
  onProgress?: (message: string) => void,
): Promise<T> {
  let lastErr: unknown;
  const startedAt = Date.now();

  for (let attempt = 1; attempt <= MAX_RETRY_ITERATIONS; attempt++) {
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

      // No point scheduling another backoff if we're out of iterations.
      if (attempt === MAX_RETRY_ITERATIONS) {
        if (is429) {
          monitorError('openai', 'rate limit — max retry iterations', {
            waitedMs: Date.now() - startedAt,
            iterations: MAX_RETRY_ITERATIONS,
          });
          throw new Error(
            `OpenAI rate limited — still failing after ${MAX_RETRY_ITERATIONS} retries (~${Math.round((Date.now() - startedAt) / 1000)}s). ` +
              `Wait a minute, check usage at platform.openai.com, then click ↻.`,
          );
        }
        throw err;
      }

      let delay: number;
      if (err instanceof RateLimitError && err.retryAfterSec != null) {
        delay = err.retryAfterSec * 1000 + 500;
      } else {
        const base = is429 ? 2000 : 800;
        delay = Math.min(base * Math.pow(2, attempt - 1), 30_000) + Math.random() * 500;
      }

      const elapsed = Date.now() - startedAt;
      const budgetLeft = MAX_TOTAL_RETRY_MS - elapsed;

      if (delay > budgetLeft) {
        if (is429) {
          monitorError('openai', 'rate limit budget exhausted', {
            waitedMs: elapsed,
            budgetMs: MAX_TOTAL_RETRY_MS,
            delayNeededMs: Math.round(delay),
            attempt,
          });
          throw new Error(
            `OpenAI rate limited — after ${Math.round(elapsed / 1000)}s the next backoff needs ~${Math.round(delay / 1000)}s (cap ${Math.round(MAX_TOTAL_RETRY_MS / 1000)}s). ` +
              `Check usage/billing at platform.openai.com, then click ↻.`,
          );
        }
        throw err;
      }

      monitorWarn('openai', 'transient failure, backing off', {
        attempt,
        maxIterations: MAX_RETRY_ITERATIONS,
        delayMs: Math.round(delay),
        kind: is429 ? '429' : is5xx ? '5xx' : 'network',
        snippet: msg.slice(0, 120),
      });

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
  originalName?: string,
): Array<{ role: 'system' | 'user'; content: unknown }> {
  const rec =
    metadata.recordedAtUtc != null ? `, recorded(UTC)=${metadata.recordedAtUtc}` : '';
  const metaLine = `Metadata: duration=${metadata.durationSec.toFixed(1)}s, ${metadata.width}x${metadata.height}, ${metadata.fps.toFixed(1)}fps, codec=${metadata.codec}${rec}.`;
  const originalNameLine = originalName ? `Original filename: ${originalName}.` : '';
  const framesLine = `Frames provided: ${frames.length}, sampled evenly across the timeline (earliest first).`;

  const userContent: Array<
    | { type: 'text'; text: string }
    | { type: 'image_url'; image_url: { url: string; detail?: 'low' | 'high' | 'auto' } }
  > = [
    {
      type: 'text',
      text: `${metaLine}\n${originalNameLine}\n${framesLine}\n\nAnalyze the clip, read any in-video cues carefully, use the original filename only when it matches the frames, and produce specific filename parts.`,
    },
  ];
  for (const buf of frames) {
    userContent.push({
      type: 'image_url',
      image_url: {
        url: `data:image/jpeg;base64,${buf.toString('base64')}`,
        // Use high-detail vision so signs, lower-thirds, storefronts, and
        // other small in-video cues survive the trip to the model.
        detail: 'high',
      },
    });
  }

  return [
    { role: 'system', content: SYSTEM_INSTRUCTION },
    { role: 'user', content: userContent },
  ];
}

function buildVerifyMessages(
  draft: NameParts,
  metadata: ClipMetadata,
  originalName?: string,
): Array<{ role: 'system' | 'user'; content: string }> {
  const rec =
    metadata.recordedAtUtc != null ? `, recorded(UTC)=${metadata.recordedAtUtc}` : '';
  const metaLine = `Metadata: duration=${metadata.durationSec.toFixed(1)}s, ${metadata.width}x${metadata.height}, ${metadata.fps.toFixed(1)}fps, codec=${metadata.codec}${rec}.`;
  const originalNameLine = originalName ? `Original filename: ${originalName}.` : '';
  const draftJson = JSON.stringify({
    subject: draft.subject,
    technique: draft.technique,
    setting: draft.setting,
    confidence: draft.confidence,
    notes: draft.notes ?? '',
    locationHint: draft.locationHint ?? '',
  });
  const userText = `${metaLine}\n${originalNameLine}\n\nDraft from vision model:\n${draftJson}\n\nVerify and return corrected JSON. Do not invent details unsupported by the draft, notes, or filename.`;

  return [
    { role: 'system', content: VERIFY_SYSTEM_INSTRUCTION },
    { role: 'user', content: userText },
  ];
}

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
  originalName: string | undefined,
  settings: Settings,
  onProgress?: (m: string) => void,
): Promise<NameParts> {
  const gapMs = resolveRequestGapMs(settings);
  const model = resolveOpenAiModel(settings);
  const url = `${settings.proxyUrl.replace(/\/$/, '')}/analyze`;
  return withRetry(async () => {
    await paceRequest(gapMs, onProgress);
    onProgress?.('contacting analyzer');
    const res = await fetch(url, {
      method: 'POST',
      signal: AbortSignal.timeout(240_000),
      headers: {
        'Content-Type': 'application/json',
        'X-Shared-Secret': CLIENT_SHARED_SECRET,
      },
      body: JSON.stringify({
        model,
        frames: frames.map((f) => f.toString('base64')),
        ...(originalName ? { originalName } : {}),
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
      // 400 "missing frames or metadata" usually means the frame extraction
      // produced empty or zero-byte outputs — give a more actionable message.
      if (res.status === 400 && text.includes('missing frames')) {
        throw new Error(
          'Frame extraction failed silently — the file codec may not be supported on this platform. ' +
            'Try converting the clip to MP4 and dropping it again.',
        );
      }
      throw new Error(`Proxy error ${res.status}: ${text.slice(0, 200)}`);
    }
    const parsed = (await res.json()) as Partial<NameParts>;
    return validate(parsed);
  }, onProgress);
}

async function verifyViaProxy(
  draft: NameParts,
  metadata: ClipMetadata,
  originalName: string | undefined,
  settings: Settings,
  onProgress?: (m: string) => void,
): Promise<NameParts> {
  const gapMs = resolveRequestGapMs(settings);
  const model = resolveOpenAiModel(settings);
  const url = `${settings.proxyUrl.replace(/\/$/, '')}/verify`;
  return withRetry(async () => {
    await paceRequest(gapMs, onProgress);
    onProgress?.('verification pass');
    const res = await fetch(url, {
      method: 'POST',
      signal: AbortSignal.timeout(120_000),
      headers: {
        'Content-Type': 'application/json',
        'X-Shared-Secret': CLIENT_SHARED_SECRET,
      },
      body: JSON.stringify({
        model,
        draft: {
          subject: draft.subject,
          technique: draft.technique,
          setting: draft.setting,
          confidence: draft.confidence,
          notes: draft.notes ?? '',
        },
        ...(originalName ? { originalName } : {}),
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
      throw new Error(`Proxy verify error ${res.status}: ${text.slice(0, 200)}`);
    }
    const parsed = (await res.json()) as Partial<NameParts>;
    return validate(parsed);
  }, onProgress);
}

async function analyzeViaDirect(
  frames: Buffer[],
  metadata: ClipMetadata,
  originalName: string | undefined,
  apiKey: string,
  settings: Settings,
  onProgress?: (m: string) => void,
): Promise<NameParts> {
  const gapMs = resolveRequestGapMs(settings);
  const model = resolveOpenAiModel(settings);
  return withRetry(async () => {
    await paceRequest(gapMs, onProgress);
    onProgress?.('contacting analyzer');
    const messages = buildMessages(frames, metadata, originalName);
    const res = await fetch(OPENAI_API_URL, {
      method: 'POST',
      signal: AbortSignal.timeout(240_000),
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0.1,
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

async function verifyViaDirect(
  draft: NameParts,
  metadata: ClipMetadata,
  originalName: string | undefined,
  apiKey: string,
  settings: Settings,
  onProgress?: (m: string) => void,
): Promise<NameParts> {
  const gapMs = resolveRequestGapMs(settings);
  const model = resolveOpenAiModel(settings);
  return withRetry(async () => {
    await paceRequest(gapMs, onProgress);
    onProgress?.('verification pass');
    const messages = buildVerifyMessages(draft, metadata, originalName);
    const res = await fetch(OPENAI_API_URL, {
      method: 'POST',
      signal: AbortSignal.timeout(120_000),
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0.1,
        messages,
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'clip_name_verify',
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
      throw new Error(`OpenAI verify error ${res.status}: ${text.slice(0, 200)}`);
    }

    const data = await res.json();
    const content = extractContent(data);
    if (!content) {
      throw new Error('OpenAI returned an empty verification response.');
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
  originalName,
  apiKey,
  onProgress,
}: AnalyzeArgs): Promise<NameParts> {
  // Guard: if ffmpeg produced no frames (can happen on Windows for certain
  // MOV/codec combinations), bail early with a clear message instead of
  // forwarding an empty array to the worker and getting a cryptic 400.
  const validFrames = frames.filter((f) => f && f.length > 0);
  if (validFrames.length === 0) {
    throw new Error(
      'Frame extraction produced no output — the file codec may not be supported on this platform. ' +
        'Try converting to MP4 first, or use the "8 frames" option which retries with different settings.',
    );
  }

  let vision: NameParts;
  if (settings.backendMode === 'proxy') {
    if (!settings.proxyUrl) {
      throw new Error('Proxy URL not set. Open Settings to configure.');
    }
    vision = await analyzeViaProxy(validFrames, metadata, originalName, settings, onProgress);
  } else {
    if (!apiKey) {
      throw new Error('No OpenAI API key set. Open Settings to add one.');
    }
    vision = await analyzeViaDirect(validFrames, metadata, originalName, apiKey, settings, onProgress);
  }

  let result: NameParts;
  if (!settings.verificationSecondPass) {
    result = vision;
  } else if (settings.backendMode === 'proxy') {
    result = await verifyViaProxy(vision, metadata, originalName, settings, onProgress);
  } else {
    result = await verifyViaDirect(vision, metadata, originalName, apiKey!, settings, onProgress);
  }

  // Tier 0: GPS embedded in the clip — most precise, works for any location
  if (metadata.gpsLat != null && metadata.gpsLng != null) {
    onProgress?.('locating via GPS');
    const gpsResolved = await resolveLocationFromGps(metadata.gpsLat, metadata.gpsLng);
    if (gpsResolved) {
      result = { ...result, setting: gpsResolved };
      return result;
    }
  }

  // Tiers 1-4: AI locationHint → local list → Nominatim → Brave Search → raw hint
  // Brave gets an enriched query: "{subject words} {locationHint}" so "building demolition"
  // narrows "downtown Nashville" to the active demolition story (e.g. Second Ave North).
  if (result.locationHint) {
    onProgress?.('looking up location');
    const proxyUrl = settings.backendMode === 'proxy' ? settings.proxyUrl : undefined;
    const subjectWords = result.subject.replace(/-/g, ' ');
    const braveQuery = `${subjectWords} ${result.locationHint}`.trim();
    const resolved = await resolveLocation(result.locationHint, proxyUrl, braveQuery);
    if (resolved) result = { ...result, setting: resolved };
  }

  return result;
}
