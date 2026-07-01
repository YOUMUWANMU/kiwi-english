// Cloudflare Worker · Kiwi English Platform API (v2 with auth)
// 部署方法：wrangler deploy
// 环境变量：ANTHROPIC_API_KEY（Secret）
//
// KV Schema:
//   account:{email}                 → { passwordHash, salt, children: [childId], createdAt }
//   child:{childId}                 → { name, avatar, pinHash, pinSalt, parentEmail, createdAt }
//   token:{tokenStr}                → { type: 'parent'|'child', id, expires }
//   progress:{childId}              → 累计统计数据（用于 dashboard 快速读取）
//   events:{childId}:{YYYY-MM-DD}   → 当天事件列表

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

const TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30; // 30天

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // 公开接口（不需要登录）
      if (path === '/api/auth/has-account' && request.method === 'GET') return handleHasAccount(env);
      if (path === '/api/auth/register-parent' && request.method === 'POST') return handleRegisterParent(request, env);
      if (path === '/api/auth/login-parent' && request.method === 'POST') return handleLoginParent(request, env);
      if (path === '/api/auth/list-children' && request.method === 'GET') return handleListChildren(env);
      if (path === '/api/auth/login-child' && request.method === 'POST') return handleLoginChild(request, env);

      // 需要登录的接口
      if (path === '/api/auth/me' && request.method === 'GET') return withAuth(request, env, handleMe);
      if (path === '/api/auth/logout' && request.method === 'POST') return withAuth(request, env, handleLogout);
      if (path === '/api/auth/add-child' && request.method === 'POST') return withAuth(request, env, handleAddChild, ['parent']);

      // 学习相关
      if (path === '/api/chat' && request.method === 'POST') return withAuth(request, env, handleChat);
      if (path === '/api/writing' && request.method === 'POST') return withAuth(request, env, handleWriting);
      if (path === '/api/event' && request.method === 'POST') return withAuth(request, env, handleEvent);
      if (path === '/api/stats' && request.method === 'GET') return withAuth(request, env, handleStats);
      if (path === '/api/settings' && request.method === 'GET') return withAuth(request, env, handleGetSettings);
      if (path === '/api/settings' && request.method === 'POST') return withAuth(request, env, handleSetSettings, ['parent']);
      if (path === '/api/settings/advance-stage' && request.method === 'POST') return withAuth(request, env, handleAdvanceStage, ['parent']);
      if (path === '/api/stage-gate' && request.method === 'GET') return withAuth(request, env, handleStageGate);
      if (path === '/api/stage-test' && request.method === 'POST') return withAuth(request, env, handleStageTest, ['child']);
      if (path === '/api/book-log' && request.method === 'GET') return withAuth(request, env, handleGetBookLog);
      if (path === '/api/book-log' && request.method === 'POST') return withAuth(request, env, handleAddBookLog, ['parent']);
      if (path === '/api/book-log' && request.method === 'DELETE') return withAuth(request, env, handleDeleteBookLog, ['parent']);
      if (path === '/api/book-quiz/generate' && request.method === 'POST') return withAuth(request, env, handleBookQuizGenerate, ['child']);
      if (path === '/api/book-quiz/get' && request.method === 'GET') return withAuth(request, env, handleBookQuizGet, ['child']);
      if (path === '/api/book-quiz/submit' && request.method === 'POST') return withAuth(request, env, handleBookQuizSubmit, ['child']);

      // 根路径
      if (path === '/') return new Response('Kiwi English API v2', { headers: { ...CORS, 'Content-Type': 'text/plain' } });

      return jsonResponse({ error: 'Not found' }, 404);
    } catch (e) {
      return jsonResponse({ error: e.message || 'Internal error' }, 500);
    }
  }
};

/* ========== 通用工具 ========== */

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

async function readJson(request) {
  try { return await request.json(); } catch { return {}; }
}

