// Types shared between Electron main process and React renderer.

export type ClipStatus =
  | 'queued'
  | 'analyzing'
  | 'ready'
  | 'approved'
  | 'renamed'
  | 'skipped'
  | 'error';

export type Confidence = 'high' | 'medium' | 'low';

export interface ClipMetadata {
  durationSec: number;
  width: number;
  height: number;
  fps: number;
  codec: string;
  sizeBytes: number;
  /** ISO 8601 instant from container/stream tags (e.g. creation_time) when present. */
  recordedAtUtc?: string;
}

export interface NameParts {
  subject: string;
  technique: string;
  setting: string;
  confidence: Confidence;
  notes?: string;
}

export interface Clip {
  id: string;
  originalPath: string;
  originalName: string;
  dir: string;
  ext: string;
  metadata?: ClipMetadata;
  thumbnailDataUrl?: string;
  nameParts?: NameParts;
  proposedName?: string; // without extension
  finalPath?: string;
  status: ClipStatus;
  error?: string;
  /**
   * Human-readable progress hint while a long-running step is in flight.
   * Example: "rate limited — retrying in 8s". Cleared on success/error.
   */
  statusMessage?: string;
}

export interface Settings {
  // Backend config
  backendMode: 'proxy' | 'direct';
  proxyUrl: string;
  apiKeySet: boolean; // only relevant when backendMode === 'direct'
  // Pipeline
  keyframeCount: number; // 2..8
  concurrency: number; // 1..5
  /** Naming pattern. Tokens: {date} (MM.DD.YY from clip metadata shoot time), {subject}, … */
  template: string;
  outputMode: 'rename-in-place' | 'copy-to-folder';
  copyFolder?: string;
}

export interface RenameJob {
  id: string;
  originalPath: string;
  proposedName: string;
  ext: string;
}

export interface RenameResult {
  id: string;
  ok: boolean;
  finalPath?: string;
  error?: string;
}

export interface HistoryEntry {
  ts: string;
  originalPath: string;
  finalPath: string;
}

export interface BackendStatus {
  ok: boolean;
  mode: 'proxy' | 'direct';
  detail?: string;
}

// IPC contract — keep in sync with electron/preload.ts
export interface MnnApi {
  // File path resolver (Electron 32+ removed File.path)
  getPathForFile(file: File): string;

  // Settings
  getSettings(): Promise<Settings>;
  saveSettings(partial: Partial<Settings>): Promise<Settings>;
  setApiKey(key: string): Promise<void>;
  hasApiKey(): Promise<boolean>;
  openExternalUrl(url: string): Promise<void>;
  checkBackend(): Promise<BackendStatus>;

  // Pipeline
  ingestPaths(paths: string[]): Promise<Clip[]>;
  analyzeClip(id: string): Promise<Clip>;
  applyRenames(jobs: RenameJob[]): Promise<RenameResult[]>;
  undoLast(): Promise<number>;
  exportCsv(clips: Clip[]): Promise<string | null>;

  // Events
  onClipUpdate(cb: (clip: Clip) => void): () => void;
}

declare global {
  interface Window {
    mnn: MnnApi;
  }
}
