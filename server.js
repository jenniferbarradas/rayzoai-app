console.log('Starting StoreCritic server...');
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const gplay = require('google-play-scraper');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
app.use(cors({
  origin: ['https://rayzoai-app.vercel.app', '*'],
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type']
}));
app.use(express.json());
app.use(express.static(path.join(__dirname)));

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

app.post('/api/analyze', async (req, res) => {
  const { appName, appId: directAppId, timeRange } = req.body;
  if (!appName?.trim() && !directAppId?.trim()) {
    return res.status(400).json({ error: 'App name or app ID is required' });
  }

  const reviewCount = timeRange === '2w' ? 50 : timeRange === '3m' ? 200 : 100;

  try {
    let appId, appTitle;

    if (directAppId) {
      // Direct app ID from a pasted Google Play URL — skip search
      appId = directAppId.trim();
      try {
        const details = await gplay.app({ appId, lang: 'en', country: 'us' });
        appTitle = details.title;
      } catch (_) {
        appTitle = appId;
      }
      console.log(`Direct ID: ${appTitle} (${appId})`);
    } else {
      // 1. Search Google Play for the app by name
      const searchResults = await gplay.search({
        term: appName.trim(),
        num: 5,
        lang: 'en',
        country: 'us',
        throttle: 1
      });

      if (!searchResults || searchResults.length === 0) {
        return res.status(404).json({ error: `No app found for "${appName}" on Google Play` });
      }

      const appInfo = searchResults[0];
      appId = appInfo.appId || new URL(appInfo.url).searchParams.get('id');
      appTitle = appInfo.title;
      if (!appId) {
        return res.status(404).json({ error: `Could not resolve app ID for "${appName}"` });
      }
      console.log(`Found: ${appTitle} (${appId})`);
    }

    // 2. Fetch recent reviews and filter to 1–2 stars
    const reviewResult = await gplay.reviews({
      appId,
      sort: gplay.sort.NEWEST,
      num: reviewCount,
      lang: 'en',
      country: 'us',
      throttle: 1
    });

    const allReviews = Array.isArray(reviewResult)
      ? reviewResult
      : (reviewResult.data || []);

    const negativeReviews = allReviews.filter(r => r.score <= 2);
    console.log(`Reviews fetched: ${allReviews.length}, Negative (1-2★): ${negativeReviews.length}`);

    if (negativeReviews.length === 0) {
      return res.json({
        isLive: true,
        appTitle,
        totalReviews: 0,
        categories: []
      });
    }

    // 3. Build prompt with real review text (cap at 100 to stay within token limits)
    const reviewsText = negativeReviews
      .slice(0, 100)
      .map((r, i) => `[${i + 1}] (${r.score}★) ${r.text}`)
      .join('\n\n');

    const prompt = `Analyze these ${negativeReviews.length} negative Google Play reviews for "${appTitle}" and categorize them into exactly 4 groups:

1. Crashes & Bugs — app crashes, freezes, errors, force closes, black screens
2. UX Issues — confusing navigation, bad design, poor usability, missing features
3. Performance — slow loading, battery drain, lag, high memory or data usage
4. Pricing Complaints — expensive subscriptions, paywalled features, hidden costs, poor value

Reviews:
${reviewsText}

Return ONLY valid JSON with no markdown or explanation:
{
  "totalReviews": ${negativeReviews.length},
  "categories": [
    {
      "name": "Crashes & Bugs",
      "count": <integer: reviews in this category>,
      "pct": <integer: percentage of totalReviews>,
      "tag": "Critical",
      "tagClass": "tag-critical",
      "quotes": ["<verbatim snippet from a real review>", "<another verbatim snippet>"]
    },
    {
      "name": "UX Issues",
      "count": <integer>,
      "pct": <integer>,
      "tag": "High",
      "tagClass": "tag-high",
      "quotes": ["<verbatim snippet>", "<verbatim snippet>"]
    },
    {
      "name": "Performance",
      "count": <integer>,
      "pct": <integer>,
      "tag": "High",
      "tagClass": "tag-high",
      "quotes": ["<verbatim snippet>", "<verbatim snippet>"]
    },
    {
      "name": "Pricing Complaints",
      "count": <integer>,
      "pct": <integer>,
      "tag": "Medium",
      "tagClass": "tag-medium",
      "quotes": ["<verbatim snippet>", "<verbatim snippet>"]
    }
  ]
}

Use actual verbatim snippets (30–100 characters) pulled directly from the reviews above. A review may fit multiple categories.`;

    // 4. Ask Claude to categorize the real reviews
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1500,
      messages: [{ role: 'user', content: prompt }]
    });

    let text = response.content[0].text.trim();
    // Strip markdown code fences if the model adds them
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

    const data = JSON.parse(text);
    data.isLive = true;
    data.appTitle = appTitle;

    res.json(data);

  } catch (err) {
    console.error('Error:', err.message);
    if (err.message && err.message.toLowerCase().includes('not found')) {
      const label = directAppId || appName;
      return res.status(404).json({ error: `App "${label}" not found on Google Play` });
    }
    res.status(500).json({ error: 'Analysis failed. Please try again.' });
  }
});

const PORT = process.env.PORT || 3000;
try {
  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n✅ Rayzoai server → http://0.0.0.0:${PORT}\n`);
    if (!process.env.ANTHROPIC_API_KEY) {
      console.warn('⚠️  ANTHROPIC_API_KEY not set — copy .env.example to .env and add your key\n');
    }
  });
  server.on('error', (err) => {
    console.error('Server failed to start:', err);
    process.exit(1);
  });
} catch (err) {
  console.error('Fatal error during server startup:', err);
  process.exit(1);
}
