import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AnalyzeClipOptions, BackendStatus, Clip, Settings, VideoMetadataTags } from '../shared/types';
import DropZone from './components/DropZone';
import ClipTable from './components/ClipTable';
import SettingsPanel from './components/SettingsPanel';
import OnboardingModal from './components/OnboardingModal';
import Toast from './components/Toast';
import { getBrowserPreviewClips } from './browserPreview';
import brandLogoUrl from './assets/brand-logo.png';

const VIDEO_EXTS = new Set(['.mov', '.mp4', '.mkv', '.m4v', '.avi', '.mxf', '.webm']);

function metadataTagsForClip(clip: Clip): VideoMetadataTags | undefined {
  if (!clip.proposedName || !clip.nameParts) return undefined;
  const parts = [clip.nameParts.subject, clip.nameParts.technique, clip.nameParts.setting]
    .map((p) => p.trim())
    .filter(Boolean);
  const notes = clip.nameParts.notes?.trim();
  return {
    title: clip.proposedName,
    description: parts.join(' - '),
    keywords: parts.join(', '),
    comment: [
      `Original file: ${clip.originalName}`,
      `AI confidence: ${clip.nameParts.confidence}`,
      notes ? `Notes: ${notes}` : '',
      'Tagged by MNN Clip Namer',
    ]
      .filter(Boolean)
      .join('; '),
    originalName: clip.originalName,
  };
}

/**
 * Nashville skyline — hairline silhouette featuring the AT&T Batman Building's
 * twin antennas. Used big in the hero and mini in the footer credit.
 */
// Nashville skyline silhouette, west-facing (the iconic postcard view from the
// pedestrian bridge). Featured: Bridgestone Arena (low left), Pinnacle, UBS, the
// AT&T "Batman" Building with its stepped-pyramid base and twin antennas dead
// center, Snodgrass / Tennessee Tower, the State Capitol with classical
// pediment + dome, L&C Tower, 333 Commerce, JW Marriott and 505 Nashville
// (the tall right-side cluster).
const SKYLINE_PATH =
  'M0 116 L0 100 L50 100 L50 86 L130 86 L130 96 L135 96 L135 56 L195 56 L195 64 L200 64 L200 50 L245 50 L245 58 L250 58 L250 50 L252 50 L252 40 L270 40 L270 30 L288 30 L288 4 L292 4 L292 30 L338 30 L338 4 L342 4 L342 30 L360 30 L360 40 L378 40 L378 50 L380 50 L380 60 L388 60 L440 60 L440 72 L450 72 L450 78 L470 78 L470 68 L478 68 L478 60 L482 60 L482 68 L486 68 L486 78 L510 78 L510 70 L515 70 L515 64 L555 64 L555 60 L560 60 L560 50 L605 50 L605 38 L612 38 L612 26 L660 26 L660 36 L668 36 L668 22 L715 22 L715 92 L720 92 L720 100 L760 100 L760 90 L800 90 L800 116';

function NashvilleSkyline({ className = '' }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 800 140"
      preserveAspectRatio="xMidYMax meet"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="square"
      strokeLinejoin="miter"
      aria-hidden="true"
    >
      <path d={SKYLINE_PATH} />
    </svg>
  );
}

/** Footer credit — mini skyline + Nashville GPS coordinates. */
function CityCredit() {
  return (
    <div className="city-credit" title="Nashville, Tennessee · 36.1627°N 86.7816°W">
      <NashvilleSkyline className="skyline-mini" />
      <span className="gps">36.16°N · 86.78°W</span>
    </div>
  );
}

function ToolbarIcon({ name }: { name: 'settings' }) {
  if (name === 'settings') {
    return (
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <circle cx="10" cy="10" r="2.5" />
        <path d="M10 2.5v2M10 15.5v2M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4M2.5 10h2M15.5 10h2M4.7 15.3l1.4-1.4M13.9 6.1l1.4-1.4" />
      </svg>
    );
  }
  return null;
}

/** Re-mounts and re-animates whenever the value changes. */
function Tick({ n }: { n: number }) {
  return <span key={n} className="num tick">{n}</span>;
}

/** A subtle empty-state graphic (used only as a small mark) */
function MnnLogo({ className = '' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 64 64" aria-hidden="true">
      <rect width="64" height="64" rx="12" fill="rgba(242, 237, 227, 0.05)" stroke="rgba(242, 237, 227, 0.18)" />
      <text
        x="32"
        y="44"
        textAnchor="middle"
        fontFamily="ui-serif, 'New York', Georgia, serif"
        fontSize="30"
        fontWeight="300"
        fontStyle="italic"
        fill="#f2ede3"
      >mn</text>
    </svg>
  );
}

