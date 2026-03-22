const https = require('https');

function callAnthropic(apiKey, messages, tools) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      tools: tools,
      messages: messages
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

  const prompt = `Search for current products and prices listed on this page: ${url}

Return ONLY a numbered list of products with prices. Nothing else.
No company info. No delivery info. No grading info. No contact details. No summaries.
Just: 1. Product name - £price

If you cannot find specific products, say "No products found."
End with: STATUS: OK (products found) | WARNING (only a few found) | ISSUE (none found)`;

  try {
    const data = await callAnthropic(apiKey, 
      [{ role: 'user', content: prompt }],
      [{ type: 'web_search_20250305', name: 'web_search' }]
    );

    if (data.error) {
      return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: data.error.message }) };
    }

    const text = (data.content || [])
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('\n')
      .trim();

    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ result: text || 'No products found.' }) };
  } catch(e) {
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: e.message }) };
  }
};
