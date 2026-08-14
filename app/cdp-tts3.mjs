// cdp-tts3.mjs — 查 console 错误 + 所有按钮 aria-label + tts 相关
import { WebSocket } from 'ws';
const ws = new WebSocket(process.argv[2]);
let msgId = 0;
const pending = new Map();
const errors = [];
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
  if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
    const desc = (msg.params.args || []).map((a) => a.description || a.value || '').join(' ');
    errors.push(desc.slice(0, 400));
  }
});
ws.on('open', async () => {
  await send('Runtime.enable');
  await new Promise((r) => setTimeout(r, 3000));

  // 刷新页面重新加载（确保最新 bundle 生效），然后打开会话
  await send('Page.enable');
  await send('Page.reload');
  await new Promise((r) => setTimeout(r, 5000));

  const r = await send('Runtime.evaluate', {
    expression: `(() => {
      const btns = [...document.querySelectorAll('button')];
      const labels = btns.map(b => b.getAttribute('aria-label')).filter(Boolean);
      return JSON.stringify({
        totalButtons: btns.length,
        ttsLike: labels.filter(l => l.includes('朗读') || l.includes('speak') || l.includes('TTS')),
        sampleLabels: labels.slice(0, 25),
        bodyHasSession: document.body.innerText.includes('牛顿第二定律查询与解释'),
      });
    })()`,
    returnByValue: true,
  });
  console.log('AFTER RELOAD:', r.result?.value);
  console.log('ERRORS:', errors.length ? errors.join(' | ').slice(0, 800) : 'NONE');

  ws.close();
  process.exit(0);
});
setTimeout(() => process.exit(0), 30000);
