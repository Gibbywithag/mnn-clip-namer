import { useEffect } from 'react';

interface Props {
  msg: string;
  action?: { label: string; onClick: () => void };
  onClose: () => void;
}

export default function Toast({ msg, action, onClose }: Props) {
  useEffect(() => {
    const t = setTimeout(onClose, action ? 7000 : 4000);
    return () => clearTimeout(t);
  }, [onClose, action]);

  return (
    <div className="toast" role="status">
      <span>{msg}</span>
      {action && (
        <button
          className="ghost"
          style={{ padding: '4px 10px', fontSize: 12 }}
          onClick={() => {
            action.onClick();
            onClose();
          }}
        >
          {action.label}
        </button>
      )}
      <button
        className="ghost"
        style={{ padding: '4px 8px', fontSize: 12 }}
        onClick={onClose}
        aria-label="Close"
      >
        ✕
      </button>
    </div>
  );
}
