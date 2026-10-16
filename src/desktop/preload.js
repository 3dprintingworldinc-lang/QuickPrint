'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Expose narrow capabilities only. The renderer never receives Node or Electron.
contextBridge.exposeInMainWorld('quickprint', Object.freeze({
  selectFolder: () => ipcRenderer.invoke('quickprint:select-folder'),
  selectFile: (options) => ipcRenderer.invoke('quickprint:select-file', options),
  openDataFolder: () => ipcRenderer.invoke('quickprint:open-data-folder'),
  version: () => ipcRenderer.invoke('quickprint:version'),
}));
