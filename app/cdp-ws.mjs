// cdp-ws.mjs — 检查 hero 工作区 dropdown DOM
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

  // 新建会话看 hero（点新建会话）
  await send('Runtime.evaluate', {
    expression: `(() => {
      const btns = [...document.querySelectorAll('button')];
      const t = btns.find(b => (b.textContent||'').trim() === '新建会话' || (b.textContent||'').trim() === '新会话');
      if (t) { t.click(); return 'clicked'; }
      return 'no new session btn';
    })()`,
    returnByValue: true,
  }).then((r) => console.log('NEW:', r.result?.value));
  await new Promise((r) => setTimeout(r, 2000));

  const r = await send('Runtime.evaluate', {
    expression: `(() => {
      const text = document.body.innerText;
      // 找 workspace chip / dropdown 相关元素
      const workspaceLike = [...document.querySelectorAll('button, [role="button"], [role="combobox"]')].filter(el => {
        const t = (el.textContent||'').trim();
        return t.includes('Aemeath-DMi-agent') || t.includes('选择工作区') || t.includes('工作区');
      });
      const heroEls = [...document.querySelectorAll('[class*="hero"]')];
      return JSON.stringify({
        workspaceButtonCount: workspaceLike.length,
        workspaceButtons: workspaceLike.map(el => ({tag: el.tagName, text: (el.textContent||'').trim().slice(0,40), cls: (el.className||'').slice(0,60), aria: el.getAttribute('aria-label')})),
        hasText: text.includes('选择工作区'),
        snippet: text.slice(0, 300),
      });
    })()`,
    returnByValue: true,
  });
  console.log('CHECK:', r.result?.value);

  ws.close();
  process.exit(0);
});
setTimeout(() => process.exit(0), 20000);
