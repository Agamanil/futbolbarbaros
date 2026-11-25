
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

      const body = await request.clone().json().catch(() => ({}));

      if (body.action === 'adminLogin') return handleAdminLogin(body, env);
      if (body.action === 'createAccountTransfer') return handleCreateAccountTransfer(body, env);
      if (body.action === 'redeemAccountTransfer') return handleRedeemAccountTransfer(body, env);

      return handleNotification(request, env);
    }

    if (request.method !== 'GET') return json({ ok: false, error: 'GET or POST only' }, 405);

    const id = url.searchParams.get('event') || '';
    if (!/^\d{5,20}$/.test(id)) return json({ ok: false, error: 'Geçersiz ESPN maç ID' }, 400);

    const leagues = ['tur.1','eng.1','esp.1','ger.1','ita.1','uefa.champions','uefa.europa','uefa.europa.conf','uefa.nations'];

    for (const league of leagues) {
      try {
        const endpoint = `https://site.api.espn.com/apis/site/v2/sports/soccer/${league}/summary?event=${encodeURIComponent(id)}`;
        const response = await fetch(endpoint, {
          headers: { 'Accept': 'application/json', 'User-Agent': 'FUTBOLBARBAROS/1.0' }
        });

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

        return json({
          ok: true,
          match: {
            espnId: id,
            homeTeam: home.team?.displayName || home.team?.name || home.displayName,
            awayTeam: away.team?.displayName || away.team?.name || away.displayName,
            competition: comp.series?.title || data.leagues?.[0]?.name || header.season?.name || 'Futbol',
            kickoff,
            leagueCode: league
          }
        });
      } catch (e) {
        // Sıradaki ESPN ligini dene.
      }
    }

    return json({ ok: false, error: 'Bu ID seçili ESPN liglerinde bulunamadı veya maç bilgisi henüz yayınlanmadı.' }, 404);
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runAutomaticNotifications(env));
    ctx.waitUntil(runMediaAutomation(env));
  }
};

const TRANSFER_COLLECTION = "accountTransfers";
const MAX_TRANSFER_WRITES = 450;

function firestorePath(path) {
  return path.split("/").map(encodeURIComponent).join("/");
}

function firestoreDocumentUrl(path) {
  return FIRESTORE_ROOT + "/" + firestorePath(path);
}

/* 429 ve geçici sunucu hatalarında bekleyip yeniden dene. */
async function firestoreFetchWithRetry(url, options = {}, maxAttempts = 7) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const response = await fetch(url, options);

    if (![429, 500, 502, 503, 504].includes(response.status)) {
      return response;
    }

    if (attempt === maxAttempts - 1) {
      return response;
    }

    const retryAfter = Number(response.headers.get("Retry-After"));

    const delay = retryAfter > 0
      ? retryAfter * 1000
      : Math.min(1000 * Math.pow(2, attempt), 15000);

    await new Promise(resolve => setTimeout(resolve, delay));
  }
}

async function verifyFirebaseIdToken(idToken) {
  if (typeof idToken !== "string" || !idToken) {
    throw new Error("Oturum doğrulaması eksik.");
  }

  const response = await fetch(
    "https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=" + FIREBASE_API_KEY,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idToken })
    }
  );

  if (!response.ok) throw new Error("Firebase oturumu doğrulanamadı.");

  const data = await response.json();
  const user = data.users && data.users[0];

  if (!user || !user.localId) {
    throw new Error("Firebase kullanıcı kimliği alınamadı.");
  }

  return user.localId;
}

function constantTimeStringEqual(a, b) {
  const left = new TextEncoder().encode(String(a || ""));
  const right = new TextEncoder().encode(String(b || ""));
  let diff = left.length ^ right.length;
  const size = Math.max(left.length, right.length);
  for (let i = 0; i < size; i++) {
    diff |= (left[i % (left.length || 1)] || 0) ^ (right[i % (right.length || 1)] || 0);
  }
  return diff === 0;
}

async function createAdminCustomToken(serviceAccount) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claims = {
    iss: serviceAccount.client_email,
    sub: serviceAccount.client_email,
    aud: "https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit",
    iat: now,
    exp: now + 3600,
    uid: FIREBASE_ADMIN_UID,
    claims: { admin: true }
  };
  const unsigned = base64Url(JSON.stringify(header)) + "." + base64Url(JSON.stringify(claims));
  const pem = serviceAccount.private_key
    .replace(/-----BEGIN PRIVATE KEY-----/g, "")
    .replace(/-----END PRIVATE KEY-----/g, "")
    .replace(/\s/g, "");
  const der = Uint8Array.from(atob(pem), char => char.charCodeAt(0));
  const key = await crypto.subtle.importKey(
    "pkcs8",
    der,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(unsigned)
  );
  return unsigned + "." + base64UrlBytes(new Uint8Array(signature));
}

async function handleAdminLogin(body, env) {
  try {
    if (!env.ADMIN_PANEL_PASSWORD) {
      throw new Error("Cloudflare ADMIN_PANEL_PASSWORD secret ayarlanmamış.");
    }
    if (body.username !== "Agamanil(patron)" ||
        !constantTimeStringEqual(body.password, env.ADMIN_PANEL_PASSWORD)) {
      return json({ ok: false, error: "Yönetici adı veya şifre hatalı." }, 401);
    }
    if (!env.FIREBASE_SERVICE_ACCOUNT) {
      throw new Error("Firebase servis hesabı Worker'da ayarlanmamış.");
    }
    const account = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT);
    if (account.project_id !== FIREBASE_PROJECT_ID || !account.client_email || !account.private_key) {
      throw new Error("Firebase servis hesabı bilgileri geçersiz.");
    }
    const customToken = await createAdminCustomToken(account);
    return json({ ok: true, customToken });
  } catch (error) {
    return json({ ok: false, error: error.message || "Yönetici girişi başarısız." }, 500);
  }
}

