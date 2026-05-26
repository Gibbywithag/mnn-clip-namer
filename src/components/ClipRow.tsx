import { useCallback, useEffect, useRef, useState } from 'react';
import type { AnalyzeClipOptions, Clip } from '../../shared/types';

interface Props {
  clip: Clip;
  onChange: (id: string, patch: Partial<Clip>) => void;
  onRemove: (id: string) => void;
  onRegenerate: (id: string, options?: AnalyzeClipOptions) => void;
  onNotify?: (msg: string) => void;
}

function formatDuration(sec?: number): string {
  if (!sec || !isFinite(sec)) return '';
  const s = Math.round(sec);
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}m${s % 60}s` : `${s}s`;
}

/** Chromium/Electron often lacks codecs FFmpeg has (e.g. HEVC in MP4, ProRes). */
function videoCodecLikelyBlockedInEmbeddedBrowser(codec?: string): boolean {
  const c = (codec ?? '').toLowerCase().trim();
  if (!c || c === 'unknown') return false;
  if (c === 'hevc' || c === 'h265' || c === 'hev1' || c === 'hvc1') return true;
  if (c.startsWith('prores')) return true;
  if (c.includes('dnxhd') || c.includes('dnxhr')) return true;
  if (c === 'mpeg2video') return true;
  return false;
}

type PreviewMode = 'closed' | 'video' | 'transcoding' | 'external-only';

function RowIcon({ name }: { name: 'refresh' | 'remove' }) {
  if (name === 'refresh') {
    return (
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <path d="M15.25 5.75A6.25 6.25 0 1 0 16 10" />
        <path d="M15.25 2.75v3h-3" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="m5.75 5.75 8.5 8.5M14.25 5.75l-8.5 8.5" />
    </svg>
  );
}

function ThumbPlayBadge() {
  return (
    <span className="thumb-play-overlay" aria-hidden="true">
      <span className="thumb-play-disc">
        <svg viewBox="0 0 24 24" className="thumb-play-glyph">
          <path d="M9 7.5v9l7.5-4.5L9 7.5z" fill="currentColor" />
        </svg>
      </span>
    </span>
  );
}

export default function ClipRow({
  clip,
  onChange,
  onRemove,
  onRegenerate,
  onNotify,
}: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const videoDecodeErrorRef = useRef(false);
  const transcodeAttemptedRef = useRef(false);
  const [local, setLocal] = useState(clip.proposedName ?? '');
  const [previewMode, setPreviewMode] = useState<PreviewMode>('closed');
  const [videoSrc, setVideoSrc] = useState<string | null>(null);

  useEffect(() => setLocal(clip.proposedName ?? ''), [clip.proposedName]);

  useEffect(() => {
    setPreviewMode('closed');
    setVideoSrc(null);
    videoDecodeErrorRef.current = false;
    transcodeAttemptedRef.current = false;
  }, [clip.id, clip.originalPath]);

  const stopInlinePreview = useCallback(() => {
    videoRef.current?.pause();
    setPreviewMode('closed');
    setVideoSrc(null);
    videoDecodeErrorRef.current = false;
    transcodeAttemptedRef.current = false;
  }, []);

  useEffect(() => {
    if (previewMode === 'closed') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') stopInlinePreview();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [previewMode, stopInlinePreview]);

  const commit = () => {
    if (local !== (clip.proposedName ?? '')) {
      onChange(clip.id, { proposedName: local });
    }
  };

  const renderThumb = () => {
    if (clip.thumbnailDataUrl) {
      return <img src={clip.thumbnailDataUrl} className="thumb" alt="" />;
    }
    if (clip.status === 'queued' || clip.status === 'analyzing') {
      return <div className="thumb-skeleton">loading</div>;
    }
    return <div className="thumb-missing">no preview</div>;
  };

  const openClipExternally = async () => {
    const res = await window.mnn.openClipPath(clip.originalPath);
    if (!res.ok && res.error) {
      onNotify?.(`Could not open clip: ${res.error}`);
    }
  };

  const loadTranscodedProxy = async () => {
    // One transcode attempt per preview session — if the proxy itself fails to
    // play, fall through to the "open externally" panel instead of looping.
    if (transcodeAttemptedRef.current) {
      setPreviewMode('external-only');
      return;
    }
    transcodeAttemptedRef.current = true;
    setVideoSrc(null);
    setPreviewMode('transcoding');
    const proxy = await window.mnn.previewProxyForPath(clip.originalPath);
    if (!proxy.ok || !proxy.url) {
      setPreviewMode('external-only');
      return;
    }
    videoDecodeErrorRef.current = false;
    setVideoSrc(proxy.url);
    setPreviewMode('video');
  };

  const startInlinePreview = async () => {
    if (videoCodecLikelyBlockedInEmbeddedBrowser(clip.metadata?.codec)) {
      void loadTranscodedProxy();
      return;
    }
    const res = await window.mnn.fileUrlFromPath(clip.originalPath);
    if (!res.ok || !res.url) {
      onNotify?.(res.error ?? 'Could not load video preview');
      return;
    }
    videoDecodeErrorRef.current = false;
    setVideoSrc(res.url);
    setPreviewMode('video');
  };

  const handleVideoError = () => {
    if (videoDecodeErrorRef.current) return;
    videoDecodeErrorRef.current = true;
    void loadTranscodedProxy();
  };

  const previewOpen = previewMode !== 'closed';

  return (
    <article
      className={`clip-card ${previewOpen ? 'clip-card--preview-open ' : ''}${clip.status}`}
    >
      <div className={`clip-media${previewOpen ? ' clip-media--preview-open' : ''}`}>
        {clip.status === 'analyzing' ? (
          renderThumb()
        ) : previewMode === 'video' && videoSrc ? (
          <div className="inline-video-wrap">
            <video
              key={videoSrc}
              ref={videoRef}
              className="inline-video"
              src={videoSrc}
              controls
              playsInline
              autoPlay
              muted
              preload="auto"
              poster={clip.thumbnailDataUrl}
              onError={handleVideoError}
            />
            <button
              type="button"
              className="inline-video-close"
              onClick={stopInlinePreview}
              title="Close preview"
              aria-label="Close in-app video preview"
            >
              ×
            </button>
          </div>
        ) : previewMode === 'transcoding' ? (
          <div className="inline-video-wrap inline-preview-transcoding">
            <div className="inline-preview-fallback-thumb" aria-hidden="true">
              {renderThumb()}
            </div>
            <div className="inline-preview-fallback-panel">
              <p className="inline-preview-fallback-title">Preparing preview…</p>
              <span className="transcoding-progress" aria-hidden="true" />
            </div>
            <button
              type="button"
              className="inline-video-close"
              onClick={stopInlinePreview}
              title="Cancel"
              aria-label="Cancel preview build"
            >
              ×
            </button>
          </div>
        ) : previewMode === 'external-only' ? (
          <div className="inline-video-wrap inline-preview-fallback">
            <div className="inline-preview-fallback-thumb" aria-hidden="true">
              {renderThumb()}
            </div>
            <div className="inline-preview-fallback-panel">
              <p className="inline-preview-fallback-title">Preview unavailable</p>
              <div className="inline-preview-fallback-actions">
                <button
                  type="button"
                  className="btn-open-external"
                  onClick={() => void openClipExternally()}
                >
                  Open externally
                </button>
              </div>
            </div>
            <button
              type="button"
              className="inline-video-close"
              onClick={stopInlinePreview}
              title="Close"
              aria-label="Close preview panel"
            >
              ×
            </button>
          </div>
        ) : (
          <button
            type="button"
            className="thumb-stack"
            onClick={() => void startInlinePreview()}
            title="Watch this clip in the app"
            aria-label={`Play preview of ${clip.originalName}`}
          >
            {renderThumb()}
            <ThumbPlayBadge />
          </button>
        )}
      </div>

      <div className="clip-body">
        <div className="clip-topline">
          <div className="original-cell">
            <div
              className="original-name"
              title={`${clip.originalPath}\nDouble-click to open in default video app`}
              onDoubleClick={() => {
                if (clip.status !== 'analyzing') void openClipExternally();
              }}
            >
              {clip.originalName}
            </div>
            <div className="meta">
              {clip.metadata
                ? `${clip.metadata.width}×${clip.metadata.height} • ${formatDuration(clip.metadata.durationSec)}`
                : '—'}
            </div>
          </div>
          <div className="clip-badges">
            {clip.nameParts?.confidence ? (
              <span
                className={`conf-badge ${clip.nameParts.confidence}`}
                title={
                  clip.nameParts.notes?.trim()
                    ? `${clip.nameParts.confidence}: ${clip.nameParts.notes}`
                    : `Confidence: ${clip.nameParts.confidence}`
                }
              >
                {clip.nameParts.confidence}
              </span>
            ) : null}
            <span className={`status-badge ${clip.status}`}>{clip.status}</span>
          </div>
        </div>

        {clip.status === 'analyzing' ? (
          <div className="analyzing-cell">
            <div className="progress" />
            <span className="progress-label">{clip.statusMessage ?? 'analyzing…'}</span>
          </div>
        ) : clip.status === 'queued' ? (
          <div className="queued-cell">
            <span className="pulse-dot" />
            {clip.statusMessage ?? 'queued'}
          </div>
        ) : (
          <div className="name-stack">
            <input
              type="text"
              className="name-edit"
              value={local}
              onChange={(e) => setLocal(e.target.value)}
              onBlur={commit}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                if (e.key === 'Escape') setLocal(clip.proposedName ?? '');
              }}
              placeholder={clip.error ? clip.error : 'subject-technique-setting'}
              disabled={clip.status === 'renamed'}
            />
            {clip.nameParts?.notes && <span className="cue-note">{clip.nameParts.notes}</span>}
            {clip.nameParts && (
              <details className="ai-detail">
                <summary>AI breakdown</summary>
                <dl className="ai-detail-grid">
                  <dt>Subject</dt>
                  <dd>{clip.nameParts.subject}</dd>
                  <dt>Technique</dt>
                  <dd>{clip.nameParts.technique}</dd>
                  <dt>Setting</dt>
                  <dd>{clip.nameParts.setting}</dd>
                  <dt>Notes</dt>
                  <dd>{clip.nameParts.notes?.trim() ? clip.nameParts.notes : '—'}</dd>
                </dl>
              </details>
            )}
            {(clip.status === 'ready' || clip.status === 'approved') && (
              <label className="clip-tweak-toggle">
                <input
                  type="checkbox"
                  checked={Boolean(clip.applyOutputTweaks)}
                  onChange={(e) =>
                    onChange(clip.id, { applyOutputTweaks: e.target.checked })
                  }
                />
                <span>Apply LUT / exposure on output</span>
              </label>
            )}
          </div>
        )}
      </div>

      <div className="clip-actions">
        <div className="row-actions">
          {clip.status !== 'renamed' && clip.status !== 'analyzing' && (
            <>
              <button
                className="icon-button"
                onClick={() => onRegenerate(clip.id)}
                title="Re-run AI analysis"
                aria-label={`Re-run AI analysis for ${clip.originalName}`}
              >
                <RowIcon name="refresh" />
              </button>
              <button
                type="button"
                className="secondary-action"
                onClick={() => onRegenerate(clip.id, { forceMaxKeyframes: true })}
                title="Re-analyze using 8 keyframes (max sampling)"
              >
                8 frames
              </button>
            </>
          )}
          <button
            className="icon-button"
            onClick={() => onRemove(clip.id)}
            title="Remove from list"
            aria-label={`Remove ${clip.originalName} from list`}
          >
            <RowIcon name="remove" />
          </button>
        </div>
      </div>
    </article>
  );
}
