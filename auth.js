// auth.js · Kiwi English 共享认证库
// 所有需要登录的页面在 <head> 顶部引入此脚本

window.KIWI = (function () {
  const TOKEN_KEY = 'kiwi:token';
  const USER_KEY = 'kiwi:user';

  // ⚠️ 部署后需要把这里填成你的 Worker URL，没填则走演示模式
  const WORKER_URL = 'https://kiwi-english-api.zh08243080.workers.dev';

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
    getToken, setToken, getUser, setUser, clearAuth, logout
  };
})();
