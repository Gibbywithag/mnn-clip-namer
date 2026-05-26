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

/** Vision models allowed for clip naming (must stay in sync with worker allowlist). */
export const ANALYSIS_MODELS = ['gpt-4o-mini', 'gpt-4o'] as const;
export type AnalysisModel = (typeof ANALYSIS_MODELS)[number];

/** Options for a single analyze run (IPC). */
export interface AnalyzeClipOptions {
  /** Use 8 keyframes for this run even if Settings.keyframeCount is lower. */
  forceMaxKeyframes?: boolean;
}

export interface ClipMetadata {
  durationSec: number;
  width: number;
  height: number;
  fps: number;
  codec: string;
  sizeBytes: number;
  /** ISO 8601 instant from container/stream tags (e.g. creation_time) when present. */
  recordedAtUtc?: string;
  /** GPS coordinates embedded in the video file (e.g. DJI, Sony with GPS). */
  gpsLat?: number;
  gpsLng?: number;
}

export interface NameParts {
  subject: string;
  technique: string;
  setting: string;
  confidence: Confidence;
  notes?: string;
  /** Natural-language place name returned by the AI; consumed by the geocoder. */
  locationHint?: string;
}

export interface VideoMetadataTags {
  title: string;
  description: string;
  keywords: string;
  comment: string;
  originalName: string;
}

export interface OutputTweaks {
  applyConversionLut: boolean;
  /** Exposure adjustment in stops. 0 leaves exposure unchanged. */
  exposureStops: number;
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
  applyOutputTweaks?: boolean;
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
  keyframeCount: number; // 5..8
  concurrency: number; // 1..2
  /** OpenAI vision model (direct API or proxy). */
  analysisModel: AnalysisModel;
  /**
   * Minimum spacing between AI requests (ms). Higher reduces rate-limit spikes on large batches.
   * Typical range 2000–45000.
   */
  requestGapMs: number;
  /**
   * After vision analysis, run a text-only consistency pass (same schema).
   * Costs one extra small request per clip when enabled.
   */
  verificationSecondPass: boolean;
  /** Naming pattern. Tokens: {date} (MM.DD.YY from clip metadata shoot time), {subject}, … */
  template: string;
  outputMode: 'rename-in-place' | 'copy-to-folder';
  copyFolder?: string;
  outputTweaks: OutputTweaks;
  /**
   * Where LUT/exposure-graded clips go. 'overwrite' replaces the original
   * file in place; 'copy-to-folder' writes the graded version to
   * `gradedCopyFolder` and leaves the original untouched.
   */
  gradedOutputMode: 'overwrite' | 'copy-to-folder';
  gradedCopyFolder?: string;
}

export interface RenameJob {
  id: string;
  originalPath: string;
  proposedName: string;
  ext: string;
  metadataTags?: VideoMetadataTags;
  outputTweaks?: OutputTweaks;
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
  /**
   * Opens a local video file in the OS default application (QuickTime, VLC, etc.).
   * Use to verify a clip before analysis or remove it from the batch.
   */
  openClipPath(filePath: string): Promise<{ ok: boolean; error?: string }>;
  /**
   * Stable file:// URL for an absolute path so the renderer can assign local files to HTMLVideoElement.src.
   */
  fileUrlFromPath(filePath: string): Promise<{ ok: boolean; url?: string; error?: string }>;
  /**
   * Build (or fetch a cached) low-res H.264 mp4 proxy for the clip so the embedded
   * <video> element can preview HEVC/ProRes/DNxHD sources Chromium can't decode.
   */
  previewProxyForPath(filePath: string): Promise<{ ok: boolean; url?: string; error?: string }>;

  // Pipeline
  ingestPaths(paths: string[]): Promise<Clip[]>;
  analyzeClip(id: string, options?: AnalyzeClipOptions): Promise<Clip>;
  applyRenames(jobs: RenameJob[]): Promise<RenameResult[]>;
  undoLast(): Promise<number>;
  exportCsv(clips: Clip[]): Promise<string | null>;
  pickFolder(): Promise<string | null>;

  // Events
  onClipUpdate(cb: (clip: Clip) => void): () => void;
}

declare global {
  interface Window {
    mnn: MnnApi;
  }
}
