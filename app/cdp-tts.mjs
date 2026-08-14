// cdp-tts.mjs — 验证 TTS 按钮 + 无工作区 dropdown
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

  // 关闭设置面板（ESC）
  await send('Runtime.evaluate', {
    expression: `document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}))`,
    returnByValue: true,
  });
  await new Promise((r) => setTimeout(r, 800));

  // 点第一个会话（打开历史消息）
  await send('Runtime.evaluate', {
    expression: `(() => {
      const rows = [...document.querySelectorAll('button')];
      const session = rows.find(b => b.getAttribute('aria-label') && (b.getAttribute('aria-label').includes('牛顿第二定律') || b.getAttribute('aria-label').includes('熵')));
      if (session) { session.click(); return 'clicked: ' + session.getAttribute('aria-label'); }
      return 'no session btn; labels=' + rows.map(r=>r.getAttribute('aria-label')).filter(Boolean).slice(0,10).join(',');
    })()`,
    returnByValue: true,
  }).then((r) => console.log('OPEN SESSION:', r.result?.value));
  await new Promise((r) => setTimeout(r, 2000));

  const check = await send('Runtime.evaluate', {
    expression: `(() => {
      const text = document.body.innerText;
      const speakBtns = [...document.querySelectorAll('button')].filter(b => (b.getAttribute('aria-label')||'').includes('朗读'));
      return JSON.stringify({
        hasTtsButton: speakBtns.length > 0,
        ttsButtonCount: speakBtns.length,
        hasWorkspaceDropdown: text.includes('选择工作区') || text.includes('Choose workspace'),
        hasHeroWorkspace: text.includes('Aemeath-DMi-agent'),
        snippet: text.slice(0, 250),
      });
    })()`,
    returnByValue: true,
  });
  console.log('CHECK:', check.result?.value);

  ws.close();
  process.exit(0);
});
setTimeout(() => process.exit(0), 25000);
