'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('vigil', {
  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (payload) => ipcRenderer.invoke('config:set', payload),

  series: (id, win) => ipcRenderer.invoke('store:series', { id, win }),
  stats: (id, win) => ipcRenderer.invoke('store:stats', { id, win }),
  readiness: (id, ms) => ipcRenderer.invoke('store:readiness', { id, ms }),
  live: () => ipcRenderer.invoke('store:live'),
  detectGateway: () => ipcRenderer.invoke('sys:gateway'),

  setAlwaysOnTop: (v) => ipcRenderer.invoke('win:aot', v),
  setCompact: (v) => ipcRenderer.invoke('win:compact', v),
  setOpacity: (v) => ipcRenderer.invoke('win:opacity', v),
  setAutostart: (v) => ipcRenderer.invoke('app:setAutostart', v),
  minimize: () => ipcRenderer.invoke('win:min'),
  close: () => ipcRenderer.invoke('win:close'),

  onTick: (cb) => ipcRenderer.on('tick', (_e, data) => cb(data)),
  onMode: (cb) => ipcRenderer.on('mode', (_e, m) => cb(m)),
});
