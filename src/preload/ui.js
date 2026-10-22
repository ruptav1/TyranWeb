'use strict';
// Preload for the browser shell (tyran://app). Exposes a small, typed IPC bridge.
const { contextBridge, ipcRenderer } = require('electron');

const EVENTS = new Set([
  'settings:changed', 'shortcuts:changed', 'bookmarks:changed', 'history:changed',
  'downloads:update', 'downloads:done', 'downloads:changed',
  'tab:open', 'command', 'perm:request', 'adblock:count', 'win:state', 'win:placement', 'cursor:changed', 'extensions:changed', 'crx:activate', 'crx:close',
  'nikke:changed', 'azur:changed', 'sekai:changed', 'apps:changed', 'update:state',
]);

contextBridge.exposeInMainWorld('tyran', {
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  on(channel, cb) {
    if (!EVENTS.has(channel)) throw new Error('Unknown event ' + channel);
    const fn = (_e, ...args) => cb(...args);
    ipcRenderer.on(channel, fn);
    return () => ipcRenderer.removeListener(channel, fn);
  },
});