function bufferToHex(buf) {
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function randomHex(bytes) {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return bufferToHex(arr);
}

async function hashPassword(password, salt) {
  const data = new TextEncoder().encode(salt + ':' + password);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return bufferToHex(hash);
}

async function verifyPassword(password, salt, hashHex) {
  const computed = await hashPassword(password, salt);
  return computed === hashHex;
}

function todayKey() {
  // 用UTC+12（NZ时区）来定义"今天"，避免家长在中国晚上看不到孩子白天的数据
  const now = new Date(Date.now() + 12 * 3600 * 1000);
  return now.toISOString().slice(0, 10);
}

function daysAgo(n) {
  const now = new Date(Date.now() + 12 * 3600 * 1000);
  now.setUTCDate(now.getUTCDate() - n);
  return now.toISOString().slice(0, 10);
}

/* ========== 认证中间件 ========== */

async function withAuth(request, env, handler, allowedTypes = ['parent', 'child']) {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return jsonResponse({ error: 'Unauthorized' }, 401);

  const sessionRaw = await env.KV.get(`token:${token}`);
  if (!sessionRaw) return jsonResponse({ error: 'Token expired or invalid' }, 401);

  const session = JSON.parse(sessionRaw);
  if (session.expires < Date.now()) {
    await env.KV.delete(`token:${token}`);
    return jsonResponse({ error: 'Token expired' }, 401);
  }
  if (!allowedTypes.includes(session.type)) {
    return jsonResponse({ error: 'Forbidden' }, 403);
  }

  return handler(request, env, session, token);
}

/* ========== 账号 / 注册 ========== */

async function handleHasAccount(env) {
  // 用一个flag表示家长账号是否已存在
  const flag = await env.KV.get('system:parent-account-email');
  return jsonResponse({ hasAccount: !!flag, parentEmail: flag || null });
}

async function handleRegisterParent(request, env) {
  const { email, password } = await readJson(request);
  if (!email || !password) return jsonResponse({ error: '邮箱和密码必填' }, 400);
  if (password.length < 6) return jsonResponse({ error: '密码至少6位' }, 400);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return jsonResponse({ error: '邮箱格式不正确' }, 400);

  const emailLower = email.toLowerCase().trim();
  const existing = await env.KV.get(`account:${emailLower}`);
  if (existing) return jsonResponse({ error: '该邮箱已注册' }, 400);

  const salt = randomHex(16);
  const passwordHash = await hashPassword(password, salt);
  const account = { email: emailLower, passwordHash, salt, children: [], createdAt: Date.now() };
  await env.KV.put(`account:${emailLower}`, JSON.stringify(account));
  await env.KV.put('system:parent-account-email', emailLower);

  const token = await issueToken(env, 'parent', emailLower);
  return jsonResponse({ ok: true, token, parentEmail: emailLower });
}

async function handleLoginParent(request, env) {
  const { email, password } = await readJson(request);
  if (!email || !password) return jsonResponse({ error: '邮箱和密码必填' }, 400);

  const emailLower = email.toLowerCase().trim();
  const accountRaw = await env.KV.get(`account:${emailLower}`);
  if (!accountRaw) return jsonResponse({ error: '邮箱或密码错误' }, 401);

  const account = JSON.parse(accountRaw);
  const ok = await verifyPassword(password, account.salt, account.passwordHash);
  if (!ok) return jsonResponse({ error: '邮箱或密码错误' }, 401);

  const token = await issueToken(env, 'parent', emailLower);
  return jsonResponse({ ok: true, token, parentEmail: emailLower });
}

async function issueToken(env, type, id) {
  const token = randomHex(24);
  const expires = Date.now() + TOKEN_TTL_SECONDS * 1000;
  await env.KV.put(`token:${token}`, JSON.stringify({ type, id, expires }), { expirationTtl: TOKEN_TTL_SECONDS });
  return token;
}

async function handleMe(request, env, session) {
  if (session.type === 'parent') {
    const accountRaw = await env.KV.get(`account:${session.id}`);
    if (!accountRaw) return jsonResponse({ error: 'Account missing' }, 401);
    const account = JSON.parse(accountRaw);
    const children = [];
    for (const cid of account.children) {
      const cRaw = await env.KV.get(`child:${cid}`);
      if (cRaw) {
        const c = JSON.parse(cRaw);
        children.push({ id: cid, name: c.name, avatar: c.avatar });
      }
    }
    return jsonResponse({ type: 'parent', email: session.id, children });
  } else {
    const cRaw = await env.KV.get(`child:${session.id}`);
    if (!cRaw) return jsonResponse({ error: 'Child missing' }, 401);
    const c = JSON.parse(cRaw);
    return jsonResponse({ type: 'child', id: session.id, name: c.name, avatar: c.avatar });
  }
}

async function handleLogout(request, env, session, token) {
  await env.KV.delete(`token:${token}`);
  return jsonResponse({ ok: true });
}

/* ========== 孩子管理 ========== */

async function handleAddChild(request, env, session) {
  const { name, avatar, pin } = await readJson(request);
  if (!name || !avatar || !pin) return jsonResponse({ error: '名字、头像、PIN都要填' }, 400);
  if (!/^\d{4}$/.test(pin)) return jsonResponse({ error: 'PIN必须是4位数字' }, 400);
  const nameTrim = String(name).trim();
  if (nameTrim.length === 0 || nameTrim.length > 20) return jsonResponse({ error: '名字长度1-20字' }, 400);

  const accountRaw = await env.KV.get(`account:${session.id}`);
  const account = JSON.parse(accountRaw);
  if (account.children.length >= 5) return jsonResponse({ error: '最多5个孩子' }, 400);

  const childId = randomHex(12);
  const pinSalt = randomHex(16);
  const pinHash = await hashPassword(pin, pinSalt);
  const child = { name: nameTrim, avatar, pinHash, pinSalt, parentEmail: session.id, createdAt: Date.now() };
  await env.KV.put(`child:${childId}`, JSON.stringify(child));

  account.children.push(childId);
  await env.KV.put(`account:${session.id}`, JSON.stringify(account));

  // 初始化空进度
  await env.KV.put(`progress:${childId}`, JSON.stringify(emptyProgress()));

  return jsonResponse({ ok: true, id: childId, name: nameTrim, avatar });
}

async function handleListChildren(env) {
  // 登录页用，返回所有孩子的非敏感信息（仅名字+头像+id）
  const flag = await env.KV.get('system:parent-account-email');
  if (!flag) return jsonResponse({ children: [], hasAccount: false });
  const accountRaw = await env.KV.get(`account:${flag}`);
  if (!accountRaw) return jsonResponse({ children: [], hasAccount: true });
  const account = JSON.parse(accountRaw);
  const children = [];
  for (const cid of account.children) {
    const cRaw = await env.KV.get(`child:${cid}`);
    if (cRaw) {
      const c = JSON.parse(cRaw);
      children.push({ id: cid, name: c.name, avatar: c.avatar });
    }
  }
  return jsonResponse({ children, hasAccount: true });
}

async function handleLoginChild(request, env) {
  const { id, pin } = await readJson(request);
  if (!id || !pin) return jsonResponse({ error: '请选择头像并输入PIN' }, 400);
  const cRaw = await env.KV.get(`child:${id}`);
  if (!cRaw) return jsonResponse({ error: 'PIN错误' }, 401);
  const c = JSON.parse(cRaw);
  const ok = await verifyPassword(pin, c.pinSalt, c.pinHash);
  if (!ok) return jsonResponse({ error: 'PIN错误' }, 401);

  const token = await issueToken(env, 'child', id);
  return jsonResponse({ ok: true, token, id, name: c.name, avatar: c.avatar });
}

/* ========== 学习事件 & 统计 ========== */

function emptyProgress() {
  return {
    listening: { sessions: 0, correct: 0, total: 0, scoreSum: 0 },
    speaking:  { sessions: 0, turns: 0, durationSec: 0 },
    writing:   { sessions: 0, scoreSum: 0, count: 0 },
    reading:   { sessions: 0, correct: 0, total: 0, scoreSum: 0 },
    streak: { current: 0, lastActiveDate: null, bestStreak: 0 },
    totalMinutes: 0,
    errorTypes: {},
    createdAt: Date.now(),
  };
}

async function handleEvent(request, env, session) {
  // 只允许孩子上报自己的事件
  if (session.type !== 'child') return jsonResponse({ error: '仅孩子账号可上报事件' }, 403);
  const childId = session.id;
  const event = await readJson(request);
  event.ts = Date.now();

  // 1. 写入当天events列表（保留7天历史）
  const dateKey = todayKey();
  const eventsKey = `events:${childId}:${dateKey}`;
  const existingRaw = await env.KV.get(eventsKey);
  const existing = existingRaw ? JSON.parse(existingRaw) : [];
  existing.push(event);
  await env.KV.put(eventsKey, JSON.stringify(existing), { expirationTtl: 60 * 60 * 24 * 35 }); // 35天过期

  // 2. 累加统计到progress
  const progressRaw = await env.KV.get(`progress:${childId}`);
  const progress = progressRaw ? JSON.parse(progressRaw) : emptyProgress();

  if (event.module === 'listening') {
    progress.listening.sessions += 1;
    if (typeof event.correct === 'number') progress.listening.correct += event.correct;
    if (typeof event.total === 'number') progress.listening.total += event.total;
    if (typeof event.score === 'number') progress.listening.scoreSum += event.score;
  } else if (event.module === 'speaking') {
    progress.speaking.sessions += 1;
    if (typeof event.turns === 'number') progress.speaking.turns += event.turns;
    if (typeof event.durationSec === 'number') progress.speaking.durationSec += event.durationSec;
  } else if (event.module === 'writing') {
    progress.writing.sessions += 1;
    progress.writing.count += 1;
    if (typeof event.score === 'number') progress.writing.scoreSum += event.score;
    // 写作错误聚合
    if (Array.isArray(event.errors)) {
      for (const err of event.errors) {
        const key = (err.original || '') + ' → ' + (err.corrected || '');
        if (key.trim() === '→') continue;
        progress.errorTypes[key] = (progress.errorTypes[key] || 0) + 1;
      }
    }
  } else if (event.module === 'reading') {
    if (!progress.reading) progress.reading = { sessions: 0, correct: 0, total: 0, scoreSum: 0 };
    progress.reading.sessions += 1;
    if (typeof event.correct === 'number') progress.reading.correct += event.correct;
    if (typeof event.total === 'number') progress.reading.total += event.total;
    if (typeof event.score === 'number') progress.reading.scoreSum += event.score;
  }
  if (typeof event.durationSec === 'number') {
    progress.totalMinutes += event.durationSec / 60;
  }

  // 更新连续打卡
  if (progress.streak.lastActiveDate !== dateKey) {
    const yesterday = daysAgo(1);
    if (progress.streak.lastActiveDate === yesterday) {
      progress.streak.current += 1;
    } else {
      progress.streak.current = 1;
    }
    progress.streak.lastActiveDate = dateKey;
    if (progress.streak.current > progress.streak.bestStreak) {
      progress.streak.bestStreak = progress.streak.current;
    }
  }

  await env.KV.put(`progress:${childId}`, JSON.stringify(progress));
  return jsonResponse({ ok: true });
}

async function handleStats(request, env, session) {
  const url = new URL(request.url);
  const childId = url.searchParams.get('child');
  if (!childId) return jsonResponse({ error: '需要child参数' }, 400);

  // 权限检查：家长只能查自己的孩子；孩子只能查自己
  if (session.type === 'parent') {
    const accountRaw = await env.KV.get(`account:${session.id}`);
    const account = JSON.parse(accountRaw);
    if (!account.children.includes(childId)) return jsonResponse({ error: '无权访问' }, 403);
  } else if (session.type === 'child') {
    if (session.id !== childId) return jsonResponse({ error: '无权访问' }, 403);
  }

  const cRaw = await env.KV.get(`child:${childId}`);
  if (!cRaw) return jsonResponse({ error: '孩子不存在' }, 404);
  const child = JSON.parse(cRaw);

  const progressRaw = await env.KV.get(`progress:${childId}`);
  const progress = progressRaw ? JSON.parse(progressRaw) : emptyProgress();

  // 7天趋势数据（每天聚合）
  const trend = [];
  for (let i = 6; i >= 0; i--) {
    const dateKey = daysAgo(i);
    const eRaw = await env.KV.get(`events:${childId}:${dateKey}`);
    const events = eRaw ? JSON.parse(eRaw) : [];
    let durationSec = 0, scoreSum = 0, scoreCount = 0, sessions = events.length;
    for (const ev of events) {
      if (typeof ev.durationSec === 'number') durationSec += ev.durationSec;
      if (typeof ev.score === 'number') { scoreSum += ev.score; scoreCount += 1; }
    }
    trend.push({
      date: dateKey,
      minutes: Math.round(durationSec / 60),
      avgScore: scoreCount > 0 ? Number((scoreSum / scoreCount).toFixed(1)) : null,
      sessions,
    });
  }

  // 高频错误（top 5）
  const topErrors = Object.entries(progress.errorTypes || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([k, v]) => ({ pattern: k, count: v }));

  return jsonResponse({
    child: { id: childId, name: child.name, avatar: child.avatar },
    progress,
    trend,
    topErrors,
    derived: {
      listeningAvg: progress.listening.sessions > 0 ? Number((progress.listening.scoreSum / progress.listening.sessions).toFixed(1)) : null,
      writingAvg:   progress.writing.count > 0 ? Number((progress.writing.scoreSum / progress.writing.count).toFixed(1)) : null,
      listeningAcc: progress.listening.total > 0 ? Number((progress.listening.correct / progress.listening.total * 100).toFixed(0)) : null,
    }
  });
}

/* ========== 训练设置（家长配置，孩子读取） ========== */

const DEFAULT_SETTINGS = {
  // AI 文本显示：'show' = 显示英文+中文，'audio_only' = 仅语音
  aiTextMode: 'show',
  // 孩子回复方式：'text' = 仅打字，'voice' = 仅语音
  replyMode: 'voice',
  // 当前阶段 1-8（家长根据测试结果设定，默认 1）
  currentStage: 1,
};

async function handleGetSettings(request, env, session) {
  const url = new URL(request.url);
  let childId = url.searchParams.get('child');

  // 孩子默认读自己的；家长必须带 child 参数
  if (session.type === 'child') {
    childId = session.id;
  } else if (session.type === 'parent') {
    if (!childId) return jsonResponse({ error: '需要child参数' }, 400);
    const accountRaw = await env.KV.get(`account:${session.id}`);
    const account = JSON.parse(accountRaw);
    if (!account.children.includes(childId)) return jsonResponse({ error: '无权访问' }, 403);
  }

  const raw = await env.KV.get(`settings:${childId}`);
  const settings = raw ? { ...DEFAULT_SETTINGS, ...JSON.parse(raw) } : { ...DEFAULT_SETTINGS };
  return jsonResponse({ childId, settings });
}

async function handleSetSettings(request, env, session) {
  const { childId, settings } = await readJson(request);
  if (!childId || !settings) return jsonResponse({ error: '参数缺失' }, 400);

  // 权限：仅家长可设
  const accountRaw = await env.KV.get(`account:${session.id}`);
  const account = JSON.parse(accountRaw);
  if (!account.children.includes(childId)) return jsonResponse({ error: '无权访问' }, 403);

  // 校验字段
  const clean = {};
  if (['show', 'audio_only'].includes(settings.aiTextMode)) {
    clean.aiTextMode = settings.aiTextMode;
  }
  if (['text', 'voice'].includes(settings.replyMode)) {
    clean.replyMode = settings.replyMode;
  }
  // currentStage 规则：
  //   - 首次设定（stageInitialized=false）可任选 1-8 作为起点（根据线下测试结果定起跑线）
  //   - 设过一次后只能通过 /api/settings/advance-stage 推进 +1，不能跳
  const existingRaw = await env.KV.get(`settings:${childId}`);
  const existing = existingRaw ? JSON.parse(existingRaw) : {};
  if (!existing.stageInitialized && Number.isInteger(settings.currentStage) && settings.currentStage >= 1 && settings.currentStage <= 8) {
    clean.currentStage = settings.currentStage;
    clean.stageInitialized = true;
    clean.stageEnteredAt = Date.now();
  }

  const merged = { ...DEFAULT_SETTINGS, ...existing, ...clean };
  await env.KV.put(`settings:${childId}`, JSON.stringify(merged));
  return jsonResponse({ ok: true, settings: merged });
}

/* ========== 通关 / 阶段推进 ========== */

const STAGE_GATES = [
  { id: 1,  gate: { listening: 24, speaking: 12, writing: 8,  reading: 12, minListeningAcc: 80, minWritingScore: 7 } },
  { id: 2,  gate: { listening: 32, speaking: 24, writing: 10, reading: 8,  minListeningAcc: 80, minWritingScore: 7 } },
  { id: 3,  gate: { listening: 28, speaking: 18, writing: 8,  reading: 6,  minListeningAcc: 82, minWritingScore: 7 } },
  { id: 4,  gate: { listening: 24, speaking: 20, writing: 8,  reading: 6,  minListeningAcc: 82, minWritingScore: 7 } },
  { id: 5,  gate: { listening: 32, speaking: 24, writing: 12, reading: 8,  minListeningAcc: 82, minWritingScore: 7 } },
  { id: 6,  gate: { listening: 28, speaking: 24, writing: 18, reading: 8,  minListeningAcc: 85, minWritingScore: 7.5 } },
  { id: 7,  gate: { listening: 28, speaking: 24, writing: 12, reading: 10, minListeningAcc: 85, minWritingScore: 7.5 } },
  { id: 8,  gate: { listening: 32, speaking: 24, writing: 10, reading: 8,  minListeningAcc: 85, minWritingScore: 8 } },
  { id: 9,  gate: { listening: 24, speaking: 24, writing: 12, reading: 8,  minListeningAcc: 85, minWritingScore: 8 } },
  { id: 10, gate: { listening: 32, speaking: 32, writing: 14, reading: 10, minListeningAcc: 88, minWritingScore: 8 } },
];

const MAX_REMEDIATION_COUNT = 2;

async function getChildSettingsAndProgress(env, childId) {
  const settingsRaw = await env.KV.get(`settings:${childId}`);
  const settings = settingsRaw ? { ...DEFAULT_SETTINGS, ...JSON.parse(settingsRaw) } : { ...DEFAULT_SETTINGS };
  const progressRaw = await env.KV.get(`progress:${childId}`);
  const progress = progressRaw ? JSON.parse(progressRaw) : emptyProgress();
  return { settings, progress };
}

function computeStageStatus(settings, progress) {
  const stageId = settings.currentStage || 1;
  const baseline = settings.stageBaseline || {};
  const stageGate = STAGE_GATES.find(s => s.id === stageId)?.gate || STAGE_GATES[0].gate;

  const inStage = {
    listening: progress.listening.sessions - (baseline.listening || 0),
    speaking:  progress.speaking.sessions  - (baseline.speaking  || 0),
    writing:   progress.writing.sessions   - (baseline.writing   || 0),
    reading:   (progress.reading?.sessions || 0) - (baseline.reading || 0),
  };
  const listeningAcc = progress.listening.total > 0
    ? (progress.listening.correct / progress.listening.total * 100)
    : null;
  const writingAvg = progress.writing.count > 0
    ? (progress.writing.scoreSum / progress.writing.count)
    : null;

  const checks = {
    listening:    { current: Math.max(0, inStage.listening), required: stageGate.listening, ok: inStage.listening >= stageGate.listening },
    speaking:     { current: Math.max(0, inStage.speaking),  required: stageGate.speaking,  ok: inStage.speaking  >= stageGate.speaking },
    writing:      { current: Math.max(0, inStage.writing),   required: stageGate.writing,   ok: inStage.writing   >= stageGate.writing },
    reading:      { current: Math.max(0, inStage.reading),   required: stageGate.reading,   ok: inStage.reading   >= stageGate.reading },
    listeningAcc: { current: listeningAcc, required: stageGate.minListeningAcc, ok: listeningAcc !== null && listeningAcc >= stageGate.minListeningAcc },
    writingScore: { current: writingAvg,   required: stageGate.minWritingScore, ok: writingAvg !== null && writingAvg >= stageGate.minWritingScore },
  };
  const volumeOk  = checks.listening.ok && checks.speaking.ok && checks.writing.ok && checks.reading.ok;
  const qualityOk = checks.listeningAcc.ok && checks.writingScore.ok;
  const canTakeTest = volumeOk && qualityOk;
  return { stageId, checks, volumeOk, qualityOk, canTakeTest };
}

async function handleStageGate(request, env, session) {
  const url = new URL(request.url);
  let childId = url.searchParams.get('child');
  if (session.type === 'child') childId = session.id;
  if (session.type === 'parent') {
    if (!childId) return jsonResponse({ error: '需要child参数' }, 400);
    const acc = JSON.parse(await env.KV.get(`account:${session.id}`));
    if (!acc.children.includes(childId)) return jsonResponse({ error: '无权访问' }, 403);
  }

  const { settings, progress } = await getChildSettingsAndProgress(env, childId);
  const status = computeStageStatus(settings, progress);

  // 最近一次通关测试结果
  const lastTestRaw = await env.KV.get(`stage-test:${childId}:${status.stageId}`);
  const lastTest = lastTestRaw ? JSON.parse(lastTestRaw) : null;

  // 补习记录
  const remRaw = await env.KV.get(`remediation:${childId}:${status.stageId}`);
  const remediation = remRaw ? JSON.parse(remRaw) : null;

  return jsonResponse({
    childId,
    ...status,
    lastTest,
    remediation,  // { count, weakAreas: [], currentWeakArea, lastFailedAt }
    needsParentHelp: !!(remediation && remediation.count >= MAX_REMEDIATION_COUNT && (!lastTest || !lastTest.passed)),
    canAdvance: !!(lastTest && lastTest.passed && !lastTest.advanced),
    isLastStage: status.stageId >= 10,
  });
}

async function handleStageTest(request, env, session) {
  const { answers, totalQuestions } = await readJson(request);
  if (!Array.isArray(answers) || answers.length === 0) return jsonResponse({ error: '答案缺失' }, 400);

  const childId = session.id;
  const { settings } = await getChildSettingsAndProgress(env, childId);
  const stageId = settings.currentStage || 1;
  if (stageId >= 10) return jsonResponse({ error: '已是最高阶段' }, 400);

  // 按模块统计正确率，用于找最弱项
  const areaStats = {
    listening: { correct: 0, total: 0 },
    reading:   { correct: 0, total: 0 },
    speaking:  { sum: 0, count: 0 },
    writing:   { sum: 0, count: 0 },
  };
  let passedCount = 0;
  for (const a of answers) {
    if (a.type === 'listening' || a.type === 'reading') {
      areaStats[a.type].total += 1;
      if (a.correct) { areaStats[a.type].correct += 1; passedCount += 1; }
    } else if (a.type === 'speaking' || a.type === 'writing') {
      if (typeof a.score === 'number') {
        areaStats[a.type].sum += a.score;
        areaStats[a.type].count += 1;
        if (a.score >= 6) passedCount += 1;
      }
    }
  }
  const total = totalQuestions || answers.length;
  const required = Math.ceil(total * 5 / 7);  // 5/7 ≈ 70%
  const passed = passedCount >= required;

  // 找最弱项（自适应补习）
  let weakArea = null;
  if (!passed) {
    const rates = {};
    if (areaStats.listening.total > 0) rates.listening = areaStats.listening.correct / areaStats.listening.total;
    if (areaStats.reading.total > 0)   rates.reading   = areaStats.reading.correct / areaStats.reading.total;
    if (areaStats.speaking.count > 0)  rates.speaking  = (areaStats.speaking.sum / areaStats.speaking.count) / 10;  // 归一化到 0-1
    if (areaStats.writing.count > 0)   rates.writing   = (areaStats.writing.sum / areaStats.writing.count) / 10;
    weakArea = Object.entries(rates).sort((a,b) => a[1]-b[1])[0]?.[0] || null;
  }

  // 补习记录
  let remediation = null;
  const remRaw = await env.KV.get(`remediation:${childId}:${stageId}`);
  const existingRem = remRaw ? JSON.parse(remRaw) : { count: 0, weakAreas: [] };
  if (!passed) {
    existingRem.count = (existingRem.count || 0) + 1;
    if (weakArea && !existingRem.weakAreas.includes(weakArea)) {
      existingRem.weakAreas.push(weakArea);
    }
    existingRem.lastFailedAt = Date.now();
    existingRem.currentWeakArea = weakArea;
    await env.KV.put(`remediation:${childId}:${stageId}`, JSON.stringify(existingRem));
    remediation = existingRem;
  } else if (existingRem.count > 0) {
    // 通过后清除补习记录
    await env.KV.delete(`remediation:${childId}:${stageId}`);
  }

  const result = {
    stageId, passedCount, total, required, passed,
    weakArea,
    remediationCount: existingRem.count || 0,
    needsParentHelp: !passed && (existingRem.count >= MAX_REMEDIATION_COUNT),
    submittedAt: Date.now(),
    advanced: false,
  };
  await env.KV.put(`stage-test:${childId}:${stageId}`, JSON.stringify(result));

  return jsonResponse({ ok: true, result, remediation });
}

async function handleAdvanceStage(request, env, session) {
  const { childId, confirm } = await readJson(request);
  if (!childId) return jsonResponse({ error: '需要childId' }, 400);
  const acc = JSON.parse(await env.KV.get(`account:${session.id}`));
  if (!acc.children.includes(childId)) return jsonResponse({ error: '无权访问' }, 403);

  const { settings, progress } = await getChildSettingsAndProgress(env, childId);
  const stageId = settings.currentStage || 1;
  if (stageId >= 10) return jsonResponse({ error: '已是最高阶段' }, 400);

  const testRaw = await env.KV.get(`stage-test:${childId}:${stageId}`);
  const test = testRaw ? JSON.parse(testRaw) : null;
  if (!test && !confirm) {
    return jsonResponse({ error: '孩子尚未参加通关测试' }, 400);
  }
  if (test && !test.passed && !confirm) {
    return jsonResponse({ error: '通关测试未通过' }, 400);
  }

  // 记录新阶段 baseline，使训练量从 0 重新开始算
  const newBaseline = {
    listening: progress.listening.sessions,
    speaking:  progress.speaking.sessions,
    writing:   progress.writing.sessions,
    reading:   (progress.reading?.sessions || 0),
  };
  const newSettings = {
    ...settings,
    currentStage: stageId + 1,
    stageBaseline: newBaseline,
    stageEnteredAt: Date.now(),
  };
  await env.KV.put(`settings:${childId}`, JSON.stringify(newSettings));

  if (test) {
    test.advanced = true;
    await env.KV.put(`stage-test:${childId}:${stageId}`, JSON.stringify(test));
  }

  // 升阶后清掉本阶段补习记录
  await env.KV.delete(`remediation:${childId}:${stageId}`);

  return jsonResponse({ ok: true, newStage: stageId + 1 });
}

/* ========== /通关 ========== */

/* ========== 原版书打卡 ========== */

async function handleGetBookLog(request, env, session) {
  const url = new URL(request.url);
  let childId = url.searchParams.get('child');
  if (session.type === 'child') childId = session.id;
  if (session.type === 'parent') {
    if (!childId) return jsonResponse({ error: '需要child参数' }, 400);
    const acc = JSON.parse(await env.KV.get(`account:${session.id}`));
    if (!acc.children.includes(childId)) return jsonResponse({ error: '无权访问' }, 403);
  }
  const raw = await env.KV.get(`book-log:${childId}`);
  const books = raw ? JSON.parse(raw) : [];
  return jsonResponse({ books });
}

async function handleAddBookLog(request, env, session) {
  // body: { childId, title, author?, lexile?, countAsArticles?, kind? ('novel'|'article'|'journal') }
  const { childId, title, author, lexile, countAsArticles, kind } = await readJson(request);
  if (!childId || !title) return jsonResponse({ error: '需要 childId 和 title' }, 400);
  const acc = JSON.parse(await env.KV.get(`account:${session.id}`));
  if (!acc.children.includes(childId)) return jsonResponse({ error: '无权访问' }, 403);

  // 默认折算：小说 5 篇、短文 1 篇、journal 2 篇
  const defaultCount = kind === 'novel' ? 5 : (kind === 'journal' ? 2 : 1);
  const count = Math.max(1, Math.min(20, Number(countAsArticles) || defaultCount));

  const newBook = {
    id: 'b_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    title: String(title).trim().slice(0, 120),
    author: author ? String(author).trim().slice(0, 80) : '',
    lexile: lexile ? Number(lexile) : null,
    kind: kind || 'novel',
    countAsArticles: count,
    finishedAt: Date.now(),
  };

  // 追加到 book-log
  const raw = await env.KV.get(`book-log:${childId}`);
  const books = raw ? JSON.parse(raw) : [];
  books.unshift(newBook);
  await env.KV.put(`book-log:${childId}`, JSON.stringify(books));

  // 同步累加到 progress.reading.sessions
  const progressRaw = await env.KV.get(`progress:${childId}`);
  const progress = progressRaw ? JSON.parse(progressRaw) : emptyProgress();
  if (!progress.reading) progress.reading = { sessions: 0, correct: 0, total: 0, scoreSum: 0 };
  progress.reading.sessions += count;
  await env.KV.put(`progress:${childId}`, JSON.stringify(progress));

  return jsonResponse({ ok: true, book: newBook, totalReadingSessions: progress.reading.sessions });
}

async function handleDeleteBookLog(request, env, session) {
  // body: { childId, bookId }
  const { childId, bookId } = await readJson(request);
  if (!childId || !bookId) return jsonResponse({ error: '需要 childId 和 bookId' }, 400);
  const acc = JSON.parse(await env.KV.get(`account:${session.id}`));
  if (!acc.children.includes(childId)) return jsonResponse({ error: '无权访问' }, 403);

  const raw = await env.KV.get(`book-log:${childId}`);
  const books = raw ? JSON.parse(raw) : [];
  const idx = books.findIndex(b => b.id === bookId);
  if (idx < 0) return jsonResponse({ error: '记录不存在' }, 404);
  const removed = books.splice(idx, 1)[0];
  await env.KV.put(`book-log:${childId}`, JSON.stringify(books));

  // 同步减回 progress.reading.sessions（不低于 0）
  const progressRaw = await env.KV.get(`progress:${childId}`);
  if (progressRaw) {
    const progress = JSON.parse(progressRaw);
    if (progress.reading) {
      progress.reading.sessions = Math.max(0, progress.reading.sessions - (removed.countAsArticles || 0));
      await env.KV.put(`progress:${childId}`, JSON.stringify(progress));
    }
  }

  return jsonResponse({ ok: true });
}

/* ========== /原版书打卡 ========== */

/* ========== 读后测试（Claude API 现场出题 + 评分） ========== */

async function callClaudeJSON(env, system, userPrompt, maxTokens = 3500) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: userPrompt }],
    }),
  });
  if (!response.ok) {
    const t = await response.text();
    throw new Error('Claude API error: ' + t.slice(0, 200));
  }
  const data = await response.json();
  let text = data.content?.[0]?.text || '';
  // 剥 markdown 代码块
  text = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
  // 提取首个 [ 或 { 到末尾的 JSON
  const jsonStart = Math.min(
    text.indexOf('[') >= 0 ? text.indexOf('[') : Infinity,
    text.indexOf('{') >= 0 ? text.indexOf('{') : Infinity
  );
  if (jsonStart < Infinity) text = text.slice(jsonStart);
  return JSON.parse(text);
}

