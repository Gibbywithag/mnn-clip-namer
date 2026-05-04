import type { Clip } from '../../shared/types';
import ClipRow from './ClipRow';

interface Props {
  clips: Clip[];
  onChange: (id: string, patch: Partial<Clip>) => void;
  onRemove: (id: string) => void;
  onRegenerate: (id: string) => void;
}

export default function ClipTable({ clips, onChange, onRemove, onRegenerate }: Props) {
  return (
    <table className="table">
      <thead>
        <tr>
          <th style={{ width: 110 }}>Preview</th>
          <th>Original</th>
          <th>Proposed name</th>
          <th style={{ width: 90 }}>Conf.</th>
          <th style={{ width: 100 }}>Status</th>
          <th style={{ width: 140 }}></th>
        </tr>
      </thead>
      <tbody>
        {clips.map((c) => (
          <ClipRow
            key={c.id}
            clip={c}
            onChange={onChange}
            onRemove={onRemove}
            onRegenerate={onRegenerate}
          />
        ))}
      </tbody>
    </table>
  );
}
