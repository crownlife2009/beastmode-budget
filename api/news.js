// GET /api/news
// Powers the "Beastmode News" widget on the Insights tab.
//
// Why this is a server function: browsers block pages from reading other websites'
// RSS feeds directly (CORS), so the site asks THIS endpoint, which reads the feeds
// from reputable publishers on the server, trims them to headline + link + short
// summary, and returns clean JSON. No API key and no extra npm packages needed.
//
// Freshness: the response is cached at Vercel's edge for 3 hours and may be served
// stale for up to a day while it refreshes in the background — so the feed renews
// itself continuously, many times a day, without anyone doing anything.
//
// Every article links straight to the publisher's own page (we never copy full
// articles — only the headline and a short excerpt the publisher puts in its feed).
//
// To check that the feeds are working after you deploy, open:
//   https://www.beastmodebudget.com/api/news?debug=1
// It lists every source and whether it answered.

// EDIT: add / remove sources here. `cats` = which Beastmode News tabs the feed feeds.
// Categories: finance (Personal Finance), savings, banking, business (Small Business Growth), investing
const SOURCES = [
  { name: 'CNBC Personal Finance', url: 'https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=21324812', cats: ['finance', 'savings'] },
  { name: 'CNBC Investing',        url: 'https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=15839069', cats: ['investing'] },
  { name: 'CNBC Small Business',   url: 'https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=44877279', cats: ['business'] },
  { name: 'Kiplinger',             url: 'https://www.kiplinger.com/feed/all',                                                     cats: ['finance', 'savings', 'investing'] },
  { name: 'NerdWallet',            url: 'https://www.nerdwallet.com/blog/feed/',                                                  cats: ['finance', 'savings', 'banking'] },
  { name: 'Investopedia',          url: 'https://www.investopedia.com/feedbuilder/feed/getfeed?feedName=rss_headline',            cats: ['investing', 'finance'] },
  { name: 'MarketWatch',           url: 'https://feeds.content.dowjones.io/public/rss/mw_personalfinance',                        cats: ['finance', 'investing'] },
  { name: 'Entrepreneur',          url: 'https://www.entrepreneur.com/latest.rss',                                                cats: ['business'] },
  { name: 'Inc.',                  url: 'https://www.inc.com/rss',                                                                cats: ['business'] },
  { name: 'Federal Reserve',       url: 'https://www.federalreserve.gov/feeds/press_all.xml',                                     cats: ['banking'] },
];

// Words that nudge a story into a tab even if its source feeds several tabs.
const KEYWORDS = {
  savings:   /\b(sav(e|ing|ings)|high-yield|cd rates?|emergency fund|apy|money market|budget(ing)?)\b/i,
  banking:   /\b(bank(s|ing)?|checking|credit union|fdic|mortgage|interest rates?|fed(eral reserve)?|loan|credit card)\b/i,
  business:  /\b(small business|entrepreneur|startup|founder|payroll|cash flow|sba|self-employed|side hustle|revenue)\b/i,
  investing: /\b(invest(ing|ment|or|ors)?|stocks?|etf|401\(?k\)?|ira|retirement|index fund|dividend|portfolio)\b/i,
  finance:   /\b(personal finance|family|household|debt|credit score|tax(es)?|inflation|spend(ing)?|income|wealth)\b/i,
};

const MAX_PER_CATEGORY = 12;
const MAX_AGE_DAYS = 21;
const FETCH_TIMEOUT_MS = 6000;

function decodeEntities(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&');
}
function stripTags(s) {
  return decodeEntities(s).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}
