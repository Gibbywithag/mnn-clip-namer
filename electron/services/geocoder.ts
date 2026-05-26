import places from './nashville-places.json';
import { monitorInfo, monitorWarn } from './monitorLog';
import { CLIENT_SHARED_SECRET } from './buildConfig';

// Davidson County approximate bounding box (Nominatim viewbox format: W,S,E,N)
const DAVIDSON_VIEWBOX = '-87.0499,35.9676,-86.5172,36.4037';

// Davidson County bounds for GPS sanity checks
const DAVIDSON_BOUNDS = { south: 35.9676, north: 36.4037, west: -87.0499, east: -86.5172 };

// Nominatim usage policy: must identify the app and provide contact info
const NOMINATIM_UA = 'MNN-ClipNamer/1.0 (Metro Nashville Network; gilbranlaureano0417@gmail.com)';

// Enforce Nominatim's 1 req/sec policy
let nominatimNextAt = 0;

interface PlaceEntry {
  names: string[];
  slug: string;
  category: string;
}

// Words too common to be useful as match signals
const STOP_WORDS = new Set([
  'building', 'nashville', 'tennessee', 'center', 'centre', 'street',
  'avenue', 'drive', 'road', 'place', 'suite', 'office', 'complex',
  'area', 'district', 'tower', 'plaza', 'hall', 'house',
]);

function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/&/g, '')            // AT&T → att, not "at t"
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 45);
}

function fuzzyScore(hint: string, entry: PlaceEntry): number {
  const hNorm = norm(hint);
  // Meaningful words: > 2 chars and not a stop word
  const hWords = hNorm.split(' ').filter((w) => w.length > 2 && !STOP_WORDS.has(w));

  for (const name of entry.names) {
    const nNorm = norm(name);
    if (nNorm === hNorm) return 1.0;
    // Substring match: the name must be long enough to be distinctive (>= 10 chars)
    // and the hint must cover at least half the name's length — prevents bare words
    // like "downtown" or "midtown" from matching unrelated descriptive phrases.
    if (
      nNorm.length >= 10 &&
      hNorm.length >= 6 &&
      hNorm.length >= nNorm.length * 0.5 &&
      (nNorm.includes(hNorm) || hNorm.includes(nNorm))
    ) {
      return 0.85;
    }
  }

  if (hWords.length === 0) return 0;

  let best = 0;
  for (const name of entry.names) {
    const nWords = norm(name)
      .split(' ')
      .filter((w) => w.length > 2 && !STOP_WORDS.has(w));
    if (nWords.length === 0) continue;
    const overlap = hWords.filter((w) => nWords.includes(w)).length;
    if (overlap > 0) {
      const score = overlap / Math.max(hWords.length, nWords.length);
      if (score > best) best = score;
    }
  }
  return best;
}

async function tryNominatim(hint: string): Promise<string | null> {
  const now = Date.now();
  if (now < nominatimNextAt) {
    await new Promise<void>((r) => setTimeout(r, nominatimNextAt - now));
  }
  nominatimNextAt = Date.now() + 1100;

  try {
    const q = encodeURIComponent(`${hint}, Nashville, Tennessee`);
    const url =
      `https://nominatim.openstreetmap.org/search` +
      `?q=${q}&format=json&limit=1&bounded=1&viewbox=${DAVIDSON_VIEWBOX}&countrycodes=us`;

    const res = await fetch(url, {
      signal: AbortSignal.timeout(4500),
      headers: { 'User-Agent': NOMINATIM_UA },
    });
    if (!res.ok) return null;

    const data = (await res.json()) as Array<{ display_name: string; name?: string }>;
    if (!data.length) return null;

    const name = data[0].name ?? data[0].display_name.split(',')[0].trim();
    return name.length > 1 ? name : null;
  } catch {
    return null;
  }
}

interface NominatimReverseResult {
  namedPlace: string | null;
  address: string | null;
}

