// ============================================================
// app.js - 聊天窗口核心逻辑
// 功能：双模态切换、共享记忆、流式对话、OOC自动修正、
//       TTS语音、语音输入、KaTeX公式渲染
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

  // AI 服务地址
  const AI_SERVICE_URL = 'http://127.0.0.1:18892';

  // ========== TTS 语音播报（通过 Electron 主进程请求，不占用浏览器连接池） ==========
  async function speakText(text) {
    if (!text) return;
    
    try {
      const appPath = await window.electronAPI.getAppPath();
      const projectRoot = appPath.substring(0, appPath.lastIndexOf('\\'));
      const voicePath = projectRoot + '\\voices\\aemeath.wav';

      console.log('[TTS] 通过主进程请求...');
      
      // 用 Electron IPC 请求 TTS（不走浏览器 fetch）
      const base64Audio = await window.electronAPI.ttsFetch(text, voicePath);
      
      console.log('[TTS] 收到音频，开始播放...');
      
      // base64 → Blob → 播放
      const binaryString = atob(base64Audio);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }
      const blob = new Blob([bytes], { type: 'audio/wav' });
      const audioUrl = URL.createObjectURL(blob);
      
      await new Promise((resolve) => {
        const audio = new Audio(audioUrl);
        audio.onended = () => { URL.revokeObjectURL(audioUrl); resolve(); };
        audio.onerror = () => { URL.revokeObjectURL(audioUrl); resolve(); };
        audio.play().catch(() => resolve());
      });
      
      console.log('[TTS] 播放完成');
      
    } catch (error) {
      console.warn('[TTS] 不可用:', error.message);
    }
  }

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
    // 启动 TTS 暖机（不阻塞）
    warmupTTS();
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
      deleteBtn.style.cssText = 'background: none; border: none; color: #888; font-size: 16px; cursor: pointer; padding: 0 4px; margin-left: 8px; border-radius: 4px; display: none; line-height: 1;';
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
      div.innerHTML = '<div class="typing-indicator"><span></span><span></span><span></span></div>';
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
      lastMsgDiv.innerHTML = '<div class="typing-indicator"><span></span><span></span><span></span></div>';
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

  // ========== 发送消息（流式） ==========
  async function sendMessage() {
    const text = userInput.value.trim();
    if (!text) return;
    if (!configData || !configData.deepseek_api_key || configData.deepseek_api_key === 'sk-把你的DeepSeekAPIKey填在这里') {
      alert('请先在 config.json 中配置 DeepSeek API Key');
      return;
    }

    const conv = getCurrentConversation();

    // 1. 添加用户消息到数据 + DOM
    conv.messages.push({ role: 'user', content: text });
    userInput.value = '';
    appendMessageToDOM('user', text);
    updateConversationTitle(conv);

    // 2. 添加助理占位消息到数据 + DOM
    conv.messages.push({ role: 'assistant', content: '', typing: true });
    appendMessageToDOM('assistant', '', true);
    
    // 【修复】先保存到 localStorage，供历史构建用
    // 注意助手消息还没回复，所以要排除占位消息
    saveConversations();


    const sharedMemoryText = getAllSharedMemoryText();

        // 3. 构造历史消息（不用 typing 判断，用内容长度）
    const historyMessages = [];
    for (const msg of conv.messages) {
      if (msg.role === 'user' && msg.content === text) continue;  // 跳过当前用户消息
      if ((msg.role === 'user' || msg.role === 'assistant') && msg.content && msg.content.length > 0) {
        historyMessages.push({ role: msg.role, content: msg.content });
      }
    }
    
    console.log('[Debug] history:', JSON.stringify(historyMessages));

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 90000);

      // === 关键：传 skip_tools！有历史时跳过工具模式 ===
      const skipTools = historyMessages.length > 0;

      // === 【调试】看看到底发了什么 ===
      console.log('[Send]', JSON.stringify({
        query: text,
        mode: currentMode,
        history: historyMessages,
        skip_tools: skipTools
      }));
      
      const response = await fetch(`${AI_SERVICE_URL}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: text,
          mode: currentMode,
          history: historyMessages,
          shared_memory: sharedMemoryText,
          skip_tools: skipTools
        }),
        signal: controller.signal
      });
      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`HTTP ${response.status}: ${errorText}`);
      }

      // 4. 流式读取
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
                // 【修复】同步更新 conv.messages 里的内容
                if (conv.messages.length > 0) {
                  const lastAssistant = conv.messages[conv.messages.length - 1];
                  if (lastAssistant.role === 'assistant') {
                    lastAssistant.content = fullAnswer;
                  }
                }
                updateLastAssistantMessage(filterThinkTags(fullAnswer), false);
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

      // 5. 更新对话数据
      const lastMsg = conv.messages[conv.messages.length - 1];
      if (lastMsg && lastMsg.role === 'assistant') {
        lastMsg.content = finalAnswer;
        lastMsg.typing = false;
      }
      updateLastAssistantMessage(finalAnswer, false);
      saveConversations();

      // 6. TTS 语音播报（只在开关打开时调用）
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
      } else if (error.message.includes('500')) {
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

  // ========== 语音识别 ==========
  function initSpeechRecognition() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      alert('Browser speech recognition not supported');
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
  // ========== TTS 暖机监测（后台自动检测，不影响使用） ==========
  let ttsWarmedUp = false;
  const ttsStatusEl = document.getElementById('tts-status');

  async function warmupTTS() {
    if (!ttsStatusEl) return;
    // 最多检查 2 分钟（24次 × 5秒）
    for (let i = 0; i < 24; i++) {
      try {
        const resp = await fetch('http://127.0.0.1:18900/health', {
          signal: AbortSignal.timeout(3000)
        });
        const data = await resp.json();
        if (data.engine_loaded === true) {
          ttsWarmedUp = true;
          ttsStatusEl.textContent = '✔';
          ttsStatusEl.style.color = '#34d399';
          ttsStatusEl.title = 'TTS 已就绪';
          console.log('[TTS] 暖机完成');
          return;
        }
      } catch (e) {
        // 服务还没起来，继续等
      }
      ttsStatusEl.textContent = '⟳';
      ttsStatusEl.title = 'TTS 加载中...';
      await new Promise(r => setTimeout(r, 5000));
    }
    // 超时
    ttsStatusEl.textContent = '!';
    ttsStatusEl.style.color = '#f87171';
    ttsStatusEl.title = 'TTS 服务未就绪';
    console.log('[TTS] 暖机超时');
  }

  // ===== 启动 =====
  init();
});