async function getTransferAccessToken(env) {
  if (!env.FIREBASE_SERVICE_ACCOUNT) {
    throw new Error("Cloudflare Worker servis hesabı ayarlanmamış.");
  }

  const account = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT);

  if (account.project_id !== FIREBASE_PROJECT_ID || !account.client_email || !account.private_key) {
    throw new Error("Firebase servis hesabı bilgileri geçersiz.");
  }

  return createFirebaseAccessToken(account);
}

async function firestoreGetRaw(path, token) {
  const response = await firestoreFetchWithRetry(firestoreDocumentUrl(path), {
    headers: { Authorization: "Bearer " + token }
  });

  if (response.status === 404) return null;

  if (!response.ok) {
    throw new Error("Firestore okuma hatası (" + response.status + "): " + path);
  }

  return response.json();
}

async function firestoreListRaw(path, token) {
  const output = [];
  let pageToken = "";

  do {
    const url = FIRESTORE_ROOT + "/" + firestorePath(path) + "?pageSize=1000" +
      (pageToken ? "&pageToken=" + encodeURIComponent(pageToken) : "");

    const response = await firestoreFetchWithRetry(url, {
      headers: { Authorization: "Bearer " + token }
    });

    if (!response.ok) {
      throw new Error("Firestore listeleme hatası (" + response.status + "): " + path);
    }

    const data = await response.json();

    output.push(...(data.documents || []));
    pageToken = data.nextPageToken || "";

    if (output.length > 5000) {
      throw new Error("Aktarım güvenliği için tek koleksiyonda 5000 kayıt sınırı aşıldı.");
    }
  } while (pageToken);

  return output;
}

async function firestoreCommit(writes, token) {
  if (!writes.length) return;

  const response = await fetch(FIRESTORE_ROOT + ":commit", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ writes })
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error("Hesap aktarımı kaydedilemedi (" + response.status + "). " + detail.slice(0, 300));
  }

  return response.json();
}

function rawString(document, key) {
  return document && document.fields && document.fields[key]
    ? document.fields[key].stringValue || "" : "";
}

function rawBoolean(document, key) {
  return Boolean(document && document.fields && document.fields[key] && document.fields[key].booleanValue);
}

function rawTimestamp(document, key) {
  return document && document.fields && document.fields[key]
    ? Date.parse(document.fields[key].timestampValue || "") || 0 : 0;
}

function cloneFields(document) {
  return JSON.parse(JSON.stringify(document.fields || {}));
}

function setRawString(fields, key, value) {
  fields[key] = { stringValue: value };
}

function setRawBoolean(fields, key, value) {
  fields[key] = { booleanValue: value };
}

/* Firestore commit için tam URL değil, resource name kullanılır. */
function writeCreate(path, fields) {
  return {
    update: {
      name: "projects/" + FIREBASE_PROJECT_ID + "/databases/(default)/documents/" + firestorePath(path),
      fields
    },
    currentDocument: { exists: false }
  };
}

function writeDelete(document) {
  return {
    delete: document.name,
    currentDocument: document.updateTime ? { updateTime: document.updateTime } : { exists: true }
  };
}

function writePatch(document, fields, fieldPaths) {
  return {
    update: { name: document.name, fields },
    updateMask: { fieldPaths },
    currentDocument: document.updateTime ? { updateTime: document.updateTime } : { exists: true }
  };
}

async function isAccountRestricted(uid, token) {
  const record = await firestoreGetRaw("userModeration/" + uid, token);

  if (!record) return false;
  if (rawBoolean(record, "banned")) return true;

  const timeout = rawTimestamp(record, "timeoutUntil");
  return timeout > Date.now();
}

function normalizeTransferCode(value) {
  return String(value || "").trim().toUpperCase().replace(/\s+/g, "");
}

async function transferCodeHash(code) {
  const normalized = normalizeTransferCode(code);

  if (!/^FB-[A-F0-9]{8}(?:-[A-F0-9]{8}){3}$/.test(normalized)) {
    throw new Error("Aktarım kodunun biçimi geçersiz.");
  }

  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(normalized));

  return [...new Uint8Array(digest)]
    .map(x => x.toString(16).padStart(2, "0"))
    .join("");
}

function makeTransferCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const hex = [...bytes].map(x => x.toString(16).padStart(2, "0")).join("").toUpperCase();

  return "FB-" + hex.match(/.{8}/g).join("-");
}

function transferJsonError(error, status = 400) {
  return json({
    ok: false,
    error: error && error.message ? error.message : "Hesap aktarımı tamamlanamadı."
  }, status);
}

async function handleCreateAccountTransfer(body, env) {
  try {
    const oldUid = await verifyFirebaseIdToken(body.idToken);

    if (oldUid === FIREBASE_ADMIN_UID) {
      return json({
        ok: false,
        error: "Yönetici hesabı aktarım koduyla taşınamaz; yönetici yetkisi sabit UID'ye bağlı."
      }, 403);
    }

    const token = await getTransferAccessToken(env);

    if (await isAccountRestricted(oldUid, token)) {
      return json({
        ok: false,
        error: "Kısıtlı hesaplar için aktarım kodu oluşturulamıyor."
      }, 403);
    }

    const code = makeTransferCode();
    const hash = await transferCodeHash(code);
    const now = Date.now();
    const expiresAt = new Date(now + 24 * 60 * 60 * 1000).toISOString();

    const previous = await firestoreListRaw(TRANSFER_COLLECTION, token);
    const writes = [];

    for (const item of previous) {
      if (rawString(item, "oldUid") !== oldUid || rawBoolean(item, "used") || rawBoolean(item, "revoked")) continue;

      const fields = cloneFields(item);
      setRawBoolean(fields, "revoked", true);

      writes.push({
        update: { name: item.name, fields },
        currentDocument: item.updateTime ? { updateTime: item.updateTime } : { exists: true }
      });
    }

    writes.push(writeCreate(TRANSFER_COLLECTION + "/" + hash, {
      oldUid: { stringValue: oldUid },
      createdAt: { timestampValue: new Date(now).toISOString() },
      expiresAt: { timestampValue: expiresAt },
      used: { booleanValue: false },
      revoked: { booleanValue: false }
    }));

    await firestoreCommit(writes, token);

    return json({ ok: true, code, expiresAt });
  } catch (error) {
    return transferJsonError(error, 400);
  }
}

