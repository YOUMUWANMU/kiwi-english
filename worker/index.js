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
  { id: 1, gate: { listening: 24, speaking: 12, writing: 4,  reading: 6,  minListeningAcc: 80, minWritingScore: 7 } },
  { id: 2, gate: { listening: 32, speaking: 24, writing: 6,  reading: 8,  minListeningAcc: 80, minWritingScore: 7 } },
  { id: 3, gate: { listening: 48, speaking: 32, writing: 10, reading: 6,  minListeningAcc: 82, minWritingScore: 7 } },
  { id: 4, gate: { listening: 40, speaking: 40, writing: 10, reading: 1,  minListeningAcc: 82, minWritingScore: 7 } },
  { id: 5, gate: { listening: 32, speaking: 32, writing: 14, reading: 1,  minListeningAcc: 85, minWritingScore: 7.5 } },
  { id: 6, gate: { listening: 32, speaking: 32, writing: 10, reading: 1,  minListeningAcc: 85, minWritingScore: 7.5 } },
  { id: 7, gate: { listening: 48, speaking: 48, writing: 14, reading: 1,  minListeningAcc: 85, minWritingScore: 8 } },
  { id: 8, gate: { listening: 32, speaking: 32, writing: 8,  reading: 1,  minListeningAcc: 88, minWritingScore: 8 } },
];

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

  return jsonResponse({
    childId,
    ...status,
    lastTest,
    canAdvance: !!(lastTest && lastTest.passed && !lastTest.advanced),
    isLastStage: status.stageId >= 8,
  });
}

async function handleStageTest(request, env, session) {
  const { answers, totalQuestions } = await readJson(request);
  if (!Array.isArray(answers) || answers.length === 0) return jsonResponse({ error: '答案缺失' }, 400);

  const childId = session.id;
  const { settings } = await getChildSettingsAndProgress(env, childId);
  const stageId = settings.currentStage || 1;
  if (stageId >= 8) return jsonResponse({ error: '已是最高阶段' }, 400);

  let passedCount = 0;
  for (const a of answers) {
    if (a.type === 'listening' || a.type === 'reading') {
      if (a.correct) passedCount += 1;
    } else if (a.type === 'speaking' || a.type === 'writing') {
      if (typeof a.score === 'number' && a.score >= 6) passedCount += 1;
    }
  }
  const total = totalQuestions || answers.length;
  const required = Math.ceil(total * 5 / 7);  // 5/7 ≈ 70%
  const passed = passedCount >= required;

  const result = {
    stageId, passedCount, total, required, passed,
    submittedAt: Date.now(),
    advanced: false,
  };
  await env.KV.put(`stage-test:${childId}:${stageId}`, JSON.stringify(result));

  return jsonResponse({ ok: true, result });
}

async function handleAdvanceStage(request, env, session) {
  const { childId, confirm } = await readJson(request);
  if (!childId) return jsonResponse({ error: '需要childId' }, 400);
  const acc = JSON.parse(await env.KV.get(`account:${session.id}`));
  if (!acc.children.includes(childId)) return jsonResponse({ error: '无权访问' }, 403);

  const { settings, progress } = await getChildSettingsAndProgress(env, childId);
  const stageId = settings.currentStage || 1;
  if (stageId >= 8) return jsonResponse({ error: '已是最高阶段' }, 400);

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

  return jsonResponse({ ok: true, newStage: stageId + 1 });
}

/* ========== /通关 ========== */

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
