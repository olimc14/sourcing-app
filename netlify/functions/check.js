const https = require('https');
const http = require('http');
const { URL } = require('url');

function fetchPage(urlString, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 5) return reject(new Error('Too many redirects'));
    try {
      const parsedUrl = new URL(urlString);
      const lib = parsedUrl.protocol === 'https:' ? https : http;
      const options = {
        hostname: parsedUrl.hostname,
        path: parsedUrl.pathname + parsedUrl.search,
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-GB,en;q=0.5',
        }
      };
      const req = lib.request(options, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          const redirectUrl = res.headers.location.startsWith('http')
            ? res.headers.location
            : `${parsedUrl.protocol}//${parsedUrl.hostname}${res.headers.location}`;
          return resolve(fetchPage(redirectUrl, redirectCount + 1));
        }
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve({ status: res.statusCode, html: data }));
      });
      req.on('error', reject);
      req.setTimeout(10000, () => { req.destroy(); reject(new Error('Request timed out')); });
      req.end();
    } catch(e) { reject(e); }
  });
}

function extractText(html) {
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#[0-9]+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.slice(0, 8000);
}

function callAnthropic(apiKey, prompt) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1500,
      messages: [{ role: 'user', content: prompt }]
    });
    const options = {
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(body)
      }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error('Invalid JSON: ' + data.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let parsed;
  try { parsed = JSON.parse(event.body); }
  catch(e) { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request body' }) }; }

  const { url, type, title, check, apiKey } = parsed;

  let pageContent = '';
  let fetchError = '';
  try {
    const result = await fetchPage(url);
    if (result.status === 200) {
      pageContent = extractText(result.html);
    } else {
      fetchError = `Page returned status ${result.status}`;
    }
  } catch(e) {
    fetchError = `Could not fetch page: ${e.message}`;
  }

  const pageTypeLabel = type === 'listing' ? 'individual product listing page' : 'product collection/category page';

  let prompt;
  if (pageContent) {
    prompt = `You are a product sourcing assistant. Analyse this live webpage content and perform the requested check.

URL: ${url}
Page type: ${pageTypeLabel}
Source name: ${title}
Check to perform: ${check}

LIVE PAGE CONTENT:
${pageContent}

Based ONLY on the page content above, perform the requested check.

Rules:
- List ONLY product names, prices, and stock status
- No company info, no contact details, no grading explanations, no business model, no analysis
- Just a clean numbered list of products with prices
- If stock status is visible, include it next to the product
- Nothing else

Finish with:
SUMMARY: [one sentence]
STATUS: OK (products found / in stock) | WARNING (low stock / few products) | ISSUE (out of stock / no products / page inaccessible)`;
  } else {
    prompt = `You are a product sourcing assistant. The live page could not be fetched (${fetchError}).

URL: ${url}
Page type: ${pageTypeLabel}
Source name: ${title}
Check requested: ${check}

Note clearly that the live page could not be checked. Do not guess or invent product listings.

Finish with:
SUMMARY: Page could not be fetched live
STATUS: ISSUE`;
  }

  try {
    const data = await callAnthropic(apiKey, prompt);
    if (data.error) {
      return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: data.error.message }) };
    }
    const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ result: text || 'No details returned.' }) };
  } catch(e) {
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: e.message }) };
  }
};
