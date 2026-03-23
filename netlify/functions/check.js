const https = require('https');

function scrapeUrl(scraperKey, targetUrl) {
  return new Promise((resolve, reject) => {
    const encodedUrl = encodeURIComponent(targetUrl);
    const path = `/v1/?api_key=${scraperKey}&url=${encodedUrl}&render=true`;
    const options = {
      hostname: 'api.scraperapi.com',
      path: path,
      method: 'GET',
      headers: { 'Accept': 'text/html' }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, html: data }));
    });
    req.on('error', reject);
    req.setTimeout(60000, () => { req.destroy(); reject(new Error('ScraperAPI timed out')); });
    req.end();
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
  return text.slice(0, 12000);
}

function callAnthropic(apiKey, prompt) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
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

  const { url, type, title, check, apiKey, scraperKey } = parsed;

  if (!scraperKey) {
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'No ScraperAPI key set' }) };
  }

  let pageContent = '';
  try {
    const result = await scrapeUrl(scraperKey, url);
    if (result.status === 200) {
      pageContent = extractText(result.html);
    } else {
      return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ result: `Page returned status ${result.status}\nSTATUS: ISSUE` }) };
    }
  } catch(e) {
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ result: `Could not fetch page: ${e.message}\nSTATUS: ISSUE` }) };
  }

  const pageTypeLabel = type === 'listing' ? 'individual product listing page' : 'product collection page';

  const prompt = `You are helping someone source products to resell. Look at this ${pageTypeLabel} content and ${check}.

Output ONLY a numbered list of products with their current prices.
No company info. No delivery info. No grading info. No contact details. No summaries.
Just: 1. Product name - £price
If no products found, say "No products found on this page."

PAGE CONTENT:
${pageContent}

End with: STATUS: OK (products found) | WARNING (very few) | ISSUE (none found)`;

  try {
    const data = await callAnthropic(apiKey, prompt);
    if (data.error) {
      return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: data.error.message }) };
    }
    const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ result: text || 'No products found.' }) };
  } catch(e) {
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: e.message }) };
  }
};
