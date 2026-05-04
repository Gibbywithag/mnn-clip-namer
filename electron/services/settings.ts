import fs from 'node:fs/promises';
import path from 'node:path';
import { app } from 'electron';
import type { Settings } from '../../shared/types';
import { DEFAULT_PROXY_URL } from './buildConfig';

const SETTINGS_PATH = path.join(app.getPath('userData'), 'settings.json');

function baseDefaults(): Settings {
  return {
    backendMode: DEFAULT_PROXY_URL ? 'proxy' : 'direct',
    proxyUrl: DEFAULT_PROXY_URL,
    apiKeySet: false,
    keyframeCount: 3,
    // OpenAI tier-1 is 500 RPM / 200K TPM — 3 concurrent clips is well within
    // budget and gives noticeably faster batch processing.
    concurrency: 3,
    template: '{date}{subject}-{technique}-{setting}',
    outputMode: 'rename-in-place',
  };
}

export async function loadSettings(): Promise<Settings> {
  const defaults = baseDefaults();
  try {
    const raw = await fs.readFile(SETTINGS_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<Settings>;
    return { ...defaults, ...parsed };
  } catch {
    return defaults;
  }
}

export async function saveSettings(partial: Partial<Settings>): Promise<Settings> {
  const current = await loadSettings();
  const merged: Settings = { ...current, ...partial };
  // Clamp numeric ranges
  merged.keyframeCount = Math.max(2, Math.min(8, Number(merged.keyframeCount) || 4));
  merged.concurrency = Math.max(1, Math.min(5, Number(merged.concurrency) || 3));
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