function pick(block, tag) {
  const m = new RegExp('<' + tag + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + tag + '>', 'i').exec(block);
  return m ? m[1] : '';
}
function atomLink(block) {
  const m = /<link[^>]*?href=["']([^"']+)["'][^>]*?>/i.exec(block);
  return m ? m[1] : '';
}
function safeUrl(u) {
  try {
    const url = new URL(decodeEntities(u).trim());
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : '';
  } catch (e) { return ''; }
}
function clip(s, n) {
  if (s.length <= n) return s;
  const cut = s.slice(0, n - 1);
  return cut.slice(0, cut.lastIndexOf(' ') > 60 ? cut.lastIndexOf(' ') : cut.length).replace(/[.,;:\s]+$/, '') + '…';
}

function parseFeed(xml, source) {
  const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>|<entry[\s>][\s\S]*?<\/entry>/gi) || [];
  const items = [];
  for (const b of blocks) {
    const title = stripTags(pick(b, 'title'));
    const link = safeUrl(pick(b, 'link') || atomLink(b) || pick(b, 'guid'));
    if (!title || !link) continue;
    const dateRaw = pick(b, 'pubDate') || pick(b, 'published') || pick(b, 'updated') || pick(b, 'dc:date');
    const t = Date.parse(decodeEntities(dateRaw).trim());
    const summary = clip(stripTags(pick(b, 'description') || pick(b, 'summary') || pick(b, 'content:encoded')), 150);
    items.push({ title: clip(title, 140), link, summary, source: source.name, cats: source.cats, published: isNaN(t) ? null : t });
  }
  return items;
}

async function fetchSource(source) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(source.url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BeastmodeBudgetNews/1.0; +https://www.beastmodebudget.com)', 'Accept': 'application/rss+xml, application/xml, text/xml, */*' },
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const xml = await res.text();
    const items = parseFeed(xml, source);
    return { source: source.name, ok: items.length > 0, count: items.length, items };
  } catch (err) {
    return { source: source.name, ok: false, count: 0, items: [], error: String(err && err.message || err) };
  } finally {
    clearTimeout(timer);
  }
}

function categorize(item) {
  // A story always appears under its source's categories; keywords can add more.
  const set = new Set(item.cats);
  const text = item.title + ' ' + item.summary;
  for (const [cat, re] of Object.entries(KEYWORDS)) if (re.test(text)) set.add(cat);
  // Keep a story out of a tab it clearly doesn't belong in (e.g. a startup story is not "Savings").
  if (!item.cats.includes('business') && !KEYWORDS.business.test(text)) set.delete('business');
  return [...set];
}

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  try {
    const results = await Promise.all(SOURCES.map(fetchSource));
    const cutoff = Date.now() - MAX_AGE_DAYS * 86400000;
    const seen = new Set();
    const all = [];
    for (const r of results) {
      for (const it of r.items) {
        if (it.published && it.published < cutoff) continue;
        const key = it.link.replace(/[?#].*$/, '');
        if (seen.has(key)) continue;
        seen.add(key);
        all.push(it);
      }
    }
    // Newest first; undated items sink to the bottom.
    all.sort((a, b) => (b.published || 0) - (a.published || 0));

    const categories = { finance: [], savings: [], banking: [], business: [], investing: [] };
    for (const it of all) {
      for (const cat of categorize(it)) {
        if (!categories[cat] || categories[cat].length >= MAX_PER_CATEGORY) continue;
        categories[cat].push({ title: it.title, link: it.link, summary: it.summary, source: it.source, published: it.published });
      }
    }

    // 3 hours at the edge, then up to a day of stale-while-revalidate (see top-of-file note).
    res.setHeader('Cache-Control', 'public, s-maxage=10800, stale-while-revalidate=86400');
    const body = { updatedAt: Date.now(), categories };
    if (req.query && req.query.debug) {
      body.sources = results.map(r => ({ source: r.source, ok: r.ok, count: r.count, error: r.error || null }));
      res.setHeader('Cache-Control', 'no-store');
    }
    res.status(200).json(body);
  } catch (err) {
    console.error('news error:', err);
    res.status(500).json({ error: 'News is unavailable right now.' });
  }
};

// Exposed for local testing only.
module.exports._parseFeed = parseFeed;
module.exports._categorize = categorize;
