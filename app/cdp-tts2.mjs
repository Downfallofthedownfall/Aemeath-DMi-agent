// cdp-tts2.mjs — 深入检查 TTS 与消息流
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

  // 检查：是否有 assistant 消息内容在 DOM（历史会话应该已渲染）
  const r = await send('Runtime.evaluate', {
    expression: `(() => {
      const text = document.body.innerText;
      const allBtns = [...document.querySelectorAll('button')];
      return JSON.stringify({
        hasMessageContent: text.includes('熵') && text.includes('推导'),
        hasConversationArea: !!document.querySelector('[contenteditable="true"], textarea'),
        ariaLabels: allBtns.map(b=>b.getAttribute('aria-label')).filter(Boolean).filter(l=>l.includes('朗读')||l.includes('赞')||l.includes('踩')).slice(0,10),
        bodyLen: text.length,
        snippet: text.slice(300, 600),
      });
    })()`,
    returnByValue: true,
  });
  console.log('CHECK:', r.result?.value);

  // 尝试再次打开会话（列表行的点击可能没触发 open）
  await send('Runtime.evaluate', {
    expression: `(() => {
      const btns = [...document.querySelectorAll('button')];
      // 找会话列表行（含标题和副标题）
      const row = btns.find(b => b.getAttribute('aria-label') && b.getAttribute('aria-label').includes('查询'));
      if (row) { row.dispatchEvent(new MouseEvent('click', {bubbles: true})); return 'clicked row'; }
      return 'no row';
    })()`,
    returnByValue: true,
  }).then((r2) => console.log('CLICK:', r2.result?.value));
  await new Promise((r) => setTimeout(r, 2500));

  const r2 = await send('Runtime.evaluate', {
    expression: `(() => {
      const text = document.body.innerText;
      const speak = [...document.querySelectorAll('button')].filter(b => (b.getAttribute('aria-label')||'').includes('朗读'));
      return JSON.stringify({
        hasTts: speak.length > 0,
        ttsCount: speak.length,
        hasComposer: !!document.querySelector('[contenteditable="true"], textarea'),
        snippet: text.slice(0, 200),
      });
    })()`,
    returnByValue: true,
  });
  console.log('AFTER:', r2.result?.value);

  ws.close();
  process.exit(0);
});
setTimeout(() => process.exit(0), 25000);
