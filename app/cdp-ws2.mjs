// cdp-ws2.mjs — 验证工作区 chip 隐藏 + 无副作用
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

  // 点新建会话进 hero
  await send('Runtime.evaluate', {
    expression: `(() => {
      const btns = [...document.querySelectorAll('button')];
      const t = btns.find(b => (b.textContent||'').trim() === '新建会话' || (b.textContent||'').trim() === '新会话');
      if (t) { t.click(); return 'clicked'; }
      return 'no';
    })()`,
    returnByValue: true,
  }).then((r) => console.log('NEW:', r.result?.value));
  await new Promise((r) => setTimeout(r, 1500));

  const r = await send('Runtime.evaluate', {
    expression: `(() => {
      const wsBtn = document.querySelector('button[aria-label="选择工作区"]');
      const wsBtn2 = document.querySelector('button[aria-label="Choose workspace"]');
      // 侧边栏会话列表是否还在（检查 _workspace 误伤）
      const sessionList = [...document.querySelectorAll('button')].filter(b => b.getAttribute('aria-label') && b.getAttribute('aria-label').length > 2 && !['新建会话','收起侧边栏','设置'].includes(b.getAttribute('aria-label')));
      const display = wsBtn ? getComputedStyle(wsBtn).display : 'not-found';
      const display2 = wsBtn2 ? getComputedStyle(wsBtn2).display : 'not-found';
      const text = document.body.innerText;
      return JSON.stringify({
        wsBtnDisplay: display,
        wsBtn2Display: display2,
        wsBtnHidden: wsBtn ? display === 'none' : true,
        sessionRowsStillThere: sessionList.length,
        hasAemeathHero: text.includes('我是爱弥斯'),
        bodySnippet: text.slice(0, 200),
      });
    })()`,
    returnByValue: true,
  });
  console.log('CHECK:', r.result?.value);

  ws.close();
  process.exit(0);
});
setTimeout(() => process.exit(0), 20000);
