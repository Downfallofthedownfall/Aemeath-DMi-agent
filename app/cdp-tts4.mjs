// cdp-tts4.mjs — 新回复后检查 TTS 按钮
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
  await new Promise((r) => setTimeout(r, 2000));
  const r = await send('Runtime.evaluate', {
    expression: `(() => {
      const btns = [...document.querySelectorAll('button')];
      const labels = btns.map(b => b.getAttribute('aria-label')).filter(Boolean);
      return JSON.stringify({
        ttsCount: labels.filter(l => l.includes('朗读')).length,
        actionLabels: labels.filter(l => l.includes('朗读') || l.includes('赞') || l.includes('踩') || l.includes('复制')),
        bodyHasReply: document.body.innerText.includes('打招呼'),
      });
    })()`,
    returnByValue: true,
  });
  console.log('TTS CHECK:', r.result?.value);
  ws.close();
  process.exit(0);
});
setTimeout(() => process.exit(0), 15000);
