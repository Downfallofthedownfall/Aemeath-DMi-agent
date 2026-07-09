// ============================================================
// app.js - 聊天窗口核心逻辑
// 功能：双模态切换、共享记忆、流式对话、OOC自动修正、
//       TTS语音、语音输入、KaTeX公式渲染
// 改动：去掉 Dify 依赖，改为直连 ai_service.py
// ============================================================

window.addEventListener('DOMContentLoaded', () => {

  // ========== DOM 元素 ==========
  const historyList = document.getElementById('history-list');
  const messagesContainer = document.getElementById('messages-container');
  const userInput = document.getElementById('user-input');
  const sendBtn = document.getElementById('send-btn');
  const micBtn = document.getElementById('mic-btn');
  const newChatBtn = document.getElementById('new-chat-btn');
  const ttsSwitch = document.getElementById('tts-switch');
  const modeToggleBtn = document.getElementById('mode-toggle-btn');
  const modeIndicator = document.getElementById('mode-indicator');

  // ========== 状态变量 ==========
  let conversations = [];
  let currentConversationId = null;
  let isRecording = false;
  let recognition = null;
  let currentMode = 'aemeath';
  let configData = null;

  // AI 服务地址（本地 Python 服务，替代 Dify）
  const AI_SERVICE_URL = 'http://127.0.0.1:18892';

  // ========== 语音播报开关 ==========
  const ttsEnabled = localStorage.getItem('ttsEnabled') !== 'false';
  ttsSwitch.checked = ttsEnabled;
  ttsSwitch.addEventListener('change', () => {
    localStorage.setItem('ttsEnabled', ttsSwitch.checked);
  });

  // ========== 共享记忆 ==========
  function saveSharedMemory(key, value) {
    let memory = JSON.parse(localStorage.getItem('shared_memory') || '{}');
    memory[key] = value;
    localStorage.setItem('shared_memory', JSON.stringify(memory));
  }

  function getSharedMemory(key) {
    let memory = JSON.parse(localStorage.getItem('shared_memory') || '{}');
    return memory[key] || null;
  }

  function getAllSharedMemoryText() {
    let memory = JSON.parse(localStorage.getItem('shared_memory') || '{}');
    let parts = [];
    for (let key in memory) {
      parts.push(key + '：' + memory[key]);
    }
    return parts.length > 0 ? '用户信息：' + parts.join('；') : '';
  }

  // ========== 初始化 ==========
  async function init() {
    const config = await window.electronAPI.getConfig();
    configData = config;

    if (!configData.deepseek_api_key || configData.deepseek_api_key === 'sk-把你的DeepSeekAPIKey填在这里') {
      console.warn('⚠️ 警告：未配置 DeepSeek API Key，请在 config.json 中设置');
    }

    const savedConversations = localStorage.getItem('conversations_' + currentMode);
    if (savedConversations) {
      conversations = JSON.parse(savedConversations);
    } else {
      conversations = [createNewConversation()];
    }

    currentConversationId = conversations[0].id;
    updateModeIndicator();
    renderHistoryList();
    renderMessages();
  }

  // ========== 对话对象 ==========
  function createNewConversation() {
    return {
      id: Date.now().toString() + Math.random().toString(36).substr(2, 9),
      title: 'New',
      messages: [],
    };
  }

  function saveConversations() {
    localStorage.setItem('conversations_' + currentMode, JSON.stringify(conversations));
  }

  function getCurrentConversation() {
    return conversations.find(c => c.id === currentConversationId);
  }

  function updateModeIndicator() {
    if (modeIndicator && configData && configData.modes) {
      modeIndicator.textContent = configData.modes[currentMode]?.name || currentMode;
    }
  }

  function addSystemMessage(text) {
    const div = document.createElement('div');
    div.style.cssText = 'text-align: center; color: #888; font-size: 13px; padding: 8px;';
    div.textContent = '✦ ' + text + ' ✦';
    messagesContainer.appendChild(div);
    scrollToBottom();
  }

  // ========== 模式切换 ==========
  function switchMode(mode) {
    if (mode === currentMode) return;
    saveConversations();
    currentMode = mode;

    const savedConversations = localStorage.getItem('conversations_' + mode);
    if (savedConversations) {
      conversations = JSON.parse(savedConversations);
    } else {
      conversations = [createNewConversation()];
    }
    currentConversationId = conversations[0].id;
    updateModeIndicator();
    renderHistoryList();
    renderMessages();
    addSystemMessage('Switched to：' + (configData.modes[mode]?.name || mode));
  }

  // ========== 渲染函数 ==========

  function renderHistoryList() {
    historyList.innerHTML = '';
    conversations.forEach(conv => {
      const li = document.createElement('li');
      const titleSpan = document.createElement('span');
      titleSpan.textContent = conv.title;
      titleSpan.style.flex = '1';
      titleSpan.style.overflow = 'hidden';
      titleSpan.style.textOverflow = 'ellipsis';
      titleSpan.style.whiteSpace = 'nowrap';

      const deleteBtn = document.createElement('button');
      deleteBtn.textContent = '×';
      deleteBtn.style.cssText = `
        background: none; border: none; color: #888; font-size: 16px;
        cursor: pointer; padding: 0 4px; margin-left: 8px;
        border-radius: 4px; display: none; line-height: 1;
      `;
      deleteBtn.title = 'Delete this conversation';

      li.addEventListener('mouseenter', () => { deleteBtn.style.display = 'inline-block'; });
      li.addEventListener('mouseleave', () => { deleteBtn.style.display = 'none'; });

      deleteBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const index = conversations.findIndex(c => c.id === conv.id);
        if (index !== -1) {
          conversations.splice(index, 1);
          if (conversations.length === 0) conversations.push(createNewConversation());
          if (currentConversationId === conv.id) currentConversationId = conversations[0].id;
          saveConversations();
          renderHistoryList();
          renderMessages();
        }
      });

      const wrapper = document.createElement('div');
      wrapper.style.cssText = 'display: flex; align-items: center; width: 100%;';
      wrapper.appendChild(titleSpan);
      wrapper.appendChild(deleteBtn);
      li.appendChild(wrapper);
      li.dataset.id = conv.id;
      if (conv.id === currentConversationId) li.classList.add('active');
      li.addEventListener('click', () => { switchConversation(conv.id); });
      historyList.appendChild(li);
    });
  }

  function switchConversation(convId) {
    currentConversationId = convId;
    renderHistoryList();
    renderMessages();
  }

  function renderMessages() {
    const conv = getCurrentConversation();
    if (!conv) return;
    messagesContainer.innerHTML = '';
    conv.messages.forEach(msg => {
      appendMessageToDOM(msg.role, msg.content, msg.typing);
    });
    scrollToBottom();
  }

  function appendMessageToDOM(role, content, typing = false) {
    const div = document.createElement('div');
    div.classList.add('message');
    div.classList.add(role);
    if (typing) {
      div.innerHTML = `<div class="typing-indicator"><span></span><span></span><span></span></div>`;
    } else {
      let clean = content || '';
      clean = filterThinkTags(clean);
      div.innerHTML = renderKaTeX(clean);
    }
    messagesContainer.appendChild(div);
    scrollToBottom();
    return div;
  }

  function scrollToBottom() {
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
  }

  function updateLastAssistantMessage(content, typing = false) {
    const messages = messagesContainer.querySelectorAll('.message.assistant');
    if (messages.length === 0) return;
    const lastMsgDiv = messages[messages.length - 1];
    if (typing) {
      lastMsgDiv.innerHTML = `<div class="typing-indicator"><span></span><span></span><span></span></div>`;
    } else {
      let clean = content || '';
      clean = filterThinkTags(clean);
      lastMsgDiv.innerHTML = renderKaTeX(clean);
    }
    scrollToBottom();
  }

  // ========== 过滤 <think> 标签 ==========
  function filterThinkTags(text) {
    if (!text) return '';
    let r = text;
    while (r.includes('<think') || r.includes('</think>')) {
      const s = r.indexOf('<think');
      if (s === -1) break;
      const e = r.indexOf('</think>', s);
      if (e === -1) { r = r.substring(0, s); break; }
      r = r.substring(0, s) + r.substring(e + 8);
    }
    return r;
  }

  // ========== KaTeX 渲染 ==========
  function renderKaTeX(text) {
    if (!text) return '';
    let result = text;
    result = result.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    if (window.katex) {
      result = result.replace(/\\\\\[([\s\S]*?)\\\\\]/g, (match, formula) => {
        try { return katex.renderToString(formula.trim(), { displayMode: true, throwOnError: false }); }
        catch (e) { return match; }
      });
      result = result.replace(/\\\\\(([\s\S]*?)\\\\\)/g, (match, formula) => {
        try { return katex.renderToString(formula.trim(), { displayMode: false, throwOnError: false }); }
        catch (e) { return match; }
      });
    }
    return result;
  }

  // ========== 对话管理 ==========
  function newChat() {
    const newConv = createNewConversation();
    conversations.unshift(newConv);
    currentConversationId = newConv.id;
    saveConversations();
    renderHistoryList();
    renderMessages();
  }

  function updateConversationTitle(conv) {
    const firstUserMsg = conv.messages.find(m => m.role === 'user');
    if (firstUserMsg) {
      conv.title = firstUserMsg.content.substring(0, 20) + (firstUserMsg.content.length > 20 ? '...' : '');
    }
    saveConversations();
    renderHistoryList();
  }

  // ========== 清理回答 ==========
  function cleanReply(text) {
    if (!text) return '';
    let r = text;
    r = filterThinkTags(r);
    r = r.replace(/<[^>]*>/g, '');
    r = r.replace(/\n{3,}/g, '\n\n').trim();
    r = r.replace(/^[\s\n]*/, '');
    return r;
  }

  // ========== OOC 检测 + 自动修正 ==========
  async function autoFixOOC(originalReply, mode, maxRetries = 2) {
    let currentReply = originalReply;

    // 工具调用结果跳过 OOC（避免误判）
    const toolCallIndicators = [
      '已打开', '已输入', '已执行', '已保存', '已关闭', '已点击',
      '已粘贴', '已按下', '已复制', '已启动', '已停止',
      '正在打开', '正在执行', '正在输入', '正在搜索',
      '操作成功', '执行成功',
      '已写入文件', '已删除', '已创建',
    ];

    const replyLower = (originalReply || '').toLowerCase();
    const isToolResult = toolCallIndicators.some(indicator =>
      replyLower.includes(indicator.toLowerCase())
    );

    if (isToolResult) {
      console.log('[OOC] 检测到工具调用结果，跳过 OOC 检测');
      return { reply: originalReply, score: 10, fixed: false, skipped: true };
    }

    let attempts = 0;
    let lastScore = 0;

    while (attempts <= maxRetries) {
      attempts++;

      try {
        const oocResponse = await fetch(`${AI_SERVICE_URL}/ooc-check`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reply: currentReply, mode: mode })
        });

        if (!oocResponse.ok) {
          console.warn('[OOC] 检测失败，使用原回答');
          return { reply: currentReply, score: 10, fixed: false };
        }

        const oocData = await oocResponse.json();
        lastScore = oocData.score || 10;
        console.log(`[OOC] 第${attempts}次检查 | ${mode} | 评分: ${lastScore}/10`);

        if (lastScore >= 6) {
          return { reply: currentReply, score: lastScore, fixed: attempts > 1 };
        }

        if (attempts <= maxRetries) {
          console.log(`[OOC] 评分过低 (${lastScore})，正在重新生成...`);
          const problem = oocData.problem || '回答不符合当前角色设定';

          const conv = getCurrentConversation();
          const sharedMemoryText = getAllSharedMemoryText();
          const userMessages = conv.messages.filter(m => m.role === 'user');
          const userQuery = userMessages.length ? userMessages[userMessages.length - 1].content : '';

          const fixText = `用户刚才的问题是：${userQuery}\n\n你刚才的回答存在角色偏离问题：${problem}。请重新回答用户的问题，确保回答严格符合当前角色设定。直接给出修正后的回答，不要解释。`;

          const fixResponse = await fetch(`${AI_SERVICE_URL}/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              query: fixText,
              mode: mode,
              history: [],
              shared_memory: sharedMemoryText
            })
          });

          if (fixResponse.ok) {
            const reader = fixResponse.body.getReader();
            const decoder = new TextDecoder();
            let fullFixAnswer = '';

            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              const chunk = decoder.decode(value, { stream: true });
              const lines = chunk.split('\n');
              for (const line of lines) {
                if (line.startsWith('data: ')) {
                  try {
                    const data = JSON.parse(line.substring(6));
                    if (data.answer) {
                      fullFixAnswer += data.answer;
                    }
                  } catch (e) { }
                }
              }
            }

            const fixed = cleanReply(fullFixAnswer);
            if (fixed && fixed.length > 5) {
              currentReply = fixed;
              console.log('[OOC] 修正成功，新回答长度:', fixed.length);
            } else {
              console.warn('[OOC] 修正返回内容太短，保留原回答');
            }
          }
        }
      } catch (e) {
        console.warn('[OOC] 检测异常:', e.message);
        return { reply: currentReply, score: 10, fixed: false };
      }
    }

    return { reply: currentReply, score: lastScore, fixed: true, exhausted: true };
  }

  // ========== 发送消息（流式） ==========
  async function sendMessage() {
    const text = userInput.value.trim();
    if (!text) return;
    if (!configData || !configData.deepseek_api_key || configData.deepseek_api_key === 'sk-把你的DeepSeekAPIKey填在这里') {
      alert('请先在 config.json 中配置 DeepSeek API Key');
      return;
    }

    const conv = getCurrentConversation();
    
    // 1. 添加用户消息到数据 + DOM（增量追加，不清空）
    conv.messages.push({ role: 'user', content: text });
    userInput.value = '';
    appendMessageToDOM('user', text);
    updateConversationTitle(conv);

    // 2. 添加助理占位消息到数据 + DOM
    conv.messages.push({ role: 'assistant', content: '', typing: true });
    appendMessageToDOM('assistant', '', true);
    saveConversations();

    const sharedMemoryText = getAllSharedMemoryText();

    // 构造历史消息（传给 AI 服务用于上下文）
    const historyMessages = [];
    for (const msg of conv.messages) {
      if (msg.role === 'assistant' && msg.typing) continue;  // 跳过正在打的
      if (msg.role === 'user' && msg.content === text) continue;  // 当前消息单独传
      if (msg.role === 'user' || msg.role === 'assistant') {
        if (msg.content) {
          historyMessages.push({ role: msg.role, content: msg.content });
        }
      }
    }

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 90000);

      const response = await fetch(`${AI_SERVICE_URL}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: text,
          mode: currentMode,
          history: historyMessages,
          shared_memory: sharedMemoryText
        }),
        signal: controller.signal
      });
      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`HTTP ${response.status}: ${errorText}`);
      }

      // 3. 流式读取
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let fullAnswer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split('\n');
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const dataStr = line.substring(6);
            if (dataStr === '[DONE]') continue;
            try {
              const data = JSON.parse(dataStr);
              if (data.answer) {
                fullAnswer += data.answer;
                let displayText = filterThinkTags(fullAnswer);
                updateLastAssistantMessage(displayText, false);
              }
              if (data.error) {
                console.error('[AI] 服务返回错误:', data.answer);
              }
            } catch (e) { }
          }
        }
      }
      
      let finalAnswer = cleanReply(fullAnswer);
      if (!finalAnswer.trim()) finalAnswer = '抱歉，我暂时无法回答。';

      // OOC 检测已在后端 ai_service.py 自动完成
      // 更新对话数组
      const lastMsg = conv.messages[conv.messages.length - 1];
      if (lastMsg && lastMsg.role === 'assistant') {
        lastMsg.content = finalAnswer;
        lastMsg.typing = false;
      }
      updateLastAssistantMessage(finalAnswer, false);
      saveConversations();

      // TTS 语音播报
      if (ttsSwitch.checked) {
        speakText(finalAnswer);
      }

    } catch (error) {
      console.error('请求失败：', error);
      let errMsg = '网络请求失败';
      if (error.name === 'AbortError') {
        errMsg = 'AI 服务响应超时（超过90秒），请重试';
      } else if (error.message.includes('Failed to fetch') || error.message.includes('ERR_CONNECTION_REFUSED')) {
        errMsg = '无法连接 AI 服务（127.0.0.1:18892），请确保 ai_service.py 已启动';
      } else if (error.message.includes('Internal Server Error') || error.message.includes('500')) {
        errMsg = 'AI 服务内部错误，请查看终端日志';
      } else {
        errMsg = 'AI 服务错误：' + error.message;
      }
      updateLastAssistantMessage(errMsg, false);
      const lastMsg = conv.messages[conv.messages.length - 1];
      if (lastMsg && lastMsg.role === 'assistant') {
        lastMsg.content = errMsg;
        lastMsg.typing = false;
      }
      saveConversations();
    }
  }

  // ========== TTS 语音播报 ==========
  async function speakText(text) {
    if (!text) return;
    try {
      const response = await fetch('http://127.0.0.1:18900/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: text, voice: null })
      });
      if (!response.ok) { console.warn('TTS 请求失败:', response.status); return; }
      const audioBlob = await response.blob();
      const audioUrl = URL.createObjectURL(audioBlob);
      const audio = new Audio(audioUrl);
      audio.onended = () => URL.revokeObjectURL(audioUrl);
      audio.play().catch(e => console.error('TTS 播放失败:', e));
    } catch (error) {
      console.warn('TTS 服务不可用:', error.message);
    }
  }

  // ========== 语音识别 ==========
  function initSpeechRecognition() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      alert('Browser speech recognition not supported, please use the latest release of Chrome or Edge');
      return null;
    }
    const recog = new SpeechRecognition();
    recog.lang = 'zh-CN';
    recog.interimResults = false;
    recog.continuous = false;
    return recog;
  }

  function startRecording() {
    if (!recognition) {
      recognition = initSpeechRecognition();
      if (!recognition) return;
      recognition.addEventListener('result', (event) => {
        userInput.value = event.results[0][0].transcript;
      });
      recognition.addEventListener('error', (event) => {
        console.error('语音识别错误:', event.error);
        stopRecording();
      });
      recognition.addEventListener('end', () => { stopRecording(); });
    }
    recognition.start();
    isRecording = true;
    micBtn.classList.add('recording');
    micBtn.textContent = '⏹️';
  }

  function stopRecording() {
    if (recognition) recognition.stop();
    isRecording = false;
    micBtn.classList.remove('recording');
    micBtn.textContent = '🎤';
  }

  function toggleRecording() {
    if (isRecording) stopRecording();
    else startRecording();
  }

  // ========== 绑定事件 ==========
  sendBtn.addEventListener('click', sendMessage);
  micBtn.addEventListener('click', toggleRecording);
  newChatBtn.addEventListener('click', newChat);
  userInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });
  modeToggleBtn.addEventListener('click', () => {
    const nextMode = currentMode === 'aemeath' ? 'physicist' : 'aemeath';
    switchMode(nextMode);
  });

  // ===== 启动 =====
  init();
});
