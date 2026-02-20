#!/usr/bin/env node
import 'dotenv/config';
/**
 * AI Trends Agent - 獨立 Discord Bot
 *
 * 24 小時內全球 AI 趨勢搜集器（以增速為核心指標）
 *
 * 篩選邏輯：
 * - GitHub: 24hr 內 stars 增速最快的項目
 * - Hacker News: 24hr 內 points/hour 最高的文章
 * - Reddit: 24hr 內 upvotes/hour 最高的討論
 * - arXiv: 24hr 內最新發布的論文
 * - Hugging Face: 7 天內 likes 增速最快
 * - Product Hunt: 當日 upvotes 最高
 */

import { Client, GatewayIntentBits, ChannelType, Events, Partials, EmbedBuilder } from 'discord.js';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { readFileSync, existsSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// 載入配置
function loadConfig() {
  const configPath = join(__dirname, 'config.json');
  if (existsSync(configPath)) {
    return JSON.parse(readFileSync(configPath, 'utf-8'));
  }
  return { timezone: 'Asia/Taipei', defaultChannelId: null };
}

const config = loadConfig();

// 推送時間配置 (台北時間)
const PUSH_SCHEDULE = [
  { hour: 8, minute: 0 },
  { hour: 20, minute: 0 }
];

// 初始化 Discord 客戶端
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel, Partials.Message, Partials.User],
});

const subscribers = new Map();
const pushedSlots = new Set();

// 訊息去重 (防止 Discord 事件重複觸發)
const processedMessages = new Set();
const DEDUP_TIMEOUT = 10000; // 10 秒內相同訊息不重複處理

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function get24hAgo() {
  return new Date(Date.now() - 24 * 60 * 60 * 1000);
}

// ==================== 數據來源 ====================

/**
 * GitHub Trending (使用 OSS Insight API + GitHub Search API)
 * 指標：24hr 內 stars 增速
 */
