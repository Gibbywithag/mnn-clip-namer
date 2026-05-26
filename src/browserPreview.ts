import type { BackendStatus, Clip, MnnApi, RenameJob, RenameResult, Settings } from '../shared/types';

type PreviewApi = MnnApi & {
  isBrowserPreview: true;
};

const previewSettings: Settings = {
  backendMode: 'proxy',
  proxyUrl: 'https://mnn-clip-namer.gilbranlaureano0417.workers.dev',
  apiKeySet: false,
  keyframeCount: 5,
  concurrency: 1,
  analysisModel: 'gpt-4o-mini',
  requestGapMs: 5000,
  verificationSecondPass: false,
  template: '{date}{subject}-{technique}-{setting}',
  outputMode: 'rename-in-place',
  outputTweaks: {
    applyConversionLut: true,
    exposureStops: 0,
  },
  gradedOutputMode: 'overwrite',
};

const svgThumb = (label: string, a: string, b: string, c: string) =>
  `data:image/svg+xml;utf8,${encodeURIComponent(`
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 180">
      <defs>
        <linearGradient id="g" x1="0" x2="1" y1="0" y2="1">
          <stop stop-color="${a}"/>
          <stop offset=".58" stop-color="${b}"/>
          <stop offset="1" stop-color="${c}"/>
        </linearGradient>
      </defs>
      <rect width="320" height="180" fill="url(#g)"/>
      <rect x="18" y="20" width="284" height="134" rx="16" fill="rgba(255,255,255,.12)" stroke="rgba(255,255,255,.22)"/>
      <circle cx="68" cy="72" r="24" fill="rgba(255,255,255,.26)"/>
      <rect x="110" y="55" width="136" height="12" rx="6" fill="rgba(255,255,255,.56)"/>
      <rect x="110" y="78" width="92" height="9" rx="4.5" fill="rgba(255,255,255,.34)"/>
      <rect x="44" y="122" width="230" height="14" rx="7" fill="rgba(0,0,0,.24)"/>
      <text x="54" y="133" fill="rgba(255,255,255,.78)" font-family="-apple-system, BlinkMacSystemFont, sans-serif" font-size="13" font-weight="700">${label}</text>
    </svg>
  `)}`;

export function getBrowserPreviewClips(): Clip[] {
  return [
    {
      id: 'preview-1',
      originalPath: '/Preview/Ribbon Cutting Full.MOV',
      originalName: 'Ribbon Cutting Full.MOV',
      dir: '/Preview',
      ext: '.mov',
      status: 'ready',
      thumbnailDataUrl: svgThumb('RIBBON CUTTING', '#0b1b2d', '#2768a6', '#58d19a'),
      metadata: {
        durationSec: 76,
        width: 3840,
        height: 2160,
        fps: 29.97,
        codec: 'h264',
        sizeBytes: 184000000,
        recordedAtUtc: '2025-08-14T16:30:00.000Z',
      },
      nameParts: {
        subject: 'ribbon-cutting-ceremony',
        technique: 'medium-shot',
        setting: 'downtown-storefront',
        confidence: 'high',
        notes: 'used filename cue and storefront signage',
      },
      proposedName: '(08.14.25)ribbon-cutting-ceremony-medium-shot-downtown-storefront',
    },
    {
      id: 'preview-2',
      originalPath: '/Preview/Council Agenda Clip.mov',
      originalName: 'Council Agenda Clip.mov',
      dir: '/Preview',
      ext: '.mov',
      status: 'analyzing',
      statusMessage: 'reading visual cues',
      thumbnailDataUrl: svgThumb('AGENDA SLIDE', '#15151f', '#37507d', '#0a84ff'),
      metadata: {
        durationSec: 34,
        width: 1920,
        height: 1080,
        fps: 30,
        codec: 'h264',
        sizeBytes: 64000000,
      },
    },
  ];
}

export function installBrowserPreviewApi(): void {
  const browserWindow = window as typeof window & { mnn?: MnnApi };
  if (browserWindow.mnn) return;

  let clips = getBrowserPreviewClips();
  const listeners = new Set<(clip: Clip) => void>();
  const emit = (clip: Clip) => listeners.forEach((cb) => cb(clip));

  const api: PreviewApi = {
    isBrowserPreview: true,
    getPathForFile: (file) => file.name,
    getSettings: async () => previewSettings,
    saveSettings: async (partial) => Object.assign(previewSettings, partial),
    setApiKey: async () => undefined,
    hasApiKey: async () => false,
    openExternalUrl: async (url) => {
      window.open(url, '_blank', 'noopener,noreferrer');
    },
    openClipPath: async () => ({ ok: true }),
    fileUrlFromPath: async () => ({
      ok: false,
      error: 'In-app video preview is available in the desktop app.',
    }),
    previewProxyForPath: async () => ({
      ok: false,
      error: 'In-app video preview is available in the desktop app.',
    }),
    checkBackend: async (): Promise<BackendStatus> => ({ ok: true, mode: 'proxy' }),
    ingestPaths: async (paths) => {
      clips = paths.map((path, index) => ({
        ...getBrowserPreviewClips()[index % 2],
        id: `preview-drop-${Date.now()}-${index}`,
        originalPath: path,
        originalName: path.split('/').pop() || path,
      }));
      return clips;
    },
    analyzeClip: async (id, _options) => {
      const clip = clips.find((c) => c.id === id) ?? getBrowserPreviewClips()[0];
      const updated: Clip = {
        ...clip,
        status: 'ready',
        statusMessage: undefined,
        nameParts: getBrowserPreviewClips()[0].nameParts,
        proposedName: getBrowserPreviewClips()[0].proposedName,
      };
      emit(updated);
      return updated;
    },
    applyRenames: async (jobs: RenameJob[]): Promise<RenameResult[]> =>
      jobs.map((job) => ({
        id: job.id,
        ok: true,
        finalPath: `/Preview/${job.proposedName}${job.ext}`,
      })),
    undoLast: async () => 0,
    exportCsv: async () => '/Preview/mnn-clip-namer-export.csv',
    pickFolder: async () => '/Preview/Output',
    onClipUpdate: (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };

  browserWindow.mnn = api;
}