// 校验选择题：答案分布、选项长度
function validateChoiceQuestions(questions) {
  const choiceQs = questions.filter(q => q.type === 'choice');
  if (choiceQs.length === 0) return { ok: true };

  // 1. 答案分布：每个位置至少出现 1 次（8 题，理想各 2 次）
  const dist = [0, 0, 0, 0];
  for (const q of choiceQs) {
    if (typeof q.correct !== 'number' || q.correct < 0 || q.correct > 3) {
      return { ok: false, reason: '选择题 correct 字段非法' };
    }
    dist[q.correct]++;
  }
  const missing = dist.filter(c => c === 0).length;
  if (missing > 1) return { ok: false, reason: `答案分布不均：${dist.join('/')}` };
  // 任一位置占比超过 50%
  const maxRatio = Math.max(...dist) / choiceQs.length;
  if (maxRatio > 0.5) return { ok: false, reason: `答案过于集中：${dist.join('/')}` };

  // 2. 选项长度：每题正确答案不能明显比其他选项长
  for (let i = 0; i < choiceQs.length; i++) {
    const q = choiceQs[i];
    if (!Array.isArray(q.options) || q.options.length !== 4) {
      return { ok: false, reason: `第 ${i+1} 题选项数不为 4` };
    }
    const lens = q.options.map(o => String(o).length);
    const correctLen = lens[q.correct];
    const others = lens.filter((_, idx) => idx !== q.correct);
    const otherMax = Math.max(...others);
    // 正确答案不能比其他最长选项还长 50%
    if (correctLen > otherMax * 1.5 && correctLen > 30) {
      return { ok: false, reason: `第 ${i+1} 题正确选项明显过长（${correctLen} vs 其他最长 ${otherMax}）` };
    }
  }
  return { ok: true };
}