function replaceUidInArrayField(fields, key, oldUid, newUid) {
  const value = fields[key];
  const values = value && value.arrayValue && value.arrayValue.values;

  if (!Array.isArray(values)) return false;

  let changed = false;

  fields[key].arrayValue.values = values.map(item => {
    if (item && item.stringValue === oldUid) {
      changed = true;
      return { stringValue: newUid };
    }
    return item;
  });

  return changed;
}

async function handleRedeemAccountTransfer(body, env) {
  try {
    const newUid = await verifyFirebaseIdToken(body.idToken);

    if (newUid === FIREBASE_ADMIN_UID) {
      return json({
        ok: false,
        error: "Yönetici oturumu başka bir oyuncu hesabına aktarılamaz."
      }, 403);
    }

    const hash = await transferCodeHash(body.code);
    const token = await getTransferAccessToken(env);
    const transfer = await firestoreGetRaw(TRANSFER_COLLECTION + "/" + hash, token);

    if (!transfer) throw new Error("Aktarım kodu bulunamadı.");
    if (rawBoolean(transfer, "used")) throw new Error("Bu aktarım kodu daha önce kullanılmış.");
    if (rawBoolean(transfer, "revoked")) throw new Error("Bu aktarım kodu iptal edilmiş. Eski tarayıcıdan yeni kod oluştur.");
    if (rawTimestamp(transfer, "expiresAt") <= Date.now()) throw new Error("Aktarım kodunun süresi dolmuş. Eski tarayıcıdan yeni kod oluştur.");

    const oldUid = rawString(transfer, "oldUid");

    if (!oldUid || oldUid === newUid) {
      throw new Error("Bu kod farklı bir tarayıcıdaki hesap için kullanılmalı.");
    }

    if (await isAccountRestricted(oldUid, token) || await isAccountRestricted(newUid, token)) {
      return json({ ok: false, error: "Kısıtlı hesaplar arasında aktarım yapılamaz." }, 403);
    }

    const groupDocs = await firestoreListRaw("groups", token);
    const groupCodes = groupDocs.map(item => item.name.split("/").pop());

    const writes = [];
    const transferredGroups = [];

    let movedPredictions = 0;
    let movedBonuses = 0;
    let movedRisks = 0;
    let movedSeasonRecords = 0;

    for (const code of groupCodes) {
      const targetPlayer = await firestoreGetRaw("groups/" + code + "/players/" + newUid, token);

      if (targetPlayer) {
        throw new Error("Bu tarayıcıda zaten bir lig oyuncu kaydı var. Aktarım için boş bir tarayıcı hesabı gerekli.");
      }
    }

    if (await firestoreGetRaw("users/" + newUid, token)) {
      throw new Error("Bu tarayıcı hesabında profil kaydı zaten var. Mevcut hesabın üzerine yazılmadı.");
    }

    for (const code of groupCodes) {
      const playerPath = "groups/" + code + "/players/" + oldUid;
      const oldPlayer = await firestoreGetRaw(playerPath, token);

      if (!oldPlayer) continue;

      const playerFields = cloneFields(oldPlayer);
      setRawString(playerFields, "uid", newUid);

      writes.push(writeCreate("groups/" + code + "/players/" + newUid, playerFields));
      writes.push(writeDelete(oldPlayer));

      transferredGroups.push(code);

      const matches = await firestoreListRaw("groups/" + code + "/matches", token);

      for (const match of matches) {
        const predictions = match.fields && match.fields.predictions;
        const predictionFields = predictions && predictions.mapValue && predictions.mapValue.fields;

        if (!predictionFields || !Object.prototype.hasOwnProperty.call(predictionFields, oldUid)) continue;

        if (Object.prototype.hasOwnProperty.call(predictionFields, newUid)) {
          throw new Error(code + " liginde hedef hesap için önceden tahmin var; güvenlik nedeniyle aktarım durduruldu.");
        }

        const next = JSON.parse(JSON.stringify(predictions));
        next.mapValue.fields[newUid] = next.mapValue.fields[oldUid];
        delete next.mapValue.fields[oldUid];

        writes.push(writePatch(match, { predictions: next }, ["predictions"]));
        movedPredictions++;
      }

      const bonuses = await firestoreListRaw("groups/" + code + "/bonusSelections", token);

      for (const bonus of bonuses) {
        if (rawString(bonus, "uid") !== oldUid) continue;

        const oldId = bonus.name.split("/").pop();

        const nextId = oldId.endsWith("_" + oldUid)
          ? oldId.slice(0, -oldUid.length) + newUid
          : oldId;

        const nextFields = cloneFields(bonus);
        setRawString(nextFields, "uid", newUid);

        if (nextId !== oldId) {
          const targetBonus = await firestoreGetRaw("groups/" + code + "/bonusSelections/" + nextId, token);

          if (targetBonus) {
            throw new Error(code + " liginde aynı güne ait bonus kaydı çakışıyor.");
          }

          writes.push(writeCreate("groups/" + code + "/bonusSelections/" + nextId, nextFields));
          writes.push(writeDelete(bonus));
        } else {
          writes.push(writePatch(bonus, { uid: nextFields.uid }, ["uid"]));
        }

        movedBonuses++;
      }

      for (const match of matches) {
        const matchId = match.name.split("/").pop();
        const risks = await firestoreListRaw(
          "groups/" + code + "/matches/" + matchId + "/risks",
          token
        );

        for (const risk of risks) {
          const riskId = risk.name.split("/").pop();

          const participantPath =
            "groups/" + code + "/matches/" + matchId +
            "/risks/" + riskId + "/participants";

          const sourceParticipant = await firestoreGetRaw(participantPath + "/" + oldUid, token);

          if (!sourceParticipant) continue;

          const targetParticipant = await firestoreGetRaw(participantPath + "/" + newUid, token);

          if (targetParticipant) {
            throw new Error(code + " ligindeki risk katılımı hedef hesapla çakışıyor.");
          }

          const participantFields = cloneFields(sourceParticipant);
          setRawString(participantFields, "uid", newUid);

          writes.push(writeCreate(participantPath + "/" + newUid, participantFields));
          writes.push(writeDelete(sourceParticipant));

          movedRisks++;
        }
      }

      const honorDocs = await firestoreListRaw("groups/" + code + "/seasonHonor", token);

      for (const honor of honorDocs) {
        const honorId = honor.name.split("/").pop();
        const honorFields = cloneFields(honor);
        const changedPaths = [];

        for (const key of ["winnerIds", "lastIds", "memberIds"]) {
          if (replaceUidInArrayField(honorFields, key, oldUid, newUid)) {
            changedPaths.push(key);
          }
        }

        if (changedPaths.length) {
          writes.push(writePatch(
            honor,
            Object.fromEntries(changedPaths.map(key => [key, honorFields[key]])),
            changedPaths
          ));
        }

        const sourceMember = await firestoreGetRaw(
          "groups/" + code + "/seasonHonor/" + honorId + "/members/" + oldUid,
          token
        );

        if (sourceMember) {
          const targetMember = await firestoreGetRaw(
            "groups/" + code + "/seasonHonor/" + honorId + "/members/" + newUid,
            token
          );

          if (targetMember) {
            throw new Error(code + " sezon onur kaydında hedef oyuncu zaten bulunuyor.");
          }

          const memberFields = cloneFields(sourceMember);
          setRawString(memberFields, "playerId", newUid);

          writes.push(writeCreate(
            "groups/" + code + "/seasonHonor/" + honorId + "/members/" + newUid,
            memberFields
          ));

          writes.push(writeDelete(sourceMember));
          movedSeasonRecords++;
        }
      }
    }

    const oldProfile = await firestoreGetRaw("users/" + oldUid, token);

    if (oldProfile) {
      writes.push(writeCreate("users/" + newUid, cloneFields(oldProfile)));
      writes.push(writeDelete(oldProfile));
    }

    const oldPushToken = await firestoreGetRaw("pushTokens/" + oldUid, token);

    if (oldPushToken) {
      writes.push(writeDelete(oldPushToken));
    }

    if (writes.length + 1 > MAX_TRANSFER_WRITES) {
      throw new Error("Hesabın çok fazla geçmiş kaydı içeriyor. Güvenli tek seferlik aktarım sınırı aşıldı; yönetici yardımı gerekiyor.");
    }

    const transferFields = cloneFields(transfer);

    setRawBoolean(transferFields, "used", true);
    setRawString(transferFields, "usedBy", newUid);
    transferFields.usedAt = { timestampValue: new Date().toISOString() };

    writes.push({
      update: { name: transfer.name, fields: transferFields },
      currentDocument: transfer.updateTime ? { updateTime: transfer.updateTime } : { exists: true }
    });

    await firestoreCommit(writes, token);

    return json({
      ok: true,
      groupCodes: transferredGroups,
      moved: {
        predictions: movedPredictions,
        bonuses: movedBonuses,
        riskParticipations: movedRisks,
        seasonRecords: movedSeasonRecords
      }
    });
  } catch (error) {
    return transferJsonError(error, 400);
  }
}

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

    const identityResponse = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${FIREBASE_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken })
      }
    );

    if (!identityResponse.ok) {
      return json({ ok: false, error: 'Firebase oturumu doğrulanamadı.' }, 401);
    }

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

        return {
          ok: false,
          error: detail.error?.message || `FCM HTTP ${response.status}`
        };
      }));

      for (const result of results) {
        if (result.ok) {
          sent++;
        } else {
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

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary)
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/json; charset=utf-8'
    }
  });
}

