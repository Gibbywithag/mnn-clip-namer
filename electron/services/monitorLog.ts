/**
 * Dev / diagnostics logging for the Electron main process.
 * Lines go to the terminal where `npm run dev` runs (stdout/stderr).
 *
 * Prefix every line with `[mnn]` so it’s easy to grep: `npm run dev 2>&1 | grep '\[mnn\]'`
 */

function stamp(): string {
  return new Date().toISOString();
}

export function monitorInfo(scope: string, message: string, meta?: Record<string, unknown>): void {
  const head = `[mnn] ${stamp()} [${scope}] ${message}`;
  if (meta && Object.keys(meta).length > 0) console.log(head, meta);
  else console.log(head);
}

export function monitorWarn(scope: string, message: string, meta?: Record<string, unknown>): void {
  const head = `[mnn] ${stamp()} [${scope}] ${message}`;
  if (meta && Object.keys(meta).length > 0) console.warn(head, meta);
  else console.warn(head);
}

export function monitorError(scope: string, message: string, meta?: Record<string, unknown>): void {
  const head = `[mnn] ${stamp()} [${scope}] ${message}`;
  if (meta && Object.keys(meta).length > 0) console.error(head, meta);
  else console.error(head);
}
