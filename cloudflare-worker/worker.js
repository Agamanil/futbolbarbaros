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
    if (!/^\d{5,20}$/.test(id)) return json({ ok: false, error: 'Geçersiz ESPN maç ID' }, 400);

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
  },
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runAutomaticNotifications(env));
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
    scope: 'https://www.googleapis.com/auth/cloud-platform',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600
  };
  const unsigned = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(claims))}`;

  const pem = serviceAccount.private_key
    .replace(/-----BEGIN PRIVATE KEY-----/g, '')
    .replace(/-----END PRIVATE KEY-----/g, '')
    .replace(/\s/g, '');
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
  return btoa(binary).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' }
  });
}

// Cloudflare Cron ile otomatik bildirim taraması.
const FIRESTORE_ROOT = "https://firestore.googleapis.com/v1/projects/" + FIREBASE_PROJECT_ID + "/databases/(default)/documents";

function fsValue(v) {
  if (!v) return null;
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.integerValue !== undefined) return Number(v.integerValue);
  if (v.doubleValue !== undefined) return Number(v.doubleValue);
  if (v.booleanValue !== undefined) return v.booleanValue;
  if (v.timestampValue !== undefined) return v.timestampValue;
  if (v.arrayValue) return (v.arrayValue.values || []).map(fsValue);
  if (v.mapValue) return fsFields(v.mapValue.fields || {});
  return null;
}
function fsFields(fields) {
  const out = {};
  for (const key of Object.keys(fields || {})) out[key] = fsValue(fields[key]);
  return out;
}
function fsWrite(v) {
  if (typeof v === "string") return { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(fsWrite) } };
  return { nullValue: "NULL_VALUE" };
}
async function fsList(path, token) {
  const response = await fetch(FIRESTORE_ROOT + "/" + path + "?pageSize=1000", {
    headers: { Authorization: "Bearer " + token }
  });
  if (!response.ok) throw new Error("Firestore listeleme HTTP " + response.status);
  const data = await response.json();
  return (data.documents || []).map(doc => ({
    id: doc.name.split("/").pop(),
    ...fsFields(doc.fields || {})
  }));
}
async function fsGet(path, token) {
  const response = await fetch(FIRESTORE_ROOT + "/" + path, {
    headers: { Authorization: "Bearer " + token }
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error("Firestore okuma HTTP " + response.status);
  const data = await response.json();
  return fsFields(data.fields || {});
}
async function fsSaveState(code, state, token) {
  const fields = {
    sentStarts: fsWrite(state.sentStarts.slice(-500)),
    sentResults: fsWrite(state.sentResults.slice(-500)),
    sentBonuses: fsWrite(state.sentBonuses.slice(-500)),
    lastPlaceDay: fsWrite(state.lastPlaceDay || "")
  };
  const query = Object.keys(fields).map(key => "updateMask.fieldPaths=" + key).join("&");
  const response = await fetch(FIRESTORE_ROOT + "/notificationState/" + encodeURIComponent(code) + "?" + query, {
    method: "PATCH",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify({ fields })
  });
  if (!response.ok) throw new Error("Bildirim durumu kaydedilemedi: HTTP " + response.status);
}
function fsTime(value) {
  const n = Date.parse(value || "");
  return Number.isFinite(n) ? n : 0;
}
function localDay(date) {
  const p = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Istanbul", year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(date);
  const get = type => p.find(x => x.type === type).value;
  return get("year") + "-" + get("month") + "-" + get("day");
}
function previousDay(key) {
  const a = key.split("-").map(Number);
  const d = new Date(Date.UTC(a[0], a[1] - 1, a[2] - 1));
  return d.getUTCFullYear() + "-" + String(d.getUTCMonth() + 1).padStart(2, "0") + "-" + String(d.getUTCDate()).padStart(2, "0");
}
function finished(m) {
  return m.homeScore !== undefined && m.awayScore !== undefined;
}
async function sendAuto(tokens, title, body, accessToken) {
  const unique = [...new Set(tokens)].filter(x => typeof x === "string" && x.length >= 100);
  for (let i = 0; i < unique.length; i += 20) {
    await Promise.all(unique.slice(i, i + 20).map(token => fetch(
      "https://fcm.googleapis.com/v1/projects/" + FIREBASE_PROJECT_ID + "/messages:send",
      {
        method: "POST",
        headers: { Authorization: "Bearer " + accessToken, "Content-Type": "application/json" },
        body: JSON.stringify({ message: {
          token,
          notification: { title, body },
          webpush: { fcmOptions: { link: "https://agamanil.github.io/futbolbarbaros/" } }
        } })
      }
    )));
  }
}
async function getRiskPoints(code, matches, token) {
  const points = new Map();
  for (const match of matches) {
    const base = "groups/" + encodeURIComponent(code) + "/matches/" + encodeURIComponent(match.id) + "/risks";
    const risks = await fsList(base, token);
    for (const risk of risks) {
      if (risk.status !== "resolved" || typeof risk.outcome !== "boolean") continue;
      const people = await fsList(base + "/" + encodeURIComponent(risk.id) + "/participants", token);
      for (const person of people) {
        const correct = (person.choice === "yes") === risk.outcome;
        const score = correct ? Number(risk.plusPoints || 0) : Number(risk.minusPoints || 0);
        points.set(person.uid, (points.get(person.uid) || 0) + score);
      }
    }
  }
  return points;
}
async function runAutomaticNotifications(env) {
  if (!env.FIREBASE_SERVICE_ACCOUNT) return console.error("FIREBASE_SERVICE_ACCOUNT secret eksik.");
  try {
    const account = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT);
    if (account.project_id !== FIREBASE_PROJECT_ID || !account.client_email || !account.private_key) {
      throw new Error("Firebase servis hesabı geçersiz.");
    }
    const accessToken = await createFirebaseAccessToken(account);
    const [groups, tokens] = await Promise.all([fsList("groups", accessToken), fsList("pushTokens", accessToken)]);
    const now = Date.now();
    const today = localDay(new Date(now));
    for (const group of groups) {
      const code = group.id;
      try {
        const [matches, players, bonuses, oldState] = await Promise.all([
          fsList("groups/" + encodeURIComponent(code) + "/matches", accessToken),
          fsList("groups/" + encodeURIComponent(code) + "/players", accessToken),
          fsList("groups/" + encodeURIComponent(code) + "/bonusSelections", accessToken),
          fsGet("notificationState/" + encodeURIComponent(code), accessToken)
        ]);
        const groupTokens = tokens.filter(x => x.token && Array.isArray(x.groupCodes) && x.groupCodes.includes(code)).map(x => x.token);
        const starts = new Set(Array.isArray(oldState && oldState.sentStarts) ? oldState.sentStarts : matches.filter(m => fsTime(m.kickoff) <= now).map(m => m.id));
        const results = new Set(Array.isArray(oldState && oldState.sentResults) ? oldState.sentResults : matches.filter(finished).map(m => m.id));
        const bonusDone = new Set(Array.isArray(oldState && oldState.sentBonuses) ? oldState.sentBonuses : bonuses.map(b => b.id));
        let lastPlaceDay = oldState && oldState.lastPlaceDay || "";

        for (const match of matches) {
          const kickoff = fsTime(match.kickoff);
          if (kickoff && kickoff <= now && kickoff > now - 10 * 60 * 1000 && !starts.has(match.id)) {
            await sendAuto(groupTokens, "⚽ Maç başladı!", (match.homeTeam || "Ev sahibi") + " - " + (match.awayTeam || "Deplasman") + " başladı.", accessToken);
            starts.add(match.id);
          }
          if (finished(match) && match.resultAt && !results.has(match.id)) {
            await sendAuto(groupTokens, "🏁 Maç sonucu açıklandı", (match.homeTeam || "Ev sahibi") + " " + match.homeScore + "-" + match.awayScore + " " + (match.awayTeam || "Deplasman") + " · Puan tablosu güncellendi.", accessToken);
            results.add(match.id);
          }
        }
        for (const bonus of bonuses) {
          if (bonusDone.has(bonus.id)) continue;
          await sendAuto(groupTokens, "⭐ Yeni bonus maçı seçildi!", (bonus.playerName || "Sonuncu") + " " + (bonus.homeTeam || "Ev sahibi") + " - " + (bonus.awayTeam || "Deplasman") + " maçını seçti. Puanlar 2X!", accessToken);
          bonusDone.add(bonus.id);
        }

        const todayMatches = matches.filter(m => fsTime(m.kickoff) && localDay(new Date(fsTime(m.kickoff))) === today);
        if (todayMatches.length && todayMatches.every(finished) && lastPlaceDay !== today && players.length) {
          const riskPoints = await getRiskPoints(code, matches, accessToken);
          const bonusIds = new Set(bonuses.map(b => b.matchId));
          const standings = players.map(player => {
            let pts = riskPoints.get(player.id) || 0;
            for (const match of matches) {
              if (!finished(match)) continue;
              const prediction = match.predictions && match.predictions[player.id];
              if (!prediction) continue;
              const exact = prediction.home === match.homeScore && prediction.away === match.awayScore;
              const same = Math.sign(match.homeScore - match.awayScore) === Math.sign(prediction.home - prediction.away);
              pts += (exact ? 3 : same ? 1 : 0) * (bonusIds.has(match.id) ? 2 : 1);
            }
            return { id: player.id, name: player.name, pts };
          });
          const lowest = Math.min(...standings.map(p => p.pts));
          const yesterday = previousDay(today);
          const selectedYesterday = new Set(bonuses.filter(b => b.selectionDay === yesterday).map(b => b.uid));
          const eligible = standings.filter(p => p.pts === lowest && !selectedYesterday.has(p.id));
          const ids = new Set(eligible.map(p => p.id));
          const personalTokens = tokens.filter(x => x.token && ids.has(x.uid) && Array.isArray(x.groupCodes) && x.groupCodes.includes(code)).map(x => x.token);
          if (eligible.length) await sendAuto(personalTokens, "📉 Günün sonuncusu belli oldu!", "Sonuncu: " + eligible.map(p => p.name || "Oyuncu").join(", ") + ". Yarın için bonus maç seçme hakkı sende!", accessToken);
          lastPlaceDay = today;
        }
        await fsSaveState(code, {
          sentStarts: [...starts], sentResults: [...results], sentBonuses: [...bonusDone], lastPlaceDay
        }, accessToken);
      } catch (error) {
        console.error("Otomatik bildirim " + code + ":", error);
      }
    }
  } catch (error) {
    console.error("Otomatik bildirim taraması:", error);
  }
}