export default function App() {
  const [clips, setClips] = useState<Clip[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [backend, setBackend] = useState<BackendStatus | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [toast, setToast] = useState<
    { msg: string; action?: { label: string; onClick: () => void } } | null
  >(null);
  const [busy, setBusy] = useState(false);

  const refreshBackend = useCallback(async () => {
    const status = await window.mnn.checkBackend();
    setBackend(status);
    return status;
  }, []);

  const handleUndo = useCallback(async () => {
    const reverted = await window.mnn.undoLast();
    if (reverted > 0) {
      setClips((prev) =>
        prev.map((c) =>
          c.status === 'renamed' ? { ...c, status: 'ready', finalPath: undefined } : c,
        ),
      );
      setToast({ msg: `Reverted ${reverted} rename${reverted === 1 ? '' : 's'}.` });
    } else {
      setToast({ msg: 'Nothing to undo.' });
    }
  }, []);

  // Load settings + backend health on mount
  useEffect(() => {
    (async () => {
      const s = await window.mnn.getSettings();
      setSettings(s);
      const status = await refreshBackend();
      if ('isBrowserPreview' in window.mnn) {
        setClips(getBrowserPreviewClips());
      }
      // Only show onboarding if the backend is NOT usable out of the box.
      if (!status.ok) setShowOnboarding(true);
    })();
  }, [refreshBackend]);

  // Subscribe to live clip updates from main process
  useEffect(() => {
    const off = window.mnn.onClipUpdate((updated) => {
      setClips((prev) => prev.map((c) => (c.id === updated.id ? updated : c)));
    });
    return off;
  }, []);

  const ingestPaths = useCallback(
    async (paths: string[]) => {
      const filtered = paths.filter((p) => {
        const ext = p.slice(p.lastIndexOf('.')).toLowerCase();
        return VIDEO_EXTS.has(ext);
      });
      if (!filtered.length) {
        setToast({ msg: 'No supported video files in that drop.' });
        return;
      }
      setBusy(true);
      try {
        const newClips = await window.mnn.ingestPaths(filtered);
        setClips((prev) => [...prev, ...newClips]);
        // No auto-analyze — the user kicks off naming with the "Start naming"
        // button so a stray drop doesn't burn API calls.
        const status = backend ?? (await refreshBackend());
        if (!status.ok) {
          setToast({ msg: `Backend not ready: ${status.detail ?? 'open Settings'}.` });
        }
      } finally {
        setBusy(false);
      }
    },
    [backend, refreshBackend],
  );

  const handleStartNaming = useCallback(async () => {
    const status = backend ?? (await refreshBackend());
    if (!status.ok) {
      setToast({ msg: `Backend not ready: ${status.detail ?? 'open Settings'}.` });
      return;
    }
    const targets = clips.filter((c) => c.status === 'queued' || c.status === 'error');
    if (!targets.length) {
      setToast({ msg: 'Nothing to name — drop in some clips first.' });
      return;
    }
    for (const c of targets) {
      void window.mnn.analyzeClip(c.id).catch(() => undefined);
    }
  }, [backend, refreshBackend, clips]);

  // Listen for files dropped on the app icon (Mac open-file)
  useEffect(() => {
    const handler = (e: Event) => {
      const ce = e as CustomEvent<string[]>;
      void ingestPaths(ce.detail);
    };
    window.addEventListener('mnn:filesDropped', handler);
    return () => window.removeEventListener('mnn:filesDropped', handler);
  }, [ingestPaths]);

  const handleRowChange = useCallback((id: string, patch: Partial<Clip>) => {
    setClips((prev) => prev.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  }, []);

  const handleRemove = useCallback((id: string) => {
    setClips((prev) => prev.filter((c) => c.id !== id));
  }, []);

  const handleRegenerate = useCallback((id: string, options?: AnalyzeClipOptions) => {
    // Immediately show 'analyzing' so the user knows the retry is in progress
    // before the main process fires its first clip:update event.
    setClips((prev) =>
      prev.map((c) =>
        c.id === id
          ? { ...c, status: 'analyzing', error: undefined, statusMessage: undefined }
          : c,
      ),
    );
    void window.mnn.analyzeClip(id, options).catch((err: unknown) => {
      setToast({
        msg: `Regenerate failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    });
  }, []);

  const readyToRename = useMemo(
    () =>
      clips.filter(
        (c) =>
          (c.status === 'ready' || c.status === 'approved') &&
          c.proposedName &&
          c.proposedName.trim().length > 0,
      ),
    [clips],
  );

  const handleApproveAll = useCallback(async () => {
    if (!readyToRename.length) return;
    setBusy(true);
    try {
      const jobs = readyToRename.map((c) => ({
        id: c.id,
        originalPath: c.originalPath,
        proposedName: c.proposedName!,
        ext: c.ext,
        metadataTags: metadataTagsForClip(c),
        outputTweaks: c.applyOutputTweaks ? settings?.outputTweaks : undefined,
      }));
      const results = await window.mnn.applyRenames(jobs);
      const okCount = results.filter((r) => r.ok).length;
      setClips((prev) =>
        prev.map((c) => {
          const r = results.find((x) => x.id === c.id);
          if (!r) return c;
          if (r.ok) return { ...c, status: 'renamed', finalPath: r.finalPath };
          return { ...c, status: 'error', error: r.error };
        }),
      );
      setToast({
        msg: `Renamed ${okCount} clip${okCount === 1 ? '' : 's'}.`,
        action: { label: 'Undo', onClick: handleUndo },
      });
    } finally {
      setBusy(false);
    }
  }, [readyToRename, handleUndo, settings?.outputTweaks]);

  const handleExport = useCallback(async () => {
    const done = clips.filter((c) => c.status === 'renamed');
    if (!done.length) {
      setToast({ msg: 'No renamed clips to export yet.' });
      return;
    }
    const saved = await window.mnn.exportCsv(done);
    if (saved) setToast({ msg: `Saved CSV to ${saved}` });
  }, [clips]);

  const handleClear = useCallback(() => {
    setClips([]);
  }, []);

  const summary = useMemo(() => {
    const total = clips.length;
    const ready = clips.filter((c) => c.status === 'ready').length;
    const analyzing = clips.filter((c) => c.status === 'analyzing').length;
    const queued = clips.filter((c) => c.status === 'queued').length;
    const renamed = clips.filter((c) => c.status === 'renamed').length;
    const errored = clips.filter((c) => c.status === 'error').length;
    return { total, ready, analyzing, queued, renamed, errored };
  }, [clips]);

  const nameableCount = summary.queued + summary.errored;

  const tweakSummary = useMemo(() => {
    const eligible = clips.filter(
      (c) => c.status === 'ready' || c.status === 'approved',
    );
    const withTweak = eligible.filter((c) => c.applyOutputTweaks).length;
    return { eligible: eligible.length, withTweak };
  }, [clips]);

  const tweaksConfigured = Boolean(
    settings?.outputTweaks.applyConversionLut ||
      (settings && Math.abs(settings.outputTweaks.exposureStops) > 0.001),
  );

  const allHaveTweak =
    tweakSummary.eligible > 0 && tweakSummary.withTweak === tweakSummary.eligible;

  const handleApplyLutToAll = useCallback(() => {
    setClips((prev) =>
      prev.map((c) => {
        if (c.status !== 'ready' && c.status !== 'approved') return c;
        return { ...c, applyOutputTweaks: !allHaveTweak };
      }),
    );
  }, [allHaveTweak]);

  if (!settings) return <div className="empty">Loading…</div>;

  const backendLabel = backend?.ok
    ? backend.mode === 'proxy'
      ? 'Connected'
      : 'Using your API key'
    : backend
      ? `Offline — ${backend.detail ?? 'check settings'}`
      : 'Checking…';

  const backendClass = backend?.ok ? 'ok' : backend ? 'bad' : '';

  return (
    <div className="app">
      <div className="titlebar">
        <div className="brand">
          <img className="brand-logo" src={brandLogoUrl} alt="" />
          <span className="brand-mark">mnn</span>
          <span className="brand-divider" />
          <span className="brand-sub">Clip Namer</span>
        </div>
        <div className="actions">
          <span className={`backend-pill ${backendClass}`} title={backend?.detail}>
            <span className="dot" />
            {backendLabel}
          </span>
          <button
            className="toolbar-button"
            onClick={() => setShowSettings(true)}
            aria-label="Open Settings"
            title="Settings"
          >
            <ToolbarIcon name="settings" />
          </button>
        </div>
      </div>

      <div className={`main${clips.length > 0 ? ' has-clips' : ' no-clips'}`}>
        <div className="ingest-panel">
          <DropZone onDropPaths={ingestPaths} compact={clips.length > 0} busy={busy} />
        </div>

        <div className="table-wrap">
          {clips.length === 0 ? (
            <div className="empty">
              <MnnLogo className="empty-logo" />
              <div className="empty-copy">
                <strong>No clips yet</strong>
                <span>Drop videos above to generate names and review them here.</span>
              </div>
            </div>
          ) : (
            <>
              <div className="review-head">
                <div>
                  <span className="eyebrow">Review</span>
                  <strong>{summary.total} clip{summary.total === 1 ? '' : 's'}</strong>
                </div>
                <div className="review-metrics" aria-label="Clip status summary">
                  {summary.queued > 0 && <span>{summary.queued} waiting</span>}
                  {summary.analyzing > 0 && <span>{summary.analyzing} analyzing</span>}
                  {summary.ready > 0 && <span>{summary.ready} ready</span>}
                  {summary.renamed > 0 && <span>{summary.renamed} renamed</span>}
                  {summary.errored > 0 && <span>{summary.errored} error{summary.errored === 1 ? '' : 's'}</span>}
                </div>
                <div className="review-actions">
                  {tweakSummary.eligible > 0 && (
                    <button
                      className="ghost"
                      onClick={handleApplyLutToAll}
                      disabled={!tweaksConfigured}
                      title={
                        !tweaksConfigured
                          ? 'Enable LUT or exposure in Settings first.'
                          : allHaveTweak
                            ? `Remove LUT from all ${tweakSummary.eligible} clip${tweakSummary.eligible === 1 ? '' : 's'}`
                            : `Apply LUT/exposure on output to all ${tweakSummary.eligible} clip${tweakSummary.eligible === 1 ? '' : 's'}`
                      }
                    >
                      {allHaveTweak
                        ? 'Remove LUT from all'
                        : `Apply LUT to all (${tweakSummary.eligible})`}
                    </button>
                  )}
                  <button
                    className="primary"
                    onClick={() => void handleStartNaming()}
                    disabled={nameableCount === 0 || summary.analyzing > 0}
                    title={
                      nameableCount === 0
                        ? 'No clips waiting to be named'
                        : `Start naming ${nameableCount} clip${nameableCount === 1 ? '' : 's'}`
                    }
                  >
                    {summary.analyzing > 0
                      ? `Naming ${summary.analyzing}…`
                      : `Start naming${nameableCount > 0 ? ` (${nameableCount})` : ''}`}
                  </button>
                </div>
              </div>
              <ClipTable
                clips={clips}
                onChange={handleRowChange}
                onRemove={handleRemove}
                onRegenerate={handleRegenerate}
                onNotify={(msg) => setToast({ msg })}
              />
            </>
          )}
        </div>

        <div className="footer">
          <CityCredit />
          <div className="summary-chips">
            <span className="summary-chip">
              <Tick n={summary.total} />
              clip{summary.total === 1 ? '' : 's'}
            </span>
            {summary.queued > 0 && (
              <span className="summary-chip queued">
                <Tick n={summary.queued} />waiting
              </span>
            )}
            {summary.analyzing > 0 && (
              <span className="summary-chip analyzing">
                <Tick n={summary.analyzing} />analyzing
              </span>
            )}
            {summary.ready > 0 && (
              <span className="summary-chip ready">
                <Tick n={summary.ready} />ready
              </span>
            )}
            {summary.renamed > 0 && (
              <span className="summary-chip renamed">
                <Tick n={summary.renamed} />renamed
              </span>
            )}
            {summary.errored > 0 && (
              <span className="summary-chip error">
                <Tick n={summary.errored} />error{summary.errored === 1 ? '' : 's'}
              </span>
            )}
          </div>
          <div className="spacer" />
          {clips.length > 0 && (
            <button className="ghost" onClick={handleClear} disabled={busy}>
              Clear list
            </button>
          )}
          <button onClick={handleExport} disabled={summary.renamed === 0}>
            Export CSV
          </button>
          <button onClick={handleUndo} disabled={busy}>
            Undo last
          </button>
          <button
            className="primary"
            onClick={handleApproveAll}
            disabled={busy || readyToRename.length === 0}
          >
            Approve &amp; rename {readyToRename.length || ''}
          </button>
        </div>
      </div>

      {showSettings && settings && (
        <SettingsPanel
          settings={settings}
          onClose={() => setShowSettings(false)}
          onSaved={async (s) => {
            setSettings(s);
            await refreshBackend();
          }}
        />
      )}
      {showOnboarding && (
        <OnboardingModal
          settings={settings}
          backend={backend}
          onDone={async () => {
            setShowOnboarding(false);
            const s = await window.mnn.getSettings();
            setSettings(s);
            await refreshBackend();
          }}
          onOpenSettings={() => {
            setShowOnboarding(false);
            setShowSettings(true);
          }}
        />
      )}
      {toast && <Toast msg={toast.msg} action={toast.action} onClose={() => setToast(null)} />}
    </div>
  );
}
