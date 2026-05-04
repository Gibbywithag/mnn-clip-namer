import ffmpeg from 'fluent-ffmpeg';
import ffprobeInstaller from '@ffprobe-installer/ffprobe';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { ClipMetadata } from '../../shared/types';

// Rewrite asar → asar.unpacked so the bundled binaries are actually executable
// in the packaged app.
const unpack = (p: string) =>
  p.replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`);
ffmpeg.setFfprobePath(unpack(ffprobeInstaller.path));
ffmpeg.setFfmpegPath(unpack(ffmpegInstaller.path));

type LooseTags = Record<string, unknown> | undefined;

function stringTag(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t || undefined;
}

/** Merge format + stream tags (video first, then others). Later values overwrite earlier for the same key. */
function mergeFfprobeTags(
  formatTags: LooseTags,
  streams: Array<{ codec_type?: string; tags?: LooseTags }> | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  const put = (tags: LooseTags) => {
    if (!tags || typeof tags !== 'object') return;
    for (const [k, v] of Object.entries(tags)) {
      const s = stringTag(v);
      if (s) out[k] = s;
    }
  };
  put(formatTags);
  const video = streams?.find((s) => s.codec_type === 'video');
  put(video?.tags);
  if (streams) {
    for (const s of streams) {
      if (s === video) continue;
      put(s.tags);
    }
  }
  return out;
}

const RECORDING_TAG_KEYS = [
  'creation_time',
  'com.apple.quicktime.creationdate',
  'media_create_date',
  'date',
  'creation_date',
  'DATE',
] as const;

/** Parse common container / QuickTime / legacy date tag shapes. */
function parseRecordingInstant(raw: string): Date | null {
  const s = raw.trim();
  if (!s) return null;
  const compact = /^(\d{4})(\d{2})(\d{2})$/.exec(s);
  if (compact) {
    const y = Number(compact[1]);
    const mo = Number(compact[2]) - 1;
    const da = Number(compact[3]);
    const d = new Date(Date.UTC(y, mo, da));
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  if (d.getUTCFullYear() < 1970) return null;
  return d;
}

function recordedAtUtcFromTags(tags: Record<string, string>): string | undefined {
  for (const key of RECORDING_TAG_KEYS) {
    const raw = tags[key];
    if (!raw) continue;
    const d = parseRecordingInstant(raw);
    if (d) return d.toISOString();
  }
  return undefined;
}

export async function probeMetadata(filePath: string): Promise<ClipMetadata> {
  const stat = await fs.stat(filePath);
  return new Promise<ClipMetadata>((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, data) => {
      if (err) return reject(err);
      const videoStream = data.streams.find((s) => s.codec_type === 'video');
      if (!videoStream) return reject(new Error('No video stream found'));
      const fpsParts = (videoStream.r_frame_rate ?? '0/1').split('/');
      const fps =
        fpsParts.length === 2 && Number(fpsParts[1]) > 0
          ? Number(fpsParts[0]) / Number(fpsParts[1])
          : 0;
      const merged = mergeFfprobeTags(data.format?.tags, data.streams);
      const recordedAtUtc = recordedAtUtcFromTags(merged);
      resolve({
        durationSec: Number(data.format.duration ?? 0),
        width: Number(videoStream.width ?? 0),
        height: Number(videoStream.height ?? 0),
        fps,
        codec: String(videoStream.codec_name ?? 'unknown'),
        sizeBytes: stat.size,
        ...(recordedAtUtc ? { recordedAtUtc } : {}),
      });
    });
  });
}