const FIRESTORE_ROOT =
  "https://firestore.googleapis.com/v1/projects/" +
  FIREBASE_PROJECT_ID +
  "/databases/(default)/documents";

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

  for (const key of Object.keys(fields || {})) {
    out[key] = fsValue(fields[key]);
  }

  return out;
}

function fsWrite(v) {
  if (typeof v === "string") return { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(fsWrite) } };
  return { nullValue: "NULL_VALUE" };
}

async function fsList(path, token) {
  const response = await firestoreFetchWithRetry(
    FIRESTORE_ROOT + "/" + path + "?pageSize=1000",
    { headers: { Authorization: "Bearer " + token } }
  );

  if (!response.ok) {
    throw new Error("Firestore listeleme HTTP " + response.status);
  }

  const data = await response.json();

  return (data.documents || []).map(doc => ({
    id: doc.name.split("/").pop(),
    ...fsFields(doc.fields || {})
  }));
}

async function fsGet(path, token) {
  const response = await firestoreFetchWithRetry(
    FIRESTORE_ROOT + "/" + path,
    { headers: { Authorization: "Bearer " + token } }
  );

  if (response.status === 404) return null;

  if (!response.ok) {
    throw new Error("Firestore okuma HTTP " + response.status);
  }

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

  const query = Object.keys(fields)
    .map(key => "updateMask.fieldPaths=" + key)
    .join("&");

  const response = await fetch(
    FIRESTORE_ROOT + "/notificationState/" + encodeURIComponent(code) + "?" + query,
    {
      method: "PATCH",
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ fields })
    }
  );

  if (!response.ok) {
    throw new Error("Bildirim durumu kaydedilemedi: HTTP " + response.status);
  }
}

