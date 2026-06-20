# 🥝 Kiwi English · 新西兰Year 9生存训练营

专为赴新西兰Year 9学习的中国学生设计的英语训练平台。

## 在线访问

部署后访问：`https://你的用户名.github.io/kiwi-english`

## 功能模块

| 模块 | 功能 | 技术 |
|------|------|------|
| 🎤 口语陪练 | AI扮演NZ同学/老师，6大场景对话 | Claude API + Web Speech |
| ✏️ 写作批改 | 4类写作题目，AI实时批改反馈 | Claude API |
| 🎧 NZ听力 | 新西兰口音适应训练 | 建设中 |
| 📚 学科英语 | 体育/科学/数学/音乐课词汇 | 建设中 |

## 部署步骤

### 第一步：GitHub Pages（前端）

```bash
# 1. Fork或克隆此仓库
git clone https://github.com/你的用户名/kiwi-english.git

# 2. 推送到main分支，GitHub Actions自动部署
git push origin main
```

在GitHub仓库设置里：Settings → Pages → Source → GitHub Actions

### 第二步：Cloudflare Worker（后端API）

```bash
# 安装wrangler
npm install -g wrangler

# 登录Cloudflare
wrangler login

# 创建KV命名空间
wrangler kv:namespace create KV
# 复制输出的id，填入worker/wrangler.toml

# 部署Worker
cd worker
wrangler deploy

# 设置API密钥（在Cloudflare Dashboard）
# Workers & Pages → kiwi-english-api → Settings → Variables
# 添加：ANTHROPIC_API_KEY = "sk-ant-..."
```

### 第三步：连接前后端

部署Worker后，复制Worker的URL（如 `https://kiwi-english-api.你的账号.workers.dev`），
然后在以下文件的顶部填入：

```javascript
// speaking.html 和 writing.html 顶部
const WORKER_URL = 'https://kiwi-english-api.你的账号.workers.dev';
```

## 项目结构

```
kiwi-english/
├── index.html          # 首页 + 导航
├── speaking.html       # 口语陪练（核心模块）
├── writing.html        # 写作批改
├── listening.html      # NZ听力训练（建设中）
├── subject.html        # 学科英语（建设中）
├── worker/
│   ├── index.js        # Cloudflare Worker代码
│   └── wrangler.toml   # Worker配置
├── .github/workflows/
│   └── deploy.yml      # 自动部署
└── PLAN.md             # 完整产品规划
```

## 口语练习场景

| 场景 | AI角色 | 训练重点 |
|------|--------|----------|
| 🍱 食堂点餐 | Liam（同学） | 礼貌请求、日常寒暄 |
| 📚 课堂求助 | Ms. Johnson（老师） | 听不懂时如何应对 |
| ⚽ 体育课 | Mr. Tane（毛利老师） | 运动指令词 |
| 👋 课间社交 | Aroha（同学） | 聊兴趣、交朋友 |
| 🔬 科学实验 | 实验搭档 | 实验操作英语 |
| 🗺️ 问路 | Gordon（保安） | 校园导航用语 |

## 技术说明

- 前端：纯HTML + CSS + 原生JS，无框架依赖
- 后端：Cloudflare Workers（无需服务器，免费额度充足）
- AI：Anthropic Claude API（claude-sonnet-4-6）
- 存储：Cloudflare KV（学习进度）
- 语音：Web Speech API（TTS朗读 + 语音识别）
- 部署：GitHub Pages（静态托管）

## 离线使用

基础功能（界面、快捷短语）可离线使用。AI对话功能需要网络连接。

---

Made with 🥝 for future Kiwi kids
