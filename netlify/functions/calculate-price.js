const crypto = require('crypto');
const https = require('https');

function percentEncode(str) {
  return encodeURIComponent(str)
    .replace(/!/g, '%21')
    .replace(/\*/g, '%2A')
    .replace(/'/g, '%27')
    .replace(/\(/g, '\%28') .replace(/\)/g, '%29');
}

function generateOAuthHeader(baseUrl, method, params, credentials) {
  const oauthParams = {
    oauth_consumer_key: credentials.consumerKey,
    oauth_nonce: crypto.randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_token: credentials.tokenValue,
    oauth_version: '1.0'
  };

  const allParams = { ...params, ...oauthParams };
  const sortedKeys = Object.keys(allParams).sort();
  const paramString = sortedKeys
    .map(key => `${percentEncode(key)}=${percentEncode(allParams[key])}`)
    .join('&');

  const baseString = `${method.toUpperCase()}&${percentEncode(baseUrl)}&${percentEncode(paramString)}`;
  const signingKey = `${percentEncode(credentials.consumerSecret)}&${percentEncode(credentials.tokenSecret)}`;
  
  const signature = crypto
    .createHmac('sha1', signingKey)
    .update(baseString)
    .digest('base64');

  oauthParams.oauth_signature = signature;

  return 'OAuth ' + Object.keys(oauthParams)
    .sort()
    .map(key => `${percentEncode(key)}="${percentEncode(oauthParams[key])}"`)
    .join(', ');
}

function fetchBrickLink(fullUrl, credentials) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(fullUrl);
    const queryParams = {};
    urlObj.searchParams.forEach((value, key) => {
      queryParams[key] = value;
    });
    const baseUrl = `${urlObj.protocol}//${urlObj.host}${urlObj.pathname}`;

    const authHeader = generateOAuthHeader(baseUrl, 'GET', queryParams, credentials);
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: 'GET',
      headers: {
        'Authorization': authHeader,
        'Content-Type': 'application/json',
        'User-Agent': 'ZwoStein-Ankauf'
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          if (data.includes('<!DOCTYPE html>') || data.includes('<html')) {
            resolve({ statusCode: 503, raw: data });
            return;
          }
          const json = JSON.parse(data);
          resolve({ statusCode: res.statusCode, data: json, raw: data });
        } catch (e) {
          resolve({ statusCode: res.statusCode, raw: data, error: e.message });
        }
      });
    });

    req.on('error', err => {
      reject(err);
    });

    req.end();
  });
}

exports.handler = async (event) => {
  const queryParams = event.queryStringParameters || {};
  const setNumber = queryParams.set;

  if (!setNumber) {
    return {
      statusCode: 400,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ error: "Bitte eine Set-Nummer angeben." })
    };
  }

  const itemNo = setNumber.includes('-') ? setNumber : `${setNumber}-1`;
  const credentials = {
    consumerKey: process.env.BL_CONSUMER_KEY,
    consumerSecret: process.env.BL_CONSUMER_SECRET,
    tokenValue: process.env.BL_TOKEN_VALUE,
    tokenSecret: process.env.BL_TOKEN_SECRET
  };

  let bricklinkNewAvg = 0;
  let bricklinkUsedAvg = 0;
  let legoSetName = `LEGO® Set ${setNumber}`;

  try {
    // Schritt 0: Artikeldetails abrufen (Echter Name + Existenzprüfung)
    let itemUrl = `https://api.bricklink.com/api/store/v1/items/SET/${itemNo}`;
    let itemRes = await fetchBrickLink(itemUrl, credentials).catch(err => null);
    
    // Nur bei echter Wartung (503) abbrechen
    if (itemRes && itemRes.statusCode === 503) {
      return getMaintenanceResponse();
    }

    // Wenn der Status 200 ist und Daten da sind, Name übernehmen
    if (itemRes && itemRes.statusCode === 200 && itemRes.data && itemRes.data.data) {
      legoSetName = itemRes.data.data.name;
    } else {
      // Wenn BrickLink ein echtes 404 (Set existiert nicht) wirft
      return {
        statusCode: 404,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        body: JSON.stringify({ error: `Das LEGO® Set "${setNumber}" existiert nicht oder wurde auf BrickLink nicht gefunden.` })
      };
    }

    // 1. Kaskade Schritt 1: Deutschland (Sold / DE)
    let urlUsedDE = `https://api.bricklink.com/api/store/v1/items/SET/${itemNo}/price?new_or_used=U&guide_type=sold&currency_code=EUR&country_code=DE`;
    let urlNewDE = `https://api.bricklink.com/api/store/v1/items/SET/${itemNo}/price?new_or_used=N&guide_type=sold&currency_code=EUR&country_code=DE`;

    let [usedDeRes, newDeRes] = await Promise.all([
      fetchBrickLink(urlUsedDE, credentials).catch(err => null),
      fetchBrickLink(urlNewDE, credentials).catch(err => null)
    ]);

    if ((usedDeRes && usedDeRes.statusCode === 503) || (newDeRes && newDeRes.statusCode === 503)) {
      return getMaintenanceResponse();
    }

    if (usedDeRes && usedDeRes.statusCode === 200 && usedDeRes.data && usedDeRes.data.data) {
      bricklinkUsedAvg = parseFloat(usedDeRes.data.data.qty_avg_price || usedDeRes.data.data.avg_price) || 0;
    }
    if (newDeRes && newDeRes.statusCode === 200 && newDeRes.data && newDeRes.data.data) {
      bricklinkNewAvg = parseFloat(newDe