const QUIZ_GEN_SYSTEM = `You are an English reading-comprehension teacher creating quizzes for Chinese students learning English (preparing for NZ Year 9). Output strict JSON only.

GENERATION RULES (NON-NEGOTIABLE):

1) Mix exactly: 8 multiple-choice + 4 short-answer + 2 opinion + 1 vocabulary = 15 questions total.

2) MULTIPLE CHOICE QUALITY:
   - For the 8 choice questions, the correct-answer position must be distributed roughly evenly across A(0), B(1), C(2), D(3). Aim for ~2 of each. Never have more than 3 in any single position. Never have 0 in any position.
   - All 4 options for each question MUST be similar in length (within 30% character count of each other). Never make the correct answer noticeably longer or shorter than the distractors.
   - Distractors must be plausible — related to the book, not obviously silly.
   - Test understanding of plot, characters, themes, cause-and-effect. Not trivia.

3) SHORT ANSWER: ask for 2-3 sentence responses. Provide a sampleAnswer.

4) OPINION: ask for personal reaction in 3-5 sentences ("Which character do you most relate to and why?"). No sampleAnswer needed.

5) VOCABULARY: pick one important word from the book; ask its meaning in the book's context. Provide sampleAnswer.

6) ALL TEXT IN ENGLISH ONLY.

7) Difficulty matches the book's Lexile level and CEFR target.

OUTPUT FORMAT (JSON array, no prose, no markdown fences):
[
  {"type":"choice","q":"Question text","options":["A text","B text","C text","D text"],"correct":0},
  ...
  {"type":"short","q":"...","sampleAnswer":"..."},
  {"type":"opinion","q":"..."},
  {"type":"vocab","q":"What does the word \\"___\\" mean as used in the book?","sampleAnswer":"..."}
]`;

