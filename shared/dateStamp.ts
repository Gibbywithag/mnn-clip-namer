/**
 * Filename-safe date prefix for naming templates: (MM.DD.YY)
 * Matches the convention (MM.DD.YR) with a 2-digit year.
 * Uses the caller's local calendar for month/day/year digits.
 */
export function formatTemplateDate(d: Date = new Date()): string {
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const yy = String(d.getFullYear()).slice(-2);
  return `(${mm}.${dd}.${yy})`;
}

/** `{date}` replacement from ffprobe `recordedAtUtc` (clip shoot time), or empty if unknown. */
export function clipDateTokenFromMetadata(metadata?: { recordedAtUtc?: string } | null): string {
  if (!metadata?.recordedAtUtc) return '';
  const d = new Date(metadata.recordedAtUtc);
  if (Number.isNaN(d.getTime())) return '';
  return formatTemplateDate(d);
}
