import ffmpeg from 'fluent-ffmpeg';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import ffprobeInstaller from '@ffprobe-installer/ffprobe';
import { app } from 'electron';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { OutputTweaks, VideoMetadataTags } from '../../shared/types';
import { monitorError, monitorInfo, monitorWarn } from './monitorLog';

// In packaged Electron apps, ffmpeg lives inside app.asar but binaries there
// aren't executable — electron-builder mirrors them to app.asar.unpacked
// (see asarUnpack in package.json). Rewrite the path so spawn() actually works.
const ffmpegPath = ffmpegInstaller.path.replace(
  `${path.sep}app.asar${path.sep}`,
  `${path.sep}app.asar.unpacked${path.sep}`,
);
const ffprobePath = ffprobeInstaller.path.replace(
  `${path.sep}app.asar${path.sep}`,
  `${path.sep}app.asar.unpacked${path.sep}`,
);
ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);

const TMP_ROOT = path.join(app.getPath('temp'), 'mnn-clip-namer');
const BUNDLED_LUT_RELATIVE_PATH = path.join('resources', 'luts', 'Neutral-Fx6-65x-Legacy.cube');

async function ensureTmp(): Promise<string> {
  const dir = path.join(TMP_ROOT, randomUUID());
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

/** Extract a single thumbnail (first reasonable frame) as a data URL. */
export async function extractThumbnail(
  filePath: string,
  durationSec: number,
): Promise<string> {
  const tmpDir = await ensureTmp();
  const outPath = path.join(tmpDir, 'thumb.jpg');
  const seekSec = Math.min(Math.max(durationSec * 0.1, 0.5), Math.max(durationSec - 0.5, 0.5));
  const useHwDecode = process.platform === 'darwin';
  await new Promise<void>((resolve, reject) => {
    const cmd = ffmpeg(filePath);
    if (useHwDecode) cmd.inputOptions(['-hwaccel', 'videotoolbox']);
    cmd
      .seekInput(seekSec)
      .frames(1)
      .outputOptions(['-vf', 'scale=480:-2', '-q:v', '4'])
      .output(outPath)
      .on('end', () => resolve())
      .on('error', reject)
      .run();
  });
  const buf = await fs.readFile(outPath);
  await fs.rm(tmpDir, { recursive: true, force: true });
  return `data:image/jpeg;base64,${buf.toString('base64')}`;
}

/**
 * Extract N evenly-spaced keyframes across the clip as JPEG buffers.
 * Frames are scaled large enough for OCR-ish visual cues such as lower-thirds,
 * storefronts, room labels, and signs to remain legible to the vision model.
 */
export async function extractKeyframes(
  filePath: string,
  durationSec: number,
  count: number,
): Promise<Buffer[]> {
  const n = Math.max(2, Math.min(8, count));
  // Bias toward the opening/closing context instead of only midpoint samples:
  // title cards, signs, storefronts, and establishing shots often live there.
  const stops = Array.from(
    { length: n },
    (_, i) => (0.08 + (0.84 * i) / Math.max(n - 1, 1)) * durationSec,
  );
  const tmpDir = await ensureTmp();
  // Use a pre-sized array filled with null-sentinels so Promise.all results
  // always land at the right index and .map() never encounters sparse holes.
  const frames: Array<Buffer | null> = Array(n).fill(null);
  const useHwDecode = process.platform === 'darwin';

  try {
    // Extract all N frames in parallel. Each ffmpeg process does a fast
    // seek + single-frame grab, so they don't fight over the CPU; the
    // previous serial loop spent most of its time on per-process startup.
    // Hardware HEVC decode (videotoolbox) on Apple Silicon makes each one
    // cheap even for 4K Sony FX inputs.
    await Promise.all(
      stops.map(async (rawStop, i) => {
        const out = path.join(tmpDir, `frame-${i}.jpg`);
        const seekSec = Math.min(Math.max(rawStop, 0), Math.max(durationSec - 0.05, 0));
        await new Promise<void>((resolve, reject) => {
          const cmd = ffmpeg(filePath);
          if (useHwDecode) cmd.inputOptions(['-hwaccel', 'videotoolbox']);
          cmd
            .seekInput(seekSec)
            .frames(1)
            // 1280px wide @ q=3 costs more than tiny previews, but vague names
            // are worse than slightly larger analysis frames for this workflow.
            .outputOptions(['-vf', 'scale=1280:-2', '-q:v', '3'])
            .output(out)
            .on('end', () => resolve())
            .on('error', reject)
            .run();
        });
        const buf = await fs.readFile(out);
        if (buf.length > 0) frames[i] = buf;
      }),
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  }

  // Filter out any nulls (failed/empty frames) and return only valid ones.
  return frames.filter((f): f is Buffer => f !== null && f.length > 0);
}

function metadataOptions(tags: VideoMetadataTags): string[] {
  const options = ['-movflags', 'use_metadata_tags'];
  const entries: Array<[string, string]> = [
    ['title', tags.title],
    ['description', tags.description],
    ['comment', tags.comment],
    ['keywords', tags.keywords],
    ['original_filename', tags.originalName],
  ];

  for (const [key, value] of entries) {
    const trimmed = value.trim();
    if (trimmed) options.push('-metadata', `${key}=${trimmed}`);
  }

  return options;
}

function bundledLutPath(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'luts', 'Neutral-Fx6-65x-Legacy.cube');
  }
  return path.join(process.cwd(), BUNDLED_LUT_RELATIVE_PATH);
}

