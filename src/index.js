import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { GoogleGenerativeAI } from '@google/generative-ai';
import Parser from 'rss-parser';

const app = new Hono();

// Enable CORS for API routes
app.use('/api/*', cors());

const parser = new Parser();

// Clean HTML tags from content
function cleanText(text) {
  if (!text) return '';
  return text.replace(/<[^>]*>/g, '').trim();
}

// Scrape Open Graph Image from article page
async function scrapeOgImage(url) {
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36'
      }
    });
    if (!response.ok) return null;
    const html = await response.text();
    const ogImageRegex = /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i;
    const ogImageRegexAlt = /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i;
    let match = html.match(ogImageRegex);
    if (!match) {
      match = html.match(ogImageRegexAlt);
    }
    return match ? match[1] : null;
  } catch (error) {
    console.error(`Failed to scrape image for ${url}:`, error.message);
    return null;
  }
}

// Resolve Google News article redirects using a quick DuckDuckGo HTML search
async function resolveUrlWithDDG(title) {
  try {
    const cleanedTitle = title.split(' - ')[0].trim();
    const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(cleanedTitle)}`;
    const response = await fetch(searchUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36'
      }
    });
    if (!response.ok) return null;
    const html = await response.text();
    const hrefRegex = /<a[^>]+class=["']result__url["'][^>]+href=["']([^"']+)["']/i;
    const hrefRegexAlt = /<a[^>]+href=["']([^"']+)["'][^>]+class=["']result__url["']/i;
    let match = html.match(hrefRegex);
    if (!match) match = html.match(hrefRegexAlt);
    if (!match) {
      const genericRegex = /<a[^>]+class=["']result__snippet["'][^>]+href=["']([^"']+)["']/i;
      match = html.match(genericRegex);
    }
    if (match && match[1]) {
      let resolvedUrl = match[1];
      if (resolvedUrl.startsWith('//')) {
        resolvedUrl = 'https:' + resolvedUrl;
      }
      if (resolvedUrl.includes('uddg=')) {
        const parts = resolvedUrl.split('uddg=');
        if (parts[1]) {
          resolvedUrl = decodeURIComponent(parts[1].split('&')[0]);
        }
      }
      return resolvedUrl;
    }
    return null;
  } catch (error) {
    console.error("DuckDuckGo link resolution error:", error.message);
    return null;
  }
}

// Scrape og:image helper wrapping Google News resolution
async function scrapeOgImageForPost(url, title) {
  let targetUrl = url;
  if (url.includes('news.google.com') && title) {
    const resolved = await resolveUrlWithDDG(title);
    if (resolved) {
      targetUrl = resolved;
    }
  }
  return await scrapeOgImage(targetUrl);
}

// Function to translate title and description using Gemini
async function translateWithGemini(apiKey, title, description) {
  if (!apiKey) {
    return {
      mizoTitle: `[Mock Translate] ${title}`,
      mizoSummary: `[Gemini API Key missing] ${description}`,
      mizoFullReport: `Chanchin thar chipchiar: ${description}`
    };
  }

  const ai = new GoogleGenerativeAI(apiKey);
  const prompt = `You are an expert sports journalist fluent in English and Mizo.
Based on the following Manchester United news headline and summary, perform two tasks:
1. Translate the headline and short summary into Mizo (concise, for feed display).
2. Write a detailed, paraphrased news report in Mizo (max 2000 characters) that expands on the details of the article, explaining them clearly to Mizo fans so they don't have to read the English article.

CRITICAL INSTRUCTIONS FOR FACTUAL ACCURACY:
- Do NOT invent or add external facts, rumors, or names (such as specific managers, players, or coaching staff) that are not mentioned in the provided headline or summary below.
- For example, do NOT write about Ruben Amorim, Michael Carrick, or any specific transfer target or coaching staff unless they are explicitly named in the headline or summary text.
- Keep the translation and the detailed report strictly faithful to the provided text. Any exaggeration or fabrication of facts is completely unacceptable.

Format the output as a valid JSON object with EXACTLY these three keys:
"mizoTitle": "Mizo translation of the headline",
"mizoSummary": "Mizo translation of the short summary",
"mizoFullReport": "Detailed Mizo paraphrased news report (max 2000 characters, formatted with newlines if needed, strictly based on the text below)"

Do not wrap the response in markdown blocks or backticks. Return raw JSON only.

Headline: ${title}
Summary: ${cleanText(description)}`;

  const model = ai.getGenerativeModel({ model: 'gemini-3.1-flash-lite' });
  const response = await model.generateContent(prompt);
  let text = response.response.text().trim();
  if (text.startsWith('```')) {
    text = text.replace(/^```json\s*/i, '').replace(/```$/, '').trim();
  }
  const translated = JSON.parse(text);
  return {
    mizoTitle: translated.mizoTitle || title,
    mizoSummary: translated.mizoSummary || description,
    mizoFullReport: translated.mizoFullReport || `Chanchin thar: ${description}`
  };
}

