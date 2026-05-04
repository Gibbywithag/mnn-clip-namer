import { useCallback, useRef, useState } from 'react';

interface Props {
  onDropPaths: (paths: string[]) => void;
  compact?: boolean;
  busy?: boolean;
}

export default function DropZone({ onDropPaths, compact, busy }: Props) {
  const [over, setOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setOver(true);
  }, []);

  const onDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setOver(false);
  }, []);

  const resolvePath = (file: File): string | null => {
    // Electron 32+ — use webUtils bridge. Fall back to legacy .path if present.
    try {
      const p = window.mnn?.getPathForFile?.(file);
      if (p) return p;
    } catch {
      /* ignore */
    }
    const legacy = (file as File & { path?: string }).path;
    return legacy || null;
  };

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setOver(false);
      const paths: string[] = [];
      for (const file of Array.from(e.dataTransfer.files)) {
        const p = resolvePath(file);
        if (p) paths.push(p);
      }
      if (paths.length) onDropPaths(paths);
    },
    [onDropPaths],
  );

  const onPick = useCallback(() => {
    inputRef.current?.click();
  }, []);

  const onFileInput = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const paths: string[] = [];
      for (const file of Array.from(e.target.files ?? [])) {
        const p = resolvePath(file);
        if (p) paths.push(p);
      }
      if (paths.length) onDropPaths(paths);
      e.target.value = '';
    },
    [onDropPaths],
  );

  return (
    <div
      className={`dropzone${over ? ' over' : ''}${compact ? ' compact' : ''}`}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      onClick={onPick}
      role="button"
      tabIndex={0}
    >
      {compact ? (
        <p>
          <strong>Drop more clips</strong> — or click to browse. {busy && '• working…'}
        </p>
      ) : (
        <>
          <h1>Drop video clips here</h1>
          <p>
            Supports .mov, .mp4, .mkv, .m4v, .avi, .mxf, .webm — or click to browse.
            {busy && ' • working…'}
          </p>
        </>
      )}
      <input
        ref={inputRef}
        type="file"
        multiple
        accept=".mov,.mp4,.mkv,.m4v,.avi,.mxf,.webm,video/*"
        style={{ display: 'none' }}
        onChange={onFileInput}
      />
    </div>
  );
}