function fsTime(value) {
  const n = Date.parse(value || "");
  return Number.isFinite(n) ? n : 0;
}

function localDay(date) {
  const p = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Istanbul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);

  const get = type => p.find(x => x.type === type).value;

  return get("year") + "-" + get("month") + "-" + get("day");
}

function previousDay(key) {
  const a = key.split("-").map(Number);
  const d = new Date(Date.UTC(a[0], a[1] - 1, a[2] - 1));

  return d.getUTCFullYear() + "-" +
    String(d.getUTCMonth() + 1).padStart(2, "0") + "-" +
    String(d.getUTCDate()).padStart(2, "0");
}

function finished(m) {
  return m.homeScore !== undefined && m.awayScore !== undefined;
}

async function sendAuto(tokens, title, body, accessToken) {
  const unique = [...new Set(tokens)]
    .filter(x => typeof x === "string" && x.length >= 100);

  for (let i = 0; i < unique.length; i += 20) {
    await Promise.all(unique.slice(i, i + 20).map(token => fetch(
      "https://fcm.googleapis.com/v1/projects/" + FIREBASE_PROJECT_ID + "/messages:send",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer " + accessToken,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          message: {
            token,
            notification: { title, body },
            webpush: {
              fcmOptions: {
                link: "https://agamanil.github.io/futbolbarbaros/"
              }
            }
          }
        })
      }
    )));
  }
}

async function getRiskPoints(code, matches, token) {
  const points = new Map();

  for (const match of matches) {
    const base =
      "groups/" + encodeURIComponent(code) +
      "/matches/" + encodeURIComponent(match.id) +
      "/risks";

    const risks = await fsList(base, token);

    for (const risk of risks) {
      if (risk.status !== "resolved" || typeof risk.outcome !== "boolean") continue;

      const people = await fsList(
        base + "/" + encodeURIComponent(risk.id) + "/participants",
        token
      );

      for (const person of people) {
        const correct = (person.choice === "yes") === risk.outcome;

        const score = correct
          ? Number(risk.plusPoints || 0)
          : Number(risk.minusPoints || 0);

        points.set(
          person.uid,
          (points.get(person.uid) || 0) + score
        );
      }
    }
  }

  return points;
}

async function runAutomaticNotifications(env) {
  // Bildirim taramasini yalnizca maclarin yogun oldugu Istanbul saatlerinde calistir.
  // Cloudflare cron'u daha sik tetiklense bile bu saatler disinda Firestore okunmaz.
  const istanbulHour = Number(new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Istanbul",
    hour: "2-digit",
    hourCycle: "h23"
  }).format(new Date()));

  if (istanbulHour >= 2 && istanbulHour < 19) return;

  if (!env.FIREBASE_SERVICE_ACCOUNT) {
    return console.error("FIREBASE_SERVICE_ACCOUNT secret eksik.");
  }

  try {
    const account = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT);

    if (account.project_id !== FIREBASE_PROJECT_ID || !account.client_email || !account.private_key) {
      throw new Error("Firebase servis hesabı geçersiz.");
    }

    const accessToken = await createFirebaseAccessToken(account);

    const [groups, tokens] = await Promise.all([
      fsList("groups", accessToken),
      fsList("pushTokens", accessToken)
    ]);

    const now = Date.now();
    const today = localDay(new Date(now));

    for (const group of groups) {
      const code = group.id;

      try {
        // Bu ligde push bildirimi alacak cihaz yoksa alt koleksiyonlari tarama.
        const groupTokens = tokens
          .filter(x => x.token && Array.isArray(x.groupCodes) && x.groupCodes.includes(code))
          .map(x => x.token);

        if (!groupTokens.length) continue;

        // Oyuncular yalnizca gunun sonuncusu hesaplanacagi zaman okunacak.
        const [matches, bonuses, oldState] = await Promise.all([
          fsList("groups/" + encodeURIComponent(code) + "/matches", accessToken),
          fsList("groups/" + encodeURIComponent(code) + "/bonusSelections", accessToken),
          fsGet("notificationState/" + encodeURIComponent(code), accessToken)
        ]);

        const starts = new Set(
          Array.isArray(oldState && oldState.sentStarts)
            ? oldState.sentStarts
            : matches.filter(m => fsTime(m.kickoff) <= now).map(m => m.id)
        );

        const results = new Set(
          Array.isArray(oldState && oldState.sentResults)
            ? oldState.sentResults
            : matches.filter(finished).map(m => m.id)
        );

        const bonusDone = new Set(
          Array.isArray(oldState && oldState.sentBonuses)
            ? oldState.sentBonuses
            : bonuses.map(b => b.id)
        );

        let lastPlaceDay = oldState && oldState.lastPlaceDay || "";

        for (const match of matches) {
          const kickoff = fsTime(match.kickoff);

          if (kickoff && kickoff <= now && kickoff > now - 10 * 60 * 1000 && !starts.has(match.id)) {
            await sendAuto(
              groupTokens,
              "⚽ Maç başladı!",
              (match.homeTeam || "Ev sahibi") + " - " +
              (match.awayTeam || "Deplasman") + " başladı.",
              accessToken
            );

            starts.add(match.id);
          }

          if (finished(match) && match.resultAt && !results.has(match.id)) {
            await sendAuto(
              groupTokens,
              "🏁 Maç sonucu açıklandı",
              (match.homeTeam || "Ev sahibi") + " " +
              match.homeScore + "-" + match.awayScore + " " +
              (match.awayTeam || "Deplasman") +
              " · Puan tablosu güncellendi.",
              accessToken
            );

            results.add(match.id);
          }
        }

        for (const bonus of bonuses) {
          if (bonusDone.has(bonus.id)) continue;

          await sendAuto(
            groupTokens,
            "⭐ Yeni bonus maçı seçildi!",
            (bonus.playerName || "Sonuncu") + " " +
            (bonus.homeTeam || "Ev sahibi") + " - " +
            (bonus.awayTeam || "Deplasman") +
            " maçını seçti. Puanlar 2X!",
            accessToken
          );

          bonusDone.add(bonus.id);
        }

        const todayMatches = matches.filter(
          m => fsTime(m.kickoff) &&
          localDay(new Date(fsTime(m.kickoff))) === today
        );

        if (todayMatches.length && todayMatches.every(finished) && lastPlaceDay !== today) {
          const players = await fsList("groups/" + encodeURIComponent(code) + "/players", accessToken);

          if (players.length) {
            const riskPoints = await getRiskPoints(code, matches, accessToken);
            const bonusIds = new Set(bonuses.map(b => b.matchId));
  
            const standings = players.map(player => {
              let pts = riskPoints.get(player.id) || 0;
  
              for (const match of matches) {
                if (!finished(match)) continue;
  
                const prediction = match.predictions && match.predictions[player.id];
                if (!prediction) continue;
  
                const exact =
                  prediction.home === match.homeScore &&
                  prediction.away === match.awayScore;
  
                const same =
                  Math.sign(match.homeScore - match.awayScore) ===
                  Math.sign(prediction.home - prediction.away);
  
                pts += (exact ? 3 : same ? 1 : 0) *
                  (bonusIds.has(match.id) ? 2 : 1);
              }
  
              return { id: player.id, name: player.name, pts };
            });
  
            const lowest = Math.min(...standings.map(p => p.pts));
            const yesterday = previousDay(today);
  
            const selectedYesterday = new Set(
              bonuses.filter(b => b.selectionDay === yesterday).map(b => b.uid)
            );
  
            const eligible = standings.filter(
              p => p.pts === lowest && !selectedYesterday.has(p.id)
            );
  
            const ids = new Set(eligible.map(p => p.id));
  
            const personalTokens = tokens
              .filter(x => x.token && ids.has(x.uid) &&
                Array.isArray(x.groupCodes) && x.groupCodes.includes(code))
              .map(x => x.token);
  
            if (eligible.length) {
              await sendAuto(
                personalTokens,
                "📉 Günün sonuncusu belli oldu!",
                "Sonuncu: " +
                eligible.map(p => p.name || "Oyuncu").join(", ") +
                ". Yarın için bonus maç seçme hakkı sende!",
                accessToken
              );
            }
  
            lastPlaceDay = today;
          }
        }

        await fsSaveState(code, {
          sentStarts: [...starts],
          sentResults: [...results],
          sentBonuses: [...bonusDone],
          lastPlaceDay
        }, accessToken);

      } catch (error) {
        console.error("Otomatik bildirim " + code + ":", error);
      }
    }

  } catch (error) {
    console.error("Otomatik bildirim taraması:", error);
  }
}

