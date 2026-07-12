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
});
