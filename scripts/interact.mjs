// interact.mjs — 交互验证（P3）：快速设置 / 角色切换 / 工作区菜单
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9335;
const APP_URL = 'http://127.0.0.1:3081/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Cdp {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 0;
    this.pending = new Map();
    this.errors = [];
    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.method === 'Runtime.exceptionThrown') {
        this.errors.push((msg.params.exceptionDetails?.exception?.description ?? msg.params.exceptionDetails?.text ?? '').slice(0, 300));
      }
      if (msg.id && this.pending.has(msg.id)) {
        this.pending.get(msg.id)(msg);
        this.pending.delete(msg.id);
      }
    };
  }
  open() { return new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = () => rej(new Error('ws')); }); }
  send(method, params = {}) {
    return new Promise((resolve) => {
      const id = ++this.id;
      this.pending.set(id, resolve);
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  close() { try { this.ws.close(); } catch {} }
}

const profileDir = mkdtempSync(join(tmpdir(), 'aemeath-int-'));
const edge = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run', '--window-size=1440,900', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profileDir}`, 'about:blank'], { stdio: 'ignore' });

let ready = false;
for (let i = 0; i < 40 && !ready; i++) {
  await sleep(500);
  try { ready = (await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok; } catch {}
}
const created = await (await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(APP_URL)}`, { method: 'PUT' })).json();
const cdp = new Cdp(created.webSocketDebuggerUrl);
await cdp.open();
await cdp.send('Runtime.enable');

for (let i = 0; i < 40; i++) {
  await sleep(1000);
  const r = await cdp.send('Runtime.evaluate', { expression: `!!document.querySelector('[data-aemeath-brand-header]')`, returnByValue: true });
  if (r.result?.result?.value) break;
}

const evalJs = async (expr) => {
  const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  return r.result?.result?.value;
};

const out = {};

// —— 1. 快速设置面板 ——
out.quickSettingsOpen = await evalJs(`(() => {
  const t = document.querySelector('[data-aemeath-quick-settings-trigger]');
  if (!t) return 'no-trigger';
  t.click();
  return true;
})()`);
await sleep(600);
out.quickDialog = await evalJs(`(() => {
  const d = document.querySelector('[role="dialog"][aria-label="快速设置"]');
  if (!d) return null;
  const text = d.textContent || '';
  return {
    hasRoleSeg: text.includes('小爱同学') && text.includes('学霸'),
    switchCount: d.querySelectorAll('[role="switch"]').length,
    hasMemory: text.includes('记忆'),
    hasApiBadge: /API/.test(text),
  };
})()`);
// 关闭
await evalJs(`document.querySelector('[role="dialog"][aria-label="快速设置"] button[aria-label="关闭快速设置"]')?.click()`);
await sleep(300);
out.quickClosed = await evalJs(`!document.querySelector('[role="dialog"][aria-label="快速设置"]')`);

// —— 2. 角色切换（hero 卡片）——
const roleBefore = await evalJs(`fetch('/aemeath/api/settings').then(r => r.json()).then(d => d.namespaces?.['agent-presets'])`);
out.roleBefore = roleBefore;
await evalJs(`(() => {
  const btn = [...document.querySelectorAll('button')].find(b => (b.textContent||'').includes('物理学习 · 解题'));
  if (btn) { btn.click(); return 'clicked'; }
  return 'no-btn';
})()`);
await sleep(800);
const roleAfter = await evalJs(`fetch('/aemeath/api/settings').then(r => r.json()).then(d => d.namespaces?.['agent-presets'])`);
out.roleAfter = roleAfter;
// 切回 aemeath
await evalJs(`(() => {
  const btn = [...document.querySelectorAll('button')].find(b => (b.textContent||'').includes('陪伴 · 日常聊天'));
  if (btn) btn.click();
})()`);
await sleep(600);

// —— 3. 工作区菜单（输入框 chip，锚定输入框左下）——
out.wsMenuOpen = await evalJs(`(() => {
  const t = document.querySelector('[data-aemeath-ws="chip"]');
  if (!t) return 'no-chip';
  t.click();
  return true;
})()`);
await sleep(600);
out.wsMenu = await evalJs(`(() => {
  const menu = [...document.querySelectorAll('[role="menu"]')].pop();
  if (!menu) return null;
  const rect = menu.getBoundingClientRect();
  const card = document.querySelector('[data-composer-card]');
  const cardRect = card ? card.getBoundingClientRect() : null;
  const vh = window.innerHeight;
  return {
    hasNone: !!menu.querySelector('[data-aemeath-ws-none]'),
    noneActive: menu.querySelector('[data-aemeath-ws-none]')?.getAttribute('aria-pressed'),
    hasPickDir: menu.textContent.includes('选择文件夹'),
    itemCount: menu.querySelectorAll('[role="menuitem"]').length,
    // 锚定：菜单左边缘 ≈ 输入框卡左边缘（±4px）
    anchoredLeft: cardRect ? Math.abs(rect.left - cardRect.left) <= 4 : null,
    // 视口内（修复"点了没反应"：原菜单在输入框下方=视口外）
    inViewport: rect.top >= 0 && rect.bottom <= vh && rect.width > 0,
    // 贴住输入框：菜单贴着卡的下沿（向下）或上沿（向上）
    hugsCard: cardRect ? Math.abs(rect.top - cardRect.bottom) <= 8 || Math.abs(rect.bottom - cardRect.top) <= 8 : null,
    // 方向（向下优先）
    openedDown: cardRect ? rect.top >= cardRect.bottom - 1 : null,
  };
})()`);

out.jsErrors = cdp.errors.slice(-10);
console.log(JSON.stringify(out, null, 2));
cdp.close();
edge.kill();
process.exit(0);