// Cloudflare GitHub otomatik dağıtım testi: compatibility date ayarlı.


const MEDIA_MODEL = "@cf/zai-org/glm-4.7-flash";

async function mediaSave(path, values, token) {
  const current = await fsGet(path, token);
  const fields = {};
  Object.keys(values).forEach(key => fields[key] = fsWrite(String(values[key] == null ? "" : values[key])));
  const headers = { Authorization: "Bearer " + token, "Content-Type": "application/json" };
  let response;
  if (current) {
    const mask = Object.keys(fields).map(key => "updateMask.fieldPaths=" + encodeURIComponent(key)).join("&");
    response = await firestoreFetchWithRetry(FIRESTORE_ROOT + "/" + firestorePath(path) + "?" + mask,
      { method: "PATCH", headers, body: JSON.stringify({ fields }) });
  } else {
    const parts = path.split("/");
    const id = parts.pop();
    response = await firestoreFetchWithRetry(FIRESTORE_ROOT + "/" + firestorePath(parts.join("/")) +
      "?documentId=" + encodeURIComponent(id), { method: "POST", headers, body: JSON.stringify({ fields }) });
  }
  if (!response.ok) throw new Error("Firestore medya kaydı HTTP " + response.status);
}

function mediaScore(match, prediction) {
  if (!finished(match) || !prediction) return 0;
  if (Number(prediction.home) === Number(match.homeScore) &&
      Number(prediction.away) === Number(match.awayScore)) return 3;
  return Math.sign(Number(prediction.home) - Number(prediction.away)) ===
    Math.sign(Number(match.homeScore) - Number(match.awayScore)) ? 1 : 0;
}

function mediaEvents(matches) {
  const events = [];
  for (const match of matches) {
    const home = Number(match.homeScore), away = Number(match.awayScore);
    const score = match.homeTeam + " " + home + "-" + away + " " + match.awayTeam;
    if (Math.abs(home - away) >= 4) events.push({ title: "Farklı galibiyet", detail: score });
    if (home === away) events.push({ title: "Beraberlik", detail: score });
    const keyEvents = Array.isArray(match.espnKeyEvents) ? match.espnKeyEvents : [];
    for (const event of keyEvents) {
      const minute = Number(String(event.minute || "").replace(/\D/g, ""));
      if (event.kind === "redCard" || event.kind === "ownGoal" ||
          (event.kind === "goal" && minute >= 85)) {
        events.push({
          title: event.kind === "redCard" ? "Kırmızı kart" :
            event.kind === "ownGoal" ? "Kendi kalesine gol" : "Son dakika golü",
          detail: String(event.player || event.description || "Maçın kritik anı") +
            " · " + score + (event.minute ? " · " + event.minute : "")
        });
      }
    }
  }
  return events.slice(0, 15);
}

