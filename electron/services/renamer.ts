import fs from 'node:fs/promises';
import path from 'node:path';
import { app } from 'electron';
import pLimit from 'p-limit';
import type { Clip, HistoryEntry, RenameJob, RenameResult, Settings } from '../../shared/types';
import { rewriteVideoMetadataInPlace, shouldRenderOutput, writeVideoWithMetadata } from './ffmpeg';
import { monitorError, monitorInfo } from './monitorLog';
import { sanitizeFilename } from './namer';

const HISTORY_PATH = path.join(app.getPath('userData'), 'history.json');

// Four parallel encodes is the practical ceiling on Apple Silicon for this
// workload: VideoToolbox multiplexes hardware HEVC sessions cleanly, source
// I/O off a USB-C / Thunderbolt drive doesn't get thrashed, and we leave
// enough CPU headroom for the single-threaded lut3d filter to run on each
// job. Pure rename / -c copy jobs are I/O-bound and benefit from the same
// parallelism without saturating the encoder.
const EXPORT_CONCURRENCY = 4;

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

export async function applyRenames(
  jobs: RenameJob[],
  settings: Settings,
): Promise<RenameResult[]> {
  const batch: HistoryEntry[] = [];
  const ts = new Date().toISOString();

  const plainDestBase =
    settings.outputMode === 'copy-to-folder' && settings.copyFolder
      ? settings.copyFolder
      : null;
  const gradedDestBase =
    settings.gradedOutputMode === 'copy-to-folder' && settings.gradedCopyFolder
      ? settings.gradedCopyFolder
      : null;
  if (plainDestBase) await fs.mkdir(plainDestBase, { recursive: true });
  if (gradedDestBase) await fs.mkdir(gradedDestBase, { recursive: true });

  /** A job counts as graded when it has LUT or non-zero exposure applied. */
  function isGradedJob(job: RenameJob): boolean {
    return shouldRenderOutput(job.outputTweaks);
  }
  function destBaseFor(job: RenameJob): string | null {
    return isGradedJob(job) && gradedDestBase ? gradedDestBase : plainDestBase;
  }

  monitorInfo('export', 'batch planning complete', {
    jobs: jobs.length,
    concurrency: EXPORT_CONCURRENCY,
    plainOutputMode: plainDestBase ? 'copy-to-folder' : 'same-folder',
    plainDestBase: plainDestBase ?? '(source dirs)',
    gradedOutputMode: gradedDestBase ? 'copy-to-folder' : 'overwrite',
    gradedDestBase: gradedDestBase ?? '(source dirs)',
  });

  // uniquePath() is racy under parallelism: two jobs landing on the same
  // baseName could both probe and resolve to the same candidate before
  // either writes. Pre-reserve names sequentially first, then run the
  // ffmpeg / fs work in parallel.
  type Plan = {
    job: RenameJob;
    finalPath: string;
    noop: boolean;
    /** Destination folder for this specific job (may differ from the global plain base). */
    jobDestBase: string | null;
  };
  const reserved = new Set<string>();
  const plans: Plan[] = [];

  async function reserveUnique(dir: string, baseName: string, ext: string): Promise<string> {
    let i = 1;
    while (true) {
      const candidate = i === 1
        ? path.join(dir, `${baseName}${ext}`)
        : path.join(dir, `${baseName}-${i}${ext}`);
      const key = path.resolve(candidate).toLowerCase();
      if (!reserved.has(key) && !(await exists(candidate))) {
        reserved.add(key);
        return candidate;
      }
      i += 1;
    }
  }

  for (const job of jobs) {
    const baseName = sanitizeFilename(job.proposedName);
    const srcDir = path.dirname(job.originalPath);
    const jobDestBase = destBaseFor(job);
    const dir = jobDestBase ?? srcDir;
    const desired = path.join(dir, `${baseName}${job.ext}`);
    const noop = !jobDestBase && path.resolve(desired) === path.resolve(job.originalPath);
    const finalPath = noop ? job.originalPath : await reserveUnique(dir, baseName, job.ext);
    plans.push({ job, finalPath, noop, jobDestBase });
  }

  const limit = pLimit(EXPORT_CONCURRENCY);
  const results: RenameResult[] = await Promise.all(
    plans.map((plan) =>
      limit(async (): Promise<RenameResult> => {
        const { job, finalPath, noop, jobDestBase } = plan;
        monitorInfo('export', 'job start', {
          id: job.id,
          src: job.originalPath,
          dst: finalPath,
          noop,
          lutOrExposure: isGradedJob(job),
          destBase: jobDestBase ?? '(source dir)',
        });
        try {
          if (noop) {
            if (job.metadataTags) {
              await rewriteVideoMetadataInPlace(
                job.originalPath,
                job.metadataTags,
                job.outputTweaks,
              );
            }
            monitorInfo('export', 'job ok', { id: job.id, finalPath: job.originalPath, noop: true });
            return { id: job.id, ok: true, finalPath: job.originalPath };
          }

          if (job.metadataTags && path.resolve(finalPath) === path.resolve(job.originalPath)) {
            await rewriteVideoMetadataInPlace(job.originalPath, job.metadataTags, job.outputTweaks);
          } else if (job.metadataTags) {
            await writeVideoWithMetadata(
              job.originalPath,
              finalPath,
              job.metadataTags,
              job.outputTweaks,
            );
            // Remove the source only when this job is writing back into the
            // same source tree (overwrite-style rename). If it landed in any
            // destination folder — plain copy OR graded copy — leave the
            // original alone.
            if (!jobDestBase) await fs.rm(job.originalPath, { force: true });
          } else if (jobDestBase) {
            await fs.copyFile(job.originalPath, finalPath);
          } else {
            await fs.rename(job.originalPath, finalPath);
          }

          batch.push({ ts, originalPath: job.originalPath, finalPath });
          monitorInfo('export', 'job ok', { id: job.id, finalPath });
          return { id: job.id, ok: true, finalPath };
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          monitorError('export', 'job failed', {
            id: job.id,
            src: job.originalPath,
            dst: finalPath,
            error: message,
          });
          return {
            id: job.id,
            ok: false,
            error: message,
          };
        }
      }),
    ),
  );

  if (batch.length) {
    const history = await readHistory();
    history.push(batch);
    // Keep only the last 50 batches
    if (history.length > 50) history.splice(0, history.length - 50);
    await writeHistory(history);
  }

  const ok = results.filter((r) => r.ok).length;
  monitorInfo('export', 'batch finished', {
    jobs: results.length,
    ok,
    failed: results.length - ok,
  });

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