async function tryNominatimReverse(lat: number, lng: number): Promise<NominatimReverseResult | null> {
  const now = Date.now();
  if (now < nominatimNextAt) await new Promise<void>((r) => setTimeout(r, nominatimNextAt - now));
  nominatimNextAt = Date.now() + 1100;

  try {
    const url =
      `https://nominatim.openstreetmap.org/reverse` +
      `?lat=${lat}&lon=${lng}&format=json&zoom=18&addressdetails=1`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(5000),
      headers: { 'User-Agent': NOMINATIM_UA },
    });
    if (!res.ok) return null;

    const data = (await res.json()) as {
      name?: string;
      display_name?: string;
      address?: Record<string, string>;
    };

    const addr = data.address ?? {};
    // A named place is anything with a proper name that isn't just a road
    const namedPlace =
      data.name && data.name !== addr.road && data.name !== addr.suburb
        ? data.name
        : (addr.amenity ?? addr.shop ?? addr.tourism ?? addr.historic ?? addr.leisure ?? null);

    // Build a readable address slug: house_number + road, or suburb
    const road = addr.road ?? addr.pedestrian ?? addr.footway;
    const houseNum = addr.house_number;
    const suburb = addr.suburb ?? addr.neighbourhood ?? addr.quarter;
    const addressStr = road
      ? `${houseNum ? houseNum + ' ' : ''}${road}${suburb ? ' ' + suburb : ''}`
      : suburb ?? null;

    return { namedPlace: namedPlace ?? null, address: addressStr };
  } catch {
    return null;
  }
}

