import { useEffect, useState } from 'react';
import type { Clip } from '../../shared/types';

interface Props {
  clip: Clip;
  onChange: (id: string, patch: Partial<Clip>) => void;
  onRemove: (id: string) => void;
  onRegenerate: (id: string) => void;
}

function formatDuration(sec?: number): string {
  if (!sec || !isFinite(sec)) return '';
  const s = Math.round(sec);
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}m${s % 60}s` : `${s}s`;
}

export default function ClipRow({ clip, onChange, onRemove, onRegenerate }: Props) {
  const [local, setLocal] = useState(clip.proposedName ?? '');
  useEffect(() => setLocal(clip.proposedName ?? ''), [clip.proposedName]);

  const commit = () => {
    if (local !== (clip.proposedName ?? '')) {
      onChange(clip.id, { proposedName: local });
    }
  };

  return (
    <tr>
      <td>
        {clip.thumbnailDataUrl ? (
          <img src={clip.thumbnailDataUrl} className="thumb" alt="" />
        ) : (
          <div className="thumb-missing">no preview</div>
        )}
      </td>
      <td>
        <div title={clip.originalPath}>{clip.originalName}</div>
        <div className="meta">
          {clip.metadata
            ? `${clip.metadata.width}x${clip.metadata.height} • ${formatDuration(clip.metadata.durationSec)}`
            : '—'}
        </div>
      </td>
      <td>
        {clip.status === 'analyzing' ? (
          <div className="meta">{clip.statusMessage ?? 'analyzing…'}</div>
        ) : clip.status === 'queued' ? (
          <div className="meta">{clip.statusMessage ?? 'queued'}</div>
        ) : (
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
        )}
      </td>
      <td>
        {clip.nameParts?.confidence ? (
          <span className={`conf-badge ${clip.nameParts.confidence}`}>
            {clip.nameParts.confidence}
          </span>
        ) : (
          <span className="meta">—</span>
        )}
      </td>
      <td>
        <span className={`status-badge ${clip.status}`}>{clip.status}</span>
      </td>
      <td>
        <div className="row-actions">
          {clip.status !== 'renamed' && clip.status !== 'analyzing' && (
            <button className="ghost" onClick={() => onRegenerate(clip.id)} title="Re-run AI analysis">
              ↻
            </button>
          )}
          <button className="ghost" onClick={() => onRemove(clip.id)} title="Remove from list">
            ✕
          </button>
        </div>
      </td>
    </tr>
  );
}
