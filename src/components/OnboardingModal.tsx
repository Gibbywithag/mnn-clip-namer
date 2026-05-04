import { useState } from 'react';
import type { BackendStatus, Settings } from '../../shared/types';

interface Props {
  settings: Settings;
  backend: BackendStatus | null;
  onDone: () => void;
  onOpenSettings: () => void;
}

/**
 * The onboarding flow has two branches:
 *
 * 1. Proxy mode with a working backend → skipped entirely (App only opens this when !backend.ok).
 * 2. Proxy mode with a broken backend → show an error + "Open Settings" + "Use your own key" fallback.
 * 3. Direct mode (no proxy configured at build time) → show the old "paste your key" flow.
 */
export default function OnboardingModal({ settings, backend, onDone, onOpenSettings }: Props) {
  const proxyConfigured = settings.backendMode === 'proxy' && settings.proxyUrl;
  const proxyBroken = proxyConfigured && backend && !backend.ok;

  const [key, setKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const saveKey = async () => {
    const trimmed = key.trim();
    if (!trimmed) {
      setError('Paste your API key to continue.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await window.mnn.setApiKey(trimmed);
      await window.mnn.saveSettings({ backendMode: 'direct' });
      onDone();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  // --- Proxy configured but backend is unreachable ---
  if (proxyBroken) {
    return (
      <div className="modal-backdrop">
        <div className="modal">
          <h2>Can&apos;t reach the MNN server</h2>
          <p className="subtitle">
            The app is configured to use the MNN proxy, but it isn&apos;t responding.
            {backend.detail ? ` (${backend.detail})` : ''}
          </p>

          <div className="onboarding-step">
            <div className="num">1</div>
            <div className="body">
              <strong>Check your internet connection</strong>
              <p>Close and reopen the app once you&apos;re back online.</p>
            </div>
          </div>

          <div className="onboarding-step">
            <div className="num">2</div>
            <div className="body">
              <strong>Or: use your own free Google AI key instead</strong>
              <p>
                Get a free key at{' '}
                <span
                  className="link"
                  onClick={() =>
                    window.mnn.openExternalUrl('https://aistudio.google.com/apikey')
                  }
                >
                  aistudio.google.com/apikey
                </span>
                , paste it below, and the app will call Google directly.
              </p>
              <div style={{ marginTop: 8 }}>
                <input
                  type="password"
                  placeholder="AIza…"
                  value={key}
                  onChange={(e) => setKey(e.target.value)}
                />
              </div>
            </div>
          </div>

          {error && (
            <div style={{ color: 'var(--danger)', fontSize: 13, marginTop: 10 }}>{error}</div>
          )}

          <div className="modal-actions">
            <button className="ghost" onClick={onOpenSettings} disabled={saving}>
              Open Settings
            </button>
            <button className="ghost" onClick={onDone} disabled={saving}>
              Skip for now
            </button>
            <button className="primary" onClick={saveKey} disabled={saving || !key.trim()}>
              {saving ? 'Saving…' : 'Use my own key'}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // --- Direct mode (no proxy baked in at build time) ---
  return (
    <div className="modal-backdrop">
      <div className="modal">
        <h2>Welcome to MNN Clip Namer</h2>
        <p className="subtitle">
          To analyze video clips, this app needs a free Google AI API key. Takes about 30 seconds.
        </p>

        <div className="onboarding-step">
          <div className="num">1</div>
          <div className="body">
            <strong>Get a free API key</strong>
            <p>
              Click below — it opens Google AI Studio. Sign in with any Google account, then click
              &quot;Create API key&quot;.
            </p>
            <div style={{ marginTop: 8 }}>
              <button
                onClick={() => window.mnn.openExternalUrl('https://aistudio.google.com/apikey')}
              >
                Open Google AI Studio →
              </button>
            </div>
          </div>
        </div>

        <div className="onboarding-step">
          <div className="num">2</div>
          <div className="body">
            <strong>Paste the key here</strong>
            <p>Stored securely in your system keychain — never written to plain text.</p>
            <div style={{ marginTop: 8 }}>
              <input
                type="password"
                placeholder="AIza…"
                value={key}
                onChange={(e) => setKey(e.target.value)}
                autoFocus
              />
            </div>
          </div>
        </div>

        <div className="onboarding-step">
          <div className="num">3</div>
          <div className="body">
            <strong>Drop videos and rename</strong>
            <p>
              Drop clips onto the window. The app proposes names like{' '}
              <code>granicus-wide-shot-council-chambers</code>. Review, edit if needed, approve.
            </p>
          </div>
        </div>

        {error && (
          <div style={{ color: 'var(--danger)', fontSize: 13, marginTop: 10 }}>{error}</div>
        )}

        <div className="modal-actions">
          <button className="ghost" onClick={onDone} disabled={saving}>
            Skip for now
          </button>
          <button className="primary" onClick={saveKey} disabled={saving || !key.trim()}>
            {saving ? 'Saving…' : 'Save & continue'}
          </button>
        </div>
      </div>
    </div>
  );
}
