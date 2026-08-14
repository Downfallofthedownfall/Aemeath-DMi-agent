// cdp-hero.mjs — 确认爱弥斯开场白可见性 + 主题 token 值
import { WebSocket } from 'ws';
const ws = new WebSocket(process.argv[2]);
let msgId = 0;
const pending = new Map();
function send(method, params = {}) {
  return new Promise((resolve) => {
    const id = ++msgId;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
}
ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg.result);
    pending.delete(msg.id);
  }
});
ws.on('open', async () => {
  await send('Runtime.enable');
  await new Promise((r) => setTimeout(r, 3000));
  const r = await send('Runtime.evaluate', {
    expression: `(() => {
      // 找含开场白的元素并检查可见性
      const els = [...document.querySelectorAll('div,span')].filter(e => e.textContent.includes('我是爱弥斯'));
      const visible = els.filter(e => {
        const cs = getComputedStyle(e);
        const rect = e.getBoundingClientRect();
        return cs.display !== 'none' && cs.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      });
      const root = document.documentElement;
      const bgBase = getComputedStyle(root).getPropertyValue('--dsw-alias-bg-base').trim();
      const labelPrimary = getComputedStyle(root).getPropertyValue('--dsw-alias-label-primary').trim();
      const darkAttr = document.body.hasAttribute('data-ds-dark-theme');
      return JSON.stringify({
        heroMatchCount: els.length,
        heroVisibleCount: visible.length,
        visibleText: visible.length ? visible[0].textContent.slice(0, 80) : null,
        tokenBgBase: bgBase,
        tokenLabelPrimary: labelPrimary,
        isDarkTheme: darkAttr,
      });
    })()`,
    returnByValue: true,
  });
  console.log('HERO:', r.result?.value);
  ws.close();
  process.exit(0);
});
setTimeout(() => process.exit(0), 20000);
