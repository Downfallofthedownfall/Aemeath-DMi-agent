// ============================================================
// preload.js - 预加载脚本
// 这是"桥梁"，让网页能安全地调用 Node.js 的功能
// 网页不能直接访问文件系统，但通过这个桥接可以安全地获取配置
// ============================================================

// 从 electron 中导入桥接模块
const { contextBridge, ipcRenderer } = require('electron');

// 通过 contextBridge 向网页暴露安全的 API
// 网页里可以通过 window.electronAPI.getConfig() 来调用
contextBridge.exposeInMainWorld('electronAPI', {
  // getConfig 方法：向主进程发送请求，获取 config.json 的内容
  getConfig: () => ipcRenderer.invoke('get-config'),
});
