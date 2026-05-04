import { useCallback, useEffect, useMemo, useState } from 'react';
import type { BackendStatus, Clip, Settings } from '../shared/types';
import DropZone from './components/DropZone';
import ClipTable from './components/ClipTable';
import SettingsPanel from './components/SettingsPanel';
import OnboardingModal from './components/OnboardingModal';
import Toast from './components/Toast';

const VIDEO_EXTS = new Set(['.mov', '.mp4', '.mkv', '.m4v', '.avi', '.mxf', '.webm']);

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
        // Auto-analyze only if the backend is reachable.
        // Newly-ingested clips arrive with status 'queued' (they have metadata + a
        // thumbnail and are waiting for the AI). Anything in 'error' came back with
        // an ingest failure and shouldn't be sent to Gemini.
        const status = backend ?? (await refreshBackend());
        if (status.ok) {
          for (const c of newClips) {
            if (c.status === 'queued') {
              void window.mnn.analyzeClip(c.id).catch(() => undefined);
            }
          }
        } else {
          setToast({ msg: `Backend not ready: ${status.detail ?? 'open Settings'}.` });
        }
      } finally {
        setBusy(false);
      }
    },
    [backend, refreshBackend],
  );

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

  const handleRegenerate = useCallback((id: string) => {
    void window.mnn.analyzeClip(id).catch((err: unknown) => {
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
  }, [readyToRename, handleUndo]);

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
    const renamed = clips.filter((c) => c.status === 'renamed').length;
    const errored = clips.filter((c) => c.status === 'error').length;
    return { total, ready, analyzing, renamed, errored };
  }, [clips]);

  if (!settings) return <div className="empty">Loading…</div>;

  const backendLabel = backend?.ok
    ? backend.mode === 'proxy'
      ? 'Connected'
      : 'Using your API key'
    : backend
      ? `Offline — ${backend.detail ?? 'check settings'}`
      : 'Checking…';

  return (
    <div className="app">
      <div className="titlebar">
        <div className="brand">MNN Clip Namer</div>
        <div className="actions">
          <span
            className={`status-badge ${backend?.ok ? 'ready' : 'error'}`}
            title={backend?.detail}
          >
            {backendLabel}
          </span>
          <button className="ghost" onClick={() => setShowSettings(true)}>
            Settings
          </button>
        </div>
      </div>

      <div className="main">
        <DropZone onDropPaths={ingestPaths} compact={clips.length > 0} busy={busy} />

        <div className="table-wrap">
          {clips.length === 0 ? (
            <div className="empty">Drop video files above to get started.</div>
          ) : (
            <ClipTable
              clips={clips}
              onChange={handleRowChange}
              onRemove={handleRemove}
              onRegenerate={handleRegenerate}
            />
          )}
        </div>

        <div className="footer">
          <div className="summary">
            {summary.total} clip{summary.total === 1 ? '' : 's'}
            {summary.analyzing > 0 && ` • ${summary.analyzing} analyzing`}
            {summary.ready > 0 && ` • ${summary.ready} ready`}
            {summary.renamed > 0 && ` • ${summary.renamed} renamed`}
            {summary.errored > 0 && ` • ${summary.errored} error`}
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
