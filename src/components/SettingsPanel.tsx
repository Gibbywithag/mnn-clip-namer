import { useMemo, useState } from 'react';
import { clipDateTokenFromMetadata } from '@shared/dateStamp';
import { ANALYSIS_MODELS, type Settings } from '../../shared/types';

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
        analysisModel: local.analysisModel,
        requestGapMs: local.requestGapMs,
        verificationSecondPass: local.verificationSecondPass,
        template: local.template,
        outputMode: local.outputMode,
        copyFolder: local.copyFolder,
        outputTweaks: local.outputTweaks,
        gradedOutputMode: local.gradedOutputMode,
        gradedCopyFolder: local.gradedCopyFolder,
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
              . Uses the vision model you select below with higher-detail frames for clearer
              on-screen cues.
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
          <label>Vision model</label>
          <select
            value={local.analysisModel}
            onChange={(e) =>
              setLocal({
                ...local,
                analysisModel: e.target.value as Settings['analysisModel'],
              })
            }
          >
            {ANALYSIS_MODELS.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
          <div className="hint">
            Applies to proxy and direct mode (worker ignores unknown models and falls back to{' '}
            <code>gpt-4o-mini</code>).
          </div>
        </div>

        <div className="row">
          <label>Min gap between AI calls</label>
          <input
            type="number"
            min={2000}
            max={60000}
            step={500}
            value={local.requestGapMs}
            onChange={(e) =>
              setLocal({ ...local, requestGapMs: Number(e.target.value) })
            }
          />
          <div className="hint">
            Milliseconds between queued requests (helps avoid rate limits on large batches).
            Saved settings clamp this between 2&nbsp;s and 60&nbsp;s.
          </div>
        </div>

        <div className="row">
          <label className="check-row">
            <input
              type="checkbox"
              checked={local.verificationSecondPass}
              onChange={(e) =>
                setLocal({ ...local, verificationSecondPass: e.target.checked })
              }
            />
            <span>Verification pass after vision</span>
          </label>
          <div className="hint">
            Runs a second, text-only check on the draft (same JSON schema). Slightly higher
            cost per clip; requires Worker <code>/verify</code> when using proxy.
          </div>
        </div>

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
          <div className="preview-box">
            <span className="preview-label">Preview</span>
            <span>{preview || '(empty)'}</span>
          </div>
        </div>

        <div className="row" style={{ display: 'flex', gap: 12 }}>
          <div style={{ flex: 1 }}>
            <label>Keyframes per clip</label>
            <input
              type="number"
              min={5}
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
              max={2}
              value={local.concurrency}
              onChange={(e) => setLocal({ ...local, concurrency: Number(e.target.value) })}
            />
          </div>
        </div>
        <div className="hint" style={{ marginTop: -10, marginBottom: 18 }}>
          Keep parallel clips at <code>1</code> for large batches. The minimum gap above spaces
          out AI traffic across concurrent clips.
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

        {local.outputMode === 'copy-to-folder' && (
          <div className="row">
            <label>Output folder</label>
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                type="text"
                value={local.copyFolder ?? ''}
                placeholder="No folder selected — click Browse"
                onChange={(e) => setLocal({ ...local, copyFolder: e.target.value })}
              />
              <button
                style={{ flexShrink: 0 }}
                onClick={async () => {
                  const picked = await window.mnn.pickFolder();
                  if (picked) setLocal({ ...local, copyFolder: picked });
                }}
              >
                Browse…
              </button>
            </div>
            <div className="hint">
              Renamed copies are written here. The original files in their source folders
              are left untouched. Tip: point this at the broll-archive watched folder for
              automatic indexing.
            </div>
          </div>
        )}

        <div className="row">
          <label>Output image processing</label>
          <label className="check-row">
            <input
              type="checkbox"
              checked={local.outputTweaks.applyConversionLut}
              onChange={(e) =>
                setLocal({
                  ...local,
                  outputTweaks: {
                    ...local.outputTweaks,
                    applyConversionLut: e.target.checked,
                  },
                })
              }
            />
            <span>Apply Neutral Fx6 conversion LUT</span>
          </label>
          <div className="range-row">
            <span>Exposure</span>
            <input
              type="range"
              min={-3}
              max={3}
              step={0.1}
              value={local.outputTweaks.exposureStops}
              onChange={(e) =>
                setLocal({
                  ...local,
                  outputTweaks: {
                    ...local.outputTweaks,
                    exposureStops: Number(e.target.value),
                  },
                })
              }
            />
            <output>{local.outputTweaks.exposureStops.toFixed(1)} stops</output>
          </div>
          <div className="hint">
            These are the settings used for clips whose row checkbox is enabled. Unchecked
            clips still get metadata, but skip the LUT/exposure render.
          </div>
        </div>

        <div className="row">
          <label>Graded output destination</label>
          <select
            value={local.gradedOutputMode}
            onChange={(e) =>
              setLocal({
                ...local,
                gradedOutputMode: e.target.value as Settings['gradedOutputMode'],
              })
            }
          >
            <option value="overwrite">Overwrite the original file</option>
            <option value="copy-to-folder">Save graded copy to another folder</option>
          </select>
          <div className="hint">
            Only affects clips with LUT or exposure applied. Plain renames follow the
            destination chosen above.
          </div>
        </div>

        {local.gradedOutputMode === 'copy-to-folder' && (
          <div className="row">
            <label>Graded folder</label>
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                type="text"
                value={local.gradedCopyFolder ?? ''}
                placeholder="/Users/you/Movies/MNN/Graded"
                onChange={(e) => setLocal({ ...local, gradedCopyFolder: e.target.value })}
                style={{ flex: 1 }}
              />
              <button
                className="ghost"
                onClick={async () => {
                  const picked = await window.mnn.pickFolder();
                  if (picked) setLocal({ ...local, gradedCopyFolder: picked });
                }}
              >
                Choose…
              </button>
            </div>
            <div className="hint">
              Graded clips land here with their new names. Originals stay put in their source
              folders, untouched.
            </div>
          </div>
        )}

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
