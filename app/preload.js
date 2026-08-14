// ============================================================
// preload.js — 预加载桥（contextIsolation 下暴露受控 API）
// 渲染进程只能通过 window.shell 访问：窗口控制、服务信息、状态订阅。
// ============================================================
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('shell', {
  // 窗口控制
  minimize: () => ipcRenderer.invoke('shell:minimize'),
  maximizeToggle: () => ipcRenderer.invoke('shell:maximize-toggle'),
  close: () => ipcRenderer.invoke('shell:close'),
  // 信息
  getInfo: () => ipcRenderer.invoke('shell:get-info'),
  // 状态订阅（窗口最大化/还原、服务启停）
  onWindowState: (cb) => {
    const handler = (_e, state) => cb(state);
    ipcRenderer.on('shell:window-state', handler);
    return () => ipcRenderer.removeListener('shell:window-state', handler);
  },
  onServiceStatus: (cb) => {
    const handler = (_e, status) => cb(status);
    ipcRenderer.on('shell:status', handler);
    return () => ipcRenderer.removeListener('shell:status', handler);
  },
});