async function mediaPhotos(match) {
  const league = String(match.espnLeagueCode || "");
  const id = String(match.espnId || "");
  if (!/^[a-z0-9.]+$/i.test(league) || !/^\d{5,20}$/.test(id)) return [];
  try {
    const response = await fetch("https://site.api.espn.com/apis/site/v2/sports/soccer/" +
      league + "/summary?event=" + id);
    if (!response.ok) return [];
    const data = await response.json();
    const result = [];
    for (const article of (Array.isArray(data.articles) ? data.articles : [])) {
      for (const image of (Array.isArray(article.images) ? article.images : [])) {
        const url = typeof image === "string" ? image : image && (image.url || image.href);
        if (!url || !url.startsWith("https://") || !url.toLowerCase().includes("espn")) continue;
        result.push({
          url,
          alt: String(article.headline || match.homeTeam + " - " + match.awayTeam).slice(0, 140),
          caption: String(article.headline || match.homeTeam + " - " + match.awayTeam).slice(0, 140),
          source: "ESPN",
          sourceUrl: article.links && article.links.web ? (article.links.web.href || "") : ""
        });
        if (result.length >= 2) return result;
      }
    }
    return result;
  } catch (error) {
    console.warn("ESPN fotoğrafı alınamadı:", id, error);
    return [];
  }
}

async function mediaGenerate(env, prompt, facts) {
  const result = await env.AI.run(MEDIA_MODEL, {
    messages: [
      { role: "system", content: prompt },
      { role: "user", content: JSON.stringify(facts) }
    ],
    temperature: 0.7,
    chat_template_kwargs: { enable_thinking: false }
  });
  let output = result && result.response ? result.response : "";
  if (Array.isArray(output)) output = output.map(item => item.text || "").join("");
  output = String(output).trim();
  const first = output.indexOf("{"), last = output.lastIndexOf("}");
  if (first < 0 || last <= first) throw new Error("AI geçerli JSON üretmedi.");
  return JSON.parse(output.slice(first, last + 1));
}

async function publishDailyGazette(env, code, day, matches, token) {
  const base = "groups/" + encodeURIComponent(code);
  const [players, bonuses, photoGroups] = await Promise.all([
    fsList(base + "/players", token),
    fsList(base + "/bonusSelections", token),
    Promise.all(matches.map(mediaPhotos))
  ]);
  const bonusIds = new Set(bonuses.map(item => item.matchId).filter(Boolean));
  const standings = players.map(person => {
    let points = 0, exact = 0;
    for (const match of matches) {
      const basePoints = mediaScore(match, match.predictions && match.predictions[person.id]);
      if (basePoints === 3) exact++;
      points += basePoints * (bonusIds.has(match.id) ? 2 : 1);
    }
    return { name: person.name || "Oyuncu", points, exact };
  }).sort((a,b) => b.points - a.points || a.name.localeCompare(b.name, "tr"));
  const events = mediaEvents(matches);
  const facts = {
    date: day,
    league: code,
    matches: matches.map(match => ({
      home: match.homeTeam, away: match.awayTeam,
      score: String(match.homeScore) + "-" + String(match.awayScore),
      competition: match.competition || "",
      events: Array.isArray(match.espnKeyEvents) ? match.espnKeyEvents.slice(0, 8) : []
    })),
    playerStandings: standings.slice(0, 8),
    notableEvents: events
  };
  const content = await mediaGenerate(env,
    "FUTBOLBARBAROS için günlük Türkçe spor gazetesi yaz. Yalnızca verilen JSON gerçeklerini kullan, skor veya olay uydurma. Mizahi, yaratıcı ve saygılı ol. SADECE JSON döndür: {headline,subheadline,lead,stories:[{title,body}],newspaperWar:[{paper,headline,comment}],tomorrowPreview,photoCaptions}. En fazla 4 haber; basın savaşı tam 3 gazete: Barbaros Spor, Futbol Kaosu, Son Dakika. Fotoğraf URL'si üretme.",
    facts);
  const photos = photoGroups.flat().slice(0, 6);
  const captions = Array.isArray(content.photoCaptions) ? content.photoCaptions : [];
  content.photos = photos.map((photo,index) => ({
    url: photo.url, alt: photo.alt, source: photo.source, sourceUrl: photo.sourceUrl,
    caption: String(captions[index] || photo.caption).slice(0, 150)
  }));
  content.date = day;
  content.playerStandings = facts.playerStandings;
  content.notableEvents = events;
  content.league = code;
  await mediaSave(base + "/dailyMedia/current", {
    date: day, status: "published", payloadJson: JSON.stringify(content),
    publishedAt: new Date().toISOString()
  }, token);

  const group = await fsGet(base, token);
  const seasons = await fsList(base + "/seasons", token);
  const season = seasons.find(item => item.startDate && item.endDate &&
    day >= item.startDate && day <= item.endDate) ||
    seasons.find(item => group && item.id === group.activeSeasonId);
  if (season) {
    await mediaSave(base + "/seasonTimeline/" + encodeURIComponent(season.id + "_" + day), {
      seasonId: season.id, day,
      eventsJson: JSON.stringify(events),
      matchesJson: JSON.stringify(facts.matches.map(item => ({
        home: item.home, away: item.away, score: item.score
      })))
    }, token);
  }
}