async function tryOverpassNearby(lat: number, lng: number): Promise<string | null> {
  try {
    // Query named POIs (buildings, amenities, art, tourism) within 80m
    const query =
      `[out:json][timeout:10];` +
      `(` +
      `way["name"]["building"](around:80,${lat},${lng});` +
      `way["name"]["amenity"](around:80,${lat},${lng});` +
      `way["name"]["tourism"](around:80,${lat},${lng});` +
      `way["name"]["historic"](around:80,${lat},${lng});` +
      `way["name"]["leisure"](around:80,${lat},${lng});` +
      `node["name"]["amenity"](around:80,${lat},${lng});` +
      `node["name"]["shop"](around:80,${lat},${lng});` +
      `node["name"]["tourism"](around:80,${lat},${lng});` +
      `node["name"]["historic"](around:80,${lat},${lng});` +
      `node["tourism"="artwork"]["name"](around:80,${lat},${lng});` +
      `);out center tags 10;`;

    const res = await fetch('https://overpass-api.de/api/interpreter', {
      method: 'POST',
      body: `data=${encodeURIComponent(query)}`,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': NOMINATIM_UA,
      },
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) return null;

    const data = (await res.json()) as {
      elements: Array<{ tags?: Record<string, string> }>;
    };

    // Prefer named buildings/amenities over generic nodes
    for (const el of data.elements) {
      const name = el.tags?.name;
      const hasType =
        el.tags?.building || el.tags?.amenity || el.tags?.tourism || el.tags?.historic;
      if (name && hasType) return slugify(name);
    }
    // Any named element
    for (const el of data.elements) {
      const name = el.tags?.name;
      if (name) return slugify(name);
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * GPS-first location resolver. Tries in order:
 *   1. Nominatim reverse → named place (business, building, park)
 *   2. Overpass API → named OSM features within 80m (public art, amenities, historic)
 *   3. Nominatim reverse address → street address slug as last resort
 */
export async function resolveLocationFromGps(lat: number, lng: number): Promise<string | null> {
  // Sanity-check: must be somewhere in or near Davidson County
  if (
    lat < DAVIDSON_BOUNDS.south - 0.2 || lat > DAVIDSON_BOUNDS.north + 0.2 ||
    lng < DAVIDSON_BOUNDS.west - 0.2 || lng > DAVIDSON_BOUNDS.east + 0.2
  ) {
    monitorWarn('geocoder', 'gps out of davidson county bounds', { lat, lng });
    return null;
  }

  // 1. Nominatim reverse — named place
  const reverse = await tryNominatimReverse(lat, lng);
  if (reverse?.namedPlace) {
    monitorInfo('geocoder', 'gps tier-1 nominatim named place', { lat, lng, name: reverse.namedPlace });
    return slugify(reverse.namedPlace);
  }

  // 2. Overpass — find any named feature within 80m
  const overpass = await tryOverpassNearby(lat, lng);
  if (overpass) {
    monitorInfo('geocoder', 'gps tier-2 overpass nearby', { lat, lng, slug: overpass });
    return overpass;
  }

  // 3. Nominatim address as fallback (e.g. "432-charlotte-ave-north-nashville")
  if (reverse?.address) {
    monitorInfo('geocoder', 'gps tier-3 address slug', { lat, lng, address: reverse.address });
    return slugify(reverse.address);
  }

  return null;
}

/**
 * Parse a street address out of a title string.
 * Looks for patterns like "170 Second Avenue North" or "170-176 Second Ave N".
 */
function parseAddressFromTitle(title: string): string | null {
  const m = title.match(
    /\b(\d+(?:-\d+)?)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,3})\s+(?:Avenue|Ave|Street|St|Road|Rd|Drive|Dr|Boulevard|Blvd|Lane|Ln|Court|Ct|Place|Pl|Way|Pike|Highway|Hwy)\b/,
  );
  if (!m) return null;
  return slugify(`${m[1]} ${m[2]}`);
}

const TITLE_BOILERPLATE =
  /\s*[-|–—]\s*(Wikipedia|YouTube|WKRN|WSMV|WTVF|Fox17|NBC|CBS|ABC|Nashville\.gov|Nashville Scene|Tennessean|Nashville Post|Reddit|Twitter|X\.com|Facebook|Instagram|Patch|News\d+).*/i;

// Listicle/guide titles that are useless as location slugs
const BAD_TITLE_RE = /^(your|a-look|how-to|what-to|guide-to|things-to|top-\d|why-|when-|where-)|\b(guide-to|tips-for|best-of|how-to|things-to-do)\b/;

// A slug is "quality" only when it contains a geographic or event-specific marker —
// prevents "nashville-demolition", "heartbreaking-conclusion" from being used as settings.
const GEOGRAPHIC_MARKER_RE = /\b(avenue|street|boulevard|blvd|road|drive|lane|bombing|explosion|christmas|memorial|second|third|fourth|broadway|gulch|germantown|parthenon|courthouse|stadium|arena|library|park)\b/;

function isQualitySlug(slug: string): boolean {
  if (slug.length < 5) return false;
  if (BAD_TITLE_RE.test(slug)) return false;
  return GEOGRAPHIC_MARKER_RE.test(slug);
}

// Named Nashville streets — matches "Second Avenue North", "Church Street", etc.
// across result descriptions to find the consensus location.
const NAMED_STREET_SCAN_RE =
  /\b((?:First|Second|Third|Fourth|Fifth|Sixth|Seventh|Eighth|Ninth|Tenth|Broadway|Charlotte|Church|Commerce|Demonbreun|Division|Jefferson|Nolensville|Gallatin)\s+(?:Avenue?|Street|Pike|Boulevard|Blvd)(?:\s+(?:North|South|East|West))?)\b/gi;

/** Scan all result texts; return most-mentioned named street if 2+ results agree. */
function extractConsensusStreet(
  results: Array<{ title: string; description: string }>,
): string | null {
  const counts = new Map<string, number>();
  for (const r of results) {
    const seen = new Set<string>();
    const text = `${r.title} ${r.description}`;
    for (const m of text.matchAll(NAMED_STREET_SCAN_RE)) {
      // Normalize direction suffix ("Second Avenue North" → "second avenue") so
      // "Second Avenue" and "Second Avenue North" in different results both count.
      const key = m[1]
        .toLowerCase()
        .replace(/\s+(north|south|east|west)$/i, '')
        .trim();
      if (!seen.has(key)) {
        seen.add(key);
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
  }
  let topStreet: string | null = null;
  let topCount = 0;
  for (const [street, count] of counts) {
    if (count >= 2 && count > topCount) {
      topStreet = street;
      topCount = count;
    }
  }
  return topStreet ? slugify(topStreet) : null;
}

// A hint is "generic" when it describes activity/appearance with no specific
// location markers (street names, named events). Generic hints produce noisy
// Brave results and should not feed into the raw-slug fallback either.
const GENERIC_ACTIVITY_RE = /\b(construction site|demolition site|building site|staging area|parking lot|outdoor (event|area)|indoor (space|room))\b/i;
const SPECIFIC_MARKER_RE = /\b(street|avenue|ave\b|boulevard|blvd|road\b|drive\b|lane\b|bombing|explosion|christmas|memorial|museum|stadium|arena|campus|historic named|landmark)\b/i;

function isGenericHint(hint: string): boolean {
  return GENERIC_ACTIVITY_RE.test(hint) && !SPECIFIC_MARKER_RE.test(hint);
}

async function tryBraveSearch(query: string, proxyUrl: string): Promise<string | null> {
  try {
    const url = `${proxyUrl.replace(/\/$/, '')}/websearch`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shared-Secret': CLIENT_SHARED_SECRET,
      },
      body: JSON.stringify({ query }),
      signal: AbortSignal.timeout(13000),
    });
    if (!res.ok) return null;

    const data = (await res.json()) as {
      results?: Array<{ title: string; description: string; url: string }>;
    };
    const results = data.results ?? [];
    if (!results.length) return null;

    const firstTitle = results[0].title;

    // 1. Named street consensus: if 2+ results agree on a street, it's the subject
    const consensusStreet = extractConsensusStreet(results);
    if (consensusStreet) {
      monitorInfo('geocoder', 'brave-search street consensus', { query, slug: consensusStreet });
      return consensusStreet;
    }

    // 2. Street address in the first result's title (numbered address like "170 Second Ave")
    const addr = parseAddressFromTitle(firstTitle);
    if (addr) {
      monitorInfo('geocoder', 'brave-search address hit', { query, title: firstTitle, addr });
      return addr;
    }

    // 3. Clean first result title: strip boilerplate, keep only what's before colon
    //    (many news titles put the real content after the colon, so try both halves)
    const stripped = firstTitle.replace(TITLE_BOILERPLATE, '').trim();
    const afterColon = stripped.replace(/^[^:]+:\s*/, '').trim();
    const beforeColon = stripped.replace(/\s*:.*$/, '').trim();
    const titleCandidate = afterColon.length > beforeColon.length ? afterColon : stripped;
    const slug = slugify(titleCandidate);
    if (slug.length > 4 && isQualitySlug(slug)) {
      monitorInfo('geocoder', 'brave-search title slug', { query, title: firstTitle, slug });
      return slug;
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Resolve a natural-language location hint to a filename-safe slug.
 *
 * Tier 1 — Local Nashville places list (instant, offline, curated)
 * Tier 2 — OpenStreetMap Nominatim (Davidson County bounded, ~300ms)
 * Tier 3 — Brave Search via proxy (subject + hint as query for richer context)
 * Tier 4 — Raw hint slug (specific hints only; generic activity descriptions are skipped)
 * null   — caller keeps the AI's own setting field unchanged
 *
 * @param braveQuery - Optional enriched query for Brave (e.g. "{subject} {locationHint}").
 *                     Falls back to `hint` when omitted.
 */
export async function resolveLocation(
  hint: string | undefined,
  proxyUrl?: string,
  braveQuery?: string,
): Promise<string | null> {
  if (!hint || norm(hint).length < 3) return null;
  const h = hint.trim();

  // Tier 1: local curated Nashville places
  let bestScore = 0;
  let bestEntry: PlaceEntry | null = null;
  for (const entry of places as PlaceEntry[]) {
    const score = fuzzyScore(h, entry);
    if (score > bestScore) {
      bestScore = score;
      bestEntry = entry;
    }
  }
  if (bestScore >= 0.5 && bestEntry) {
    monitorInfo('geocoder', 'tier-1 local match', {
      hint: h,
      slug: bestEntry.slug,
      category: bestEntry.category,
      score: bestScore.toFixed(2),
    });
    return bestEntry.slug;
  }

  // Tier 2: Nominatim (Davidson County bounded)
  const nominatimName = await tryNominatim(h);
  if (nominatimName) {
    const slug = slugify(nominatimName);
    monitorInfo('geocoder', 'tier-2 nominatim match', { hint: h, name: nominatimName, slug });
    return slug;
  }

  // Tier 3: Brave Search — use enriched query (subject + hint) for better precision
  if (proxyUrl) {
    const searchTerm = (braveQuery ?? h).trim();
    const braveSlug = await tryBraveSearch(searchTerm, proxyUrl);
    if (braveSlug && isQualitySlug(braveSlug)) {
      monitorInfo('geocoder', 'tier-3 brave-search match', { hint: h, query: searchTerm, slug: braveSlug });
      return braveSlug;
    }
    monitorWarn('geocoder', 'tier-3 brave-search no quality result', { hint: h, query: searchTerm, braveSlug });
  }

  // Tier 4: raw hint slug — only for specific hints (generic activity hints return null
  // so the caller keeps the AI's own descriptive setting field)
  if (!isGenericHint(h)) {
    const raw = slugify(h);
    if (raw.length > 2) {
      monitorWarn('geocoder', 'tier-4 raw hint fallback', { hint: h, slug: raw });
      return raw;
    }
  }

  monitorInfo('geocoder', 'no match — keeping ai setting', { hint: h });
  return null;
}
