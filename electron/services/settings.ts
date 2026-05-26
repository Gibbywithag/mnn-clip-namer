import fs from 'node:fs/promises';
import path from 'node:path';
import { app } from 'electron';
import { ANALYSIS_MODELS, type AnalysisModel, type Settings } from '../../shared/types';
import { DEFAULT_PROXY_URL } from './buildConfig';

const SETTINGS_PATH = path.join(app.getPath('userData'), 'settings.json');
const MIN_CONCURRENCY = 1;
const MAX_CONCURRENCY = 2;
const DEFAULT_CONCURRENCY = 2;
const MIN_EXPOSURE_STOPS = -3;
const MAX_EXPOSURE_STOPS = 3;
const MIN_REQUEST_GAP_MS = 2_000;
const MAX_REQUEST_GAP_MS = 60_000;
const DEFAULT_REQUEST_GAP_MS = 2_500;

function clampAnalysisModel(value: unknown): AnalysisModel {
  const s = typeof value === 'string' ? value : '';
  return (ANALYSIS_MODELS as readonly string[]).includes(s)
    ? (s as AnalysisModel)
    : 'gpt-4o-mini';
}

function clampRequestGapMs(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_REQUEST_GAP_MS;
  return Math.round(Math.max(MIN_REQUEST_GAP_MS, Math.min(MAX_REQUEST_GAP_MS, n)));
}

function clampConcurrency(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < MIN_CONCURRENCY || n > MAX_CONCURRENCY) {
    return DEFAULT_CONCURRENCY;
  }
  return Math.round(n);
}

function clampExposureStops(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(MIN_EXPOSURE_STOPS, Math.min(MAX_EXPOSURE_STOPS, n));
}

function baseDefaults(): Settings {
  return {
    backendMode: DEFAULT_PROXY_URL ? 'proxy' : 'direct',
    proxyUrl: DEFAULT_PROXY_URL,
    apiKeySet: false,
    keyframeCount: 6,
    // High-detail vision frames are accuracy-friendly but token-heavier, so
    // default to one clip at a time. Users with higher API limits can raise it.
    concurrency: DEFAULT_CONCURRENCY,
    analysisModel: 'gpt-4o-mini',
    requestGapMs: DEFAULT_REQUEST_GAP_MS,
    verificationSecondPass: false,
    template: '{date}{subject}-{technique}-{setting}',
    outputMode: 'rename-in-place',
    outputTweaks: {
      applyConversionLut: true,
      exposureStops: 0,
    },
    gradedOutputMode: 'overwrite',
  };
}

function clampGradedOutputMode(value: unknown): 'overwrite' | 'copy-to-folder' {
  return value === 'copy-to-folder' ? 'copy-to-folder' : 'overwrite';
}

export async function loadSettings(): Promise<Settings> {
  const defaults = baseDefaults();
  try {
    const raw = await fs.readFile(SETTINGS_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<Settings>;
    const merged = { ...defaults, ...parsed };
    merged.outputTweaks = { ...defaults.outputTweaks, ...parsed.outputTweaks };
    merged.keyframeCount = Math.max(5, Math.min(8, Number(merged.keyframeCount) || 6));
    merged.concurrency = clampConcurrency(merged.concurrency);
    merged.analysisModel = clampAnalysisModel(merged.analysisModel);
    merged.requestGapMs = clampRequestGapMs(merged.requestGapMs);
    merged.verificationSecondPass = Boolean(merged.verificationSecondPass);
    merged.outputTweaks.exposureStops = clampExposureStops(merged.outputTweaks.exposureStops);
    merged.gradedOutputMode = clampGradedOutputMode(merged.gradedOutputMode);
    return merged;
  } catch {
    return defaults;
  }
}

export async function saveSettings(partial: Partial<Settings>): Promise<Settings> {
  const current = await loadSettings();
  const merged: Settings = { ...current, ...partial };
  // Clamp numeric ranges
  merged.keyframeCount = Math.max(5, Math.min(8, Number(merged.keyframeCount) || 6));
  merged.concurrency = clampConcurrency(merged.concurrency);
  merged.analysisModel = clampAnalysisModel(merged.analysisModel);
  merged.requestGapMs = clampRequestGapMs(merged.requestGapMs);
  merged.verificationSecondPass = Boolean(merged.verificationSecondPass);
  merged.outputTweaks = {
    applyConversionLut: Boolean(merged.outputTweaks?.applyConversionLut),
    exposureStops: clampExposureStops(merged.outputTweaks?.exposureStops),
  };
  merged.gradedOutputMode = clampGradedOutputMode(merged.gradedOutputMode);
  if (merged.backendMode !== 'direct' && merged.backendMode !== 'proxy') {
    merged.backendMode = DEFAULT_PROXY_URL ? 'proxy' : 'direct';
  }
  // Don't persist apiKeySet — it's always computed fresh from the keychain.
  const { apiKeySet: _unused, ...persisted } = merged;
  void _unused;
  await fs.mkdir(path.dirname(SETTINGS_PATH), { recursive: true });
  await fs.writeFile(SETTINGS_PATH, JSON.stringify(persisted, null, 2), 'utf-8');
  return merged;
}
