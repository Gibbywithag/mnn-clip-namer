import { useCallback, useRef, useState } from 'react';
import brandLogoUrl from '../assets/brand-logo.png';

interface Props {
  onDropPaths: (paths: string[]) => void;
  compact?: boolean;
  busy?: boolean;
}

function DropIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth="1.4" strokeLinecap="square" strokeLinejoin="miter" aria-hidden="true">
      <path d="M12 4v12" />
      <path d="m7 11 5 5 5-5" />
      <path d="M5 20h14" />
    </svg>
  );
}

// Nashville skyline silhouette — see App.tsx for landmark notes.
const SKYLINE_PATH =
  'M0 116 L0 100 L50 100 L50 86 L130 86 L130 96 L135 96 L135 56 L195 56 L195 64 L200 64 L200 50 L245 50 L245 58 L250 58 L250 50 L252 50 L252 40 L270 40 L270 30 L288 30 L288 4 L292 4 L292 30 L338 30 L338 4 L342 4 L342 30 L360 30 L360 40 L378 40 L378 50 L380 50 L380 60 L388 60 L440 60 L440 72 L450 72 L450 78 L470 78 L470 68 L478 68 L478 60 L482 60 L482 68 L486 68 L486 78 L510 78 L510 70 L515 70 L515 64 L555 64 L555 60 L560 60 L560 50 L605 50 L605 38 L612 38 L612 26 L660 26 L660 36 L668 36 L668 22 L715 22 L715 92 L720 92 L720 100 L760 100 L760 90 L800 90 L800 116';

function HeroSkyline() {
  return (
    <svg
      className="skyline-hero"
      viewBox="0 0 800 140"
      preserveAspectRatio="xMidYMax meet"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="square"
      strokeLinejoin="miter"
      aria-hidden="true"
    >
      <path d={SKYLINE_PATH} />
    </svg>
  );
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

  const busyTag = busy ? (
    <span className="busy-tag">
      <span className="spinner" />
      working
    </span>
  ) : null;

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
        <div className="dropzone-content">
          <div className="dropzone-icon">
            <DropIcon />
          </div>
          <div className="dropzone-text">
            <strong>Drop more clips</strong>
            <p>or click to browse {busyTag}</p>
          </div>
        </div>
      ) : (
        <>
          <div className="dropzone-content">
            <img className="brand-icon-hero" src={brandLogoUrl} alt="" />
            <div>
              <h1>Drop your clips</h1>
              <p>
                Or click to browse — we'll suggest descriptive names you can review.
                {busyTag}
              </p>
              <span className="formats">.mov · .mp4 · .mkv · .m4v · .avi · .mxf · .webm</span>
            </div>
          </div>
          <HeroSkyline />
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
