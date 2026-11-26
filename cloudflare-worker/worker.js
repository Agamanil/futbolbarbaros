import {
  decodeFirestoreDocument, decodeFirestoreFields, listFirestorePages
} from './firestore-data.mjs';
import {
  calculateDailyAward, riskFinalizedAtFor, riskPointsFor, seasonMatchesForDay,
  shiftDayKey, validateBonusSelections
} from '../bonus-scoring.mjs';
import {
  buildDailyGazetteIssue, gazetteDayIsReady, gazetteDayKey, gazetteMatchesForDay,
  gazetteDateWindow, gazetteScoreIsValid, shouldSkipGazetteGeneration
} from './gazette-core.mjs';

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
    ctx.waitUntil(Promise.all([
      runAutomaticNotifications(env),
      runMediaAutomation(env)
    ]));
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

function fsFields(fields) {
  return decodeFirestoreFields(fields || {});
}

function fsWrite(v) {
  if (typeof v === "string") return { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(fsWrite) } };
  return { nullValue: "NULL_VALUE" };
}

async function fsList(path, token) {
  const documents = await listFirestorePages(async ({ pageSize, pageToken }) => {
    const params = new URLSearchParams({ pageSize: String(pageSize) });
    if (pageToken) params.set('pageToken', pageToken);
    const response = await firestoreFetchWithRetry(
      FIRESTORE_ROOT + "/" + path + "?" + params.toString(),
      { headers: { Authorization: "Bearer " + token } }
    );
    if (!response.ok) {
      throw new Error("Firestore listeleme HTTP " + response.status + ": " + path);
    }
    return response.json();
  });

  return documents.map(decodeFirestoreDocument);
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

async function fsCollectionGroup(path, collectionId, token) {
  const response = await firestoreFetchWithRetry(
    FIRESTORE_ROOT + "/" + firestorePath(path) + ":runQuery",
    {
      method: "POST",
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        structuredQuery: { from: [{ collectionId, allDescendants: true }] }
      })
    }
  );
  if (!response.ok) {
    throw new Error("Firestore collection group sorgusu HTTP " + response.status + ": " + collectionId);
  }
  const rows = await response.json();
  if (!Array.isArray(rows)) throw new Error("Firestore collection group yanıtı geçersiz: " + collectionId);
  return rows.filter(row => row?.document).map(row => row.document);
}

function firestoreDocumentPath(document) {
  const marker = "/documents/";
  const index = String(document?.name || "").indexOf(marker);
  return index < 0 ? "" : document.name.slice(index + marker.length);
}

