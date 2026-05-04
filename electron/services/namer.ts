import { clipDateTokenFromMetadata } from '../../shared/dateStamp';
import type { ClipMetadata, NameParts } from '../../shared/types';

/** Normalize a single segment: lowercase, strip accents, collapse to [a-z0-9-]. */
function sanitizeSegment(raw: string): string {
  return raw
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // strip diacritics
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
}

/** Leading (MM.DD.YY) prefix allowed in filenames — rest is hyphen slug. */
const DATE_PREFIX_RE = /^\(\d{2}\.\d{2}\.\d{2}\)/;

/** Whole-filename sanitize — never allow traversal or weird chars. */
export function sanitizeFilename(raw: string): string {
  const m = raw.match(DATE_PREFIX_RE);
  if (m && m.index === 0) {
    const prefix = m[0];
    const rest = sanitizeSegment(raw.slice(prefix.length));
    const out = (prefix + rest).slice(0, 200);
    return out || 'clip';
  }
  return sanitizeSegment(raw).slice(0, 180) || 'clip';
}

/**
 * Format a proposed name (without extension) from the template.
 * Supported vars: {date} {subject} {technique} {setting} {confidence}
 * — {date} is (MM.DD.YY) from clip `recordedAtUtc` (ffprobe shoot time), or empty if missing.
 */
export function formatProposedName(
  parts: NameParts,
  template: string,
  metadata?: ClipMetadata | null,
): string {
  const subject = sanitizeSegment(parts.subject);
  const technique = sanitizeSegment(parts.technique);
  const setting = sanitizeSegment(parts.setting);
  const confidence = sanitizeSegment(parts.confidence);

  const filled = template
    .replace(/\{date\}/g, clipDateTokenFromMetadata(metadata))
    .replace(/\{subject\}/g, subject)
    .replace(/\{technique\}/g, technique)
    .replace(/\{setting\}/g, setting)
    .replace(/\{confidence\}/g, confidence);

  return sanitizeFilename(filled);
}
