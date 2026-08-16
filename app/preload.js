// ============================================================
// preload.js — 预加载桥（contextIsolation 下暴露受控 API）
// 渲染进程只能通过 window.shell 访问：窗口控制、服务信息、状态订阅。
// 第三关：订阅回调校验（非函数直接拒绝，防止渲染进程传任意值破坏 IPC 层）。
// ============================================================
const { contextBridge, ipcRenderer } = require('electron');

/** 订阅事件：仅接受函数回调；返回取消订阅函数。 */
function subscribe(channel, cb) {
  if (typeof cb !== 'function') return () => {};
  const handler = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld('shell', {
  // 窗口控制
  minimize: () => ipcRenderer.invoke('shell:minimize'),
  maximizeToggle: () => ipcRenderer.invoke('shell:maximize-toggle'),
  close: () => ipcRenderer.invoke('shell:close'),
  // 信息
  getInfo: () => ipcRenderer.invoke('shell:get-info'),
  // 状态订阅（窗口最大化/还原、服务启停）
  onWindowState: (cb) => subscribe('shell:window-state', cb),
  onServiceStatus: (cb) => subscribe('shell:status', cb),
});