async function gazetteRiskFactsForMatches(code, matches, token, cache = new Map()) {
  if (!matches.length) return [];
  let datasetPromise = cache.get(code);
  if (!datasetPromise) {
    datasetPromise = Promise.all([
      fsCollectionGroup("groups/" + encodeURIComponent(code), "risks", token),
      fsCollectionGroup("groups/" + encodeURIComponent(code), "participants", token)
    ]).then(([riskDocuments, participantDocuments]) => ({ riskDocuments, participantDocuments }));
    cache.set(code, datasetPromise);
  }
  const { riskDocuments, participantDocuments } = await datasetPromise;
  const matchIds = new Set(matches.map(match => match.id));
  const participantsByRisk = new Map();
  for (const document of participantDocuments) {
    const path = firestoreDocumentPath(document);
    const segments = path.split("/");
    if (segments.length !== 8 || segments[0] !== "groups" || segments[1] !== code ||
        segments[2] !== "matches" || !matchIds.has(segments[3]) ||
        segments[4] !== "risks" || segments[6] !== "participants") continue;
    const riskPath = segments.slice(0, 6).join("/");
    if (!participantsByRisk.has(riskPath)) participantsByRisk.set(riskPath, []);
    const person = decodeFirestoreDocument(document);
    participantsByRisk.get(riskPath).push({ id: person.uid || person.id, choice: person.choice });
  }
  const facts = [];
  for (const document of riskDocuments) {
    const path = firestoreDocumentPath(document);
    const segments = path.split("/");
    if (segments.length !== 6 || segments[0] !== "groups" || segments[1] !== code ||
        segments[2] !== "matches" || !matchIds.has(segments[3]) || segments[4] !== "risks") continue;
    const risk = decodeFirestoreDocument(document);
    facts.push({ ...risk, matchId: segments[3], participants: participantsByRisk.get(path) || [] });
  }
  return facts;
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

async function getRiskFacts(code, matches, token) {
  const events = [];
  for (const match of matches) {
    const base = "groups/" + encodeURIComponent(code) + "/matches/" +
      encodeURIComponent(match.id) + "/risks";
    const risks = await fsList(base, token);
    for (const risk of risks) {
      const participants = risk.status === "resolved" && typeof risk.outcome === "boolean"
        ? await fsList(base + "/" + encodeURIComponent(risk.id) + "/participants", token)
        : [];
      events.push({
        ...risk,
        matchId: match.id,
        participants: participants.map(person => ({ id: person.uid, choice: person.choice }))
      });
    }
  }
  return events;
}

async function validateSeasonBonusSelections({ code, selections, allMatches, players, seasons,
  season, seasonFixtures, token, now, riskFacts: suppliedRiskFacts }) {
  if (!season) return [];
  const structurallyValid = validateBonusSelections(selections, {
    matches: allMatches, players, seasons, now, adminUid: FIREBASE_ADMIN_UID
  }).filter(selection => selection.seasonId === season.id);
  if (!structurallyValid.length) return [];

  const riskFacts = suppliedRiskFacts || await getRiskFacts(code, seasonFixtures, token);
  const accepted = [];
  const awardCache = new Map();
  for (const selection of structurallyValid) {
    if (accepted.some(item => item.uid === selection.uid &&
        (item.earnedDate === selection.earnedDate ||
          item.selectionDay === shiftDayKey(selection.selectionDay, -1)))) continue;

    let award = awardCache.get(selection.earnedDate);
    if (!award) {
      const dayMatches = seasonMatchesForDay(allMatches, season, selection.earnedDate);
      if (!dayMatches.length) continue;
      const dayIds = new Set(dayMatches.map(match => match.id));
      const dayRisks = riskFacts.filter(event => dayIds.has(event.matchId));
      const riskReady = dayRisks.every(event =>
        event.status === "resolved" && typeof event.outcome === "boolean");
      if (!riskReady) continue;
      award = calculateDailyAward({
        date: selection.earnedDate,
        dayMatches,
        players,
        bonusIds: new Set(accepted.filter(item => item.targetDate === selection.earnedDate)
          .map(item => item.matchId)),
        riskReady: true,
        pendingRisks: 0,
        riskPoints: uid => riskPointsFor(dayRisks, uid, dayIds),
        riskFinalizedAt: riskFinalizedAtFor(dayRisks, dayIds)
      });
      awardCache.set(selection.earnedDate, award);
    }
    const expiresAt = Number.isFinite(award.completedAtMs)
      ? award.completedAtMs + 48 * 60 * 60 * 1000 : 0;
    if (!award.completed || !award.lastPlayers.some(player => player.id === selection.uid) ||
        selection.selectedAtMs < award.completedAtMs || selection.selectedAtMs >= expiresAt) continue;
    accepted.push(selection);
  }
  return accepted;
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
        const [matches, bonuses, oldState, players, group, seasons] = await Promise.all([
          fsList("groups/" + encodeURIComponent(code) + "/matches", accessToken),
          fsList("groups/" + encodeURIComponent(code) + "/bonusSelections", accessToken),
          fsGet("notificationState/" + encodeURIComponent(code), accessToken),
          fsList("groups/" + encodeURIComponent(code) + "/players", accessToken),
          fsGet("groups/" + encodeURIComponent(code), accessToken),
          fsList("groups/" + encodeURIComponent(code) + "/seasons", accessToken)
        ]);

        const todayCalendarMatches = matches.filter(m => fsTime(m.kickoff) &&
          localDay(new Date(fsTime(m.kickoff))) === today);
        const activeSeason = seasons.find(item => item.id === (group && group.activeSeasonId)) ||
          seasons.find(item => todayCalendarMatches.some(match => match.seasonId === item.id)) ||
          seasons.find(item => todayCalendarMatches.some(match => {
            const date = localDay(new Date(fsTime(match.kickoff)));
            return date >= item.startDate && date <= item.endDate;
          })) || null;
        const todayMatches = activeSeason ? seasonMatchesForDay(matches, activeSeason, today) : [];
        const seasonFixtures = activeSeason ? matches.filter(match => {
          if (match.seasonId) return match.seasonId === activeSeason.id;
          const time = fsTime(match.kickoff);
          if (!time) return false;
          const date = localDay(new Date(time));
          return date >= activeSeason.startDate && date <= activeSeason.endDate;
        }).filter(finished) : [];
        const validBonuses = activeSeason ? await validateSeasonBonusSelections({
          code, selections: bonuses, allMatches: matches, players, seasons,
          season: activeSeason, seasonFixtures, token: accessToken, now
        }) : [];

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
            : validBonuses.map(b => b.id)
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

        for (const bonus of validBonuses) {
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

        if (todayMatches.length && players.length && lastPlaceDay !== today) {
          const todayMatchIds = new Set(todayMatches.map(match => match.id));
          const dayRiskFacts = await getRiskFacts(code, todayMatches, accessToken);
          const pendingRisks = dayRiskFacts.filter(event =>
            event.status !== "resolved" || typeof event.outcome !== "boolean").length;
          const dailyAward = calculateDailyAward({
            date: today,
            dayMatches: todayMatches,
            players,
            bonusIds: new Set(validBonuses.filter(item => item.targetDate === today)
              .map(item => item.matchId)),
            riskReady: true,
            pendingRisks,
            riskPoints: playerId => riskPointsFor(dayRiskFacts, playerId, todayMatchIds),
            riskFinalizedAt: riskFinalizedAtFor(dayRiskFacts, todayMatchIds)
          });
          if (dailyAward.completed) {
            const yesterday = previousDay(today);
            const selectedYesterday = new Set(
              validBonuses.filter(item => item.selectionDay === yesterday).map(item => item.uid)
            );
            const eligible = dailyAward.lastPlayers.filter(person => !selectedYesterday.has(person.id));
  
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
const DAILY_GAZETTE_BACKFILL_DAYS = 7;
const MAX_GROUPS_INSPECTED_PER_MEDIA_RUN = 6;

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

function gazetteLockPath(base) {
  return base + "/dailyMedia/generationLock";
}

function seasonDocumentaryLockPath(base, seasonId) {
  return base + "/seasonDocumentaryLocks/" + encodeURIComponent(seasonId);
}

async function acquireSeasonDocumentaryLock(base, seasonId, token, now = Date.now(), knownDocumentRaw) {
  const path = seasonDocumentaryLockPath(base, seasonId);
  const documentPath = base + "/seasonDocumentaries/" + encodeURIComponent(seasonId);
  const [current, fetchedDocumentRaw] = await Promise.all([
    firestoreGetRaw(path, token), knownDocumentRaw === undefined
      ? firestoreGetRaw(documentPath, token) : Promise.resolve(knownDocumentRaw)
  ]);
  const documentRaw = fetchedDocumentRaw;
  const lock = current ? fsFields(current.fields || {}) : null;
  const leaseUntil = Date.parse(lock && lock.leaseUntil || "");
  if (lock && lock.status === "published") return null;
  if (documentRaw && fsFields(documentRaw.fields || {}).status === "published") return null;
  if (lock && lock.status === "generating" && Number.isFinite(leaseUntil) && leaseUntil > now) {
    return null;
  }

  const attemptId = crypto.randomUUID();
  const attemptedAt = new Date(now).toISOString();
  const fields = {
    seasonId: fsWrite(seasonId),
    status: fsWrite("generating"),
    attemptId: fsWrite(attemptId),
    attemptedAt: fsWrite(attemptedAt),
    leaseUntil: fsWrite(new Date(now + 45 * 60 * 1000).toISOString()),
    errorText: fsWrite("")
  };
  const documentFields = mediaDocumentFields({
    seasonId,
    seasonName: fsFields(documentRaw && documentRaw.fields || {}).seasonName || seasonId,
    status: "generating",
    attemptedAt,
    errorText: ""
  });
  try {
    await firestoreCommit([
      current ? writePatch(current, fields, Object.keys(fields)) : writeCreate(path, fields),
      documentRaw
        ? writePatch(documentRaw, documentFields, Object.keys(documentFields))
        : writeCreate(documentPath, documentFields)
    ], token);
    return attemptId;
  } catch (error) {
    if (/\b(409|412)\b|ALREADY_EXISTS|FAILED_PRECONDITION/i.test(String(error.message || error))) {
      return null;
    }
    throw error;
  }
}

async function finishSeasonDocumentaryAttempt(base, season, attemptId, status, token,
  { now = Date.now(), error = null, content = null } = {}) {
  const lockPath = seasonDocumentaryLockPath(base, season.id);
  const documentPath = base + "/seasonDocumentaries/" + encodeURIComponent(season.id);
  const [lockRaw, documentRaw] = await Promise.all([
    firestoreGetRaw(lockPath, token), firestoreGetRaw(documentPath, token)
  ]);
  if (!lockRaw) return false;
  const lock = fsFields(lockRaw.fields || {});
  if (lock.status !== "generating" || lock.attemptId !== attemptId ||
      Date.parse(lock.leaseUntil || "") <= now) return false;
  if (documentRaw && fsFields(documentRaw.fields || {}).status === "published") return false;

  const attemptedAt = new Date(now).toISOString();
  const lockFields = {
    status: fsWrite(status),
    attemptedAt: fsWrite(attemptedAt),
    leaseUntil: fsWrite(""),
    errorText: fsWrite(error ? String(error.message || error).slice(0, 250) : "")
  };
  const documentFields = mediaDocumentFields({
    seasonId: season.id,
    seasonName: season.name || season.id,
    status,
    attemptedAt,
    errorText: error ? String(error.message || error).slice(0, 250) : "",
    ...(status === "published" ? {
      payloadJson: JSON.stringify(content),
      publishedAt: attemptedAt
    } : {})
  });
  await firestoreCommit([
    documentRaw
      ? writePatch(documentRaw, documentFields, Object.keys(documentFields))
      : writeCreate(documentPath, documentFields),
    writePatch(lockRaw, lockFields, Object.keys(lockFields))
  ], token);
  return true;
}

async function acquireGazetteGenerationLock(base, day, token, now = Date.now(), knownCurrentRaw) {
  const path = gazetteLockPath(base);
  const current = knownCurrentRaw === undefined
    ? await firestoreGetRaw(path, token) : knownCurrentRaw;
  const lock = current ? fsFields(current.fields || {}) : null;
  if (shouldSkipGazetteGeneration(day, null, lock, now)) return null;

  const attemptId = crypto.randomUUID();
  const startedAt = new Date(now);
  // Cron invocations have a 15-minute wall-time ceiling. Expire the lease
  // before the next 15-minute schedule so a terminated run cannot block recovery.
  const leaseUntil = new Date(now + 14 * 60 * 1000);
  const fields = {
    date: fsWrite(day),
    status: fsWrite("generating"),
    attemptId: fsWrite(attemptId),
    attemptedAt: fsWrite(startedAt.toISOString()),
    leaseUntil: fsWrite(leaseUntil.toISOString()),
    errorText: fsWrite("")
  };
  try {
    await firestoreCommit([
      current ? writePatch(current, fields, Object.keys(fields)) : writeCreate(path, fields)
    ], token);
    return attemptId;
  } catch (error) {
    if (/\b(409|412)\b|ALREADY_EXISTS|FAILED_PRECONDITION/i.test(String(error.message || error))) {
      return null;
    }
    throw error;
  }
}

async function finishGazetteGenerationLock(base, day, attemptId, error, token, now = Date.now()) {
  const path = gazetteLockPath(base);
  const current = await firestoreGetRaw(path, token);
  if (!current) return;
  const lock = fsFields(current.fields || {});
  if (lock.date !== day || lock.status !== "generating" || lock.attemptId !== attemptId) return;
  const fields = {
    status: fsWrite("error"),
    // Record the actual failure time, not the invocation start time.
    attemptedAt: fsWrite(new Date().toISOString()),
    leaseUntil: fsWrite(""),
    errorText: fsWrite(error ? String(error.message || error).slice(0, 250) : "")
  };
  await firestoreCommit([writePatch(current, fields, Object.keys(fields))], token);
}

function mediaDocumentFields(values) {
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [
    key, fsWrite(String(value == null ? "" : value))
  ]));
}

async function commitGazetteAndLock(base, day, attemptId, currentValues, token, now = Date.now()) {
  const currentPath = base + "/dailyMedia/current";
  const lockPath = gazetteLockPath(base);
  const [currentRaw, lockRaw] = await Promise.all([
    firestoreGetRaw(currentPath, token),
    firestoreGetRaw(lockPath, token)
  ]);

  const checkedAt = Date.now();

  if (!lockRaw) {
    console.error("Gazete yayımlama kontrolü başarısız: kilit bulunamadı.", {
      day, attemptId
    });
    return false;
  }

  const lock = fsFields(lockRaw.fields || {});
  const leaseUntil = Date.parse(lock.leaseUntil || "");

  if (lock.date !== day || lock.status !== "generating" ||
      lock.attemptId !== attemptId ||
      !Number.isFinite(leaseUntil) || leaseUntil <= checkedAt) {
    console.error("Gazete yayımlama kontrolü başarısız: kilit uyuşmazlığı.", {
      day,
      expectedAttemptId: attemptId,
      actualAttemptId: lock.attemptId,
      lockDate: lock.date,
      lockStatus: lock.status,
      leaseUntil: lock.leaseUntil,
      checkedAt: new Date(checkedAt).toISOString()
    });
    return false;
  }

  const current = currentRaw ? fsFields(currentRaw.fields || {}) : null;

  if (current && (String(current.date || "") > day ||
      (current.date === day && current.status === "published"))) {
    console.error("Gazete yayımlama kontrolü başarısız: daha yeni gazete mevcut.", {
      day,
      currentDate: current.date,
      currentStatus: current.status
    });
    return false;
  }

  const currentFields = mediaDocumentFields(currentValues);
  const lockFields = {
    date: fsWrite(day),
    status: fsWrite("published"),
    attemptedAt: fsWrite(new Date(checkedAt).toISOString()),
    leaseUntil: fsWrite(""),
    errorText: fsWrite("")
  };

  await firestoreCommit([
    currentRaw
      ? writePatch(currentRaw, currentFields, Object.keys(currentFields))
      : writeCreate(currentPath, currentFields),
    writePatch(lockRaw, lockFields, Object.keys(lockFields))
  ], token);

  return true;
}

async function updateGazetteTimelineState(base, date, status, error, token, now = Date.now()) {
  const path = base + "/dailyMedia/current";
  const currentRaw = await firestoreGetRaw(path, token);
  if (!currentRaw) return false;
  const current = fsFields(currentRaw.fields || {});
  if (current.date !== date || current.status !== "published") return false;
  if (!["pending", "error"].includes(current.timelineStatus)) {
    return ["saved", "not_required"].includes(current.timelineStatus);
  }
  const fields = {
    timelineStatus: fsWrite(status),
    timelineError: fsWrite(error ? String(error.message || error).slice(0, 250) : ""),
    timelineUpdatedAt: fsWrite(new Date(now).toISOString())
  };
  try {
    await firestoreCommit([writePatch(currentRaw, fields, Object.keys(fields))], token);
    return true;
  } catch (commitError) {
    if (/\b(409|412)\b|ALREADY_EXISTS|FAILED_PRECONDITION/i.test(String(commitError.message || commitError))) {
      return false;
    }
    throw commitError;
  }
}

async function retryCurrentGazetteTimeline(base, current, token, now = Date.now()) {
  if (!current || !["pending", "error"].includes(current.timelineStatus)) return true;
  const seasonId = current.timelineSeasonId;
  if (!seasonId) return updateGazetteTimelineState(base, current.date, "saved", null, token, now);
  try {
    let payload;
    try { payload = JSON.parse(current.payloadJson || "{}"); }
    catch { throw new Error("Yayımlanmış gazetenin zaman çizelgesi verisi bozuk."); }
    const results = Array.isArray(payload.officialData?.results) ? payload.officialData.results : [];
    const events = Array.isArray(payload.notableEvents) ? payload.notableEvents : [];
    await mediaSave(base + "/seasonTimeline/" + encodeURIComponent(seasonId + "_" + current.date), {
      seasonId,
      day: current.date,
      eventsJson: JSON.stringify(events),
      matchesJson: JSON.stringify(results.map(item => ({ home: item.home, away: item.away, score: item.score })))
    }, token);
    return await updateGazetteTimelineState(base, current.date, "saved", null, token, now);
  } catch (error) {
    await updateGazetteTimelineState(base, current.date, "error", error, token, now)
      .catch(stateError => console.error("Zaman çizelgesi hatası kaydedilemedi:", stateError));
    console.error("Gazete yayımlandı; sezon zaman çizelgesi tekrar denenecek:", error);
    return false;
  }
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
    if (Math.abs(home - away) >= 4) events.push({ matchId: match.id, eventKey: "large-margin", title: "Farklı galibiyet", detail: score });
    if (home === away) events.push({ matchId: match.id, eventKey: "draw", title: "Beraberlik", detail: score });
    const keyEvents = Array.isArray(match.espnKeyEvents) ? match.espnKeyEvents : [];
    for (const event of keyEvents) {
      const minuteText = String(event.minute || "").trim();
      const minute = /^\d{1,3}$/.test(minuteText) ? Number(minuteText) : 0;
      if (event.kind === "redCard" || event.kind === "ownGoal" ||
          (event.kind === "goal" && minute >= 85)) {
        const rawPlayer = typeof event.player === "string" ? event.player.trim() : "";
        const player = rawPlayer.length <= 80 && /^[\p{L}\p{M} .'-]+$/u.test(rawPlayer)
          ? rawPlayer : "";
        events.push({
          matchId: match.id, eventKey: `espn-${events.length}`,
          title: event.kind === "redCard" ? "Kırmızı kart" :
            event.kind === "ownGoal" ? "Kendi kalesine gol" : "Son dakika golü",
          detail: (player ? "Oyuncu: " + player : "Doğrulanmış maç olayı") +
            " · " + score + (minute ? " · " + minute + ". dakika" : "")
        });
      }
    }
  }
  return events.slice(0, 15);
}

function stableGazetteValue(value) {
  if (Array.isArray(value)) return value.map(stableGazetteValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableGazetteValue(value[key])]));
  }
  return value;
}

