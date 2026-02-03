# AI Trends Agent

24 小時全球 AI 趨勢追蹤 Discord Bot，以「增速」為核心排序指標。

## 數據來源與排序邏輯

| 來源 | 排序指標 | 說明 |
|------|----------|------|
| **GitHub** | Stars/day | 24hr Stars 增量 |
| **Hacker News** | Points/hour | 熱度增速 |
| **Reddit** | Score/hour | 熱度增速 |
| **arXiv** | Time | 最新提交時間 |
| **Hugging Face** | Likes/7d | 7 天 Likes 增量 |
| **Product Hunt** | Time | 發布時間 |

## 指令

| 指令 | 說明 |
|------|------|
| `!news` | 完整趨勢報告 |
| `!github` | GitHub 24hr Stars 增速 |
| `!hn` | Hacker News 熱度增速 |
| `!reddit` | Reddit 熱度增速 |
| `!arxiv` | arXiv 最新論文 |
| `!hf` | Hugging Face 7 天增速 |
| `!subscribe` | 訂閱每日推送 |

## 執行

```bash
AI_TRENDS_BOT_TOKEN="your-token" node bot.js
```