async function handleBookQuizGenerate(request, env, session) {
  const { bookId } = await readJson(request);
  if (!bookId) return jsonResponse({ error: '需要 bookId' }, 400);
  const childId = session.id;

  // 看缓存：同一本书已经生成过题就直接返回（节省 API 调用）
  const cacheKey = `book-quiz:${childId}:${bookId}`;
  const cached = await env.KV.get(cacheKey);
  if (cached) {
    const data = JSON.parse(cached);
    return jsonResponse({ ok: true, questions: stripAnswers(data.questions), cached: true });
  }

  // 找到这本书
  const logRaw = await env.KV.get(`book-log:${childId}`);
  const books = logRaw ? JSON.parse(logRaw) : [];
  const book = books.find(b => b.id === bookId);
  if (!book) return jsonResponse({ error: '书不存在' }, 404);

  // 生成 prompt
  const settingsRaw = await env.KV.get(`settings:${childId}`);
  const settings = settingsRaw ? JSON.parse(settingsRaw) : {};
  const stage = settings.currentStage || 1;
  const userPrompt = `Generate 15 quiz questions for this book:
Title: ${book.title}
Author: ${book.author || 'unknown'}
Lexile: ${book.lexile || 'unknown'}L
Student stage: Stage ${stage} (CEFR around ${stage <= 2 ? 'A2' : stage <= 5 ? 'B1' : 'B1+'})

Remember the rules:
- Even answer distribution across A/B/C/D
- Similar option length per question
- 8 choice + 4 short + 2 opinion + 1 vocab
- English only
Output JSON array only.`;

  // 调 Claude API，失败重试最多 2 次
  let questions = null;
  let lastError = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      questions = await callClaudeJSON(env, QUIZ_GEN_SYSTEM, userPrompt, 4000);
      if (!Array.isArray(questions) || questions.length !== 15) {
        lastError = `题目数不对：${questions?.length || 0}`;
        continue;
      }
      const v = validateChoiceQuestions(questions);
      if (v.ok) break;
      lastError = v.reason;
      questions = null;
    } catch (e) {
      lastError = e.message;
      questions = null;
    }
  }

  if (!questions) {
    return jsonResponse({ error: '出题失败：' + lastError }, 500);
  }

  // 保存到 KV
  const stored = {
    bookId,
    bookTitle: book.title,
    questions,
    generatedAt: Date.now(),
    attempts: [],
  };
  await env.KV.put(cacheKey, JSON.stringify(stored));

  return jsonResponse({ ok: true, questions: stripAnswers(questions), cached: false });
}