function sameGazetteSnapshot(left, right) {
  return JSON.stringify(stableGazetteValue(left)) === JSON.stringify(stableGazetteValue(right));
}

function gazetteSeasonSelection(selection, season) {
  if (!season) return false;
  if (selection.seasonId) return selection.seasonId === season.id;
  const targetDate = selection.targetDate || selection.selectionDay || "";
  return targetDate >= season.startDate && targetDate <= season.endDate;
}

function compareGazetteScores(match) {
  // Keep the existing season-score table behavior for legacy completed matches.
  // The stricter finish confirmation is required for a daily issue, not retroactive scoring.
  return gazetteScoreIsValid(match);
}

function mediaSurprises(matches) {
  const events = [];
  for (const match of matches) {
    const margin = Math.abs(Number(match.homeScore) - Number(match.awayScore));
    if (margin >= 4) {
      events.push({
        type: "large-margin", matchId: match.id, home: match.homeTeam, away: match.awayTeam,
        score: Number(match.homeScore) + "-" + Number(match.awayScore), margin
      });
    }
    const predictions = Object.values(match.predictions || {}).filter(prediction =>
      prediction && Number.isFinite(Number(prediction.home)) && Number.isFinite(Number(prediction.away))
    );
    if (predictions.length) {
      const actual = Math.sign(Number(match.homeScore) - Number(match.awayScore));
      const resultCounts = new Map();
      for (const prediction of predictions) {
        const outcome = Math.sign(Number(prediction.home) - Number(prediction.away));
        resultCounts.set(outcome, (resultCounts.get(outcome) || 0) + 1);
      }
      const maximum = Math.max(...resultCounts.values());
      const majorityOutcomes = [...resultCounts].filter(([, count]) => count === maximum).map(([outcome]) => outcome);
      if (majorityOutcomes.length === 1 && majorityOutcomes[0] !== actual) {
        events.push({
          type: "prediction-surprise", matchId: match.id, home: match.homeTeam, away: match.awayTeam,
          score: Number(match.homeScore) + "-" + Number(match.awayScore),
          majorityPredictionCount: maximum, totalPredictions: predictions.length
        });
      }
    }
  }
  return events;
}

