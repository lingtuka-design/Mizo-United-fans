const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const Parser = require('rss-parser');
const dotenv = require('dotenv');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// Load environment variables
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const parser = new Parser({
  customFields: {
    item: [
      ['media:content', 'mediaContent'],
      ['enclosure', 'enclosure']
    ]
  }
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Path to store our cached translations
const CACHE_FILE = path.join(__dirname, 'posts.json');

// Initialize Gemini API client if key is available
let ai = null;
if (process.env.GEMINI_API_KEY) {
  try {
    ai = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    console.log('Gemini API initialized successfully.');
  } catch (error) {
    console.error('Failed to initialize Gemini API:', error.message);
  }
} else {
  console.warn('WARNING: GEMINI_API_KEY is not set in .env. Using mock translations for now.');
}

// Helper to read cached posts
function readCache() {
  if (!fs.existsSync(CACHE_FILE)) {
    return [];
  }
  try {
    const data = fs.readFileSync(CACHE_FILE, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    console.error('Error reading cache file:', error);
    return [];
  }
}

// Helper to write cached posts
function writeCache(posts) {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(posts, null, 2), 'utf8');
  } catch (error) {
    console.error('Error writing cache file:', error);
  }
}

// Extract image from RSS item
function extractImage(item) {
  // 1. Check media:content
  if (item.mediaContent && item.mediaContent.$ && item.mediaContent.$.url) {
    return item.mediaContent.$.url;
  }
  // 2. Check enclosure
  if (item.enclosure && item.enclosure.url) {
    return item.enclosure.url;
  }
  // 3. Check embedded image in description/content
  const htmlContent = item.content || item.description || '';
  const imgRegex = /<img[^>]+src=["']([^"']+)["']/i;
  const match = htmlContent.match(imgRegex);
  if (match && match[1]) {
    return match[1];
  }
  
  // Return null if no image found (frontend will provide a nice default)
  return null;
}

// Function to scrape og:image from the article webpage
// Resolve Google News article redirects using a quick DuckDuckGo HTML search
async function resolveUrlWithDDG(title) {
  try {
    // Remove source suffix if present, e.g. " - Manchester Evening News"
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
    if (!match) {
      match = html.match(hrefRegexAlt);
    }
    
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

// Function to scrape og:image from the article webpage
async function scrapeOgImage(url, title) {
  let targetUrl = url;
  
  // If it's a Google News URL, resolve the real URL using DuckDuckGo first
  if (url.includes('news.google.com') && title) {
    console.log(`Resolving Google News link using DuckDuckGo for: "${title.substring(0, 30)}..."`);
    const resolved = await resolveUrlWithDDG(title);
    if (resolved) {
      targetUrl = resolved;
      console.log(`Resolved Google News link to: ${targetUrl}`);
    }
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3500); // 3.5 seconds timeout
    const response = await fetch(targetUrl, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36'
      }
    });
    clearTimeout(timeout);
    if (!response.ok) return null;
    const html = await response.text();
    
    // Regex to match og:image meta tag
    const ogImageRegex = /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i;
    const ogImageRegexAlt = /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i;
    
    let match = html.match(ogImageRegex);
    if (!match) {
      match = html.match(ogImageRegexAlt);
    }
    return match ? match[1] : null;
  } catch (error) {
    console.error(`Failed to scrape image for ${targetUrl}:`, error.message);
    return null;
  }
}

// Clean HTML tags from content
function cleanText(text) {
  if (!text) return '';
  return text.replace(/<[^>]*>/g, '').trim();
}

