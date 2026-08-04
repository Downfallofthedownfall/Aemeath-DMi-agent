// ============================================================
// preload.js - 预加载脚本
// 这是"桥梁"，让网页能安全地调用 Node.js 的功能
// ============================================================

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // 获取 config.json 的内容
  getConfig: () => ipcRenderer.invoke('get-config'),
  // 用系统浏览器打开外部链接
  openExternalUrl: (url) => ipcRenderer.invoke('open-external-url', url),
  // 路径
  getAppPath: () => ipcRenderer.invoke('get-app-path'),
  // fetch tts
  ttsFetch: (text, voicePath) => ipcRenderer.invoke('tts-fetch', text, voicePath),
  getAuthToken: () => ipcRenderer.invoke('get-auth-token'),
  // 工具确认角标弹窗（渲染进程 → 主进程）
  notifyToolConfirm: (data) => ipcRenderer.send('tool-confirm-pending', data),
  // 弹窗决定 → 主进程转发（渲染进程不直接碰网络）
  sendToolConfirmDecision: (data) => ipcRenderer.send('tool-confirm-decision', data),
  // 全局快捷键 F8/F7/F9（主进程 → 渲染进程）
  onApprovalHotkey: (callback) => {
    const handler = (_event, action) => callback(action);
    ipcRenderer.on('approval-hotkey', handler);
    return () => ipcRenderer.removeListener('approval-hotkey', handler);
  },
});
