import { app, BrowserWindow, ipcMain, net, protocol, shell, dialog } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import pLimit from 'p-limit';

import { probeMetadata } from './services/ffprobe';
import { buildPreviewProxy, extractKeyframes, extractThumbnail } from './services/ffmpeg';
import { analyzeClip as analyzeWithOpenAI } from './services/openai';
import { formatProposedName } from './services/namer';
import { applyRenames, undoLast, exportCsv } from './services/renamer';
import { getApiKey, setApiKey as kcSetApiKey, hasApiKey as kcHasApiKey } from './services/keychain';
import { loadSettings, saveSettings } from './services/settings';
import { CLIENT_SHARED_SECRET } from './services/buildConfig';
import { monitorError, monitorInfo, monitorWarn } from './services/monitorLog';
import type { AnalyzeClipOptions, BackendStatus, Clip, RenameJob, Settings } from '../shared/types';

const VITE_DEV_SERVER_URL = process.env['VITE_DEV_SERVER_URL'];
const isDev = !!VITE_DEV_SERVER_URL;

// Chromium blocks file:// URLs from being loaded inside http:// pages (the
// renderer in dev is served by Vite at http://localhost). Register a custom
// scheme the renderer can hit from anywhere; the handler streams the on-disk
// file with byte-range support so <video> seek/scrub works.
//
// Must be called before app.whenReady().
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'mnn-media',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      bypassCSP: true,
      corsEnabled: true,
    },
  },
]);

/**
 * Convert an absolute local path into a mnn-media:// URL the renderer can
 * pass straight to a <video src="..."> tag.
 */
function pathToMediaUrl(filePath: string): string {
  // pathToFileURL handles spaces and special chars correctly; we just swap
  // the scheme/host so the renderer can fetch it through our protocol handler.
  const fileUrl = pathToFileURL(filePath);
  return `mnn-media://local${fileUrl.pathname}`;
}

let mainWindow: BrowserWindow | null = null;
const clipCache = new Map<string, Clip>();
const pendingOpenFiles: string[] = [];