// Function to translate title and description using Gemini
async function translateWithGemini(title, description) {
  if (!ai) {
    // Return mock translation if Gemini is not initialized
    return {
      mizoTitle: `[Mock Translate] ${title}`,
      mizoSummary: `[Gemini API Key a awm loh avangin he news hi Mizo tawngin a letling thei rih lo a ni. .env file-ah khuan i API key dah rawh le.] Original English: ${cleanText(description)}`,
      mizoFullReport: `[MOCK REPORT] Manchester United chanchin thar pawimawh tak a awm e. He thil hi an ngaihven hle a ni. Gemini API Key a awm loh avangin he news hi Mizo tawngin kan letling thui thei lo a, i .env file-ah khuan i API key dah rawh le. Original English summary: ${cleanText(description)}`
    };
  }

  const prompt = `You are an expert sports journalist fluent in English and Mizo.
Based on the following Manchester United news headline and summary, perform two tasks:
1. Translate the headline and short summary into Mizo (concise, for feed display).
2. Write a detailed, paraphrased news report in Mizo (max 1500 characters) that expands on the details of the article, explaining them clearly to Mizo fans so they don't have to read the English article.

CRITICAL INSTRUCTIONS FOR FACTUAL ACCURACY:
- Do NOT invent or add external facts, rumors, or names (such as specific managers, players, or coaching staff) that are not mentioned in the provided headline or summary below.
- For example, do NOT write about Ruben Amorim, Michael Carrick, or any specific transfer target or coaching staff unless they are explicitly named in the headline or summary text.
- Keep the translation and the detailed report strictly faithful to the provided text. Any exaggeration or fabrication of facts is completely unacceptable.

Format the output as a valid JSON object with EXACTLY these three keys:
"mizoTitle": "Mizo translation of the headline",
"mizoSummary": "Mizo translation of the short summary",
"mizoFullReport": "Detailed Mizo paraphrased news report (max 1500 characters, formatted with newlines if needed, strictly based on the text below)"

Do not wrap the response in markdown blocks or backticks. Return raw JSON only.

Headline: ${title}
Summary: ${cleanText(description)}`;

  try {
    const model = ai.getGenerativeModel({ model: 'gemini-3.1-flash-lite' });
    const response = await model.generateContent(prompt);
    let text = response.response.text().trim();
    
    // In case Gemini wraps the response in ```json ```
    if (text.startsWith('```')) {
      text = text.replace(/^```json\s*/i, '').replace(/```$/, '').trim();
    }
    
    const translated = JSON.parse(text);
    return {
      mizoTitle: translated.mizoTitle || title,
      mizoSummary: translated.mizoSummary || description,
      mizoFullReport: translated.mizoFullReport || `Chanchin thar zau zawk: ${description}`
    };
  } catch (error) {
    console.error('Error translating with Gemini:', error.message);
    return {
      mizoTitle: `[Translation Error] ${title}`,
      mizoSummary: `Translate a hlawhchham rih tlat mai: ${error.message}.`,
      mizoFullReport: `Chanchin thar hi kan letling thui thei rih lo tlat mai, he thil vang hian a ni: ${error.message}. English details: ${cleanText(description)}`
    };
  }
}

// Semantic de-duplication using Gemini
async function filterDuplicatePosts(candidates, cachedPosts) {
  if (!ai || candidates.length === 0) {
    return candidates; // Return all if Gemini not initialized
  }

  // Format list of candidates
  const candidateList = candidates.map((item, index) => {
    return `[${index}] Title: "${item.title}"\nDescription: "${cleanText(item.description)}"\nSource: "${item.source}"`;
  }).join('\n\n');

  // Format list of cached titles
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

  try {
    const model = ai.getGenerativeModel({ model: 'gemini-3.1-flash-lite' });
    const response = await model.generateContent(prompt);
    let text = response.response.text().trim();
    
    if (text.startsWith('```')) {
      text = text.replace(/^```json\s*/i, '').replace(/```$/, '').trim();
    }
    
    const selectedIndices = JSON.parse(text);
    if (Array.isArray(selectedIndices)) {
      console.log(`Semantic Filter: Selected ${selectedIndices.length} out of ${candidates.length} candidate posts.`);
      return candidates.filter((_, index) => selectedIndices.includes(index));
    }
    return candidates;
  } catch (error) {
    console.error('Error during semantic filtering:', error.message);
    return candidates; // Fallback to returning all candidates
  }
}

// Fetch lock to avoid concurrent requests
let isFetching = false;