// Semantic de-duplication using Gemini
async function filterDuplicatePosts(apiKey, candidates, cachedPosts) {
  if (!apiKey || candidates.length === 0) {
    return candidates;
  }

  const candidateList = candidates.map((item, index) => {
    return `[${index}] Title: "${item.title}"\nDescription: "${cleanText(item.description)}"\nSource: "${item.source}"`;
  }).join('\n\n');

  const cachedList = cachedPosts.slice(0, 15).map((item) => {
    return `- "${item.title}"`;
  }).join('\n');

  const prompt = `You are an expert sports editor for a Manchester United news website.
We have just fetched a list of new candidate sports articles from RSS feeds:
${candidateList}

And here are the latest headlines we ALREADY have in our cache:
${cachedList || '(None)'}

Your tasks:
1. Identify stories that are about the exact same news event or topic (duplicates or highly similar stories).
2. For each duplicate group, choose the single most informative, latest, and accurate headline. For example, if one story says "negotiating for Player X" and another says "signing Player X finalized", choose the finalized/latest one.
3. If a candidate story is already covered in our cached headlines and adds no significant new updates, discard it.
4. Filter out any low-quality clickbait or contradictory rumors.

Return a JSON array containing ONLY the integer indices of the candidate articles we should keep. Return an empty array if all are duplicates or covered.
Format your response as a valid JSON array of numbers, for example: [0, 2, 5]
Do not wrap your response in markdown formatting or backticks. Return raw JSON only.`;

  const ai = new GoogleGenerativeAI(apiKey);
  const model = ai.getGenerativeModel({ model: 'gemini-3.1-flash-lite' });
  const response = await model.generateContent(prompt);
  let text = response.response.text().trim();
  if (text.startsWith('```')) {
    text = text.replace(/^```json\s*/i, '').replace(/```$/, '').trim();
  }
  const selectedIndices = JSON.parse(text);
  if (Array.isArray(selectedIndices)) {
    return candidates.filter((_, index) => selectedIndices.includes(index));
  }
  return candidates;
}