// Concurrency limiter — re-created whenever settings.concurrency changes.
// Keep the initial value conservative; saved settings are loaded shortly after
// startup, but file-open events can arrive before then.
let analyzeLimit = pLimit(1);
let currentConcurrency = 1;
function ensureLimit(concurrency: number) {
  if (concurrency !== currentConcurrency) {
    analyzeLimit = pLimit(concurrency);
    currentConcurrency = concurrency;
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 640,
    minHeight: 480,
    title: 'MNN Clip Namer',
    backgroundColor: '#0e0f12',
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  if (isDev && VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  if (pendingOpenFiles.length && mainWindow) {
    const files = pendingOpenFiles.splice(0);
    mainWindow.webContents.once('did-finish-load', () => {
      mainWindow?.webContents.send('files:dropped', files);
    });
  }
}

app.on('open-file', (event, filePath) => {
  event.preventDefault();
  if (mainWindow) {
    mainWindow.webContents.send('files:dropped', [filePath]);
  } else {
    pendingOpenFiles.push(filePath);
  }
});

app.whenReady().then(() => {
  // Resolve mnn-media://local/<absolute-path> back to the actual file. Using
  // net.fetch on the file:// URL gives us byte-range streaming for free, so
  // <video> seeking works.
  protocol.handle('mnn-media', (request) => {
    try {
      const url = new URL(request.url);
      const filePath = decodeURIComponent(url.pathname);
      // Re-encode through pathToFileURL so spaces / unicode in the on-disk path
      // (e.g. "Christmas Tree Lighting/C8115.MP4") survive net.fetch.
      return net.fetch(pathToFileURL(filePath).toString());
    } catch (err) {
      monitorError('media', 'protocol handler failed', {
        url: request.url,
        error: err instanceof Error ? err.message : String(err),
      });
      return new Response('Bad media URL', { status: 400 });
    }
  });

  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// ---------- IPC handlers ----------

ipcMain.handle('settings:get', async (): Promise<Settings> => {
  const s = await loadSettings();
  ensureLimit(s.concurrency);
  return { ...s, apiKeySet: await kcHasApiKey() };
});

ipcMain.handle('settings:save', async (_e, partial: Partial<Settings>) => {
  const saved = await saveSettings(partial);
  ensureLimit(saved.concurrency);
  return { ...saved, apiKeySet: await kcHasApiKey() };
});

ipcMain.handle('settings:setApiKey', async (_e, key: string) => {
  await kcSetApiKey(key);
});

ipcMain.handle('settings:hasApiKey', async () => kcHasApiKey());

ipcMain.handle('ui:openExternal', async (_e, url: string) => {
  await shell.openExternal(url);
});

ipcMain.handle(
  'shell:openClipPath',
  async (_e, filePath: string): Promise<{ ok: boolean; error?: string }> => {
    const p = typeof filePath === 'string' ? filePath.trim() : '';
    if (!p) return { ok: false, error: 'No file path' };
    const err = await shell.openPath(p);
    if (err) return { ok: false, error: err };
    return { ok: true };
  },
);

ipcMain.handle(
  'media:fileUrl',
  (_e, filePath: string): { ok: boolean; url?: string; error?: string } => {
    const p = typeof filePath === 'string' ? filePath.trim() : '';
    if (!p) return { ok: false, error: 'No file path' };
    try {
      if (!fs.existsSync(p)) return { ok: false, error: 'File not found' };
      return { ok: true, url: pathToMediaUrl(p) };
    } catch (err: unknown) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },
);

ipcMain.handle(
  'media:previewProxy',
  async (
    _e,
    filePath: string,
  ): Promise<{ ok: boolean; url?: string; error?: string }> => {
    const p = typeof filePath === 'string' ? filePath.trim() : '';
    if (!p) return { ok: false, error: 'No file path' };
    if (!fs.existsSync(p)) return { ok: false, error: 'File not found' };
    try {
      const proxyPath = await buildPreviewProxy(p);
      return { ok: true, url: pathToMediaUrl(proxyPath) };
    } catch (err: unknown) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },
);

ipcMain.handle('backend:check', async (): Promise<BackendStatus> => {
  const s = await loadSettings();
  if (s.backendMode === 'proxy') {
    if (!s.proxyUrl) return { ok: false, mode: 'proxy', detail: 'Proxy URL not set' };
    try {
      const res = await fetch(`${s.proxyUrl.replace(/\/$/, '')}/health`, {
        method: 'GET',
        headers: { 'X-Shared-Secret': CLIENT_SHARED_SECRET },
      });
      if (res.ok) return { ok: true, mode: 'proxy' };
      return { ok: false, mode: 'proxy', detail: `HTTP ${res.status}` };
    } catch (err: unknown) {
      return {
        ok: false,
        mode: 'proxy',
        detail: err instanceof Error ? err.message : String(err),
      };
    }
  }
  // direct mode
  const has = await kcHasApiKey();
  return {
    ok: has,
    mode: 'direct',
    detail: has ? undefined : 'No API key set',
  };
});

// Four parallel probe+thumbnail jobs is a sweet spot: ffprobe + a 480px
// thumbnail extract on hardware-decoded HEVC barely uses any CPU, but each
// pays a fixed ~80 ms process spawn cost, so doing them serially on a
// 40-clip drop wastes 3+ seconds before anything appears in the list.
const ingestLimit = pLimit(4);

ipcMain.handle('ingest:paths', async (_e, paths: string[]): Promise<Clip[]> => {
  // Pre-allocate clips in input order so we don't reshuffle the user's
  // drop on screen even though the ffmpeg work finishes out-of-order.
  const clips: Clip[] = paths.map((p) => {
    const id = randomUUID();
    const parsed = path.parse(p);
    return {
      id,
      originalPath: p,
      originalName: parsed.base,
      dir: parsed.dir,
      ext: parsed.ext.toLowerCase(),
      status: 'queued',
    } as Clip;
  });

  await Promise.all(
    clips.map((clip) =>
      ingestLimit(async () => {
        try {
          clip.metadata = await probeMetadata(clip.originalPath);
          clip.thumbnailDataUrl = await extractThumbnail(
            clip.originalPath,
            clip.metadata.durationSec,
          );
          clip.status = 'queued';
        } catch (err: unknown) {
          clip.status = 'error';
          clip.error = err instanceof Error ? err.message : String(err);
          monitorWarn('ingest', 'ffprobe/thumbnail failed', {
            path: clip.originalPath,
            error: clip.error,
          });
        }
        clipCache.set(clip.id, clip);
      }),
    ),
  );

  return clips;
});

async function runAnalyze(id: string, options?: AnalyzeClipOptions): Promise<Clip> {
  const clip = clipCache.get(id);
  if (!clip) throw new Error(`Unknown clip id: ${id}`);
  if (!clip.metadata) throw new Error('Clip has no metadata');

  const settings = await loadSettings();
  ensureLimit(settings.concurrency);

  monitorInfo('analyze', 'start', {
    id,
    file: clip.originalName,
    concurrency: currentConcurrency,
    backend: settings.backendMode,
  });

  clip.status = 'analyzing';
  clip.statusMessage = 'extracting keyframes';
  clipCache.set(id, clip);
  mainWindow?.webContents.send('clip:update', clip);

  // Coalesce rapid progress messages to one IPC update per ~250ms so we
  // don't flood the renderer when the countdown ticks every second.
  let lastProgressEmit = 0;
  const setProgress = (message: string, force = false) => {
    const now = Date.now();
    if (!force && now - lastProgressEmit < 200) {
      clip.statusMessage = message;
      return;
    }
    lastProgressEmit = now;
    clip.statusMessage = message;
    clipCache.set(id, clip);
    mainWindow?.webContents.send('clip:update', clip);
  };

  try {
    const keyframeTarget = options?.forceMaxKeyframes
      ? 8
      : Math.min(8, Math.max(5, settings.keyframeCount));
    const frames = await extractKeyframes(
      clip.originalPath,
      clip.metadata.durationSec,
      keyframeTarget,
    );
    setProgress('reading visual cues', true);
    const apiKey = settings.backendMode === 'direct' ? await getApiKey() : null;
    const parts = await analyzeWithOpenAI({
      frames,
      metadata: clip.metadata,
      settings,
      originalName: clip.originalName,
      apiKey,
      onProgress: (m) => setProgress(m),
    });
    clip.nameParts = parts;
    clip.proposedName = formatProposedName(parts, settings.template, clip.metadata);
    clip.status = 'ready';
    clip.error = undefined;
    clip.statusMessage = undefined;
    monitorInfo('analyze', 'ready', {
      id,
      file: clip.originalName,
      proposed: clip.proposedName?.slice(0, 120),
    });
  } catch (err: unknown) {
    clip.status = 'error';
    clip.error = err instanceof Error ? err.message : String(err);
    clip.statusMessage = undefined;
    monitorError('analyze', 'failed', {
      id,
      file: clip.originalName,
      error: clip.error,
    });
  }
  clipCache.set(id, clip);
  mainWindow?.webContents.send('clip:update', clip);
  return clip;
}

ipcMain.handle(
  'ai:analyzeClip',
  async (_e, id: string, options?: AnalyzeClipOptions): Promise<Clip> => {
    return analyzeLimit(() => runAnalyze(id, options));
  },
);

ipcMain.handle('rename:apply', async (_e, jobs: RenameJob[]) => {
  monitorInfo('rename', 'apply invoked', { jobs: jobs.length });
  const settings = await loadSettings();
  const results = await applyRenames(jobs, settings);
  const okN = results.filter((r) => r.ok).length;
  monitorInfo('rename', 'apply returned', {
    jobs: results.length,
    ok: okN,
    failed: results.length - okN,
  });
  for (const r of results) {
    const clip = clipCache.get(r.id);
    if (clip && r.ok && r.finalPath) {
      clip.finalPath = r.finalPath;
      clip.status = 'renamed';
      clipCache.set(r.id, clip);
    }
  }
  return results;
});

ipcMain.handle('rename:undo', async () => undoLast());

ipcMain.handle('dialog:pickFolder', async (): Promise<string | null> => {
  const result = await dialog.showOpenDialog({
    title: 'Choose output folder',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

ipcMain.handle('export:csv', async (_e, clips: Clip[]) => {
  const result = await dialog.showSaveDialog({
    title: 'Export rename map',
    defaultPath: 'clip-renames.csv',
    filters: [{ name: 'CSV', extensions: ['csv'] }],
  });
  if (result.canceled || !result.filePath) return null;
  await exportCsv(clips, result.filePath);
  return result.filePath;
});