function ffmpegFilterPath(filePath: string): string {
  return filePath
    .replace(/\\/g, '/')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'");
}

function outputTweaksEnabled(tweaks?: OutputTweaks): boolean {
  if (!tweaks) return false;
  return tweaks.applyConversionLut || Math.abs(tweaks.exposureStops) > 0.001;
}

/**
 * Pick the LUT-chain pixel format that matches the destination encoder's
 * native chroma. The lut3d filter is single-threaded CPU in ffmpeg 4.4 and
 * its cost scales with chroma resolution, so we don't want to upsample to
 * yuv422p10le only for the encoder to throw the extra chroma away (the MP4
 * / HEVC path is 4:2:0). For .mov ProRes the user is explicitly paying for
 * 4:2:2 chroma precision, so we keep yuv422p10le there.
 *
 * Forcing 10-bit either way is the load-bearing piece: Sony S-Log3 is shot
 * in 10-bit, and an auto-selected 8-bit intermediate would band skies,
 * skin, and shadow rolls hard once the LUT expands the curve.
 */
function lutChromaFormat(outputPath: string): string {
  const ext = path.extname(outputPath).toLowerCase();
  if (ext === '.mov') return 'yuv422p10le';
  return 'yuv420p10le';
}

function videoFilters(outputPath: string, tweaks?: OutputTweaks): string[] {
  if (!tweaks) return [];
  const filters: string[] = [];
  filters.push(`format=${lutChromaFormat(outputPath)}`);
  if (tweaks.applyConversionLut) {
    filters.push(
      `lut3d=file='${ffmpegFilterPath(bundledLutPath())}':interp=tetrahedral`,
    );
  }
  if (Math.abs(tweaks.exposureStops) > 0.001) {
    filters.push(`exposure=exposure=${tweaks.exposureStops.toFixed(2)}`);
  }
  return filters;
}

/**
 * Tell players that the LUT-converted output is BT.709. Sony source files
 * carry S-Log3 / S-Gamut3.Cine color tags; if we don't overwrite them the
 * output looks crushed and over-saturated in QuickTime, Premiere, Resolve,
 * and web players.
 */
function colorTagOptions(): string[] {
  return [
    '-color_primaries', 'bt709',
    '-color_trc', 'bt709',
    '-colorspace', 'bt709',
    '-color_range', 'tv',
  ];
}

interface SourceVideoProps {
  width: number;
  height: number;
  fps: number;
}

/**
 * Cheap structural probe so we can size encoder bitrate for the source's true
 * resolution × framerate. Adds ~30–50 ms per clip — trivial vs. a 25 s encode,
 * and avoids plumbing video metadata through the rename layer.
 *
 * We fail soft: if ffprobe can't determine a dimension, the encoder falls back
 * to the conservative defaults below, which still produce a valid file.
 */
async function probeSourceVideoProps(inputPath: string): Promise<SourceVideoProps | null> {
  return new Promise<SourceVideoProps | null>((resolve) => {
    ffmpeg.ffprobe(inputPath, (err, data) => {
      if (err) return resolve(null);
      const v = data?.streams?.find((s) => s.codec_type === 'video');
      if (!v) return resolve(null);
      const width = Number(v.width ?? 0);
      const height = Number(v.height ?? 0);
      const [num, den] = String(v.r_frame_rate ?? '0/1').split('/');
      const fps = Number(den) > 0 ? Number(num) / Number(den) : 0;
      if (!width || !height) return resolve(null);
      resolve({ width, height, fps: fps || 30 });
    });
  });
}

