import { app, BrowserWindow, ipcMain, shell, dialog } from 'electron';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import pLimit from 'p-limit';

import { probeMetadata } from './services/ffprobe';
import { extractKeyframes, extractThumbnail } from './services/ffmpeg';
import { analyzeClip as analyzeWithOpenAI } from './services/openai';
import { formatProposedName } from './services/namer';
import { applyRenames, undoLast, exportCsv } from './services/renamer';
import { getApiKey, setApiKey as kcSetApiKey, hasApiKey as kcHasApiKey } from './services/keychain';
import { loadSettings, saveSettings } from './services/settings';
import { CLIENT_SHARED_SECRET } from './services/buildConfig';
import type { BackendStatus, Clip, RenameJob, Settings } from '../shared/types';

const VITE_DEV_SERVER_URL = process.env['VITE_DEV_SERVER_URL'];
const isDev = !!VITE_DEV_SERVER_URL;

let mainWindow: BrowserWindow | null = null;
const clipCache = new Map<string, Clip>();
const pendingOpenFiles: string[] = [];

// Concurrency limiter — re-created whenever settings.concurrency changes.
let analyzeLimit = pLimit(3);
let currentConcurrency = 3;
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
    minWidth: 820,
    minHeight: 560,
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

app.whenReady().then(createWindow);

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

ipcMain.handle('ingest:paths', async (_e, paths: string[]): Promise<Clip[]> => {
  const clips: Clip[] = [];
  for (const p of paths) {
    const id = randomUUID();
    const parsed = path.parse(p);
    const clip: Clip = {
      id,
      originalPath: p,
      originalName: parsed.base,
      dir: parsed.dir,
      ext: parsed.ext.toLowerCase(),
      status: 'queued',
    };
    try {
      clip.metadata = await probeMetadata(p);
      clip.thumbnailDataUrl = await extractThumbnail(p, clip.metadata.durationSec);
      clip.status = 'queued';
    } catch (err: unknown) {
      clip.status = 'error';
      clip.error = err instanceof Error ? err.message : String(err);
    }
    clipCache.set(id, clip);
    clips.push(clip);
  }
  return clips;
});

async function runAnalyze(id: string): Promise<Clip> {
  const clip = clipCache.get(id);
  if (!clip) throw new Error(`Unknown clip id: ${id}`);
  if (!clip.metadata) throw new Error('Clip has no metadata');

  const settings = await loadSettings();
  ensureLimit(settings.concurrency);

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
    const frames = await extractKeyframes(
      clip.originalPath,
      clip.metadata.durationSec,
      settings.keyframeCount,
    );
    setProgress('analyzing', true);
    const apiKey = settings.backendMode === 'direct' ? await getApiKey() : null;
    const parts = await analyzeWithOpenAI({
      frames,
      metadata: clip.metadata,
      settings,
      apiKey,
      onProgress: (m) => setProgress(m),
    });
    clip.nameParts = parts;
    clip.proposedName = formatProposedName(parts, settings.template, clip.metadata);
    clip.status = 'ready';
    clip.error = undefined;
    clip.statusMessage = undefined;
  } catch (err: unknown) {
    clip.status = 'error';
    clip.error = err instanceof Error ? err.message : String(err);
    clip.statusMessage = undefined;
  }
  clipCache.set(id, clip);
  mainWindow?.webContents.send('clip:update', clip);
  return clip;
}

ipcMain.handle('ai:analyzeClip', async (_e, id: string): Promise<Clip> => {
  return analyzeLimit(() => runAnalyze(id));
});

ipcMain.handle('rename:apply', async (_e, jobs: RenameJob[]) => {
  const settings = await loadSettings();
  const results = await applyRenames(jobs, settings);
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
