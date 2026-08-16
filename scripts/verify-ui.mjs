// ============================================================
// verify-ui.mjs — UI 改造验证脚本（P1–P3）
// 用法：node scripts/verify-ui.mjs [--screenshot out.png]
// 流程：拉起 headless Edge（CDP 9333）→ 打开 http://127.0.0.1:3081/
//      → 等待应用渲染 → 收集诊断（主题/样式注入/品牌/角色卡/工作区选择器）
//      → 可选截图
// ============================================================
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9333;
const APP_URL = 'http://127.0.0.1:3081/';
const screenshotPath = process.argv.includes('--screenshot') ? process.argv[process.argv.indexOf('--screenshot') + 1] : null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// —— 极简 CDP 客户端（ws 由 node 内置 WebSocket 提供，Node 20+） ——
class Cdp {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 0;
    this.pending = new Map();
    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        this.pending.get(msg.id)(msg);
        this.pending.delete(msg.id);
      }
    };
  }
  open() {
    return new Promise((res, rej) => {
      this.ws.onopen = res;
      this.ws.onerror = (e) => rej(new Error('ws error: ' + (e.message || 'unknown')));
    });
  }
  send(method, params = {}) {
    return new Promise((resolve) => {
      const id = ++this.id;
      this.pending.set(id, resolve);
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  close() {
    try {
      this.ws.close();
    } catch {}
  }
}

async function main() {
  const profileDir = mkdtempSync(join(tmpdir(), 'aemeath-verify-'));
  const edge = spawn(EDGE, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1440,900',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profileDir}`,
    'about:blank',
  ], { stdio: 'ignore' });

  // 等 CDP 端口
  let ready = false;
  for (let i = 0; i < 40 && !ready; i++) {
    await sleep(500);
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      ready = res.ok;
    } catch {}
  }
  if (!ready) throw new Error('CDP 端口未就绪');

  // 新建 tab 打开应用
  const created = await (await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(APP_URL)}`, { method: 'PUT' })).json();
  const cdp = new Cdp(created.webSocketDebuggerUrl);
  await cdp.open();
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  // 等待应用渲染（品牌头部出现）
  let rendered = false;
  for (let i = 0; i < 60 && !rendered; i++) {
    await sleep(1000);
    const r = await cdp.send('Runtime.evaluate', {
      expression: `!!document.querySelector('[data-aemeath-brand-header]') || !!document.querySelector('style[data-plugin-css="@aemeath/dsh-plugin-ui/fluent"]')`,
      returnByValue: true,
    });
    rendered = !!r.result?.result?.value;
  }

  const evalJs = async (expr) => {
    const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true });
    return r.result?.result?.value;
  };

  const report = {};
  report.appRendered = rendered;
  report.fluentInjected = await evalJs(`!!document.querySelector('style[data-plugin-css="@aemeath/dsh-plugin-ui/fluent"]')`);
  report.deDshInjected = await evalJs(`!!document.querySelector('style[data-plugin-css="@aemeath/dsh-plugin-ui/de-dsh"]')`);
  report.brandHeader = await evalJs(`!!document.querySelector('[data-aemeath-brand-header]')`);
  report.heroGreeting = await evalJs(`[...document.querySelectorAll('div')].some(e => e.children.length === 0 && e.textContent.includes('你好呀，我是爱弥斯'))`);
  report.roleCards = await evalJs(`(() => { const btns = [...document.querySelectorAll('button')]; return btns.filter(b => (b.textContent||'').includes('陪伴 · 日常聊天') || (b.textContent||'').includes('物理学习 · 解题')).length; })()`);
  report.wsHeroHidden = await evalJs(`!document.querySelector('[data-aemeath-ws="hero"]')`);
  report.wsChip = await evalJs(`!!document.querySelector('[data-aemeath-ws="chip"]')`);
  report.wsChipLabel = await evalJs(`document.querySelector('[data-aemeath-ws="chip"]')?.textContent?.trim()`);
  report.quickSettings = await evalJs(`!!document.querySelector('[data-aemeath-quick-settings-trigger]')`);
  report.composerCardRounded = await evalJs(`(() => { const el = document.querySelector('[data-composer-card]'); if (!el) return 'no-composer'; const cs = getComputedStyle(el); return cs.borderRadius + ' / shadow:' + (cs.boxShadow !== 'none'); })()`);
  report.themeTokens = await evalJs(`(() => { const b = getComputedStyle(document.body); return { bgBase: b.getPropertyValue('--dsw-alias-bg-base').trim(), label: b.getPropertyValue('--dsw-alias-label-primary').trim(), accent: b.getPropertyValue('--dsw-alias-state-business-primary').trim(), colorScheme: document.documentElement.style.colorScheme || getComputedStyle(document.documentElement).colorScheme }; })()`);
  report.title = await evalJs(`document.title`);

  if (screenshotPath) {
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    if (shot.result?.data) {
      writeFileSync(screenshotPath, Buffer.from(shot.result.data, 'base64'));
      report.screenshot = screenshotPath;
    }
  }

  console.log(JSON.stringify(report, null, 2));
  cdp.close();
  edge.kill();
  process.exit(0);
}

main().catch((e) => {
  console.error('VERIFY FAILED:', e.message);
  process.exit(1);
});
