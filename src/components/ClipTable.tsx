import type { AnalyzeClipOptions, Clip } from '../../shared/types';
import ClipRow from './ClipRow';

interface Props {
  clips: Clip[];
  onChange: (id: string, patch: Partial<Clip>) => void;
  onRemove: (id: string) => void;
  onRegenerate: (id: string, options?: AnalyzeClipOptions) => void;
  /** Shown when opening a clip file fails (e.g. missing file). */
  onNotify?: (msg: string) => void;
}

export default function ClipTable({
  clips,
  onChange,
  onRemove,
  onRegenerate,
  onNotify,
}: Props) {
  return (
    <div className="clip-list" aria-label="Clip review list">
      {clips.map((c, i) => (
        <div
          key={c.id}
          style={{
            // Stagger the cardIn animation. Cap at 12 so big batches don't drag.
            ['--enter-delay' as unknown as string]: `${Math.min(i, 12) * 55}ms`,
          } as React.CSSProperties}
        >
          <ClipRow
            clip={c}
            onChange={onChange}
            onRemove={onRemove}
            onRegenerate={onRegenerate}
            onNotify={onNotify}
          />
        </div>
      ))}
    </div>
  );
}
