import { useEffect } from 'react';

interface Props {
  msg: string;
  action?: { label: string; onClick: () => void };
  onClose: () => void;
}

export default function Toast({ msg, action, onClose }: Props) {
  const lifeMs = action ? 7000 : 4000;
  useEffect(() => {
    const t = setTimeout(onClose, lifeMs);
    return () => clearTimeout(t);
  }, [onClose, lifeMs]);

  return (
    <div
      className="toast"
      role="status"
      style={{ ['--toast-life' as unknown as string]: `${lifeMs}ms` } as React.CSSProperties}
    >
      <span>{msg}</span>
      {action && (
        <button
          className="ghost"
          style={{ padding: '4px 10px', fontSize: 10, letterSpacing: '0.16em' }}
          onClick={() => {
            action.onClick();
            onClose();
          }}
        >
          {action.label}
        </button>
      )}
      <button
        className="icon-button"
        onClick={onClose}
        aria-label="Close"
      >
        <svg viewBox="0 0 20 20" aria-hidden="true">
          <path d="m5.75 5.75 8.5 8.5M14.25 5.75l-8.5 8.5" />
        </svg>
      </button>
    </div>
  );
}