async function fetchGitHubTrending(limit = 8) {
  try {
    const results = [];

    // 方法 1: 使用 OSS Insight Trending API (TiDB 提供，穩定可靠)
    try {
      const trendingUrl = 'https://api.ossinsight.io/v1/trends/repos?period=past_24_hours';
      const trendingRes = await fetch(trendingUrl, {
        headers: { 'User-Agent': 'AI-Trends-Bot/1.0' }
      });

      if (trendingRes.ok) {
        const data = await trendingRes.json();
        const repos = data.data?.rows || [];

        // 過濾 AI 相關項目
        const aiRepos = repos.filter(r => {
          const desc = (r.description || '').toLowerCase();
          const name = (r.repo_name || '').toLowerCase();
          return desc.match(/\b(ai|llm|gpt|claude|machine learning|deep learning|neural|transformer|language model|chatbot|agent)\b/) ||
                 name.match(/\b(ai|llm|gpt|claude|agent)\b/);
        }).slice(0, limit);

        for (const repo of aiRepos) {
          results.push({
            name: repo.repo_name,
            description: repo.description?.substring(0, 120) || '無描述',
            stars: parseInt(repo.stars) || 0,
            starsToday: parseInt(repo.stars) || 0, // OSS Insight 數據為 24hr 趨勢
            url: `https://github.com/${repo.repo_name}`,
            language: repo.primary_language || '未知',
            isHot: parseInt(repo.stars) > 500
          });
        }
      }
    } catch (e) {
      console.error('[OSS Insight API] Error:', e.message);
    }

    // 方法 2: 搜尋熱門 AI 項目 (GitHub Search API)
    if (results.length < limit) {
      const queries = [
        'topic:llm stars:>1000',
        'topic:ai stars:>500 pushed:>2026-02-01',
        '(AI OR LLM OR GPT OR Claude) stars:>100'
      ];

      for (const q of queries) {
        if (results.length >= limit) break;

        const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=5`;
        const response = await fetch(url, {
          headers: { 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'AI-Trends-Bot' }
        });

        if (response.ok) {
          const data = await response.json();
          for (const repo of (data.items || [])) {
            if (!results.find(r => r.name === repo.full_name)) {
              results.push({
                name: repo.full_name,
                description: repo.description?.substring(0, 120) || '無描述',
                stars: repo.stargazers_count,
                starsToday: Math.round(repo.stargazers_count / 30), // 估算每日增量
                url: repo.html_url,
                language: repo.language || '未知',
                isHot: repo.stargazers_count > 10000
              });
            }
          }
        }
        await sleep(300);
      }
    }

    // 按今日 stars 增量排序
    return results
      .sort((a, b) => (b.starsToday || 0) - (a.starsToday || 0))
      .slice(0, limit);

  } catch (error) {
    console.error('[GitHub] Error:', error.message);
    return [];
  }
}

/**
 * Hacker News (48hr 內發布，按 points/hour 熱度排序)
 * 指標：points per hour (熱度增速)
 */
async function fetchHackerNews(limit = 8) {
  try {
    // 使用 search_by_date 獲取最新高分文章，然後在本地過濾 AI 相關
    const timestamp48hAgo = Math.floor((Date.now() - 48 * 60 * 60 * 1000) / 1000);
    const numericFilter = encodeURIComponent(`created_at_i>${timestamp48hAgo},points>20`);
    const url = `https://hn.algolia.com/api/v1/search_by_date?tags=story&numericFilters=${numericFilter}&hitsPerPage=100`;

    console.log(`[HN] Fetching recent stories...`);
    const response = await fetch(url);
    if (!response.ok) {
      console.error(`[HN] HTTP error: ${response.status}`);
      return [];
    }

    const data = await response.json();
    const now = Date.now() / 1000;

    // AI 相關關鍵字過濾
    const aiKeywords = /\b(ai|llm|gpt|claude|openai|anthropic|gemini|llama|mistral|machine learning|deep learning|neural|transformer|chatbot|copilot|agent|rag|embedding)\b/i;

    const aiStories = (data.hits || [])
      .filter(item => {
        const text = `${item.title || ''} ${item.story_text || ''}`.toLowerCase();
        return aiKeywords.test(text);
      });

    console.log(`[HN] Got ${data.hits?.length || 0} total, ${aiStories.length} AI-related`);

    return aiStories
      .map(item => {
        const ageHours = Math.max(1, (now - item.created_at_i) / 3600);
        const pointsPerHour = item.points / ageHours;
        return {
          title: item.title,
          url: item.url || `https://news.ycombinator.com/item?id=${item.objectID}`,
          points: item.points,
          pointsPerHour: Math.round(pointsPerHour * 10) / 10,
          author: item.author,
          comments: item.num_comments,
          ageHours: Math.round(ageHours),
          isHot: pointsPerHour > 20
        };
      })
      .sort((a, b) => b.pointsPerHour - a.pointsPerHour)
      .slice(0, limit);

  } catch (error) {
    console.error('[HN] Error:', error.message);
    return [];
  }
}

/**
 * Reddit (24hr 內發布，按 upvotes/hour 熱度排序)
 * 指標：score per hour (熱度增速)
 */
async function fetchReddit(limit = 6) {
  try {
    const subreddits = ['MachineLearning', 'LocalLLaMA', 'artificial', 'ChatGPT', 'ClaudeAI'];
    const allPosts = [];
    const now = Date.now() / 1000;

    for (const sub of subreddits) {
      const url = `https://www.reddit.com/r/${sub}/hot.json?limit=15`;
      const response = await fetch(url, {
        headers: { 'User-Agent': 'AI-Trends-Bot/1.0' }
      });

      if (response.ok) {
        const data = await response.json();
        const posts = (data.data?.children || [])
          .filter(p => {
            const created = p.data.created_utc;
            return (now - created) < 86400; // 24hr 內
          })
          .map(p => {
            const ageHours = Math.max(1, (now - p.data.created_utc) / 3600);
            const scorePerHour = p.data.score / ageHours;
            return {
              title: p.data.title.substring(0, 100),
              url: `https://reddit.com${p.data.permalink}`,
              score: p.data.score,
              scorePerHour: Math.round(scorePerHour * 10) / 10,
              comments: p.data.num_comments,
              subreddit: p.data.subreddit,
              ageHours: Math.round(ageHours),
              isHot: scorePerHour > 50
            };
          });
        allPosts.push(...posts);
      }
      await sleep(200);
    }

    return allPosts
      .sort((a, b) => b.scorePerHour - a.scorePerHour)
      .slice(0, limit);

  } catch (error) {
    console.error('[Reddit] Error:', error.message);
    return [];
  }
}

/**
 * arXiv (24hr 內最新提交的 AI 論文)
 * 指標：最新提交時間
 */
async function fetchArxiv(limit = 5) {
  try {
    const categories = 'cat:cs.AI+OR+cat:cs.LG+OR+cat:cs.CL';
    const url = `http://export.arxiv.org/api/query?search_query=${categories}&sortBy=submittedDate&sortOrder=descending&max_results=20`;

    const response = await fetch(url);
    if (!response.ok) return [];

    const text = await response.text();
    const entries = text.match(/<entry>[\s\S]*?<\/entry>/g) || [];
    const papers = [];
    const now = new Date();

    for (const entry of entries) {
      const title = entry.match(/<title>([\s\S]*?)<\/title>/)?.[1]?.replace(/\s+/g, ' ').trim();
      const summary = entry.match(/<summary>([\s\S]*?)<\/summary>/)?.[1]?.replace(/\s+/g, ' ').trim();
      const link = entry.match(/<id>([\s\S]*?)<\/id>/)?.[1]?.trim();
      const published = entry.match(/<published>([\s\S]*?)<\/published>/)?.[1]?.trim();
      const authors = entry.match(/<name>([\s\S]*?)<\/name>/g)?.map(a =>
        a.match(/<name>([\s\S]*?)<\/name>/)?.[1]
      ).slice(0, 3).join(', ');

      if (title && link) {
        const pubDate = new Date(published);
        const hoursAgo = (now - pubDate) / (1000 * 60 * 60);

        if (hoursAgo <= 48) { // 48hr 內（arXiv 更新較慢）
          papers.push({
            title: title.substring(0, 100),
            summary: summary?.substring(0, 150) + '...',
            url: link,
            authors: authors || '未知',
            hoursAgo: Math.round(hoursAgo),
            isNew: hoursAgo <= 24
          });
        }
      }

      if (papers.length >= limit) break;
    }

    return papers;

  } catch (error) {
    console.error('[arXiv] Error:', error.message);
    return [];
  }
}

/**
 * Hugging Face (7 天內 likes 增速最快)
 * 指標：likes7d (過去 7 天新增 likes)
 */
async function fetchHuggingFace(limit = 5) {
  try {
    // 按 7 天內 likes 增量排序
    const modelsUrl = 'https://huggingface.co/api/models?sort=likes7d&direction=-1&limit=15&full=true';
    const spacesUrl = 'https://huggingface.co/api/spaces?sort=likes7d&direction=-1&limit=10';

    const [modelsRes, spacesRes] = await Promise.all([
      fetch(modelsUrl),
      fetch(spacesUrl)
    ]);

    const results = [];

    if (modelsRes.ok) {
      const models = await modelsRes.json();
      // 過濾 AI 相關模型
      const aiModels = models.filter(m => {
        const tags = m.tags || [];
        const id = (m.modelId || m.id || '').toLowerCase();
        return tags.some(t => ['text-generation', 'text2text-generation', 'conversational', 'image-to-text'].includes(t)) ||
               id.match(/llama|gpt|mistral|phi|qwen|gemma|claude/);
      });

      aiModels.slice(0, 4).forEach(m => {
        results.push({
          type: '🤖 Model',
          name: m.modelId || m.id,
          url: `https://huggingface.co/${m.modelId || m.id}`,
          likes: m.likes || 0,
          likes7d: m.likes7d || 0,
          downloads: m.downloads || 0,
          isHot: (m.likes7d || 0) > 100
        });
      });
    }

    if (spacesRes.ok) {
      const spaces = await spacesRes.json();
      spaces.slice(0, 3).forEach(s => {
        results.push({
          type: '🚀 Space',
          name: s.id,
          url: `https://huggingface.co/spaces/${s.id}`,
          likes: s.likes || 0,
          likes7d: s.likes7d || 0,
          downloads: null,
          isHot: (s.likes7d || 0) > 50
        });
      });
    }

    return results
      .sort((a, b) => (b.likes7d || 0) - (a.likes7d || 0))
      .slice(0, limit);

  } catch (error) {
    console.error('[HuggingFace] Error:', error.message);
    return [];
  }
}

/**
 * Product Hunt (當日 AI 產品，按 upvotes 排序)
 * 指標：當日 upvotes
 */
async function fetchProductHunt(limit = 4) {
  try {
    // 嘗試多個來源
    const sources = [
      'https://www.producthunt.com/feed?category=artificial-intelligence',
      'https://www.producthunt.com/topics/artificial-intelligence/feed'
    ];

    for (const feedUrl of sources) {
      try {
        const response = await fetch(feedUrl, {
          headers: { 'User-Agent': 'AI-Trends-Bot/1.0' }
        });

        if (response.ok) {
          const text = await response.text();
          const items = text.match(/<item>[\s\S]*?<\/item>/g) || [];

          if (items.length > 0) {
            const now = new Date();
            return items.slice(0, limit).map(item => {
              const title = item.match(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>/)?.[1] ||
                            item.match(/<title>([\s\S]*?)<\/title>/)?.[1];
              const link = item.match(/<link>([\s\S]*?)<\/link>/)?.[1];
              const pubDate = item.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1];
              const desc = item.match(/<description><!\[CDATA\[([\s\S]*?)\]\]><\/description>/)?.[1] ||
                           item.match(/<description>([\s\S]*?)<\/description>/)?.[1];

              const pub = pubDate ? new Date(pubDate) : now;
              const hoursAgo = Math.round((now - pub) / (1000 * 60 * 60));

              return {
                title: title?.substring(0, 80) || '未知',
                description: desc?.replace(/<[^>]*>/g, '').substring(0, 100) || '',
                url: link || '',
                hoursAgo,
                isNew: hoursAgo <= 24
              };
            }).filter(p => p.url);
          }
        }
      } catch (e) {
        continue;
      }
    }

    return [];
  } catch (error) {
    console.error('[ProductHunt] Error:', error.message);
    return [];
  }
}

// ==================== 報告生成 ====================

async function generateTrendReport() {
  console.log('[AI Trends] Generating 24hr trend report (velocity-based)...');

  const now = new Date();
  const date = now.toLocaleDateString('zh-TW', {
    timeZone: config.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'long'
  });

  const time = now.toLocaleTimeString('zh-TW', {
    timeZone: config.timezone,
    hour: '2-digit',
    minute: '2-digit'
  });

  const [github, hackerNews, reddit, arxiv, huggingface, productHunt] = await Promise.all([
    fetchGitHubTrending(6),
    fetchHackerNews(6),
    fetchReddit(5),
    fetchArxiv(4),
    fetchHuggingFace(5),
    fetchProductHunt(3)
  ]);

  return { date, time, github, hackerNews, reddit, arxiv, huggingface, productHunt };
}

function createReportEmbeds(report) {
  const embeds = [];

  // 標題
  embeds.push(new EmbedBuilder()
    .setColor(0x00AE86)
    .setTitle('📰 AI 全球趨勢報告 (24hr 增速排行)')
    .setDescription(`📅 ${report.date} ${report.time}\n\n*以下依據「增速」排序，優先顯示成長最快的內容*`)
    .setTimestamp()
  );

  // GitHub (顯示今日 stars 增量)
  if (report.github.length > 0) {
    embeds.push(new EmbedBuilder()
      .setColor(0x24292e)
      .setTitle('⭐ GitHub 趨勢 (今日 Stars 增量)')
      .setDescription(
        report.github.map((repo, i) =>
          `**${i + 1}. [${repo.name}](${repo.url})**` +
          `${repo.isNew ? ' 🆕 新項目' : ''}${repo.isHot ? ' 🔥' : ''}\n` +
          `📈 **+${repo.starsToday || '?'} today** | ⭐ ${repo.stars.toLocaleString()} total | ${repo.language}\n` +
          `${repo.description}`
        ).join('\n\n')
      )
      .setFooter({ text: '排序依據：24hr 內 Stars 增量' })
    );
  }

  // Hacker News (顯示 points/hour)
  if (report.hackerNews.length > 0) {
    embeds.push(new EmbedBuilder()
      .setColor(0xFF6600)
      .setTitle('🔥 Hacker News (熱度增速)')
      .setDescription(
        report.hackerNews.map((item, i) =>
          `**${i + 1}. [${item.title}](${item.url})**${item.isHot ? ' 🔥' : ''}\n` +
          `📈 **${item.pointsPerHour} pts/hr** | 👍 ${item.points} | 💬 ${item.comments} | ${item.ageHours}h ago`
        ).join('\n\n')
      )
      .setFooter({ text: '排序依據：Points per Hour' })
    );
  }

  // Reddit (顯示 score/hour)
  if (report.reddit.length > 0) {
    embeds.push(new EmbedBuilder()
      .setColor(0xFF4500)
      .setTitle('💬 Reddit (熱度增速)')
      .setDescription(
        report.reddit.map((post, i) =>
          `**${i + 1}. [${post.title}](${post.url})**${post.isHot ? ' 🔥' : ''}\n` +
          `📈 **${post.scorePerHour} pts/hr** | ⬆️ ${post.score} | 💬 ${post.comments} | r/${post.subreddit}`
        ).join('\n\n')
      )
      .setFooter({ text: '排序依據：Score per Hour' })
    );
  }

  // arXiv (顯示發布時間)
  if (report.arxiv.length > 0) {
    embeds.push(new EmbedBuilder()
      .setColor(0xB31B1B)
      .setTitle('📄 arXiv 最新論文')
      .setDescription(
        report.arxiv.map((paper, i) =>
          `**${i + 1}. [${paper.title}](${paper.url})**${paper.isNew ? ' 🆕' : ''}\n` +
          `⏰ ${paper.hoursAgo}h ago | 👤 ${paper.authors}\n` +
          `${paper.summary}`
        ).join('\n\n')
      )
      .setFooter({ text: '排序依據：最新提交時間' })
    );
  }

  // Hugging Face (顯示 7 天 likes 增量)
  if (report.huggingface.length > 0) {
    embeds.push(new EmbedBuilder()
      .setColor(0xFFD21E)
      .setTitle('🤗 Hugging Face (7 天增速)')
      .setDescription(
        report.huggingface.map((item, i) =>
          `**${i + 1}. ${item.type} [${item.name}](${item.url})**${item.isHot ? ' 🔥' : ''}\n` +
          `📈 **+${item.likes7d || '?'} likes/7d** | ❤️ ${item.likes} total` +
          `${item.downloads ? ` | ⬇️ ${item.downloads.toLocaleString()}` : ''}`
        ).join('\n\n')
      )
      .setFooter({ text: '排序依據：7 天內 Likes 增量' })
    );
  }

  // Product Hunt
  if (report.productHunt.length > 0) {
    embeds.push(new EmbedBuilder()
      .setColor(0xDA552F)
      .setTitle('🚀 Product Hunt AI 新品')
      .setDescription(
        report.productHunt.map((p, i) =>
          `**${i + 1}. [${p.title}](${p.url})**${p.isNew ? ' 🆕' : ''}\n` +
          `⏰ ${p.hoursAgo}h ago${p.description ? `\n${p.description}` : ''}`
        ).join('\n\n')
      )
      .setFooter({ text: 'Product Hunt AI Category' })
    );
  }

  return embeds;
}

async function pushReport(target) {
  try {
    const report = await generateTrendReport();
    const embeds = createReportEmbeds(report);

    for (let i = 0; i < embeds.length; i += 10) {
      await target.send({ embeds: embeds.slice(i, i + 10) });
    }

    console.log(`[AI Trends] Report pushed to ${target.id}`);
    return true;
  } catch (error) {
    console.error(`[AI Trends] Push failed:`, error.message);
    return false;
  }
}

// ==================== 定時推送 ====================

async function checkScheduledPush() {
  const now = new Date();
  const taipeiTime = new Date(now.toLocaleString('en-US', { timeZone: config.timezone }));
  const hour = taipeiTime.getHours();
  const minute = taipeiTime.getMinutes();
  const dateStr = taipeiTime.toISOString().split('T')[0];

  for (const schedule of PUSH_SCHEDULE) {
    if (hour === schedule.hour && minute === schedule.minute) {
      const slotKey = `${dateStr}-${hour}`;
      if (pushedSlots.has(slotKey)) return;

      console.log(`[AI Trends] Scheduled push at ${hour}:${String(minute).padStart(2, '0')} (Taipei Time)`);
      pushedSlots.add(slotKey);

      if (pushedSlots.size > 10) {
        const arr = Array.from(pushedSlots);
        arr.slice(0, arr.length - 10).forEach(k => pushedSlots.delete(k));
      }

      for (const [userId, sub] of subscribers) {
        if (sub.enabled) {
          try {
            const user = await client.users.fetch(userId);
            await pushReport(user);
          } catch (e) {
            console.error(`[AI Trends] Failed to push to user ${userId}:`, e.message);
          }
        }
      }

      if (config.defaultChannelId) {
        try {
          const channel = await client.channels.fetch(config.defaultChannelId);
          if (channel) await pushReport(channel);
        } catch (e) {
          console.error(`[AI Trends] Failed to push to default channel:`, e.message);
        }
      }

      break;
    }
  }
}

// ==================== 訊息處理 ====================

async function handleMessage(message, content) {
  const isDM = message.channel.type === ChannelType.DM;
  console.log(`[${isDM ? 'DM' : 'Mention'}] ${message.author.username}: ${content}`);

  const cmd = content.toLowerCase().trim();

  if (cmd === '!help' || cmd === 'help' || cmd === '幫助') {
    await message.reply(`# 🤖 AI Trends Agent

**24 小時全球 AI 趨勢（以增速排序）**

📰 **資訊查詢**
• \`!news\` - 完整趨勢報告
• \`!github\` - GitHub 今日 Stars 增速
• \`!hn\` - Hacker News 熱度增速
• \`!reddit\` - Reddit 熱度增速
• \`!arxiv\` - arXiv 最新論文
• \`!hf\` - Hugging Face 7 天增速

📬 **訂閱**
• \`!subscribe\` / \`!unsubscribe\`

---
**排序邏輯：**
• GitHub: 24hr Stars 增量
• HN/Reddit: Points per Hour
• arXiv: 最新提交時間
• HuggingFace: 7 天 Likes 增量

**推送：** 每日 AM 8:00 / PM 8:00 (台北時間)`);
    return;
  }

  if (cmd === '!news' || cmd === '!today' || cmd === '報告' || cmd === '趨勢') {
    await message.channel.sendTyping();
    await message.reply('📊 正在搜集 24 小時 AI 趨勢（以增速排序）...');
    await pushReport(message.channel);
    return;
  }

  if (cmd === '!github') {
    await message.channel.sendTyping();
    const data = await fetchGitHubTrending(10);
    if (data.length === 0) {
      await message.reply('❌ 無法獲取 GitHub 數據');
      return;
    }
    const embed = new EmbedBuilder()
      .setColor(0x24292e)
      .setTitle('⭐ GitHub 24hr Stars 增速排行')
      .setDescription(data.map((r, i) =>
        `**${i + 1}. [${r.name}](${r.url})**${r.isNew ? ' 🆕' : ''}${r.isHot ? ' 🔥' : ''}\n` +
        `📈 **+${r.starsToday || '?'} today** | ⭐ ${r.stars.toLocaleString()} | ${r.language}\n${r.description}`
      ).join('\n\n'))
      .setTimestamp();
    await message.reply({ embeds: [embed] });
    return;
  }

  if (cmd === '!hn' || cmd === '!hackernews') {
    await message.channel.sendTyping();
    const data = await fetchHackerNews(10);
    if (data.length === 0) {
      await message.reply('❌ 無法獲取 Hacker News 數據');
      return;
    }
    const embed = new EmbedBuilder()
      .setColor(0xFF6600)
      .setTitle('🔥 Hacker News 熱度增速排行')
      .setDescription(data.map((item, i) =>
        `**${i + 1}. [${item.title}](${item.url})**${item.isHot ? ' 🔥' : ''}\n` +
        `📈 **${item.pointsPerHour} pts/hr** | 👍 ${item.points} | 💬 ${item.comments} | ${item.ageHours}h ago`
      ).join('\n\n'))
      .setTimestamp();
    await message.reply({ embeds: [embed] });
    return;
  }

  if (cmd === '!reddit') {
    await message.channel.sendTyping();
    const data = await fetchReddit(10);
    if (data.length === 0) {
      await message.reply('❌ 無法獲取 Reddit 數據');
      return;
    }
    const embed = new EmbedBuilder()
      .setColor(0xFF4500)
      .setTitle('💬 Reddit 熱度增速排行')
      .setDescription(data.map((p, i) =>
        `**${i + 1}. [${p.title}](${p.url})**${p.isHot ? ' 🔥' : ''}\n` +
        `📈 **${p.scorePerHour} pts/hr** | ⬆️ ${p.score} | 💬 ${p.comments} | r/${p.subreddit}`
      ).join('\n\n'))
      .setTimestamp();
    await message.reply({ embeds: [embed] });
    return;
  }

  if (cmd === '!arxiv' || cmd === '!paper') {
    await message.channel.sendTyping();
    const data = await fetchArxiv(8);
    if (data.length === 0) {
      await message.reply('❌ 無法獲取 arXiv 數據');
      return;
    }
    const embed = new EmbedBuilder()
      .setColor(0xB31B1B)
      .setTitle('📄 arXiv 最新 AI 論文')
      .setDescription(data.map((p, i) =>
        `**${i + 1}. [${p.title}](${p.url})**${p.isNew ? ' 🆕' : ''}\n` +
        `⏰ ${p.hoursAgo}h ago | 👤 ${p.authors}\n${p.summary}`
      ).join('\n\n'))
      .setTimestamp();
    await message.reply({ embeds: [embed] });
    return;
  }

  if (cmd === '!hf' || cmd === '!huggingface') {
    await message.channel.sendTyping();
    const data = await fetchHuggingFace(10);
    if (data.length === 0) {
      await message.reply('❌ 無法獲取 Hugging Face 數據');
      return;
    }
    const embed = new EmbedBuilder()
      .setColor(0xFFD21E)
      .setTitle('🤗 Hugging Face 7 天增速排行')
      .setDescription(data.map((item, i) =>
        `**${i + 1}. ${item.type} [${item.name}](${item.url})**${item.isHot ? ' 🔥' : ''}\n` +
        `📈 **+${item.likes7d || '?'} likes/7d** | ❤️ ${item.likes}${item.downloads ? ` | ⬇️ ${item.downloads.toLocaleString()}` : ''}`
      ).join('\n\n'))
      .setTimestamp();
    await message.reply({ embeds: [embed] });
    return;
  }

  if (cmd === '!subscribe' || cmd === '訂閱') {
    subscribers.set(message.author.id, { channelId: message.channel.id, enabled: true });
    await message.reply(`✅ 訂閱成功！每天 AM 8:00 / PM 8:00 推送 AI 趨勢報告。`);
    return;
  }

  if (cmd === '!unsubscribe' || cmd === '取消訂閱') {
    subscribers.delete(message.author.id);
    await message.reply('✅ 已取消訂閱。');
    return;
  }

  if (cmd === '!status' || cmd === '狀態') {
    const sub = subscribers.get(message.author.id);
    await message.reply(`**AI Trends Agent**\n\n訂閱：${sub?.enabled ? '🟢' : '⚪'}\n訂閱者：${subscribers.size}\n\n**排序邏輯：**\n• GitHub: 24hr Stars 增量\n• HN/Reddit: Points/Hour\n• arXiv: 最新提交\n• HF: 7 天 Likes 增量`);
    return;
  }

  await message.reply(`我是 **AI Trends Agent** 🤖\n\n追蹤 24hr AI 趨勢（以增速排序）\n\n\`!news\` 獲取報告 | \`!help\` 查看指令`);
}

// ==================== 事件監聽 ====================

client.on(Events.MessageCreate, async (message) => {
  // Debug: 記錄所有收到的訊息事件
  console.log(`[Event] MessageCreate: id=${message.id}, partial=${message.partial}, author=${message.author?.tag || 'unknown'}`);

  if (message.author.bot) return;

  // 訊息去重：使用 message.id 作為唯一識別
  const msgKey = message.id;
  if (processedMessages.has(msgKey)) {
    console.log(`[Debug] Skipping duplicate message: ${msgKey}`);
    return;
  }
  processedMessages.add(msgKey);
  setTimeout(() => processedMessages.delete(msgKey), DEDUP_TIMEOUT);

  const isDM = message.channel.type === ChannelType.DM;
  const isMention = message.mentions.has(client.user);

  console.log(`[Debug] Processing: id=${message.id}, isDM=${isDM}, isMention=${isMention}, content="${message.content}"`);

  if (isDM || isMention) {
    const content = message.content.replace(/<@!?\d+>/g, '').trim();
    await handleMessage(message, content);
  }
});

client.once(Events.ClientReady, () => {
  console.log(`[Bot] AI Trends Agent logged in as ${client.user.tag}`);
  console.log(`[Bot] Push schedule: AM 8:00 & PM 8:00 (Taipei Time)`);
  console.log('[Bot] Ranking by: Stars/day, Points/hour, Likes/7d');
  console.log('[Bot] Ready!');

  setInterval(checkScheduledPush, 60000);
});

client.on('error', console.error);
process.on('unhandledRejection', console.error);

process.on('SIGINT', () => {
  console.log('\n[Bot] Shutting down...');
  client.destroy();
  process.exit(0);
});

const token = process.env.AI_TRENDS_BOT_TOKEN;
if (!token) {
  console.error('[Bot] AI_TRENDS_BOT_TOKEN not set');
  process.exit(1);
}

console.log('[Bot] Starting AI Trends Agent...');
client.login(token);
