// AI Reply using OpenRouter Step 3.5 Flash (Free) with Web Search
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';
const MODEL = 'stepfun/step-3.5-flash:free';
const BRAVE_API_KEY = process.env.BRAVE_API_KEY || '';
const BRAVE_SEARCH_URL = 'https://api.search.brave.com/res/v1/web/search';

// Keywords that trigger web search
const SEARCH_KEYWORDS = ['天氣', '氣溫', '新聞', '股價', '匯率', '現在', '今天', '最新', '查詢', '搜尋', '幾點', '時間'];

function needsWebSearch(message) {
  return SEARCH_KEYWORDS.some(keyword => message.includes(keyword));
}

async function webSearch(query) {
  try {
    console.log(`[Search] Searching: ${query}`);
    const url = `${BRAVE_SEARCH_URL}?q=${encodeURIComponent(query)}&count=3`;
    const response = await fetch(url, {
      headers: {
        'Accept': 'application/json',
        'X-Subscription-Token': BRAVE_API_KEY,
      },
    });

    if (!response.ok) {
      console.error('Brave Search error:', response.status);
      return null;
    }

    const data = await response.json();
    const results = data.web?.results || [];

    if (results.length === 0) return null;

    // Format search results
    const formatted = results.map((r, i) =>
      `${i + 1}. ${r.title}\n   ${r.description}`
    ).join('\n\n');

    console.log(`[Search] Found ${results.length} results`);
    return formatted;
  } catch (error) {
    console.error('Web search error:', error.message);
    return null;
  }
}

export async function getAIReply(userMessage) {
  try {
    let searchContext = '';

    // Check if web search is needed
    if (needsWebSearch(userMessage)) {
      const searchResults = await webSearch(userMessage);
      if (searchResults) {
        searchContext = `\n\n[網路搜尋結果]\n${searchResults}\n\n請根據以上搜尋結果回答用戶問題。`;
      }
    }

    const systemPrompt = searchContext
      ? `你是一個友善的語音助手，可以查詢網路資訊。請用繁體中文簡短回覆，不要超過100字。${searchContext}`
      : '你是一個友善的語音助手。請用繁體中文簡短回覆，不要超過100字。';

    const response = await fetch(OPENROUTER_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
        'HTTP-Referer': 'https://discord-voice-bot.local',
        'X-Title': 'Discord Voice Bot',
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          {
            role: 'system',
            content: systemPrompt
          },
          {
            role: 'user',
            content: userMessage
          }
        ],
        max_tokens: 1000,
        temperature: 0.7,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('OpenRouter API error:', response.status, errorText);
      return null;
    }

    const data = await response.json();
    return data.choices?.[0]?.message?.content || null;
  } catch (error) {
    console.error('AI Reply error:', error.message);
    return null;
  }
}
