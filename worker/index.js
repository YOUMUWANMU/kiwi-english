// Cloudflare Worker · Kiwi English Platform API
// 部署方法：wrangler deploy
// 需要在Cloudflare Dashboard设置环境变量 ANTHROPIC_API_KEY

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    const url = new URL(request.url);

    // 口语对话 / 写作批改
    if (url.pathname === '/api/chat' && request.method === 'POST') {
      return handleChat(request, env);
    }

    // 写作批改专用
    if (url.pathname === '/api/writing' && request.method === 'POST') {
      return handleWriting(request, env);
    }

    // 学习进度存储
    if (url.pathname.startsWith('/api/progress')) {
      return handleProgress(request, env, url);
    }

    return new Response('Kiwi English API', { headers: { ...CORS, 'Content-Type': 'text/plain' } });
  }
};

async function handleChat(request, env) {
  try {
    const { system, messages, max_tokens = 150 } = await request.json();

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
    return new Response(JSON.stringify(data), {
      headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }
}

async function handleWriting(request, env) {
  try {
    const { essay, prompt: writingPrompt, level = 1 } = await request.json();

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
        max_tokens: 1000,
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

    return new Response(JSON.stringify(feedback), {
      headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }
}

async function handleProgress(request, env, url) {
  const userId = url.searchParams.get('uid') || 'default';
  const key = `progress:${userId}`;

  if (request.method === 'GET') {
    try {
      const data = await env.KV.get(key);
      return new Response(data || '{}', {
        headers: { ...CORS, 'Content-Type': 'application/json' },
      });
    } catch {
      return new Response('{}', { headers: { ...CORS, 'Content-Type': 'application/json' } });
    }
  }

  if (request.method === 'POST') {
    try {
      const body = await request.json();
      const existing = JSON.parse(await env.KV.get(key) || '{}');
      const merged = { ...existing, ...body, updatedAt: new Date().toISOString() };
      await env.KV.put(key, JSON.stringify(merged));
      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...CORS, 'Content-Type': 'application/json' },
      });
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), {
        status: 500,
        headers: { ...CORS, 'Content-Type': 'application/json' },
      });
    }
  }

  return new Response('Method not allowed', { status: 405, headers: CORS });
}