// Fetch and process feeds
async function fetchAndTranslateFeeds(env) {
  const apiKey = env.GEMINI_API_KEY;
  const feeds = [
    { name: 'Google News', url: 'https://news.google.com/rss/search?q=Manchester+United&hl=en-US&gl=US&ceid=US:en' },
    { name: 'Sky Sports', url: 'https://news.google.com/rss/search?q=Manchester+United+site:skysports.com&hl=en-US&gl=US&ceid=US:en' },
    { name: 'Manchester Evening News', url: 'https://www.manchestereveningnews.co.uk/all-about/manchester-united-fc?service=rss' },
    { name: 'United In Focus', url: 'https://www.unitedinfocus.com/news/feed' },
    { name: 'The Peoples Person', url: 'https://thepeoplesperson.com/feed/' },
    { name: 'Stretty News', url: 'https://strettynews.com/feed/' }
  ];

  let cachedPosts = [];
  try {
    const rawCache = await env.NEWS_KV.get('posts');
    if (rawCache) {
      cachedPosts = JSON.parse(rawCache);
    }
  } catch (err) {
    console.error("KV read error:", err);
  }

  const cachedLinks = new Set(cachedPosts.map(p => p.link));
  const rawCandidates = [];

  // Phase 1: Collect candidates from all feeds
  for (const feed of feeds) {
    try {
      const response = await fetch(feed.url);
      if (!response.ok) continue;
      const xml = await response.text();
      
      // Basic manual parse of RSS to avoid heavy XML parser dependencies in edge runtime
      const feedData = await parser.parseString(xml);
      const items = feedData.items.slice(0, 5);
      
      for (const item of items) {
        if (cachedLinks.has(item.link)) continue;
        if (rawCandidates.some(c => c.link === item.link)) continue;

        rawCandidates.push({
          title: item.title || '',
          description: cleanText(item.contentSnippet || item.content || item.description || ''),
          link: item.link,
          pubDate: item.pubDate || new Date().toISOString(),
          source: feed.name,
          rawItem: item
        });
      }
    } catch (error) {
      console.error(`Error parsing feed ${feed.name}:`, error.message);
    }
  }

  if (rawCandidates.length === 0) {
    return cachedPosts;
  }

  const filteredCandidates = await filterDuplicatePosts(apiKey, rawCandidates, cachedPosts);
  const newPosts = [];

  // Phase 2: Translate and scrape images for selected candidates
  for (const item of filteredCandidates) {
    try {
      // Find image enclosure or scrape page
      let image = null;
      if (item.rawItem.enclosure && item.rawItem.enclosure.url) {
        image = item.rawItem.enclosure.url;
      }
      if (!image) {
        image = await scrapeOgImageForPost(item.link, item.title);
      }

      const translation = await translateWithGemini(apiKey, item.title, item.description);

      // 4.5s delay to avoid Free tier 15 RPM limits
      if (apiKey) {
        await new Promise(r => setTimeout(r, 4500));
      }

      newPosts.push({
        title: item.title,
        description: item.description,
        mizoTitle: translation.mizoTitle,
        mizoSummary: translation.mizoSummary,
        mizoFullReport: translation.mizoFullReport,
        link: item.link,
        image,
        pubDate: item.pubDate,
        source: item.source,
        addedAt: new Date().toISOString()
      });
    } catch (err) {
      console.error(`Error processing candidate "${item.title}":`, err.message);
    }
  }

  if (newPosts.length > 0) {
    const updatedPosts = [...newPosts, ...cachedPosts];
    updatedPosts.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));
    const slicePosts = updatedPosts.slice(0, 50);
    await env.NEWS_KV.put('posts', JSON.stringify(slicePosts));
    return slicePosts;
  }

  return cachedPosts;
}

// API Routes
app.get('/api/news', async (c) => {
  const cached = await c.env.NEWS_KV.get('posts');
  if (cached) {
    return c.json(JSON.parse(cached));
  }
  // If cache is empty, trigger fetch in the background and return empty array immediately
  // to avoid HTTP request timeouts (which are limited to 30 seconds on Workers)
  c.executionCtx.waitUntil(fetchAndTranslateFeeds(c.env));
  return c.json([]);
});

app.get('/api/refresh', async (c) => {
  // Trigger background refresh to avoid HTTP timeout
  c.executionCtx.waitUntil(fetchAndTranslateFeeds(c.env));
  // Return the existing posts from KV immediately so the UI doesn't blank out
  const cached = await c.env.NEWS_KV.get('posts');
  const posts = cached ? JSON.parse(cached) : [];
  return c.json({ success: true, count: posts.length, posts });
});

// Cloudflare Workers entrypoint definition
export default {
  fetch: app.fetch,
  async scheduled(event, env, ctx) {
    ctx.waitUntil(fetchAndTranslateFeeds(env));
  }
};
