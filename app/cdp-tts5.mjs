// cdp-tts5.mjs — 打开会话看 TTS 按钮
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

  // 打开最新会话（列表第一个非 blank）
  await send('Runtime.evaluate', {
    expression: `(() => {
      const btns = [...document.querySelectorAll('button')];
      const row = btns.find(b => b.getAttribute('aria-label') && !['新建会话','收起侧边栏'].includes(b.getAttribute('aria-label')));
      if (row) { row.click(); return 'clicked: ' + row.getAttribute('aria-label'); }
      return 'no row';
    })()`,
    returnByValue: true,
  }).then((r) => console.log('OPEN:', r.result?.value));
  await new Promise((r) => setTimeout(r, 3000));

  const check = await send('Runtime.evaluate', {
    expression: `(() => {
      const btns = [...document.querySelectorAll('button')];
      const labels = btns.map(b => b.getAttribute('aria-label')).filter(Boolean);
      return JSON.stringify({
        ttsCount: labels.filter(l => l.includes('朗读')).length,
        allActionLabels: labels.filter(l => l.includes('朗读') || l.includes('赞') || l.includes('踩') || l.includes('复制') || l.includes('branch')),
        hasMessage: document.body.innerText.includes('你好呀，介绍一下你自己'),
        snippet: document.body.innerText.slice(0, 200),
      });
    })()`,
    returnByValue: true,
  });
  console.log('CHECK:', check.result?.value);

  ws.close();
  process.exit(0);
});
setTimeout(() => process.exit(0), 20000);