// 不把 correct/sampleAnswer 发给前端
function stripAnswers(questions) {
  return questions.map(q => {
    const safe = { type: q.type, q: q.q };
    if (q.options) safe.options = q.options;
    return safe;
  });
}

async function handleBookQuizGet(request, env, session) {
  const url = new URL(request.url);
  const bookId = url.searchParams.get('bookId');
  if (!bookId) return jsonResponse({ error: '需要 bookId' }, 400);
  const childId = session.id;

  const cacheKey = `book-quiz:${childId}:${bookId}`;
  const raw = await env.KV.get(cacheKey);
  if (!raw) return jsonResponse({ exists: false });
  const data = JSON.parse(raw);
  const lastAttempt = data.attempts?.[data.attempts.length - 1] || null;
  return jsonResponse({
    exists: true,
    bookTitle: data.bookTitle,
    questions: stripAnswers(data.questions),
    attemptCount: data.attempts?.length || 0,
    lastAttempt: lastAttempt ? { score: lastAttempt.score, total: lastAttempt.total, submittedAt: lastAttempt.submittedAt } : null,
  });
}

async function handleBookQuizSubmit(request, env, session) {
  const { bookId, answers } = await readJson(request);
  if (!bookId || !Array.isArray(answers)) return jsonResponse({ error: '需要 bookId 和 answers' }, 400);
  const childId = session.id;

  const cacheKey = `book-quiz:${childId}:${bookId}`;
  const raw = await env.KV.get(cacheKey);
  if (!raw) return jsonResponse({ error: '题目不存在，请先生成' }, 404);
  const data = JSON.parse(raw);
  const questions = data.questions;
  if (answers.length !== questions.length) {
    return jsonResponse({ error: `答案数不匹配（需要 ${questions.length}，提交了 ${answers.length}）` }, 400);
  }

  // 评分
  const results = [];
  let score = 0;
  const maxPerQ = 10;
  const total = questions.length * maxPerQ;

  // 先批改所有客观题（选择题）
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    const a = answers[i];
    if (q.type === 'choice') {
      const correct = a === q.correct;
      const s = correct ? maxPerQ : 0;
      results.push({ index: i, type: 'choice', score: s, correct, correctAnswer: q.correct });
      score += s;
    }
  }

  // 然后批量调用 Claude 评分所有主观题（合并到一次调用，省时省钱）
  const subjective = [];
  for (let i = 0; i < questions.length; i++) {
    if (questions[i].type !== 'choice') {
      subjective.push({ index: i, q: questions[i], a: answers[i] });
    }
  }
  if (subjective.length > 0) {
    const gradePrompt = `Grade these student answers for "${data.bookTitle}". Return strict JSON array of {index, score, feedback}.
Scoring (each item, 0-${maxPerQ}):
- 0-3: irrelevant, incoherent, empty, or copies the question
- 4-6: partially correct, shows minimal understanding
- 7-8: mostly correct, clear understanding
- 9-10: thorough, well-expressed, shows real engagement
For opinion questions: judge effort, clarity, and personal voice — not whether the opinion is "right".
For vocab questions: full marks if meaning is correct in context.
Feedback in English, one short sentence per item (be encouraging).

Items to grade:
${subjective.map(s => `[${s.index}] Type: ${s.q.type}
Question: ${s.q.q}
${s.q.sampleAnswer ? 'Reference answer (don\'t reveal to student): ' + s.q.sampleAnswer : ''}
Student answer: ${String(s.a || '').slice(0, 1000)}`).join('\n\n')}

Output:
[{"index": <number>, "score": <0-${maxPerQ}>, "feedback": "<English sentence>"}, ...]`;

    try {
      const graded = await callClaudeJSON(env, 'You are a fair, encouraging English teacher grading reading-comprehension answers. Output strict JSON only.', gradePrompt, 2500);
      if (Array.isArray(graded)) {
        for (const g of graded) {
          const q = questions[g.index];
          if (!q || q.type === 'choice') continue;
          const s = Math.max(0, Math.min(maxPerQ, Number(g.score) || 0));
          results.push({ index: g.index, type: q.type, score: s, feedback: g.feedback || '' });
          score += s;
        }
      }
    } catch (e) {
      // 评分失败：主观题给 5 分作为默认
      for (const s of subjective) {
        results.push({ index: s.index, type: s.q.type, score: 5, feedback: '自动评分暂时不可用，建议家长复阅。' });
        score += 5;
      }
    }
  }

  // 按 index 排序
  results.sort((a, b) => a.index - b.index);

  const attempt = {
    submittedAt: Date.now(),
    answers,
    results,
    score,
    total,
    percentage: Math.round(score / total * 100),
  };
  data.attempts = data.attempts || [];
  data.attempts.push(attempt);
  await env.KV.put(cacheKey, JSON.stringify(data));

  return jsonResponse({
    ok: true,
    score,
    total,
    percentage: attempt.percentage,
    results,
    // 把正确答案露出（含选择题正确选项 + 主观题 sampleAnswer 供孩子学习）
    answers: questions.map((q, i) => ({
      type: q.type,
      correctChoice: q.type === 'choice' ? q.correct : null,
      sampleAnswer: q.sampleAnswer || null,
    })),
  });
}