/**
 * hevc_videotoolbox is bitrate-driven (no CRF mode), so the fixed 30 Mbps
 * default that worked for 4K 24p clips will under-bitrate 4K 60p and waste
 * space on 1080p clips. Scale by pixels-per-second using ~0.12 bpp, which is
 * the "visually transparent" rule of thumb for 10-bit HEVC of graded B-roll.
 *
 *   4K  60p ≈ 60 Mbps     1080p 120p ≈ 30 Mbps
 *   4K  30p ≈ 30 Mbps     1080p  60p ≈ 15 Mbps
 *   4K  24p ≈ 24 Mbps      720p  60p ≈  7 Mbps (clamped to 8M floor)
 *
 * Floor of 8 Mbps keeps SD/HD clips from looking obviously transcoded.
 * Ceiling of 100 Mbps protects against pathological 4K 240p inputs the
 * encoder couldn't keep up with anyway.
 */
function targetBitrateMbps(src: SourceVideoProps): number {
  const BITS_PER_PIXEL = 0.12;
  const raw = (src.width * src.height * src.fps * BITS_PER_PIXEL) / 1_000_000;
  const rounded = Math.round(raw);
  if (!Number.isFinite(rounded) || rounded < 8) return 8;
  if (rounded > 100) return 100;
  return rounded;
}

function videoEncoderOptions(outputPath: string, src: SourceVideoProps | null): string[] {
  const ext = path.extname(outputPath).toLowerCase();

  if (ext === '.webm') {
    return ['-c:v', 'libvpx-vp9', '-crf', '20', '-b:v', '0', '-c:a', 'libopus'];
  }
  if (ext === '.mxf') {
    return ['-c:v', 'mpeg2video', '-q:v', '2', '-c:a', 'copy'];
  }

  // .mov — ProRes 422 HQ is the editorial-standard intermediate for graded
  // S-Log/V-Log footage. Keeps full 4:2:2 10-bit precision; files are large
  // but exactly what an NLE wants downstream. Bitrate is determined by the
  // profile pin, not -b:v, so no scaling needed here.
  if (ext === '.mov') {
    return [
      '-c:v', 'prores_ks',
      '-profile:v', '3',
      '-vendor', 'apl0',
      '-pix_fmt', 'yuv422p10le',
      '-c:a', 'pcm_s16le',
    ];
  }

  // .mp4 / .m4v / .mkv — HEVC Main10 keeps 10-bit precision after the LUT
  // (libx264 would force 8-bit and band hard on S-Log gradients). hvc1 tag
  // is the Apple-canonical fourcc so QuickTime, Finder previews, and macOS
  // Photos all play the file without a re-wrap.
  //
  // On macOS we use hevc_videotoolbox — the Apple Silicon hardware HEVC
  // encoder runs roughly 10-30x faster than libx265 -preset medium at
  // visually equivalent quality for graded B-roll. Without it, a 40-clip
  // 4K batch takes hours. Software libx265 stays as the cross-platform
  // fallback (Intel Macs, Windows, Linux dev builds).
  if (process.platform === 'darwin') {
    const targetMbps = src ? targetBitrateMbps(src) : 30;
    const maxMbps = Math.round(targetMbps * 1.2);
    const bufMbps = targetMbps * 2;
    return [
      '-c:v', 'hevc_videotoolbox',
      '-profile:v', 'main10',
      '-pix_fmt', 'p010le',
      '-b:v', `${targetMbps}M`,
      '-maxrate', `${maxMbps}M`,
      '-bufsize', `${bufMbps}M`,
      '-tag:v', 'hvc1',
      '-c:a', 'aac',
      '-b:a', '192k',
    ];
  }

  // libx265 software path: CRF mode auto-scales bitrate with resolution and
  // framerate (more pixels-per-second naturally consume more bits at the same
  // CRF), so no explicit -b:v needed here.
  return [
    '-c:v', 'libx265',
    '-preset', 'fast',
    '-crf', '22',
    '-pix_fmt', 'yuv420p10le',
    '-tag:v', 'hvc1',
    '-x265-params', 'log-level=error:colorprim=bt709:transfer=bt709:colormatrix=bt709:range=limited',
    '-c:a', 'aac',
    '-b:a', '192k',
  ];
}

