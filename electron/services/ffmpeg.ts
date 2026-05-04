import ffmpeg from 'fluent-ffmpeg';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import { app } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// In packaged Electron apps, ffmpeg lives inside app.asar but binaries there
// aren't executable — electron-builder mirrors them to app.asar.unpacked
// (see asarUnpack in package.json). Rewrite the path so spawn() actually works.
const ffmpegPath = ffmpegInstaller.path.replace(
  `${path.sep}app.asar${path.sep}`,
  `${path.sep}app.asar.unpacked${path.sep}`,
);
ffmpeg.setFfmpegPath(ffmpegPath);

const TMP_ROOT = path.join(app.getPath('temp'), 'mnn-clip-namer');

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
  await new Promise<void>((resolve, reject) => {
    ffmpeg(filePath)
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
 * Frames are scaled to ~512px wide (height auto) and heavily compressed
 * to keep total payload to the vision model under a few hundred KB.
 */
export async function extractKeyframes(
  filePath: string,
  durationSec: number,
  count: number,
): Promise<Buffer[]> {
  const n = Math.max(2, Math.min(8, count));
  const stops = Array.from({ length: n }, (_, i) => ((i + 0.5) / n) * durationSec);
  const tmpDir = await ensureTmp();
  const frames: Buffer[] = [];

  try {
    for (let i = 0; i < stops.length; i++) {
      const out = path.join(tmpDir, `frame-${i}.jpg`);
      const seekSec = Math.min(Math.max(stops[i], 0), Math.max(durationSec - 0.05, 0));
      await new Promise<void>((resolve, reject) => {
        ffmpeg(filePath)
          .seekInput(seekSec)
          .frames(1)
          // 512px wide @ q=6 keeps each frame ~30-50KB while still readable
          // by the vision model. Smaller payload = faster requests, fewer
          // tokens, lower chance of TPM throttling.
          .outputOptions(['-vf', 'scale=512:-2', '-q:v', '6'])
          .output(out)
          .on('end', () => resolve())
          .on('error', reject)
          .run();
      });
      frames.push(await fs.readFile(out));
    }
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  }

  return frames;
}
