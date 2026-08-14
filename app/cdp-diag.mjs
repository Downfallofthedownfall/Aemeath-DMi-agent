// cdp-diag.mjs — 诊断设置面板状态
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
  const r = await send('Runtime.evaluate', {
    expression: `(() => {
      const text = document.body.innerText;
      const btns = [...document.querySelectorAll('button')];
      return JSON.stringify({
        hasGeneralSettings: text.includes('通用设置'),
        hasAemeathNav: text.includes('爱弥斯') && text.includes('角色模式'),
        bodySnippet: text.slice(0, 200),
        settingsLikeBtns: btns.filter(b => (b.getAttribute('aria-label')||b.textContent||'').includes('设置')).map(b => (b.getAttribute('aria-label')||b.textContent||'').trim()).slice(0,5),
      });
    })()`,
    returnByValue: true,
  });
  console.log('DIAG:', r.result?.value);
  ws.close();
  process.exit(0);
});
setTimeout(() => process.exit(0), 15000);
