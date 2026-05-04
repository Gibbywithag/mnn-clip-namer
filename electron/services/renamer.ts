import fs from 'node:fs/promises';
import path from 'node:path';
import { app } from 'electron';
import type { Clip, HistoryEntry, RenameJob, RenameResult, Settings } from '../../shared/types';
import { sanitizeFilename } from './namer';

const HISTORY_PATH = path.join(app.getPath('userData'), 'history.json');

async function readHistory(): Promise<HistoryEntry[][]> {
  try {
    const raw = await fs.readFile(HISTORY_PATH, 'utf-8');
    return JSON.parse(raw) as HistoryEntry[][];
  } catch {
    return [];
  }
}

async function writeHistory(h: HistoryEntry[][]): Promise<void> {
  await fs.mkdir(path.dirname(HISTORY_PATH), { recursive: true });
  await fs.writeFile(HISTORY_PATH, JSON.stringify(h, null, 2), 'utf-8');
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** Resolve a collision-free path in `dir` for baseName+ext. */
async function uniquePath(dir: string, baseName: string, ext: string): Promise<string> {
  let candidate = path.join(dir, `${baseName}${ext}`);
  let i = 2;
  while (await exists(candidate)) {
    candidate = path.join(dir, `${baseName}-${i}${ext}`);
    i += 1;
  }
  return candidate;
}

export async function applyRenames(
  jobs: RenameJob[],
  settings: Settings,
): Promise<RenameResult[]> {
  const results: RenameResult[] = [];
  const batch: HistoryEntry[] = [];
  const ts = new Date().toISOString();

  const destBase =
    settings.outputMode === 'copy-to-folder' && settings.copyFolder
      ? settings.copyFolder
      : null;
  if (destBase) await fs.mkdir(destBase, { recursive: true });

  for (const job of jobs) {
    try {
      const baseName = sanitizeFilename(job.proposedName);
      const srcDir = path.dirname(job.originalPath);
      const dir = destBase ?? srcDir;
      const desired = path.join(dir, `${baseName}${job.ext}`);

      // No-op: source and target are the same file.
      if (!destBase && path.resolve(desired) === path.resolve(job.originalPath)) {
        results.push({ id: job.id, ok: true, finalPath: job.originalPath });
        continue;
      }

      const finalPath = await uniquePath(dir, baseName, job.ext);

      if (destBase) {
        await fs.copyFile(job.originalPath, finalPath);
      } else {
        await fs.rename(job.originalPath, finalPath);
      }

      batch.push({ ts, originalPath: job.originalPath, finalPath });
      results.push({ id: job.id, ok: true, finalPath });
    } catch (err: unknown) {
      results.push({
        id: job.id,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (batch.length) {
    const history = await readHistory();
    history.push(batch);
    // Keep only the last 50 batches
    if (history.length > 50) history.splice(0, history.length - 50);
    await writeHistory(history);
  }

  return results;
}

/** Undo the most recent rename batch. Returns count of successfully reverted files. */
export async function undoLast(): Promise<number> {
  const history = await readHistory();
  const last = history.pop();
  if (!last || last.length === 0) return 0;
  let reverted = 0;
  for (const entry of last) {
    try {
      // Only undo if the final path still exists and original doesn't.
      if ((await exists(entry.finalPath)) && !(await exists(entry.originalPath))) {
        await fs.rename(entry.finalPath, entry.originalPath);
        reverted += 1;
      }
    } catch {
      // Skip failures silently — partial undo is still useful.
    }
  }
  await writeHistory(history);
  return reverted;
}

export async function exportCsv(clips: Clip[], outPath: string): Promise<void> {
  const header = 'original_path,final_path,subject,technique,setting,confidence\n';
  const rows = clips.map((c) => {
    const escape = (v: string | undefined) => {
      if (v == null) return '';
      if (/[",\n]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
      return v;
    };
    return [
      escape(c.originalPath),
      escape(c.finalPath ?? ''),
      escape(c.nameParts?.subject),
      escape(c.nameParts?.technique),
      escape(c.nameParts?.setting),
      escape(c.nameParts?.confidence),
    ].join(',');
  });
  await fs.writeFile(outPath, header + rows.join('\n') + '\n', 'utf-8');
}
