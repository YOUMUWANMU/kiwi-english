// auth.js · Kiwi English 共享认证库
// 所有需要登录的页面在 <head> 顶部引入此脚本

window.KIWI = (function () {
  const TOKEN_KEY = 'kiwi:token';
  const USER_KEY = 'kiwi:user';

  // ⚠️ 部署后需要把这里填成你的 Worker URL，没填则走演示模式
  const WORKER_URL = 'https://kiwi-english-api.zh08243080.workers.dev';

  // ====== TTS Voice 优先级选择 ======
  // 浏览器自带的 TTS 声音质量参差不齐。这里按"自然度"降序列出已知的优质 voice，
  // 强制优先挑选 Samantha / Siri / Microsoft Neural 这类接近真人的，避免随机选到机械音。
  // macOS / iOS 自带的系统级 voice 在 Chrome / Safari 都能调用到。
  const VOICE_PRIORITY = [
    // macOS / iOS Siri 系列（最新最自然）
    /^Siri/i,
    // macOS / iOS Premium / Enhanced 高清版（用户需下载）
    /^Samantha.*Premium/i,
    /^Ava.*Premium/i,
    /^Allison.*Premium/i,
    /^Susan.*Premium/i,
    /^Evan.*Premium/i,
    // macOS / iOS 默认高质量 voice
    /^Samantha/i,
    /^Ava/i,
    /^Allison/i,
    /^Susan/i,
    /^Evan/i,
    /^Karen/i,
    /^Alex$/i,
    /^Victoria/i,
    // Microsoft Edge 神经网络 voice（Windows / Edge）
    /Aria.*Online.*Natural/i,
    /Jenny.*Online.*Natural/i,
    /Guy.*Online.*Natural/i,
    /Davis.*Online.*Natural/i,
    // Google Chrome 自带
    /Google US English/i,
  ];

  let _cachedVoice = null;

  function pickBestEnVoice() {
    if (_cachedVoice) return _cachedVoice;
    if (!window.speechSynthesis) return null;
    const voices = window.speechSynthesis.getVoices();
    if (voices.length === 0) return null;  // Chrome 首次调用可能为空，需要等 voiceschanged

    // 按优先级匹配
    for (const pattern of VOICE_PRIORITY) {
      const v = voices.find(v => pattern.test(v.name) && v.lang.toLowerCase().startsWith('en'));
      if (v) { _cachedVoice = v; return v; }
    }
    // fallback：任何 en-US，再fallback到任何en-*
    _cachedVoice = voices.find(v => v.lang === 'en-US')
                || voices.find(v => v.lang.toLowerCase().startsWith('en'))
                || null;
    return _cachedVoice;
  }

  // 朗读英文文本（统一入口，所有页面用这个）
  function speak(text, opts = {}) {
    if (!window.speechSynthesis || !text) return;
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'en-US';
    u.rate = opts.rate ?? 0.92;
    u.pitch = opts.pitch ?? 1.0;
    const v = pickBestEnVoice();
    if (v) u.voice = v;
    window.speechSynthesis.speak(u);
    return u;
  }

  // 浏览器加载 voice 列表是异步的，监听一下刷新缓存
  if (window.speechSynthesis) {
    window.speechSynthesis.onvoiceschanged = () => {
      _cachedVoice = null;
      pickBestEnVoice();
    };
    // 立即触发一次
    setTimeout(pickBestEnVoice, 100);
  }
  // ====== /TTS ======

  function getToken() { return localStorage.getItem(TOKEN_KEY); }
  function setToken(t) { localStorage.setItem(TOKEN_KEY, t); }
  function clearAuth() { localStorage.removeItem(TOKEN_KEY); localStorage.removeItem(USER_KEY); }
  function getUser() { try { return JSON.parse(localStorage.getItem(USER_KEY) || 'null'); } catch { return null; } }
  function setUser(u) { localStorage.setItem(USER_KEY, JSON.stringify(u)); }

  async function api(path, options = {}) {
    if (!WORKER_URL) throw new Error('NO_WORKER_URL');
    const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
    const token = getToken();
    if (token) headers['Authorization'] = 'Bearer ' + token;

    const res = await fetch(WORKER_URL + path, { ...options, headers });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) {
      clearAuth();
      // 不直接强制跳转，由调用方决定
    }
    if (!res.ok) {
      const err = new Error(data.error || 'API错误');
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  // 要求当前页面必须登录，否则跳到 login.html
  // type 可选：'parent' | 'child' | 'any'
  async function requireAuth(type = 'any') {
    // 演示模式：没配 WORKER_URL，跳过认证（用于本地开发）
    if (!WORKER_URL) {
      return { type: 'child', id: 'demo', name: '演示模式', avatar: '🥝' };
    }
    const token = getToken();
    if (!token) {
      window.location.href = 'login.html';
      throw new Error('未登录');
    }
    try {
      const me = await api('/api/auth/me');
      if (type !== 'any' && me.type !== type) {
        window.location.href = me.type === 'parent' ? 'parent.html' : 'index.html';
        throw new Error('权限不符');
      }
      setUser(me);
      return me;
    } catch (e) {
      window.location.href = 'login.html';
      throw e;
    }
  }

  // 学习事件上报（孩子端用），失败时静默
  async function reportEvent(payload) {
    try {
      if (!WORKER_URL) return;
      const token = getToken();
      if (!token) return;
      await api('/api/event', { method: 'POST', body: JSON.stringify(payload) });
    } catch (e) {
      console.warn('上报事件失败（不影响使用）:', e.message);
    }
  }

  function logout() {
    if (!WORKER_URL) { clearAuth(); window.location.href = 'login.html'; return; }
    api('/api/auth/logout', { method: 'POST' }).catch(() => {}).finally(() => {
      clearAuth();
      window.location.href = 'login.html';
    });
  }

  return {
    WORKER_URL, api, requireAuth, reportEvent,
    getToken, setToken, getUser, setUser, clearAuth, logout,
    speak, pickBestEnVoice
  };
})();
