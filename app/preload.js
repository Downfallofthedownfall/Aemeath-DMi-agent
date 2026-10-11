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
  /**
   * 本窗口是否是**课堂记录独立窗口**。
   *
   * 怎么来的：主进程给课堂窗口的 webPreferences.additionalArguments 传
   * `--aemeath-lecture-window=1`，这里从 process.argv 同步读出来
   * （preload 在渲染进程脚本之前执行，所以客户端插件 apply() 时已可读）。
   *
   * 为什么不用 URL query：dsh 的认证流程（?token= → 换 cookie → 303 → ./）
   * 会把 URL 重写成裸路径，query 上的标记会丢（实测 location.search 变空）。
   */
  isLectureWindow: process.argv.includes('--aemeath-lecture-window=1'),

  // 窗口控制
  minimize: () => ipcRenderer.invoke('shell:minimize'),
  maximizeToggle: () => ipcRenderer.invoke('shell:maximize-toggle'),
  close: () => ipcRenderer.invoke('shell:close'),
  // 信息
  getInfo: () => ipcRenderer.invoke('shell:get-info'),
  // 状态订阅（窗口最大化/还原、服务启停）
  onWindowState: (cb) => subscribe('shell:window-state', cb),
  onServiceStatus: (cb) => subscribe('shell:status', cb),

  // ===== 课堂记录模式：**独立窗口** =====
  // 为什么走壳而不是在 Web UI 里做面板：dsh 的 Web UI 只开放四个座位，
  // 插件开不了新 OS 窗口；"可摆到屏幕边上、不重叠"只有壳能做到。
  // 浏览器模式（没有 window.shell）下这些调用不存在 → 客户端降级为侧边面板。
  lecture: {
    /** 打开（或聚焦）课堂独立窗口。返回 { ok, reason }。 */
    open: () => ipcRenderer.invoke('shell:lecture-open'),
    /** 关闭课堂窗口。 */
    close: () => ipcRenderer.invoke('shell:lecture-close'),
    /** 查询课堂窗口是否开着。 */
    isOpen: () => ipcRenderer.invoke('shell:lecture-is-open'),
    /** 订阅课堂窗口开关状态（主窗口里的入口按钮据此更新）。 */
    onStateChange: (cb) => subscribe('shell:lecture-window', cb),
  },
});