/* ========== /读后测试 ========== */

/* ========== 口语对话（接Claude） ========== */

async function handleChat(request, env, session) {
  const { system, messages, max_tokens = 200 } = await readJson(request);

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens,
      system,
      messages,
    }),
  });

  const data = await response.json();
  return jsonResponse(data);
}

/* ========== 写作批改 ========== */

async function handleWriting(request, env, session) {
  const { essay, prompt: writingPrompt, level = 1 } = await readJson(request);

  const system = `You are a patient English teacher helping a Chinese student (Year 9 level, learning English) improve their writing.
The student is preparing to study at a New Zealand secondary school.

Analyze their writing and provide feedback in the following JSON format ONLY, no other text:
{
  "score": <number 1-10>,
  "overall": "<one encouraging sentence in Chinese>",
  "corrections": [
    {
      "original": "<exact text with error>",
      "corrected": "<corrected version>",
      "explanation": "<brief Chinese explanation of why>",
      "type": "grammar|spelling|expression|punctuation"
    }
  ],
  "highlights": [
    "<something they did well, in Chinese>"
  ],
  "suggestion": "<one specific tip for improvement, in Chinese>",
  "improved_version": "<the full corrected version of their writing>"
}

Be encouraging and specific. For a level ${level} student, focus on the most important errors only (max 5 corrections).`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 1200,
      system,
      messages: [{
        role: 'user',
        content: `Writing prompt: "${writingPrompt}"\n\nStudent's writing:\n${essay}`
      }],
    }),
  });

  const data = await response.json();
  const text = data.content?.[0]?.text || '{}';
  let feedback;
  try {
    feedback = JSON.parse(text.replace(/```json\n?|\n?```/g, '').trim());
  } catch {
    feedback = { score: 7, overall: '写得不错！继续加油！', corrections: [], highlights: ['努力完成了写作练习'], suggestion: '继续练习，每天写一点点就会有进步！', improved_version: essay };
  }

  return jsonResponse(feedback);
}
