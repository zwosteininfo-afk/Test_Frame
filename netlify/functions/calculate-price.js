const crypto = require('crypto');
const https = https = require('https');

function percentEncode(str) {
  return encodeURIComponent(str)
    .replace(/!/g, '%21')
    .replace(/\*/g, '%2A')
    .replace(/'/g, '%27')
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29');
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
          // Prüfen, ob BrickLink eine Wartungsseite (HTML) statt JSON liefert
          if (data.includes('<!DOCTYPE html>')) {
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
    // 0. Artikeldetails abrufen (für den echten Namen)
    let itemUrl = `https://api.bricklink.com/api/store/v1/items/SET/${itemNo}`;
    let itemRes = await fetchBrickLink(itemUrl, credentials).catch(err => null);
    
    if (itemRes && itemRes.statusCode === 503) {
      return getMaintenanceResponse();
    }
    if (itemRes && itemRes.statusCode === 200 && itemRes.data && itemRes.data.data && itemRes.data.data.name) {
      legoSetName = itemRes.data.data.name;
    }

    // 1. Kaskade Schritt 1: Deutschland (Sold / DE)
    let urlUsedDE = `https://api.bricklink.com/api/store/v1/items/SET/${itemNo}/price?new_or_used=U&guide_type=sold&currency_code=EUR&country_code=DE`;
    let urlNewDE = `https://api.bricklink.com/api/store/v1/items/SET/${itemNo}/price?new_or_used=N&guide_type=sold&currency_code=EUR&country_code=DE`;

    let [usedDeRes, newDeRes] = await Promise.all([
      fetchBrickLink(urlUsedDE, credentials).catch(err => null),
      fetchBrickLink(urlNewDE, credentials).catch(err => null)
    ]);

    if (usedDeRes && usedDeRes.statusCode === 503 || newDeRes && newDeRes.statusCode === 503) {
      return getMaintenanceResponse();
    }

    if (usedDeRes && usedDeRes.statusCode === 200 && usedDeRes.data && usedDeRes.data.data) {
      bricklinkUsedAvg = parseFloat(usedDeRes.data.data.qty_avg_price || usedDeRes.data.data.avg_price) || 0;
    }
    if (newDeRes && newDeRes.statusCode === 200 && newDeRes.data && newDeRes.data.data) {
      bricklinkNewAvg = parseFloat(newDeRes.data.data.qty_avg_price || newDeRes.data.data.avg_price) || 0;
    }

    // 2. Kaskade Schritt 2: Europa / Global (Sold / Global) - falls DE leer ist
    if (bricklinkUsedAvg === 0 || bricklinkNewAvg === 0) {
      let urlUsedGlobal = `https://api.bricklink.com/api/store/v1/items/SET/${itemNo}/price?new_or_used=U&guide_type=sold&currency_code=EUR`;
      let urlNewGlobal = `https://api.bricklink.com/api/store/v1/items/SET/${itemNo}/price?new_or_used=N&guide_type=sold&currency_code=EUR`;

      let [usedGlobRes, newGlobRes] = await Promise.all([
        fetchBrickLink(urlUsedGlobal, credentials).catch(err => null),
        fetchBrickLink(urlNewGlobal, credentials).catch(err => null)
      ]);

      if (bricklinkUsedAvg === 0 && usedGlobRes && usedGlobRes.statusCode === 200 && usedGlobRes.data && usedGlobRes.data.data) {
        bricklinkUsedAvg = parseFloat(usedGlobRes.data.data.qty_avg_price || usedGlobRes.data.data.avg_price) || 0;
      }
      if (bricklinkNewAvg === 0 && newGlobRes && newGlobRes.statusCode === 200 && newGlobRes.data && newGlobRes.data.data) {
        bricklinkNewAvg = parseFloat(newGlobRes.data.data.qty_avg_price || newGlobRes.data.data.avg_price) || 0;
      }
    }

    // 3. Kaskade Schritt 3: Aktuelle Angebote (Stock) als letzter Ausweg vor Abbruch
    if (bricklinkUsedAvg === 0 || bricklinkNewAvg === 0) {
      let urlUsedStock = `https://api.bricklink.com/api/store/v1/items/SET/${itemNo}/price?new_or_used=U&guide_type=stock&currency_code=EUR`;
      let urlNewStock = `https://api.bricklink.com/api/store/v1/items/SET/${itemNo}/price?new_or_used=N&guide_type=stock&currency_code=EUR`;

      let [usedStockRes, newStockRes] = await Promise.all([
        fetchBrickLink(urlUsedStock, credentials).catch(err => null),
        fetchBrickLink(urlNewStock, credentials).catch(err => null)
      ]);

      if (bricklinkUsedAvg === 0 && usedStockRes && usedStockRes.statusCode === 200 && usedStockRes.data && usedStockRes.data.data) {
        bricklinkUsedAvg = parseFloat(usedStockRes.data.data.qty_avg_price || usedStockRes.data.data.avg_price) || 0;
      }
      if (bricklinkNewAvg === 0 && newStockRes && newStockRes.statusCode === 200 && newStockRes.data && newStockRes.data.data) {
        bricklinkNewAvg = parseFloat(newStockRes.data.data.qty_avg_price || newStockRes.data.data.avg_price) || 0;
      }
    }

    // Wenn absolut gar keine Marktdaten auffindbar sind
    if (bricklinkUsedAvg === 0 && bricklinkNewAvg === 0) {
      return {
        statusCode: 404,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        body: JSON.stringify({ error: `Für das Set "${setNumber}" liegen aktuell keine Marktdaten vor.` })
      }; geglueckt
    }

    // Automatische Berechnung des jeweils fehlenden Wertes
    if (bricklinkNewAvg === 0) bricklinkNewAvg = bricklinkUsedAvg * 1.35;
    if (bricklinkUsedAvg === 0) bricklinkUsedAvg = bricklinkNewAvg / 1.35;

  } catch (error) {
    return getMaintenanceResponse();
  }

  // Reguläre Preiskalkulation (wie in deiner aktuellen Version)
  let tierMultiplier = 1.0;
  let detectedTier = "Standard";

  if (bricklinkUsedAvg < 50) {
    tierMultiplier = 0.75;
    detectedTier = "Klein (< 50 €)";
  } else if (bricklinkUsedAvg > 200 || legoSetName.includes("UCS") || legoSetName.includes("Ultimate Collector")) {
    tierMultiplier = 1.25;
    detectedTier = "High-End / UCS (> 200 €)";
  }

  const calculatedPrices = { new: {}, used: {} };
  const BASE_FACTORS_NEW = { sealed_light_wear: 0.500, sealed_heavy_wear: 0.470, sealed_damaged: 0.430, opened_bags_light_wear: 0.470, opened_bags_heavy_wear: 0.440, opened_bags_damaged: 0.400 };
  const BASE_FACTORS_USED = { no_instructions_no_box_light: 0.325, no_instructions_no_box_medium: 0.306, no_instructions_no_box_heavy: 0.278, with_instructions_no_box_light: 0.334, with_instructions_no_box_medium: 0.317, with_instructions_no_box_heavy: 0.286, no_instructions_with_box_light: 0.332, no_instructions_with_box_medium: 0.312, no_instructions_with_box_heavy: 0.284, with_instructions_and_box_light: 0.343, with_instructions_and_box_medium: 0.323, with_instructions_and_box_heavy: 0.293 };

  for (const [key, factor] of Object.entries(BASE_FACTORS_NEW)) {
    calculatedPrices.new[key] = Math.round(bricklinkNewAvg * Math.min(factor * tierMultiplier, 0.60));
  }
  for (const [key, factor] of Object.entries(BASE_FACTORS_USED)) {
    calculatedPrices.used[key] = Math.round(bricklinkUsedAvg * Math.min(factor * tierMultiplier, 0.50));
  }

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    body: JSON.stringify({
      set: setNumber,
      name: legoSetName,
      tier: detectedTier, 
      marketPrices: { new: bricklinkNewAvg, used: bricklinkUsedAvg },
      prices: calculatedPrices
    })
  };
};

function getMaintenanceResponse() {
  return {
    statusCode: 503,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    body: JSON.stringify({ 
      error: "🔧 <strong>BrickLink führt gerade Wartungsarbeiten durch</strong>.<br><br>Unser Live-Rechner ist in Kürze wieder da! Du kannst uns deine Liste in der Zwischenzeit gerne direkt per <a href='https://wa.me/491791549957' target='_blank'>WhatsApp (0179 1549957)</a> schicken." 
    })
  };
}