function parseModelJsonObject(content) {
  let candidate = content.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  const fenced = candidate.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced) candidate = fenced[1].trim();
  const start = candidate.indexOf("{");
  if (start < 0) throw new SyntaxError("AI yanıtında JSON nesnesi bulunamadı.");

  let depth = 0, inString = false, escaped = false;
  for (let index = start; index < candidate.length; index++) {
    const character = candidate[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === "{") depth++;
    else if (character === "}" && --depth === 0) {
      const value = JSON.parse(candidate.slice(start, index + 1));
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new SyntaxError("AI yanıtı JSON nesnesi değil.");
      }
      return value;
    }
  }
  throw new SyntaxError("AI JSON nesnesi tamamlanmadan yanıt bitti.");
}

async function mediaGenerate(env, prompt, facts) {
  const maxAttempts = 2;
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let result;
    try {
      result = await env.AI.run(MEDIA_MODEL, {
        messages: [
          {
            role: "system",
            content: attempt === 1 ? prompt :
              prompt + "\n\nÖNEMLİ: Önceki yanıt ayrıştırılamadı. Bu kez yalnızca tek bir geçerli JSON nesnesi döndür. Markdown kod çiti (\`\`\`), açıklama, önsöz veya JSON dışı hiçbir karakter kullanma. Tüm metin değerlerinde çift tırnak kullan; sondaki virgülleri kullanma. JSON nesnesini mutlaka tamamla."
          },
          { role: "user", content: JSON.stringify(facts) }
        ],
        temperature: attempt === 1 ? 0.7 : 0,
        chat_template_kwargs: { enable_thinking: false }
      });
    } catch (error) {
      console.error("Gazete AI çağrısı başarısız; güvenli şablon kullanılacak.", {
        model: MEDIA_MODEL, stage: "run", attempt,
        errorType: String(error?.name || "Error")
      });
      throw error;
    }
    const content = result?.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) {
      console.error("Gazete AI yanıt sözleşmesi geçersiz; güvenli şablon kullanılacak.", {
        model: MEDIA_MODEL, stage: "response-shape", attempt
      });
      throw new Error("AI yanıtında choices[0].message.content bulunamadı.");
    }
    try {
      return parseModelJsonObject(content);
    } catch (error) {
      lastError = error;
      console.error("Gazete AI JSON yanıtı geçersiz.", {
        model: MEDIA_MODEL, source: "AI choices[0].message.content",
        stage: "json-parse", attempt, maxAttempts,
        errorType: String(error?.name || "Error"),
        errorMessage: String(error?.message || error).slice(0, 240),
        contentLength: content.length,
        fenced: /^\s*```/.test(content),
        hasThinkTag: /<think>/i.test(content)
      });
    }
  }
  throw new Error("AI iki denemede de geçerli bir JSON nesnesi döndürmedi.", { cause: lastError });
}

async function publishDailyGazette(env, code, day, allMatches, matches, riskEvents, token,
  now = Date.now(), context = {}) {
  const base = "groups/" + encodeURIComponent(code);
  const [players, bonuses] = await Promise.all([
    fsList(base + "/players", token), fsList(base + "/bonusSelections", token)
  ]);
  const group = context.group
    ? Object.fromEntries(Object.entries(context.group).filter(([key]) => key !== "id"))
    : await fsGet(base, token);
  const seasons = context.seasons || await fsList(base + "/seasons", token);
  const explicitSeasonId = matches.map(match => match.seasonId).find(Boolean);
  const season = seasons.find(item => item.id === explicitSeasonId) ||
    seasons.find(item => item.id === (group && group.activeSeasonId)) ||
    seasons.find(item => item.startDate && item.endDate && day >= item.startDate && day <= item.endDate) || null;
  const seasonFixtures = season ? allMatches.filter(match => {
    if (match.seasonId) return match.seasonId === season.id;
    const kickoff = fsTime(match.kickoff);
    if (!kickoff) return false;
    const matchDay = gazetteDayKey(new Date(kickoff));
    return matchDay >= season.startDate && matchDay <= season.endDate;
  }).filter(finished) : [];
  if (seasonFixtures.some(match => !compareGazetteScores(match))) {
    throw new Error("Lig tablosu için geçmiş maçlardan birinin sonucu hatalı.");
  }

  const seasonRiskFacts = seasonFixtures.length
    ? (context.riskFacts || await gazetteRiskFactsForMatches(
      code, seasonFixtures, token, context.riskCache
    )).filter(event => seasonFixtures.some(match => match.id === event.matchId))
    : [];
  const seasonMatchIds = new Set(seasonFixtures.map(match => match.id));
  const seasonRiskPoints = new Map(players.map(person => [
    person.id, riskPointsFor(seasonRiskFacts, person.id, seasonMatchIds)
  ]).filter(([, points]) => points));
  const seasonBonuses = await validateSeasonBonusSelections({
    code, selections: bonuses, allMatches, players, seasons, season, seasonFixtures, token, now,
    riskFacts: seasonRiskFacts
  });
  const bonusIds = new Set(seasonBonuses.map(item => item.matchId).filter(Boolean));
  const leagueTable = players.map(person => ({
    id: person.id,
    factId: "season-player:" + person.id,
    name: person.name || "Oyuncu",
    played: seasonFixtures.length,
    points: seasonFixtures.reduce((sum, match) => {
      const basePoints = mediaScore(match, match.predictions && match.predictions[person.id]);
      return sum + basePoints * (bonusIds.has(match.id) ? 2 : 1);
    }, 0) + (seasonRiskPoints.get(person.id) || 0)
  })).sort((a, b) => b.points - a.points || a.name.localeCompare(b.name, "tr"))
    .map((person, index) => ({ rank: index + 1, ...person }));

  const dailyBonusIds = new Set(seasonBonuses.filter(item => item.targetDate === day)
    .map(item => item.matchId).filter(Boolean));
  const dailyStandings = players.map(person => {
    let points = 0, exact = 0, predicted = 0;
    for (const match of matches) {
      const prediction = match.predictions && match.predictions[person.id];
      if (!prediction) continue;
      predicted++;
      const basePoints = mediaScore(match, prediction);
      if (basePoints === 3) exact++;
      points += basePoints * (dailyBonusIds.has(match.id) ? 2 : 1);
    }
    return { id: person.id, factId: "daily-player:" + person.id, name: person.name || "Oyuncu", points, exact, predicted };
  }).filter(person => person.predicted > 0)
    .sort((a, b) => b.points - a.points || a.name.localeCompare(b.name, "tr"));

  const events = mediaEvents(matches);
  const matchById = new Map(matches.filter(match => typeof match.id === "string")
    .map(match => [match.id, match]));
  const bonusDecisions = seasonBonuses.filter(item =>
    item.targetDate === day && matchById.has(item.matchId)
  ).map(item => ({
      factId: "bonus:" + item.id,
      id: item.id,
      uid: item.uid,
      player: item.playerName,
      match: item.homeTeam + " - " + item.awayTeam,
      matchId: item.matchId
    }));
  const riskDecisions = riskEvents.filter(item => item.status === "resolved").map(item => ({
    factId: "risk:" + item.matchId + ":" + item.id,
    id: item.id,
    matchId: item.matchId,
    question: item.question || "Risk etkinliği",
    outcome: item.outcome ? "Gerçekleşti" : "Gerçekleşmedi",
    match: matches.find(match => match.id === item.matchId)
      ? matches.find(match => match.id === item.matchId).homeTeam + " - " +
        matches.find(match => match.id === item.matchId).awayTeam
      : ""
  }));
  const tomorrow = new Date(Date.UTC(
    Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)) + 1
  ));
  const tomorrowDay = `${tomorrow.getUTCFullYear()}-${String(tomorrow.getUTCMonth() + 1).padStart(2, '0')}-${String(tomorrow.getUTCDate()).padStart(2, '0')}`;
  const tomorrowMatches = gazetteMatchesForDay(allMatches, tomorrowDay).map(match => ({
    id: match.id, factId: "fixture:" + match.id,
    home: match.homeTeam, away: match.awayTeam, kickoff: match.kickoff
  }));
  const administrativeSources = {
    announcementsAvailable: false,
    announcementsFactId: "admin-announcements-unavailable:" + code,
    announcementsNote: "Sistemde gazeteye bağlanmış yönetici duyurusu kaynağı yok.",
    disciplineAvailable: false,
    disciplineFactId: "admin-discipline-unavailable:" + code,
    disciplineNote: "Gazeteye yönelik yayımlanabilir disiplin kararı kaynağı yok."
  };
  const results = matches.map(match => ({
    id: match.id, factId: "result:" + match.id, home: match.homeTeam, away: match.awayTeam,
    homeScore: Number(match.homeScore), awayScore: Number(match.awayScore),
    score: `${Number(match.homeScore)}-${Number(match.awayScore)}`,
    competition: match.competition || ""
  }));
  const notableFacts = events.map(item => ({
    ...item, factId: `event:${item.matchId}:${item.eventKey}`
  }));
  const surprises = mediaSurprises(matches).map(item => ({
    ...item, factId: `surprise:${item.matchId}:${item.type}`
  }));
  const administrativeFacts = [
    {
      factId: administrativeSources.announcementsFactId,
      source: "Yönetici duyuruları", available: false,
      note: administrativeSources.announcementsNote
    },
    {
      factId: administrativeSources.disciplineFactId,
      source: "Disiplin kararları", available: false,
      note: administrativeSources.disciplineNote
    }
  ];
  const tomorrowFixtureScan = {
    factId: "fixture-scan:" + tomorrowDay,
    day: tomorrowDay,
    fixtures: tomorrowMatches
  };
  const factIds = [
    ...results.map(item => item.factId),
    ...leagueTable.map(item => item.factId),
    ...dailyStandings.map(item => item.factId),
    ...bonusDecisions.map(item => item.factId),
    ...riskDecisions.map(item => item.factId),
    ...notableFacts.map(item => item.factId),
    ...surprises.map(item => item.factId),
    ...administrativeFacts.map(item => item.factId),
    ...tomorrowMatches.map(item => item.factId),
    tomorrowFixtureScan.factId
  ];
  const facts = {
    date: day,
    league: code,
    factIds,
    results,
    leagueTable,
    playerPerformances: dailyStandings,
    bonusRiskDecisions: { bonuses: bonusDecisions, risks: riskDecisions },
    administrativeSources,
    administrativeFacts,
    notableEvents: notableFacts,
    surprises,
    tomorrowMatches,
    tomorrowFixtureScan
  };

  const sourceSnapshot = {
    allMatches, players, bonuses, group, seasons, riskEvents,
    seasonRiskFacts,
    seasonRiskPoints: [...seasonRiskPoints.entries()].sort(([a], [b]) => a.localeCompare(b))
  };
  const verifySources = async () => {
    const [freshMatches, freshPlayers, freshBonuses, freshGroup, freshSeasons] = await Promise.all([
      fsList(base + "/matches", token), fsList(base + "/players", token),
      fsList(base + "/bonusSelections", token), fsGet(base, token), fsList(base + "/seasons", token)
    ]);
    const freshDayMatches = gazetteMatchesForDay(freshMatches, day);
    const freshRiskCache = new Map();
    const freshSeason = freshSeasons.find(item => item.id === explicitSeasonId) ||
      freshSeasons.find(item => item.id === (freshGroup && freshGroup.activeSeasonId)) ||
      freshSeasons.find(item => item.startDate && item.endDate && day >= item.startDate && day <= item.endDate) || null;
    const freshSeasonFixtures = freshSeason ? freshMatches.filter(match => {
      if (match.seasonId) return match.seasonId === freshSeason.id;
      const kickoff = fsTime(match.kickoff);
      if (!kickoff) return false;
      const matchDay = gazetteDayKey(new Date(kickoff));
      return matchDay >= freshSeason.startDate && matchDay <= freshSeason.endDate;
    }).filter(finished) : [];
    const freshSeasonRiskFacts = freshSeasonFixtures.length
      ? await gazetteRiskFactsForMatches(
        code, freshSeasonFixtures, token, freshRiskCache
      ) : [];
    const freshDailyRisks = freshDayMatches.length
      ? await gazetteRiskFactsForMatches(code, freshDayMatches, token, freshRiskCache) : [];
    const freshSeasonMatchIds = new Set(freshSeasonFixtures.map(match => match.id));
    const freshRiskPoints = new Map(freshPlayers.map(person => [
      person.id, riskPointsFor(freshSeasonRiskFacts, person.id, freshSeasonMatchIds)
    ]).filter(([, points]) => points));
    return sameGazetteSnapshot(sourceSnapshot, {
      allMatches: freshMatches, players: freshPlayers, bonuses: freshBonuses,
      group: freshGroup, seasons: freshSeasons, riskEvents: freshDailyRisks,
      seasonRiskFacts: freshSeasonRiskFacts,
      seasonRiskPoints: [...freshRiskPoints.entries()].sort(([a], [b]) => a.localeCompare(b))
    });
  };

  const issue = await buildDailyGazetteIssue({
    date: day, matches, riskEvents, facts, photos: [], now,
    generate: ({ prompt }) => mediaGenerate(env, prompt, facts), verifySources
  });
  return {
    issue,
    currentValues: {
      date: day,
      status: "published",
      payloadJson: JSON.stringify({
        ...issue, league: code, officialData: {
          results, seasonName: season?.name || season?.id || "",
          leagueTable, bonusDecisions, riskDecisions, administrativeSources
        },
        playerStandings: dailyStandings,
        notableEvents: events
      }),
      publishedAt: new Date(now).toISOString(),
      timelineStatus: season ? "pending" : "not_required",
      timelineSeasonId: season?.id || "",
      timelineError: ""
    }
  };
}

async function publishSeasonDocumentary(env, code, season, fixtures, token, context = {}) {
  const base = "groups/" + encodeURIComponent(code);
  const [bonuses, players] = await Promise.all([
    fsList(base + "/bonusSelections", token), fsList(base + "/players", token)
  ]);
  const allMatches = context.allMatches || await fsList(base + "/matches", token);
  const seasons = context.seasons || await fsList(base + "/seasons", token);
  const riskFacts = context.riskFacts || await gazetteRiskFactsForMatches(
    code, fixtures, token, context.riskCache
  );
  const validBonuses = await validateSeasonBonusSelections({
    code, selections: bonuses, allMatches, players, seasons, season,
    seasonFixtures: fixtures, token, now: Date.now(), riskFacts
  });
  const bonusIds = new Set(validBonuses.map(item => item.matchId).filter(Boolean));
  const fixtureIds = new Set(fixtures.map(match => match.id));
  const riskPoints = new Map(players.map(person => [
    person.id, riskPointsFor(riskFacts, person.id, fixtureIds)
  ]).filter(([, points]) => points));
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
  return content;
}

export async function runMediaAutomation(env) {
  const hasAI = Boolean(env.AI);
  const hasServiceAccount = Boolean(env.FIREBASE_SERVICE_ACCOUNT);
  console.log("Medya otomasyonu başladı.", { hasAI, hasServiceAccount });
  if (!hasAI || !hasServiceAccount) {
    console.error("Medya otomasyonu durduruldu: gerekli binding veya secret eksik.", {
      hasAI, hasServiceAccount
    });
    return;
  }
  let stage = "firebase-service-account-json";
  try {
    const account = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT);
    if (account.project_id !== FIREBASE_PROJECT_ID || !account.client_email || !account.private_key) {
      console.error("Medya otomasyonu durduruldu: Firebase servis hesabı bilgileri geçersiz.", {
        projectMatches: account.project_id === FIREBASE_PROJECT_ID,
        hasClientEmail: Boolean(account.client_email),
        hasPrivateKey: Boolean(account.private_key)
      });
      return;
    }
    stage = "oauth-token-response";
    const token = await createFirebaseAccessToken(account);
    stage = "firestore-groups-response";
    await runMediaAutomationForToken(env, token, new Date());
    console.log("Medya otomasyonu tamamlandı.");
  } catch (error) {
    console.error("Medya otomasyonu genel hatası:", error, {
      stage, errorType: String(error?.name || "Error")
    });
  }
}

export async function runMediaAutomationForToken(env, token, nowDate = new Date()) {
  try {
    let groups;
    for (let attempt = 1; ; attempt++) {
      try {
        groups = await fsList("groups", token);
        break;
      } catch (error) {
        if (!(error instanceof SyntaxError) || attempt >= 2) {
          console.error("Gazete kaynak yanıtı okunamadı.", {
            source: "Firestore REST", resource: "groups", attempt,
            errorType: String(error?.name || "Error")
          });
          throw error;
        }
        console.warn("Firestore groups yanıtı geçerli JSON değil; bir kez yeniden okunacak.", {
          source: "Firestore REST", resource: "groups", attempt
        });
        await new Promise(resolve => setTimeout(resolve, 200));
      }
    }
    console.log("Medya otomasyonu: Firestore ligleri alındı.", {
      groupCount: groups.length,
      maxGroupsInspected: MAX_GROUPS_INSPECTED_PER_MEDIA_RUN
    });
    const today = localDay(nowDate);
    const publicationDays = gazetteDateWindow(today, DAILY_GAZETTE_BACKFILL_DAYS);
    const now = nowDate.getTime();
    const riskCache = new Map();
    const startIndex = groups.length ? Math.floor(now / (15 * 60 * 1000)) % groups.length : 0;
    const orderedGroups = groups.length
      ? groups.slice(startIndex).concat(groups.slice(0, startIndex)) : [];
    for (const group of orderedGroups.slice(0, MAX_GROUPS_INSPECTED_PER_MEDIA_RUN)) {
      const code = group.id, base = "groups/" + encodeURIComponent(code);
      try {
        let current = await fsGet(base + "/dailyMedia/current", token);
        if (current && ["pending", "error"].includes(current.timelineStatus)) {
          const timelineReady = await retryCurrentGazetteTimeline(base, current, token, now);
          if (!timelineReady) continue;
          current = await fsGet(base + "/dailyMedia/current", token);
        }

        const matches = await fsList(base + "/matches", token);
        const seasons = await fsList(base + "/seasons", token);
        const dailyCandidates = publicationDays.map(day => ({
          day,
          matches: gazetteMatchesForDay(matches, day)
        })).filter(item => item.matches.length);

        let timelineBlocked = false;
        let dailyAttempted = false;
        console.log("Gazete kontrolü:", {
          group: code,
          matchCount: matches.length,
          seasonCount: seasons.length,
          eligibleDateCount: dailyCandidates.length
        });
        if (!dailyCandidates.length) {
          console.log("Gazete adayı bulunamadı:", { group: code, today, publicationDays });
        }
        for (const candidate of dailyCandidates) {
          const day = candidate.day;
          if (current && current.status === "published" && String(current.date || "") >= day) {
            console.log("Gazete mevcut yayın nedeniyle atlandı:", {
              group: code, candidateDate: day, publishedDate: current.date
            });
            continue;
          }
          const lockRaw = await firestoreGetRaw(gazetteLockPath(base), token);
          const lock = lockRaw ? fsFields(lockRaw.fields || {}) : null;
          if (shouldSkipGazetteGeneration(day, null, lock, now)) {
            console.log("Gazete üretim kilidi nedeniyle atlandı:", {
              group: code, date: day, lockDate: lock?.date || null,
              lockStatus: lock?.status || null, attemptedAt: lock?.attemptedAt || null,
              leaseUntil: lock?.leaseUntil || null, errorText: lock?.errorText || null
            });
            break;
          }

          const riskEvents = await gazetteRiskFactsForMatches(code, candidate.matches, token, riskCache);
          if (!gazetteDayIsReady(candidate.matches, riskEvents, now)) {
            console.log("Gazete henüz hazır değil:", {
              group: code,
              date: day,
              matchCount: candidate.matches.length,
              riskEventCount: riskEvents.length,
              matches: candidate.matches.map(match => ({
                id: match.id, kickoff: match.kickoff, espnState: match.espnState || null,
                scoreSource: match.scoreSource || null,
                manualResultConfirmed: match.manualResultConfirmed === true,
                validScore: gazetteScoreIsValid(match)
              })),
              riskStatuses: riskEvents.map(event => ({
                matchId: event.matchId, status: event.status, outcome: event.outcome
              }))
            });
            break;
          }
          console.log("Gazete üretimine geçiliyor:", { group: code, date: day, matchCount: candidate.matches.length });
          const attemptId = await acquireGazetteGenerationLock(base, day, token, now, lockRaw);
          if (!attemptId) break;
          dailyAttempted = true;
          try {
            const generated = await publishDailyGazette(
              env, code, day, matches, candidate.matches, riskEvents, token, now,
              { group, seasons, riskCache }
            );
            const committed = await commitGazetteAndLock(
              base, day, attemptId, generated.currentValues, token, now
            );
            if (!committed) throw new Error("Gazete kilidi veya güncel tarih değişti; eski üretim yayımlanmadı.");
            console.log("Günlük gazete yayımlandı:", code, day);
            const published = { ...generated.currentValues };
            const timelineReady = await retryCurrentGazetteTimeline(base, published, token, now);
            if (!timelineReady) {
              timelineBlocked = true;
              console.error("Zaman çizelgesi kaydı bekliyor:", code, day);
            }
          } catch (error) {
            await finishGazetteGenerationLock(base, day, attemptId, error, token, now).catch(lockError =>
              console.error("Gazete kilidi güncellenemedi:", code, lockError));
            console.error("Gazete üretim hatası:", code, error);
          }
          // At most one date is published in one cron invocation.
          break;
        }

        if (timelineBlocked) continue;
        if (dailyAttempted) break;

        let seasonAttempted = false;
        for (const season of seasons) {
          if (!season.startDate || !season.endDate || today < season.endDate) continue;
          const fixtures = matches.filter(match => {
            if (match.seasonId) return match.seasonId === season.id;
            const date = localDay(new Date(fsTime(match.kickoff)));
            return date >= season.startDate && date <= season.endDate;
          });
          if (!fixtures.length || !fixtures.every(finished)) continue;
          const docPath = base + "/seasonDocumentaries/" + encodeURIComponent(season.id);
          const existingRaw = await firestoreGetRaw(docPath, token);
          const existing = existingRaw ? fsFields(existingRaw.fields || {}) : null;
          if (existing && existing.status === "published") continue;
          const attemptId = await acquireSeasonDocumentaryLock(base, season.id, token, now, existingRaw);
          if (!attemptId) continue;
          seasonAttempted = true;
          try {
            const riskFacts = await gazetteRiskFactsForMatches(code, fixtures, token, riskCache);
            const unresolved = riskFacts.some(risk => risk.status !== "resolved");
            if (unresolved) {
              await finishSeasonDocumentaryAttempt(base, season, attemptId, "waiting", token, { now });
              break;
            }
            const content = await publishSeasonDocumentary(env, code, season, fixtures, token, {
              allMatches: matches, seasons, riskFacts, riskCache
            });
            const committed = await finishSeasonDocumentaryAttempt(
              base, season, attemptId, "published", token, { now, content }
            );
            if (!committed) throw new Error("Sezon belgeseli kilidi değişti; eski üretim yayımlanmadı.");
            console.log("Sezon belgeseli Onur Duvarı'na eklendi:", code, season.id);
          } catch (error) {
            await finishSeasonDocumentaryAttempt(
              base, season, attemptId, "error", token, { now, error }
            ).catch(lockError => console.error("Sezon belgeseli kilidi güncellenemedi:", code, lockError));
            console.error("Belgesel üretim hatası:", code, season.id, error);
          }
          break;
        }
        if (seasonAttempted) break;
      } catch (error) {
        console.error("Medya otomasyonu lig hatası:", code, error);
      }
    }
  } catch (error) {
    console.error("Medya otomasyonu genel hatası:", error);
  }
}