async function publishSeasonDocumentary(env, code, season, fixtures, token) {
  const base = "groups/" + encodeURIComponent(code);
  const bonuses = await fsList(base + "/bonusSelections", token);
  const bonusIds = new Set(bonuses.filter(item =>
    item.seasonId === season.id ||
    (!item.seasonId && item.targetDate >= season.startDate && item.targetDate <= season.endDate)
  ).map(item => item.matchId).filter(Boolean));
  const riskPoints = await getRiskPoints(code, fixtures, token);
  const players = await fsList(base + "/players", token);
  const standings = players.map(person => {
    const points = fixtures.reduce((sum, match) => {
      const basePoints = mediaScore(match, match.predictions && match.predictions[person.id]);
      return sum + basePoints * (bonusIds.has(match.id) ? 2 : 1);
    }, 0) + (riskPoints.get(person.id) || 0);
    return { name: person.name || "Oyuncu", points };
  }).sort((a,b) => b.points - a.points || a.name.localeCompare(b.name, "tr"));
  const timeline = await fsList(base + "/seasonTimeline", token);
  const chronology = timeline.filter(item => item.seasonId === season.id)
    .sort((a,b) => String(a.day).localeCompare(String(b.day)))
    .map(item => ({
      day: item.day,
      events: (() => { try { return JSON.parse(item.eventsJson || "[]"); } catch { return []; } })(),
      matches: (() => { try { return JSON.parse(item.matchesJson || "[]"); } catch { return []; } })()
    }));
  const facts = {
    league: code,
    season: { name: season.name || season.id, startDate: season.startDate, endDate: season.endDate },
    matches: fixtures.map(match => ({
      home: match.homeTeam, away: match.awayTeam,
      score: String(match.homeScore) + "-" + String(match.awayScore)
    })),
    finalStandings: standings,
    chronology
  };
  const content = await mediaGenerate(env,
    "FUTBOLBARBAROS sezon belgeselini Türkçe, sinematik, eğlenceli ve saygılı yaz. Gerçek dışı olay veya puan uydurma. SADECE JSON döndür: {title,opening,chapters:[{heading,text}],seasonAwards:[{title,winner,reason}],finale}. 4-6 bölüm, en fazla 5 ödül. Şampiyon ve sonuncuyu finalStandings listesinden belirle; eşitlik varsa birlikte an.",
    facts);
  await mediaSave(base + "/seasonDocumentaries/" + encodeURIComponent(season.id), {
    seasonId: season.id, seasonName: season.name || season.id,
    status: "published", payloadJson: JSON.stringify(content),
    publishedAt: new Date().toISOString()
  }, token);
}

async function runMediaAutomation(env) {
  if (!env.AI || !env.FIREBASE_SERVICE_ACCOUNT) return;
  try {
    const account = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT);
    if (account.project_id !== FIREBASE_PROJECT_ID || !account.client_email || !account.private_key) return;
    const token = await createFirebaseAccessToken(account);
    const groups = await fsList("groups", token);
    const today = localDay(new Date());
    const publicationDays = [previousDay(today), today];
    for (const group of groups) {
      const code = group.id, base = "groups/" + encodeURIComponent(code);
      try {
        const matches = await fsList(base + "/matches", token);
        const dailyCandidates = publicationDays.map(day => ({
          day,
          matches: matches.filter(match =>
            fsTime(match.kickoff) && localDay(new Date(fsTime(match.kickoff))) === day)
        })).filter(item => item.matches.length && item.matches.every(finished));

        const current = await fsGet(base + "/dailyMedia/current", token);
        for (const candidate of dailyCandidates) {
          const day = candidate.day;
          if (current && current.status === "published" && current.date >= day) continue;

          const sameDayAttempt = current && current.date === day;
          const attempted = Date.parse(sameDayAttempt && current.attemptedAt || "");
          const locked = sameDayAttempt && current.status === "generating" &&
            Number.isFinite(attempted) && Date.now() - attempted < 45 * 60 * 1000;
          const retryWait = sameDayAttempt && current.status === "error" &&
            Number.isFinite(attempted) && Date.now() - attempted < 60 * 60 * 1000;
          if (locked || retryWait) continue;

          await mediaSave(base + "/dailyMedia/current", {
            date: day, status: "generating", attemptedAt: new Date().toISOString()
          }, token);
          try {
            await publishDailyGazette(env, code, day, candidate.matches, token);
            console.log("Günlük gazete yayımlandı:", code, day);
          } catch (error) {
            await mediaSave(base + "/dailyMedia/current", {
              date: day, status: "error", attemptedAt: new Date().toISOString(),
              errorText: String(error.message || error).slice(0, 250)
            }, token);
            console.error("Gazete üretim hatası:", code, error);
          }
          break;
        }

        const seasons = await fsList(base + "/seasons", token);
        for (const season of seasons) {
          if (!season.startDate || !season.endDate || today < season.endDate) continue;
          const fixtures = matches.filter(match => {
            if (match.seasonId) return match.seasonId === season.id;
            const date = localDay(new Date(fsTime(match.kickoff)));
            return date >= season.startDate && date <= season.endDate;
          });
          if (!fixtures.length || !fixtures.every(finished)) continue;
          const docPath = base + "/seasonDocumentaries/" + encodeURIComponent(season.id);
          const existing = await fsGet(docPath, token);
          if (existing && existing.status === "published") continue;
          const attempt = Date.parse(existing && existing.attemptedAt || "");
          if (existing && existing.status === "generating" &&
              Number.isFinite(attempt) && Date.now() - attempt < 45 * 60 * 1000) continue;
          try {
            await mediaSave(docPath, {
              seasonId: season.id, seasonName: season.name || season.id,
              status: "generating", attemptedAt: new Date().toISOString()
            }, token);
            let unresolved = false;
            for (const match of fixtures) {
              const risks = await fsList(base + "/matches/" + encodeURIComponent(match.id) + "/risks", token);
              if (risks.some(risk => risk.status !== "resolved")) unresolved = true;
            }
            if (unresolved) {
              await mediaSave(docPath, { status: "waiting", attemptedAt: new Date().toISOString() }, token);
              continue;
            }
            await publishSeasonDocumentary(env, code, season, fixtures, token);
            console.log("Sezon belgeseli Onur Duvarı'na eklendi:", code, season.id);
          } catch (error) {
            await mediaSave(docPath, {
              status: "error", attemptedAt: new Date().toISOString(),
              errorText: String(error.message || error).slice(0, 250)
            }, token);
            console.error("Belgesel üretim hatası:", code, season.id, error);
          }
        }
      } catch (error) {
        console.error("Medya otomasyonu lig hatası:", code, error);
      }
    }
  } catch (error) {
    console.error("Medya otomasyonu genel hatası:", error);
  }
}