// Fetch and process feeds
async function fetchAndTranslateFeeds() {
  if (isFetching) {
    console.log('Fetch already in progress. Returning existing cache.');
    return readCache();
  }
  isFetching = true;
  
  try {
    const feeds = [
      {
        name: 'Google News',
        url: 'https://news.google.com/rss/search?q=Manchester+United&hl=en-US&gl=US&ceid=US:en'
      },
      {
        name: 'Sky Sports',
        url: 'https://news.google.com/rss/search?q=Manchester+United+site:skysports.com&hl=en-US&gl=US&ceid=US:en'
      },
      {
        name: 'Manchester Evening News',
        url: 'https://www.manchestereveningnews.co.uk/all-about/manchester-united-fc?service=rss'
      },
      {
        name: 'United In Focus',
        url: 'https://www.unitedinfocus.com/news/feed'
      },
      {
        name: 'The Peoples Person',
        url: 'https://thepeoplesperson.com/feed/'
      },
      {
        name: 'Stretty News',
        url: 'https://strettynews.com/feed/'
      }
    ];

    const cachedPosts = readCache();
    const cachedLinks = new Set(cachedPosts.map(p => p.link));
    const rawCandidates = [];

    // Phase 1: Collect candidates from all feeds
    for (const feed of feeds) {
      try {
        console.log(`Fetching feed: ${feed.name}`);
        const parsedFeed = await parser.parseURL(feed.url);
        
        // Limit to 5 latest items per feed
        const items = parsedFeed.items.slice(0, 5);
        
        for (const item of items) {
          if (cachedLinks.has(item.link)) {
            continue; // Already processed
          }
          
          // Avoid duplicate links within the rawCandidates list
          if (rawCandidates.some(c => c.link === item.link)) {
            continue;
          }

          rawCandidates.push({
            title: item.title || '',
            description: cleanText(item.contentSnippet || item.content || item.description || ''),
            link: item.link,
            pubDate: item.pubDate || new Date().toISOString(),
            source: feed.name,
            rawItem: item // keep reference for image parsing
          });
        }
      } catch (error) {
        console.error(`Error parsing feed ${feed.name}:`, error.message);
      }
    }

    if (rawCandidates.length === 0) {
      console.log('No new posts found.');
      isFetching = false;
      return cachedPosts;
    }

    console.log(`Found ${rawCandidates.length} raw candidates. Running semantic de-duplication...`);
    const filteredCandidates = await filterDuplicatePosts(rawCandidates, cachedPosts);
    console.log(`Semantic filter selected ${filteredCandidates.length} unique posts to translate.`);

    const newPosts = [];

    // Phase 2: Translate and scrape images for the selected candidates
    for (const item of filteredCandidates) {
      try {
        let image = extractImage(item.rawItem);
        if (!image && item.link) {
          console.log(`Scraping article page for image: ${item.link}`);
          image = await scrapeOgImage(item.link, item.title);
        }

        console.log(`Translating: "${item.title.substring(0, 30)}..." from ${item.source}`);
        const translation = await translateWithGemini(item.title, item.description);

        // Wait 4.5 seconds if we are using the real Gemini API key to avoid 15 RPM limits of Free Tier
        if (ai) {
          await new Promise(resolve => setTimeout(resolve, 4500));
        }

        const newPost = {
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
        };

        newPosts.push(newPost);
      } catch (err) {
        console.error(`Error processing candidate "${item.title}":`, err.message);
      }
    }

    if (newPosts.length > 0) {
      // Prepend new posts so they are at the top (sorted by time)
      const updatedPosts = [...newPosts, ...cachedPosts];
      // Sort by pubDate descending
      updatedPosts.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));
      // Keep max 50 posts to avoid file bloating
      writeCache(updatedPosts.slice(0, 50));
      console.log(`Added ${newPosts.length} new translated posts to cache.`);
    } else {
      console.log('No new posts translated.');
    }
  } finally {
    isFetching = false;
  }

  return readCache();
}

// Endpoint to get posts
app.get('/api/news', async (req, res) => {
  const posts = readCache();
  if (posts.length === 0) {
    // If cache is empty, fetch immediately
    try {
      const fetched = await fetchAndTranslateFeeds();
      return res.json(fetched);
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  }
  res.json(posts);
});

// Endpoint to force refresh
app.get('/api/refresh', async (req, res) => {
  try {
    const fetched = await fetchAndTranslateFeeds();
    res.json({ success: true, count: fetched.length, posts: fetched });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Background job to fetch new posts every 2 minutes
setInterval(() => {
  console.log('Running background feed fetch and translation...');
  fetchAndTranslateFeeds().catch(err => console.error('Background fetch error:', err));
}, 2 * 60 * 1000);

app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
  // Initial check
  if (readCache().length === 0) {
    console.log('Cache is empty. Initializing initial feed fetch...');
    fetchAndTranslateFeeds().catch(err => console.error('Initial fetch error:', err));
  }
});