function outputOptions(
  outputPath: string,
  tags: VideoMetadataTags,
  tweaks: OutputTweaks | undefined,
  src: SourceVideoProps | null,
): string[] {
  const filters = videoFilters(outputPath, tweaks);
  // -vsync passthrough preserves the source's exact frame timestamps. The
  // default vsync mode can drop or duplicate frames at edges when ffmpeg
  // thinks the framerate is irregular — which is exactly what Sony S&Q
  // (Slow & Quick) clips and any other VFR source look like to it. With
  // passthrough, a 4K 120p slow-mo clip ships back as a 4K 120p clip with
  // every frame intact. The container itself preserves width/height since
  // we never pass -s.
  const streamOptions = filters.length
    ? [
        '-map', '0:v:0',
        '-map', '0:a?',
        '-vf', filters.join(','),
        '-vsync', 'passthrough',
        ...videoEncoderOptions(outputPath, src),
        ...colorTagOptions(),
      ]
    : ['-map', '0', '-c', 'copy'];
  return [...streamOptions, ...metadataOptions(tags)];
}

/** Copy/remux a video while preserving streams and adding container metadata. */
export async function writeVideoWithMetadata(
  inputPath: string,
  outputPath: string,
  tags: VideoMetadataTags,
  tweaks?: OutputTweaks,
): Promise<void> {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  // Only probe when we'll actually re-encode (filters present). Stream-copy
  // jobs preserve everything by definition and skip the encoder entirely.
  const src = outputTweaksEnabled(tweaks) ? await probeSourceVideoProps(inputPath) : null;
  const reencode = outputTweaksEnabled(tweaks);
  monitorInfo('ffmpeg', 'writeVideoWithMetadata start', {
    mode: reencode ? 'reencode+lut-or-tags' : 'stream-copy+metadata',
    in: inputPath,
    out: outputPath,
    ...(src ? { width: src.width, height: src.height, fps: src.fps } : {}),
  });
  const run = (useHwDecode: boolean) =>
    new Promise<void>((resolve, reject) => {
      const cmd = ffmpeg(inputPath);
      // Pair the hardware HEVC encoder with hardware decode on Apple
      // Silicon when we're actually re-encoding. Pure stream-copy passes
      // skip decode entirely so hwaccel is irrelevant there.
      if (reencode && useHwDecode) cmd.inputOptions(['-hwaccel', 'videotoolbox']);
      cmd
        .outputOptions(outputOptions(outputPath, tags, tweaks, src))
        .output(outputPath)
        .on('end', () => resolve())
        .on('error', reject)
        .run();
    });

  const useHwDecode = process.platform === 'darwin';
  try {
    try {
      await run(useHwDecode);
    } catch (firstErr) {
      if (!useHwDecode) throw firstErr;
      // Some Sony MP4s have unusual edit lists that trip videotoolbox decode.
      // Fall back to software decode rather than failing the whole rename.
      monitorWarn('ffmpeg', 'hw decode failed, retrying software', {
        in: inputPath,
        error: firstErr instanceof Error ? firstErr.message : String(firstErr),
      });
      await fs.rm(outputPath, { force: true }).catch(() => undefined);
      await run(false);
    }
    monitorInfo('ffmpeg', 'writeVideoWithMetadata done', { out: outputPath });
  } catch (err) {
    monitorError('ffmpeg', 'writeVideoWithMetadata failed', {
      in: inputPath,
      out: outputPath,
      error: err instanceof Error ? err.message : String(err),
    });
    await fs.rm(outputPath, { force: true }).catch(() => undefined);
    throw err;
  }
}

/** Rewrite metadata for an existing path without changing the visible filename. */
export async function rewriteVideoMetadataInPlace(
  filePath: string,
  tags: VideoMetadataTags,
  tweaks?: OutputTweaks,
): Promise<void> {
  const parsed = path.parse(filePath);
  const tmpPath = path.join(parsed.dir, `.mnn-meta-${randomUUID()}${parsed.ext}`);
  const backupPath = path.join(parsed.dir, `.mnn-meta-backup-${randomUUID()}${parsed.ext}`);

  try {
    await writeVideoWithMetadata(filePath, tmpPath, tags, tweaks);
    await fs.rename(filePath, backupPath);
    await fs.rename(tmpPath, filePath);
    await fs.rm(backupPath, { force: true });
  } catch (err) {
    await fs.rm(tmpPath, { force: true }).catch(() => undefined);
    if (await fileMissing(filePath)) {
      await fs.rename(backupPath, filePath).catch(() => undefined);
    } else {
      await fs.rm(backupPath, { force: true }).catch(() => undefined);
    }
    throw err;
  }
}

