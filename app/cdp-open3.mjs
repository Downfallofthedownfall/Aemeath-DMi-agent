// cdp-open3.mjs — 打开面板后精确点爱弥斯导航（dialog 内）
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
  await new Promise((r) => setTimeout(r, 2500));

  // 点设置
  await send('Runtime.evaluate', {
    expression: `(() => {
      const b = [...document.querySelectorAll('button')].find(x => (x.textContent||'').trim() === '设置' || x.getAttribute('aria-label') === '设置');
      if (b) { b.click(); return 'ok'; }
      return 'no';
    })()`,
    returnByValue: true,
  });
  await new Promise((r) => setTimeout(r, 1500));

  // 找 dialog 里的「爱弥斯」导航项并点击
  const r = await send('Runtime.evaluate', {
    expression: `(() => {
      const dialog = document.querySelector('[role="dialog"]') || document.querySelector('[aria-modal="true"]');
      if (!dialog) return 'no dialog';
      const items = [...dialog.querySelectorAll('*')].filter(e => e.textContent?.trim() === '爱弥斯' && e.children.length === 0);
      const info = items.map(e => e.tagName + '|' + (e.getAttribute('role')||'') + '|' + e.className.slice(0,40));
      if (items.length) { items[0].click(); return 'clicked: ' + info.join(' ; '); }
      // 兜底：整个文档找
      const all = [...document.querySelectorAll('*')].filter(e => e.textContent?.trim() === '爱弥斯' && e.children.length === 0);
      return 'not in dialog; all count=' + all.length;
    })()`,
    returnByValue: true,
  });
  console.log('NAV:', r.result?.value);
  await new Promise((r) => setTimeout(r, 1500));

  const r2 = await send('Runtime.evaluate', {
    expression: `(() => {
      const text = document.body.innerText;
      return JSON.stringify({
        hasRoleSection: text.includes('角色模式'),
        hasFeatureSwitches: text.includes('功能开关'),
        hasApiKeys: text.includes('API 密钥'),
        snippet: text.slice(0, 400),
      });
    })()`,
    returnByValue: true,
  });
  console.log('FINAL:', r2.result?.value);

  ws.close();
  process.exit(0);
});
setTimeout(() => process.exit(0), 25000);
