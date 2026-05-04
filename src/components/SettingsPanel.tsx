import { useMemo, useState } from 'react';
import { clipDateTokenFromMetadata } from '@shared/dateStamp';
import type { Settings } from '../../shared/types';

interface Props {
  settings: Settings;
  onClose: () => void;
  onSaved: (s: Settings) => void;
}

const PREVIEW_SAMPLE = {
  subject: 'council-meeting',
  technique: 'wide-shot',
  setting: 'council-chambers',
  confidence: 'high',
};

/** Fixed sample shoot time so preview matches real `{date}` behavior (metadata-based). */
const PREVIEW_METADATA = { recordedAtUtc: '2024-06-15T18:30:00.000Z' };

function renderPreview(template: string): string {
  const date = clipDateTokenFromMetadata(PREVIEW_METADATA);
  const withTokens = template
    .replace(/\{date\}/g, date)
    .replace(/\{subject\}/g, PREVIEW_SAMPLE.subject)
    .replace(/\{technique\}/g, PREVIEW_SAMPLE.technique)
    .replace(/\{setting\}/g, PREVIEW_SAMPLE.setting)
    .replace(/\{confidence\}/g, PREVIEW_SAMPLE.confidence);
  const m = withTokens.match(/^\(\d{2}\.\d{2}\.\d{2}\)/);
  if (m && m.index === 0) {
    const prefix = m[0];
    const rest = withTokens
      .slice(prefix.length)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    return prefix + rest;
  }
  return withTokens
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export default function SettingsPanel({ settings, onClose, onSaved }: Props) {
  const [local, setLocal] = useState<Settings>(settings);
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [saving, setSaving] = useState(false);

  const preview = useMemo(() => renderPreview(local.template || ''), [local.template]);

  const save = async () => {
    setSaving(true);
    try {
      if (apiKeyInput.trim().length > 0) {
        await window.mnn.setApiKey(apiKeyInput.trim());
      }
      const saved = await window.mnn.saveSettings({
        backendMode: local.backendMode,
        proxyUrl: local.proxyUrl,
        keyframeCount: local.keyframeCount,
        concurrency: local.concurrency,
        template: local.template,
        outputMode: local.outputMode,
      });
      onSaved(saved);
      onClose();
    } finally {
      setSaving(false);
    }
  };

  const clearKey = async () => {
    await window.mnn.setApiKey('');
    const refreshed = await window.mnn.getSettings();
    setLocal(refreshed);
    onSaved(refreshed);
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Settings</h2>
        <p className="subtitle">Stored locally on this machine.</p>

        <div className="row">
          <label>Backend</label>
          <select
            value={local.backendMode}
            onChange={(e) =>
              setLocal({ ...local, backendMode: e.target.value as Settings['backendMode'] })
            }
          >
            <option value="proxy">Use the MNN proxy (default, zero-setup)</option>
            <option value="direct">Use my own OpenAI API key</option>
          </select>
        </div>

        {local.backendMode === 'proxy' ? (
          <div className="row">
            <label>Proxy URL</label>
            <input
              type="text"
              value={local.proxyUrl}
              placeholder="https://your-worker.workers.dev"
              onChange={(e) => setLocal({ ...local, proxyUrl: e.target.value })}
            />
            <div className="hint">
              The Cloudflare Worker URL. Advanced users can override for self-hosting.
            </div>
          </div>
        ) : (
          <div className="row">
            <label>OpenAI API key</label>
            <input
              type="password"
              placeholder={
                settings.apiKeySet
                  ? '•••••••• (saved)'
                  : 'sk-... (paste your OpenAI API key here)'
              }
              value={apiKeyInput}
              onChange={(e) => setApiKeyInput(e.target.value)}
            />
            <div className="hint">
              Get a key at{' '}
              <span
                className="link"
                onClick={() =>
                  window.mnn.openExternalUrl('https://platform.openai.com/api-keys')
                }
              >
                platform.openai.com/api-keys
              </span>
              . Uses <code>gpt-4o-mini</code> — about $0.001 per clip ($1 per 1,000 clips).
              {settings.apiKeySet && (
                <>
                  {' '}
                  •{' '}
                  <span className="link" onClick={clearKey}>
                    remove saved key
                  </span>
                </>
              )}
            </div>
          </div>
        )}

        <div className="row">
          <label>Naming template</label>
          <input
            type="text"
            value={local.template}
            onChange={(e) => setLocal({ ...local, template: e.target.value })}
            placeholder="{date}{subject}-{technique}-{setting}"
          />
          <div className="hint">
            Variables: <code>{'{date}'}</code> → <code>(MM.DD.YY)</code> from the clip’s embedded
            shoot time (e.g. <code>creation_time</code>) when ffprobe finds it; otherwise
            empty. <code>{'{subject}'}</code> <code>{'{technique}'}</code> <code>{'{setting}'}</code>{' '}
            <code>{'{confidence}'}</code>. Put <code>{'{date}'}</code> first for{' '}
            <code>(MM.DD.YY)title-slug</code> style names.
          </div>
          <div
            style={{
              marginTop: 8,
              padding: '8px 10px',
              background: 'var(--panel-2)',
              border: '1px solid var(--border)',
              borderRadius: 6,
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
              fontSize: 12.5,
              color: 'var(--accent-2)',
            }}
          >
            Preview: {preview || '(empty)'}
          </div>
        </div>

        <div className="row" style={{ display: 'flex', gap: 12 }}>
          <div style={{ flex: 1 }}>
            <label>Keyframes per clip</label>
            <input
              type="number"
              min={2}
              max={8}
              value={local.keyframeCount}
              onChange={(e) => setLocal({ ...local, keyframeCount: Number(e.target.value) })}
            />
          </div>
          <div style={{ flex: 1 }}>
            <label>Parallel clips</label>
            <input
              type="number"
              min={1}
              max={5}
              value={local.concurrency}
              onChange={(e) => setLocal({ ...local, concurrency: Number(e.target.value) })}
            />
          </div>
        </div>

        <div className="row">
          <label>When approved</label>
          <select
            value={local.outputMode}
            onChange={(e) =>
              setLocal({ ...local, outputMode: e.target.value as Settings['outputMode'] })
            }
          >
            <option value="rename-in-place">Rename files in place</option>
            <option value="copy-to-folder">Copy to output folder (keep originals)</option>
          </select>
        </div>

        <div className="modal-actions">
          <button className="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button className="primary" onClick={save} disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
