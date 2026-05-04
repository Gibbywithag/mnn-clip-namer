import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { BackendStatus, Clip, MnnApi, RenameJob, Settings } from '../shared/types';

const api: MnnApi = {
  // Electron 32+ removed File.path — must go through webUtils.
  getPathForFile: (file: File) => webUtils.getPathForFile(file),

  // Settings
  getSettings: () => ipcRenderer.invoke('settings:get') as Promise<Settings>,
  saveSettings: (partial) =>
    ipcRenderer.invoke('settings:save', partial) as Promise<Settings>,
  setApiKey: (key) => ipcRenderer.invoke('settings:setApiKey', key) as Promise<void>,
  hasApiKey: () => ipcRenderer.invoke('settings:hasApiKey') as Promise<boolean>,
  openExternalUrl: (url) => ipcRenderer.invoke('ui:openExternal', url) as Promise<void>,
  checkBackend: () => ipcRenderer.invoke('backend:check') as Promise<BackendStatus>,

  // Pipeline
  ingestPaths: (paths) => ipcRenderer.invoke('ingest:paths', paths) as Promise<Clip[]>,
  analyzeClip: (id) => ipcRenderer.invoke('ai:analyzeClip', id) as Promise<Clip>,
  applyRenames: (jobs: RenameJob[]) =>
    ipcRenderer.invoke('rename:apply', jobs) as Promise<
      import('../shared/types').RenameResult[]
    >,
  undoLast: () => ipcRenderer.invoke('rename:undo') as Promise<number>,
  exportCsv: (clips) => ipcRenderer.invoke('export:csv', clips) as Promise<string | null>,
  pickFolder: () => ipcRenderer.invoke('dialog:pickFolder') as Promise<string | null>,

  // Events
  onClipUpdate: (cb) => {
    const listener = (_: unknown, clip: Clip) => cb(clip);
    ipcRenderer.on('clip:update', listener);
    return () => ipcRenderer.removeListener('clip:update', listener);
  },
};

contextBridge.exposeInMainWorld('mnn', api);

// Forward file-open events from main into a browser event the renderer can listen to.
ipcRenderer.on('files:dropped', (_e, paths: string[]) => {
  window.dispatchEvent(new CustomEvent('mnn:filesDropped', { detail: paths }));
});