export function shouldRenderOutput(tweaks?: OutputTweaks): boolean {
  return outputTweaksEnabled(tweaks);
}

async function fileMissing(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return false;
  } catch {
    return true;
  }
}

// ---------- In-app preview proxies ---------------------------------------
//
// Chromium can't decode HEVC/ProRes/DNxHD, which is most of what Sony FX
// cameras shoot. To get a watchable preview in the embedded <video> tag we
// transcode a small H.264 mp4 once per clip and cache it. Quality is
// throwaway — long edge 640px, ultrafast preset, audio at 96k — just enough
// to confirm what the clip is.

const PREVIEW_CACHE_DIR = path.join(TMP_ROOT, 'previews');
const previewJobs = new Map<string, Promise<string>>();

function cacheKey(filePath: string, size: number, mtimeMs: number): string {
  return createHash('sha1')
    .update(`${filePath}|${size}|${Math.round(mtimeMs)}`)
    .digest('hex')
    .slice(0, 16);
}

async function ensurePreviewDir(): Promise<void> {
  await fs.mkdir(PREVIEW_CACHE_DIR, { recursive: true });
}

/**
 * Render a small H.264 mp4 the embedded player can decode regardless of the
 * source codec. Cached by path + size + mtime so the second click is instant.
 *
 * Concurrent calls for the same file share one job — clicking play twice
 * before the first finishes won't fork two ffmpegs.
 */
export async function buildPreviewProxy(filePath: string): Promise<string> {
  const stat = await fs.stat(filePath);
  const key = cacheKey(filePath, stat.size, stat.mtimeMs);
  await ensurePreviewDir();
  const outPath = path.join(PREVIEW_CACHE_DIR, `${key}.mp4`);

  if (fssync.existsSync(outPath)) return outPath;

  const inFlight = previewJobs.get(key);
  if (inFlight) return inFlight;

  const tmpOut = `${outPath}.${randomUUID()}.partial.mp4`;
  // Encode is always software libx264 (-preset ultrafast at 480p is plenty
  // fast, and h264_videotoolbox refuses 10-bit input which Sony FX cameras
  // produce). We *do* hardware-accelerate the HEVC decode on Apple Silicon
  // because that's where the time actually goes — it brings a 9 s 4 K HEVC
  // clip from ~6 s wall time down to roughly 1 s.
  const tryEncode = (useHwDecode: boolean) =>
    new Promise<void>((resolve, reject) => {
      const cmd = ffmpeg(filePath);
      if (useHwDecode) cmd.inputOptions(['-hwaccel', 'videotoolbox']);
      cmd
        .outputOptions([
          '-map', '0:v:0',
          '-map', '0:a:0?',
          '-vf', 'scale=480:-2:flags=fast_bilinear,format=yuv420p',
          '-c:v', 'libx264',
          '-preset', 'ultrafast',
          '-tune', 'fastdecode',
          '-crf', '30',
          '-pix_fmt', 'yuv420p',
          '-profile:v', 'baseline',
          '-level', '3.0',
          '-r', '24',
          '-c:a', 'aac',
          '-b:a', '64k',
          '-ac', '1',
          '-movflags', '+faststart',
        ])
        .output(tmpOut)
        .on('end', () => resolve())
        .on('error', reject)
        .run();
    });

  const useHwDecode = process.platform === 'darwin';
  const job = (async () => {
    monitorInfo('preview', 'transcode start', {
      in: filePath,
      out: outPath,
      hwDecode: useHwDecode,
    });
    try {
      try {
        await tryEncode(useHwDecode);
      } catch (firstErr) {
        if (!useHwDecode) throw firstErr;
        // Hardware decode is finicky on some Sony / weird-edit-list MP4s.
        // Retry without it before giving up — still gets us a preview.
        monitorWarn('preview', 'hw decode failed, retrying software', {
          in: filePath,
          error: firstErr instanceof Error ? firstErr.message : String(firstErr),
        });
        await fs.rm(tmpOut, { force: true }).catch(() => undefined);
        await tryEncode(false);
      }
      await fs.rename(tmpOut, outPath);
      monitorInfo('preview', 'transcode done', { out: outPath });
      return outPath;
    } catch (err) {
      await fs.rm(tmpOut, { force: true }).catch(() => undefined);
      monitorError('preview', 'transcode failed', {
        in: filePath,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    } finally {
      previewJobs.delete(key);
    }
  })();

  previewJobs.set(key, job);
  return job;
}
