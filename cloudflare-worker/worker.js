const SITE_ORIGIN = 'https://agamanil.github.io';
const FIREBASE_PROJECT_ID = 'futbolbarbarosdenemesi';
const FIREBASE_API_KEY = 'AIzaSyCNpVWp9mughfYhzxV-93xaJ8O7rr_SOGY';
const FIREBASE_ADMIN_UID = 'MUxQ8O20qXa5DzWB7LTMMjilJ0Y2';

const corsHeaders = {
  'Access-Control-Allow-Origin': SITE_ORIGIN,
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Vary': 'Origin'
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    if (request.method === 'POST') {
      if (request.headers.get('Origin') !== SITE_ORIGIN) {
        return json({ ok: false, error: 'Origin not allowed' }, 403);
      }
      return handleNotification(request, env);
    }

    if (request.method !== 'GET') return json({ ok: false, error: 'GET or POST only' }, 405);

    const id = url.searchParams.get('event') || '';
    if (!/^\\d{5,20}$/.test(id)) return json({ ok: false, error: 'Geçersiz ESPN maç ID' }, 400);

    const leagues = ['tur.1','eng.1','esp.1','ger.1','ita.1','uefa.champions','uefa.europa','uefa.europa.conf','uefa.nations'];
    for (const league of leagues) {
      try {
        const endpoint = `https://site.api.espn.com/apis/site/v2/sports/soccer/${league}/summary?event=${encodeURIComponent(id)}`;
        const response = await fetch(endpoint, { headers: { 'Accept': 'application/json', 'User-Agent': 'FUTBOLBARBAROS/1.0' } });
        if (!response.ok) continue;
        const data = await response.json();
        const header = data.header || {};
        if (String(header.id || '') !== id) continue;
        const comp = (header.competitions || []).find(x => x.competitors?.length >= 2);
        if (!comp) continue;
        const home = comp.competitors.find(x => x.homeAway === 'home');
        const away = comp.competitors.find(x => x.homeAway === 'away');
        if (!home || !away || !header.competitions?.[0]?.date) continue;
        const kickoff = header.competitions[0].date || comp.date || header.season?.startDate;
        if (!kickoff) continue;
        return json({ ok: true, match: { espnId: id, homeTeam: home.team?.displayName || home.team?.name || home.displayName, awayTeam: away.team?.displayName || away.team?.name || away.displayName, competition: comp.series?.title || data.leagues?.[0]?.name || header.season?.name || 'Futbol', kickoff, leagueCode: league } });
      } catch (e) { /* Try the next ESPN competition code. */ }
    }
    return json({ ok: false, error: 'Bu ID seçili ESPN liglerinde bulunamadı veya maç bilgisi henüz yayınlanmadı.' }, 404);
  }
};

async function handleNotification(request, env) {
  try {
    if (!env.FIREBASE_SERVICE_ACCOUNT) {
      return json({ ok: false, error: 'Cloudflare Worker FIREBASE_SERVICE_ACCOUNT secret ayarlanmamış.' }, 500);
    }

    const body = await request.json();
    const title = String(body.title || '').trim().slice(0, 80);
    const messageBody = String(body.body || '').trim().slice(0, 220);
    const idToken = String(body.idToken || '');
    const tokens = [...new Set(Array.isArray(body.tokens) ? body.tokens : [])]
      .filter(token => typeof token === 'string' && token.length >= 100 && token.length <= 4096);

    if (!title || !messageBody) return json({ ok: false, error: 'Başlık ve mesaj zorunludur.' }, 400);
    if (!idToken) return json({ ok: false, error: 'Firebase oturum doğrulaması eksik.' }, 401);
    if (!tokens.length) return json({ ok: false, error: 'Bildirim alıcısı bulunamadı.' }, 400);
    if (tokens.length > 100) return json({ ok: false, error: 'Tek gönderimde en fazla 100 cihaz seçilebilir.' }, 400);

    // Firebase ID tokenini Google Identity Toolkit üzerinden doğrula.
    const identityResponse = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${FIREBASE_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken })
      }
    );
    if (!identityResponse.ok) return json({ ok: false, error: 'Firebase oturumu doğrulanamadı.' }, 401);
    const identity = await identityResponse.json();
    if (identity.users?.[0]?.localId !== FIREBASE_ADMIN_UID) {
      return json({ ok: false, error: 'Bildirim gönderme yetkisi yalnızca yöneticide.' }, 403);
    }

    const serviceAccount = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT);
    if (serviceAccount.project_id !== FIREBASE_PROJECT_ID || !serviceAccount.client_email || !serviceAccount.private_key) {
      return json({ ok: false, error: 'Firebase servis hesabı bilgileri geçersiz.' }, 500);
    }

    const accessToken = await createFirebaseAccessToken(serviceAccount);
    const targetUrl = typeof body.url === 'string' && body.url.startsWith('https://agamanil.github.io/')
      ? body.url
      : 'https://agamanil.github.io/futbolbarbaros/';

    let sent = 0;
    let failed = 0;
    const errors = [];

    // Küçük gruplar halinde göndererek API'yi gereksiz yere yükleme.
    for (let i = 0; i < tokens.length; i += 20) {
      const batch = tokens.slice(i, i + 20);
      const results = await Promise.all(batch.map(async token => {
        const response = await fetch(
          `https://fcm.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/messages:send`,
          {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${accessToken}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              message: {
                token,
                notification: { title, body: messageBody },
                webpush: { fcmOptions: { link: targetUrl } }
              }
            })
          }
        );
        if (response.ok) return { ok: true };
        const detail = await response.json().catch(() => ({}));
        return { ok: false, error: detail.error?.message || `FCM HTTP ${response.status}` };
      }));

      for (const result of results) {
        if (result.ok) sent++;
        else {
          failed++;
          if (errors.length < 5) errors.push(result.error);
        }
      }
    }

    return json({ ok: true, sent, failed, errors });
  } catch (error) {
    return json({ ok: false, error: error?.message || 'Bildirim gönderimi başarısız.' }, 500);
  }
}

async function createFirebaseAccessToken(serviceAccount) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claims = {
    iss: serviceAccount.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600
  };
  const unsigned = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(claims))}`;

  const pem = serviceAccount.private_key
    .replace(/-----BEGIN PRIVATE KEY-----/g, '')
    .replace(/-----END PRIVATE KEY-----/g, '')
    .replace(/\\s/g, '');
  const der = Uint8Array.from(atob(pem), char => char.charCodeAt(0));
  const key = await crypto.subtle.importKey(
    'pkcs8',
    der,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    new TextEncoder().encode(unsigned)
  );
  const assertion = `${unsigned}.${base64UrlBytes(new Uint8Array(signature))}`;

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion
    })
  });
  const result = await response.json();
  if (!response.ok || !result.access_token) {
    throw new Error(result.error_description || result.error || 'Firebase erişim anahtarı alınamadı.');
  }
  return result.access_token;
}

function base64Url(value) {
  return base64UrlBytes(new TextEncoder().encode(value));
}

function base64UrlBytes(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, '').replace(/\\+/g, '-').replace(/\\//g, '_');
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' }
  });
}
