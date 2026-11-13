// FUTBOLBARBAROS - COKLU LIG + GUNLUK BONUS MAC SISTEMI
// Firebase Spark (ucretsiz plan) ile calisir. Cloud Functions gerektirmez.
import { initializeApp } from 'https://www.gstatic.com/firebasejs/13.2.0/firebase-app.js';
import { getAuth, signInAnonymously, onAuthStateChanged, setPersistence, browserLocalPersistence } from 'https://www.gstatic.com/firebasejs/13.2.0/firebase-auth.js';
import { getIdToken } from 'https://www.gstatic.com/firebasejs/13.2.0/firebase-auth.js';
import { getMessaging, getToken, isSupported, onMessage } from 'https://www.gstatic.com/firebasejs/13.2.0/firebase-messaging.js';
import {
  getFirestore, doc, getDoc, setDoc, collection, getDocs,
  query, orderBy, onSnapshot, updateDoc, deleteDoc, serverTimestamp, Timestamp
} from 'https://www.gstatic.com/firebasejs/13.2.0/firebase-firestore.js';
import { firebaseConfig, ADMIN_UID, firebaseVapidKey } from './config.js';

const $ = id => document.getElementById(id);
const hasConfig = Boolean(firebaseConfig?.apiKey && firebaseConfig?.projectId);
const TIME_ZONE = 'Europe/Istanbul';
// Cloudflare Worker URL will be inserted after deploying worker.js.
const ESPN_LOOKUP_ENDPOINT = 'https://withered-flower-d39e.anileris215.workers.dev';
const KNOWN_LEAGUES = [
  { code: 'BARBAROS26', label: 'BARBAROS26' },
  { code: 'ILOVE12CBRO', label: 'ILOVE12CBRO' },
  { code: 'HALILPERION', label: 'HALILPERION' }
];

const KNOWN_LEAGUE_CODES = KNOWN_LEAGUES.map(item => item.code);

let db, uid = null, player = null, groupCode = '';
let authUser = null, pushMessaging = null, browserPushToken = null, foregroundMessageBound = false;
let memberships = [], matches = [], players = [], bonusSelections = [], activeMatch = null;
let leagueCatalog = [];
let leagueNames = {};
let avatars = [], userProfiles = {};
let unsubMatches = null, unsubPlayers = null, unsubBonusSelections = null;
let unsubAvatars = null, unsubProfiles = null;

const isAdmin = () => Boolean(uid) && uid === ADMIN_UID;

async function savePushRegistration() {
  if (!db || !uid || !browserPushToken || !memberships.length) return;
  await setDoc(doc(db, 'pushTokens', uid), {
    uid,
    token: browserPushToken,
    groupCodes: [...new Set(memberships)],
    playerName: player?.name || '',
    updatedAt: serverTimestamp()
  }, { merge: true });
}

async function enablePushNotifications(requestPermission = true) {
  const button = $('enableNotificationsButton');
  if (!('Notification' in window) || !('serviceWorker' in navigator)) {
    throw new Error('Bu tarayıcı web bildirimlerini desteklemiyor.');
  }

  let permission = Notification.permission;
  if (permission !== 'granted' && requestPermission) {
    permission = await Notification.requestPermission();
  }
  if (permission !== 'granted') {
    if (button) button.textContent = permission === 'denied' ? 'Bildirim izni kapalı' : '🔔 Bildirimleri aç';
    throw new Error('Bildirim izni verilmedi. Tarayıcı site ayarlarından izin verebilirsin.');
  }

  if (!await isSupported()) {
    throw new Error('Bu tarayıcı Firebase web bildirimlerini desteklemiyor.');
  }

  const swUrl = new URL('./firebase-messaging-sw.js', import.meta.url);
  const swScope = new URL('./', import.meta.url).pathname;
  const registration = await navigator.serviceWorker.register(swUrl, { scope: swScope });
  pushMessaging = getMessaging();
  browserPushToken = await getToken(pushMessaging, {
    vapidKey: firebaseVapidKey,
    serviceWorkerRegistration: registration
  });

  if (!browserPushToken) throw new Error('Bildirim cihaz kaydı oluşturulamadı.');
  await savePushRegistration();

  if (!foregroundMessageBound) {
    onMessage(pushMessaging, payload => {
      const title = payload.notification?.title || payload.data?.title || 'FUTBOLBARBAROS';
      const body = payload.notification?.body || payload.data?.body || '';
      if (Notification.permission === 'granted') new Notification(title, { body });
    });
    foregroundMessageBound = true;
  }

  if (button) button.textContent = '🔔 Bildirimler açık';
  return true;
}

async function setupPushNotifications() {
  const button = $('enableNotificationsButton');
  if (!button) return;
  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      await enablePushNotifications(true);
      message($('pushNotificationMessage'), 'Bu cihaz bildirimlere kaydedildi.', false);
    } catch (err) {
      console.error('Bildirim kaydı:', err);
      alert(err.message || 'Bildirimler etkinleştirilemedi.');
    } finally {
      button.disabled = false;
    }
  });

  if (Notification.permission === 'granted') {
    try {
      await enablePushNotifications(false);
    } catch (err) {
      console.warn('Önceden izin verilen bildirim kaydı yenilenemedi:', err);
    }
  } else if (Notification.permission === 'denied') {
    button.textContent = 'Bildirim izni kapalı';
  }
}

async function sendAdminPushNotification() {
  if (!isAdmin()) throw new Error('Yönetici yetkisi gerekli.');
  const title = $('pushNotificationTitle')?.value.trim() || '';
  const body = $('pushNotificationBody')?.value.trim() || '';
  const target = $('pushNotificationTarget')?.value || 'all';
  if (!title || !body) throw new Error('Başlık ve mesaj alanlarını doldur.');

  const snapshot = await getDocs(collection(db, 'pushTokens'));
  const devices = snapshot.docs
    .map(item => item.data())
    .filter(item => item.token && (target === 'all' || (Array.isArray(item.groupCodes) && item.groupCodes.includes(target))))
    .map(item => item.token);

  const uniqueTokens = [...new Set(devices)];
  if (!uniqueTokens.length) throw new Error('Bu hedef için bildirim izni vermiş cihaz bulunamadı.');

  const idToken = await getIdToken(authUser);
  const response = await fetch(ESPN_LOOKUP_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'sendNotification',
      idToken,
      title,
      body,
      tokens: uniqueTokens,
      url: 'https://agamanil.github.io/futbolbarbaros/'
    })
  });

  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.ok) {
    throw new Error(result.error || 'Bildirim gönderilemedi.');
  }
  return result;
}


function message(el, text, isError = true) {
  if (!el) return;
  el.textContent = text;
  el.style.color = isError ? 'var(--red)' : 'var(--green)';
}

function toDate(value) {
  if (!value) return null;
  return value?.toDate ? value.toDate() : new Date(value);
}

function fromLocalInput(value) {
  return value ? new Date(`${value}:00+03:00`) : null;
}

function toLocalInput(value) {
  if (!value) return '';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(toDate(value));

  const part = type => parts.find(p => p.type === type)?.value;
  return `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}`;
}

function dateText(value) {
  if (!value) return 'Belirlenmedi';
  return toDate(value).toLocaleString('tr-TR', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: TIME_ZONE
  });
}

function dayKey(value = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(toDate(value));

  const part = type => parts.find(p => p.type === type)?.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function shiftDayKey(key, amount) {
  const [year, month, day] = key.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + amount));

  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

function safe(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[c]));
}

function avatarFor(userId) {
  const avatarId = userProfiles[userId]?.avatarId;
  return avatars.find(item => item.id === avatarId) || null;
}

function avatarMarkup(userId, className = 'player-avatar') {
  const avatar = avatarFor(userId);
  if (avatar?.dataUrl) {
    return `<img class="${className}" src="${safe(avatar.dataUrl)}" alt="Profil fotoğrafı">`;
  }
  return `<span class="${className} avatar-fallback" aria-label="Varsayılan profil fotoğrafı">⚽</span>`;
}

function renderAvatarUI() {
  const trigger = $('profileAvatarButton');
  if (trigger) trigger.innerHTML = avatarMarkup(uid, 'player-avatar');

  const choices = $('avatarChoices');
  if (choices) {
    const selectedId = userProfiles[uid]?.avatarId || '';
    choices.innerHTML = `
      <button type="button" class="avatar-choice ${!selectedId ? 'selected' : ''}" data-avatar-id="">
        <span class="player-avatar avatar-fallback">⚽</span><small>Varsayılan</small>
      </button>
      ${avatars.map(item => `
        <button type="button" class="avatar-choice ${selectedId === item.id ? 'selected' : ''}" data-avatar-id="${safe(item.id)}">
          <img class="player-avatar" src="${safe(item.dataUrl)}" alt="${safe(item.name || 'Profil fotoğrafı')}">
          <small>${safe(item.name || 'Avatar')}</small>
        </button>
      `).join('')}
    `;
  }

  const adminList = $('avatarAdminList');
  if (adminList) {
    adminList.innerHTML = avatars.length ? avatars.map(item => `
      <div class="avatar-admin-item">
        <img class="player-avatar" src="${safe(item.dataUrl)}" alt="${safe(item.name || 'Avatar')}">
        <span>${safe(item.name || 'Avatar')}</span>
        <button type="button" class="danger-btn" data-delete-avatar="${safe(item.id)}">Sil</button>
      </div>
    `).join('') : '<p class="match-meta">Henüz avatar yüklenmedi.</p>';
  }
}

async function compressAvatar(file) {
  if (!file || !file.type.startsWith('image/')) {
    throw new Error('Lütfen geçerli bir görsel dosyası seç.');
  }

  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement('canvas');
  const size = 256;
  canvas.width = size;
  canvas.height = size;
  const side = Math.min(bitmap.width, bitmap.height);
  const sx = (bitmap.width - side) / 2;
  const sy = (bitmap.height - side) / 2;
  const context = canvas.getContext('2d');
  context.drawImage(bitmap, sx, sy, side, side, 0, 0, size, size);
  bitmap.close?.();

  const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/webp', 0.78));
  if (!blob) throw new Error('Fotoğraf dönüştürülemedi. Başka bir görsel dene.');
  if (blob.size > 250 * 1024) {
    throw new Error('Fotoğraf sıkıştırıldıktan sonra bile çok büyük. Daha küçük bir görsel dene.');
  }

  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Fotoğraf okunamadı.'));
    reader.readAsDataURL(blob);
  });

  return { dataUrl, mimeType: blob.type };
}

function validName(name) {
  return name.length >= 2 && name.length <= 18;
}

function hasResult(m) {
  return m.homeScore !== undefined && m.awayScore !== undefined;
}

function liveScoreMarkup(m) {
  if (hasResult(m)) {
    return `<div class="match-meta" style="margin-top:5px;color:#22c55e;font-weight:800;">BİTTİ · ${safe(m.homeScore)} - ${safe(m.awayScore)}</div>`;
  }
  if (m.espnState === 'in' && m.liveHomeScore !== undefined && m.liveAwayScore !== undefined) {
    const detail = m.espnStatus ? ` · ${safe(m.espnStatus)}` : '';
    return `<div class="match-meta" style="margin-top:5px;color:#ef4444;font-weight:800;">● CANLI · ${safe(m.liveHomeScore)} - ${safe(m.liveAwayScore)}${detail}</div>`;
  }
  if (m.espnState === 'pre') {
    return `<div class="match-meta" style="margin-top:5px;color:#94a3b8;">BAŞLAMADI</div>`;
  }
  return '';
}

function isTurkeyTeamName(name) {
  const normalized = String(name || '')
    .toLocaleLowerCase('tr-TR')
    .replace(/ü/g, 'u')
    .replace(/ı/g, 'i')
    .replace(/ş/g, 's')
    .replace(/ö/g, 'o')
    .replace(/ç/g, 'c')
    .replace(/ğ/g, 'g')
    .replace(/[^a-z0-9]/g, '');

  return normalized.includes('turkiye') || normalized.includes('turkey');
}

function matchEventsMarkup(m) {
  const events = Array.isArray(m.espnKeyEvents) ? m.espnKeyEvents : [];
  if (!events.length) return '';

  const rows = events.map(event => {
    const isRedCard = event.kind === 'redCard';
    const teamName = event.side === 'home'
      ? m.homeTeam
      : event.side === 'away'
        ? m.awayTeam
        : event.teamName;
    const icon = isRedCard ? '🟥' : (isTurkeyTeamName(teamName) ? '🇹🇷' : '⚽');
    const minute = event.minute
      ? `<span class="match-event-minute">${safe(event.minute)}</span>`
      : '';
    const note = event.kind === 'ownGoal'
      ? ' <small class="match-event-note">KK</small>'
      : event.kind === 'penaltyGoal'
        ? ' <small class="match-event-note">P</small>'
        : '';

    return `<li class="match-event${isRedCard ? ' match-event-red-card' : ''}">
      <span class="match-event-icon" aria-hidden="true">${icon}</span>
      ${minute}
      <span class="match-event-player">${safe(event.player || (isRedCard ? 'Kırmızı kart' : 'Gol'))}${note}</span>
    </li>`;
  }).join('');

  return `<div class="match-events" aria-label="Gol ve kırmızı kart olayları">
    <ul class="match-events-list">${rows}</ul>
  </div>`;
}

function predictionFor(m) {
  return m.predictions?.[uid];
}

function isLocked(m) {
  if (!m?.predictionOpenAt || !m?.predictionCloseAt) return true;

  const now = Date.now();

  return now < toDate(m.predictionOpenAt).getTime()
    || now >= toDate(m.predictionCloseAt).getTime();
}

function predictionStatus(m) {
  if (!m.predictionOpenAt || !m.predictionCloseAt) {
    return 'Tahmin saatleri belirlenmemiş';
  }

  const now = Date.now();
  const open = toDate(m.predictionOpenAt).getTime();
  const close = toDate(m.predictionCloseAt).getTime();

  if (now < open) {
    return `Tahminler ${dateText(m.predictionOpenAt)} tarihinde açılacak`;
  }

  if (now >= close) {
    return `Tahmin süresi ${dateText(m.predictionCloseAt)} tarihinde sona erdi`;
  }

  return `Tahminler açık · Kapanış: ${dateText(m.predictionCloseAt)}`;
}

function renderLeagueOptions() {
  const select = $('leagueSelect');
  if (!select) return;

  select.innerHTML = memberships
    .map(code => `<option value="${safe(code)}">${safe(leagueNames[code] || code)}</option>`)
    .join('');

  select.value = groupCode;
}

/* Yönetici için Firestore'daki bütün ligleri getirir. */
async function loadLeagueCatalog() {
  if (!isAdmin()) return;

  const snap = await getDocs(collection(db, 'groups'));
  leagueCatalog = snap.docs.map(item => ({
    code: item.id,
    name: item.data().name || item.id
  })).sort((a, b) => a.name.localeCompare(b.name, 'tr'));

  leagueNames = Object.fromEntries(leagueCatalog.map(item => [item.code, item.name]));
  renderLeagueOptions();
  refreshCopyTargetOptions();
  renderLeagueManager();
}

/* Üyenin kayıtlı olduğu liglerin görünen adlarını getirir. */
async function loadMembershipLeagueNames() {
  for (const code of memberships) {
    try {
      const snap = await getDoc(doc(db, 'groups', code));
      leagueNames[code] = snap.exists() ? (snap.data().name || code) : code;
    } catch (err) {
      console.warn('Lig adı okunamadı:', code, err);
      leagueNames[code] = leagueNames[code] || code;
    }
  }
  renderLeagueOptions();
}

/* Yönetici panelindeki hedef ligleri doldurur. */
function refreshCopyTargetOptions() {
  const select = $('copyTargetLeague');
  if (!select) return;

  const previous = select.value;
  const catalog = leagueCatalog.length
    ? leagueCatalog
    : KNOWN_LEAGUES.map(item => ({ code: item.code, name: leagueNames[item.code] || item.label }));

  select.innerHTML = catalog
    .filter(item => item.code !== groupCode)
    .map(item => `<option value="${safe(item.code)}">${safe(item.name)} · ${safe(item.code)}</option>`)
    .join('');

  if ([...select.options].some(option => option.value === previous)) {
    select.value = previous;
  }
}

/* Yönetici panelindeki lig düzenleme listesini oluşturur. */
function renderLeagueManager() {
  const el = $('leagueManagerList');
  if (!el) return;

  if (!isAdmin()) {
    el.innerHTML = '';
    return;
  }

  if (!leagueCatalog.length) {
    el.innerHTML = '<div class="empty">Henüz lig bulunamadı.</div>';
    return;
  }

  el.innerHTML = leagueCatalog.map(league => `
    <div class="league-manage-row">
      <div class="league-manage-code">
        <strong>${safe(league.name)}</strong>
        <small>Kod: ${safe(league.code)}</small>
      </div>
      <label class="league-manage-input">
        Görünen lig adı
        <input type="text" maxlength="32" value="${safe(league.name)}" data-league-name="${safe(league.code)}">
      </label>
      <button type="button" class="small-btn" data-save-league="${safe(league.code)}">Adı kaydet</button>
    </div>
  `).join('');
}

/* Yönetici giriş yaptığında eksik bilinen ligleri oluşturur. */
async function ensureKnownLeagueDocs() {
  if (!isAdmin()) return;

  for (const league of KNOWN_LEAGUES) {
    const ref = doc(db, 'groups', league.code);
    const snap = await getDoc(ref);

    if (!snap.exists()) {
      await setDoc(ref, {
        code: league.code,
        name: league.label,
        createdAt: serverTimestamp(),
        createdBy: uid
      });
    }
  }
}

function showApp() {
  $('entryView').classList.add('hidden');
  $('appView').classList.remove('hidden');

  $('userBadge').textContent = player?.name || 'Oyuncu';
  $('userBadge').classList.remove('hidden');
  renderAvatarUI();

  document.querySelectorAll('.admin-only').forEach(el => {
    el.classList.toggle('hidden', !isAdmin());
  });

  renderLeagueOptions();
  refreshCopyTargetOptions();
}

function activateTab(name) {
  document.querySelectorAll('.tab').forEach(tab => {
    tab.classList.toggle('active', tab.dataset.tab === name);
  });

  ['matches', 'table', 'admin'].forEach(tab => {
    $(`${tab}Tab`).classList.toggle('hidden', tab !== name);
  });
}

async function switchLeague(code) {
  if (!code) return;

  const [snap, groupSnap] = await Promise.all([
    getDoc(doc(db, 'groups', code, 'players', uid)),
    getDoc(doc(db, 'groups', code))
  ]);

  if (!snap.exists()) {
    throw new Error('Bu ligde oyuncu kaydın bulunamadı.');
  }

  leagueNames[code] = groupSnap.exists() ? (groupSnap.data().name || code) : code;
  groupCode = code;
  player = { ...snap.data(), uid };

  if (!memberships.includes(code)) {
    memberships.push(code);
  }

  localStorage.setItem('fb_leagues', JSON.stringify(memberships));

  showApp();
  refreshCopyTargetOptions();
  listen();
  activateTab('matches');
}

async function boot() {
  if (!hasConfig) {
    return message(
      $('entryMessage'),
      'Kurulum eksik: config.js Firebase ayarlarını kontrol et.'
    );
  }

  const app = initializeApp(firebaseConfig);
  const auth = getAuth(app);

  // Anonim Firebase kimliğini bu tarayıcıda kalıcı tut.
  try {
    await setPersistence(auth, browserLocalPersistence);
  } catch (err) {
    // Gizli mod veya tarayıcı depolama kısıtında mevcut oturumla devam et.
    console.warn('Firebase oturum kalıcılığı ayarlanamadı:', err);
  }

  db = getFirestore(app);

  // Firebase'in mevcut anonim oturumunu geri yükle; yalnızca kullanıcı yoksa yenisini oluştur.
  const user = await new Promise((resolve, reject) => {
    let signingIn = false;
    let settled = false;
    let unsubscribe = () => {};

    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      unsubscribe();
      callback(value);
    };

    unsubscribe = onAuthStateChanged(auth, async currentUser => {
      if (currentUser) {
        finish(resolve, currentUser);
        return;
      }
      if (signingIn) return;
      signingIn = true;
      try {
        const credential = await signInAnonymously(auth);
        finish(resolve, credential.user);
      } catch (err) {
        finish(reject, err);
      }
    }, err => finish(reject, err));
  });

  authUser = user;
  uid = user.uid;
  console.info('FUTBOLBARBAROS Firebase UID:', uid);
  console.info('FUTBOLBARBAROS yönetici hesabı:', isAdmin() ? 'EVET' : 'HAYIR');

  unsubAvatars = onSnapshot(collection(db, 'avatars'), snap => {
    avatars = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderAvatarUI();
    renderTable();
  }, err => console.error('Avatar galerisi okunamadı:', err));

  unsubProfiles = onSnapshot(collection(db, 'users'), snap => {
    userProfiles = Object.fromEntries(snap.docs.map(d => [d.id, d.data()]));
    renderAvatarUI();
    renderTable();
  }, err => console.error('Oyuncu profilleri okunamadı:', err));

  if (isAdmin()) {
    try {
      await ensureKnownLeagueDocs();
      await loadLeagueCatalog();
    } catch (err) {
      console.error('Ligler hazırlanamadı:', err);
    }
  }

  await restoreSession();
  await setupPushNotifications();
}

async function restoreSession() {
  let saved = [];

  try {
    saved = JSON.parse(localStorage.getItem('fb_leagues') || '[]');

    if (!Array.isArray(saved)) {
      saved = [];
    }
  } catch {
    saved = [];
  }

  // Eski ILOVE12C kalıntılarını yeni ILOVE12CBRO ile değiştir.
  saved = saved.map(c => c === 'ILOVE12C' ? 'ILOVE12CBRO' : c);
  const savedCodes = [...new Set(saved.filter(x => typeof x === 'string' && x))];

  // Kayıtlı ligler + bilinen ligler: localStorage silinmiş olsa bile
  // Firestore'daki oyuncu kaydından kullanıcı yeniden tanınır.
  const candidates = [...new Set([...savedCodes, ...KNOWN_LEAGUE_CODES])];
  const valid = [];

  for (const code of candidates) {
    try {
      const snap = await getDoc(doc(db, 'groups', code, 'players', uid));

      if (snap.exists()) {
        valid.push(code);
      }
    } catch (err) {
      // Geçici hata (ağ, izin vb.) yüzünden kayıtlı ligi SİLME.
      console.error('Lig oturumu kontrolü:', code, err);

      if (savedCodes.includes(code)) {
        valid.push(code);
      }
    }
  }

  memberships = valid;
  localStorage.setItem('fb_leagues', JSON.stringify(memberships));
  await loadMembershipLeagueNames();

  let entered = false;

  for (const code of memberships) {
    try {
      await switchLeague(code);
      entered = true;
      break;
    } catch (err) {
      console.error('Lige girilemedi:', code, err);
    }
  }

  if (!entered) {
    $('entryView').classList.remove('hidden');
    $('appView').classList.add('hidden');

    if (savedCodes.length) {
      message(
        $('entryMessage'),
        'Kayıtlı liglerin var ancak bu tarayıcıdaki Firebase oturumu oyuncu kaydınla eşleşmedi. Anonim oturum veya tarayıcı verileri sıfırlanmış olabilir. Konsoldaki FUTBOLBARBAROS Firebase UID bilgisini kontrol et.'
      );
    }
  }
}

/* İlk kez lig koduyla giriş */
$('joinForm').addEventListener('submit', async e => {
  e.preventDefault();

  const msg = $('entryMessage');

  if (!db || !uid) {
    return message(msg, 'Bağlantı henüz hazır değil.');
  }

  const code = $('groupCode').value.trim().toUpperCase();
  const name = $('playerName').value.trim();

  if (!code || !name) return;

  if (!validName(name)) {
    return message(msg, 'İsim 2-18 karakter arasında olmalı.');
  }

  try {
    const group = await getDoc(doc(db, 'groups', code));

    if (!group.exists()) {
      throw new Error('Bu grup koduyla bir lig bulunamadı.');
    }

    const ref = doc(db, 'groups', code, 'players', uid);
    const existing = await getDoc(ref);

    if (existing.exists()) {
      if (existing.data().name !== name) {
        throw new Error(
          'Bu cihazdaki oyuncu profili bu ligde farklı bir isimle kayıtlı. Kayıtlı ismini kullan.'
        );
      }
    } else {
      const all = await getDocs(collection(db, 'groups', code, 'players'));

      if (all.docs.some(d =>
        (d.data().name || '').toLowerCase() === name.toLowerCase()
      )) {
        throw new Error('Bu oyuncu adı bu ligde zaten kullanılıyor.');
      }

      await setDoc(ref, {
        name,
        uid,
        joinedAt: serverTimestamp()
      });
    }

    if (!memberships.includes(code)) {
      memberships.push(code);
    }

    memberships = [...new Set(memberships)];

    localStorage.setItem('fb_leagues', JSON.stringify(memberships));
    localStorage.removeItem('fb_player');

    await switchLeague(code);
    await savePushRegistration();
  } catch (err) {
    console.error(err);
    message(msg, err.message || 'Giriş yapılamadı.');
  }
});

/* Uygulama içinden başka lige katıl */
$('leagueJoinForm').addEventListener('submit', async e => {
  e.preventDefault();

  const code = $('newLeagueCode').value.trim().toUpperCase();
  if (!code) return;

  try {
    const group = await getDoc(doc(db, 'groups', code));

    if (!group.exists()) {
      throw new Error('Bu kodla bir lig bulunamadı.');
    }

    const ref = doc(db, 'groups', code, 'players', uid);
    const existing = await getDoc(ref);

    if (existing.exists()) {
      if (!memberships.includes(code)) {
        memberships.push(code);
      }
    } else {
      const all = await getDocs(collection(db, 'groups', code, 'players'));

      if (all.docs.some(d =>
        (d.data().name || '').toLowerCase() === player.name.toLowerCase()
      )) {
        throw new Error('Bu oyuncu adı bu ligde zaten kullanılıyor.');
      }

      await setDoc(ref, {
        name: player.name,
        uid,
        joinedAt: serverTimestamp()
      });

      memberships.push(code);
    }

    memberships = [...new Set(memberships)];
    localStorage.setItem('fb_leagues', JSON.stringify(memberships));

    $('newLeagueCode').value = '';
    message($('leagueMessage'), 'Lige katıldın!', false);

    await switchLeague(code);
    await savePushRegistration();
  } catch (err) {
    console.error(err);
    message($('leagueMessage'), err.message || 'Lige katılınamadı.');
  }
});

$('leagueSelect').addEventListener('change', async e => {
  try {
    await switchLeague(e.target.value);
    message($('leagueMessage'), '');
  } catch (err) {
    console.error(err);
    message($('leagueMessage'), err.message || 'Lige geçilemedi.');
    renderLeagueOptions();
  }
});

function listen() {
  if (unsubMatches) unsubMatches();
  if (unsubPlayers) unsubPlayers();
  if (unsubBonusSelections) unsubBonusSelections();

  matches = [];
  players = [];
  bonusSelections = [];

  renderMatches();
  renderAdminMatches();
  renderTable();
  renderBonusPanel();

  if (!groupCode) return;

  unsubMatches = onSnapshot(
    query(
      collection(db, 'groups', groupCode, 'matches'),
      orderBy('kickoff', 'asc')
    ),
    snap => {
      matches = snap.docs.map(d => ({
        id: d.id,
        ...d.data()
      }));

      renderMatches();
      renderAdminMatches();
      renderTable();
      renderBonusPanel();
    },
    err => console.error('Maç dinleme hatası:', err)
  );

  unsubPlayers = onSnapshot(
    collection(db, 'groups', groupCode, 'players'),
    snap => {
      players = snap.docs.map(d => ({
        id: d.id,
        ...d.data()
      }));

      renderTable();
      renderBonusPanel();
    },
    err => console.error('Oyuncu dinleme hatası:', err)
  );

  unsubBonusSelections = onSnapshot(
    collection(db, 'groups', groupCode, 'bonusSelections'),
    snap => {
      bonusSelections = snap.docs.map(d => ({
        id: d.id,
        ...d.data()
      }));

      renderMatches();
      renderAdminMatches();
      renderTable();
      renderBonusPanel();
    },
    err => {
      console.error('Bonus seçimleri dinleme hatası:', err);

      const status = $('bonusStatus');

      if (status) {
        status.textContent = 'Bonus seçimleri okunamadı. Firestore Rules ayarlarını kontrol et.';
      }
    }
  );
}

function bonusMatchIds() {
  return new Set(
    bonusSelections
      .map(selection => selection.matchId)
      .filter(Boolean)
  );
}

function renderMatches() {
  const countEl = $('matchCount');

  if (countEl) {
    countEl.textContent = `${matches.length} MAÇ`;
  }

  const el = $('matchesList');
  if (!el) return;

  if (!matches.length) {
    el.innerHTML = '<div class="empty">Henüz maç eklenmedi.</div>';
    return;
  }

  const bonusIds = bonusMatchIds();

  el.innerHTML = matches.map(m => {
    const p = predictionFor(m);
    const locked = isLocked(m);

    let buttonText = p ? 'Düzenle' : 'Tahmin et';

    if (!m.predictionOpenAt || !m.predictionCloseAt) {
      buttonText = 'Saatler belirlenmemiş';
    } else if (Date.now() < toDate(m.predictionOpenAt).getTime()) {
      buttonText = 'Henüz açılmadı';
    } else if (Date.now() >= toDate(m.predictionCloseAt).getTime()) {
      buttonText = 'Tahmin kapandı';
    }

    let othersHtml = '';

    if (p && m.predictions) {
      const otherEntries = Object.entries(m.predictions)
        .filter(([userId]) => userId !== uid);

      if (otherEntries.length > 0) {
        othersHtml = `<div class="others-predictions" style="margin-top:8px;font-size:.85rem;border-top:1px dashed rgba(255,255,255,.1);padding-top:6px;">
          <div style="font-weight:bold;margin-bottom:4px;color:var(--accent,#3b82f6);">Diğer Oyuncuların Tahminleri:</div>
          <ul style="list-style:none;padding:0;margin:0;">
            ${otherEntries.map(([userId, pred]) =>
              `<li><b>${safe(pred.playerName || 'Oyuncu')}:</b> ${pred.home} - ${pred.away}</li>`
            ).join('')}
          </ul>
        </div>`;
      } else {
        othersHtml = '<div class="others-predictions" style="margin-top:8px;font-size:.85rem;color:#888;">Diğer oyuncular henüz bu maça tahmin yapmamış.</div>';
      }
    } else {
      othersHtml = '<div class="others-predictions-warning" style="margin-top:8px;font-size:.8rem;color:#f59e0b;background:rgba(245,158,11,.1);padding:6px;border-radius:4px;">Tahminini kaydettikten sonra diğer kullanıcıların tahminlerini görebilirsin.</div>';
    }

    return `<article class="match-card" data-match-id="${safe(m.id)}">
      <div>
        <div class="match-meta">${safe(m.competition || 'FUTBOL')} · ${dateText(m.kickoff)} ${bonusIds.has(m.id) ? '<span style="display:inline-block;margin-left:6px;padding:3px 7px;border-radius:5px;background:rgba(245,158,11,.18);color:#fbbf24;font-weight:800;">⭐ BONUS 2X</span>' : ''}</div>
        <div class="teams"><span>${safe(m.homeTeam)}</span><span class="vs">VS</span><span>${safe(m.awayTeam)}</span></div>
        <div class="match-meta">${safe(predictionStatus(m))}</div>
        ${liveScoreMarkup(m)}
        ${matchEventsMarkup(m)}
      </div>
      <div class="match-actions">
        <div class="prediction-label">
          ${p ? `Tahminin: <b>${p.home}-${p.away}</b>` : 'Henüz tahmin yok'}
          ${hasResult(m) ? `<br>Sonuç: <b>${m.homeScore}-${m.awayScore}</b>` : ''}
        </div>
        <button class="small-btn" data-predict="${safe(m.id)}" ${locked ? 'disabled' : ''}>${buttonText}</button>
      </div>
      <div style="grid-column:1 / -1;width:100%;">${othersHtml}</div>
    </article>`;
  }).join('');

  el.querySelectorAll('[data-predict]').forEach(button => {
    button.addEventListener('click', () => openPrediction(button.dataset.predict));
  });
}

function openPrediction(id) {
  activeMatch = matches.find(m => m.id === id);

  if (!activeMatch || isLocked(activeMatch)) return;

  const p = predictionFor(activeMatch);

  $('predictionTitle').textContent = `${activeMatch.homeTeam} - ${activeMatch.awayTeam}`;
  $('predictionKickoff').textContent = dateText(activeMatch.kickoff);
  $('homePrediction').value = p?.home ?? '';
  $('awayPrediction').value = p?.away ?? '';

  message($('predictionMessage'), '');

  const modalWarning = $('modalPredictionWarning');

  if (modalWarning) {
    if (!p) {
      modalWarning.style.display = 'block';
      modalWarning.textContent = 'Not: Tahminini kaydettikten sonra bu maç için diğer kullanıcıların tahminlerini de görüntüleyebilirsin.';
    } else {
      modalWarning.style.display = 'none';
    }
  }

  $('predictionDialog').showModal();
}

$('predictionForm').addEventListener('submit', async e => {
  e.preventDefault();

  const msg = $('predictionMessage');

  if (!activeMatch || isLocked(activeMatch)) {
    return message(msg, 'Bu maçın tahmin süresi açık değil veya sona erdi.');
  }

  const hRaw = $('homePrediction').value;
  const aRaw = $('awayPrediction').value;

  const h = Number(hRaw);
  const a = Number(aRaw);

  const invalid = n => !Number.isInteger(n) || n < 0 || n > 30;

  if (hRaw === '' || aRaw === '' || invalid(h) || invalid(a)) {
    return message(msg, '0 ile 30 arasında tam sayı gir.');
  }

  try {
    await updateDoc(
      doc(db, 'groups', groupCode, 'matches', activeMatch.id),
      {
        [`predictions.${uid}`]: {
          home: h,
          away: a,
          playerName: player.name,
          updatedAt: Date.now()
        }
      }
    );

    $('predictionDialog').close();
  } catch (err) {
    console.error(err);
    message(msg, 'Tahmin kaydedilemedi: ' + err.message);
  }
});

/* ESPN ID ile otomatik maç bilgisi çek ve tek adımda kaydet. */
let fetchedEspnMatch = null;

$('lookupEspnMatchBtn')?.addEventListener('click', async () => {
  if (!isAdmin()) return message($('matchFormMessage'), 'Yönetici yetkisi yok.');
  const espnId = $('newMatchEspnId').value.trim();
  if (!/^\d{5,20}$/.test(espnId)) return message($('matchFormMessage'), "Geçerli bir ESPN maç ID'si gir.");
  if (!ESPN_LOOKUP_ENDPOINT.startsWith('https://')) return message($('matchFormMessage'), 'Önce Cloudflare Worker adresini app.js içindeki ESPN_LOOKUP_ENDPOINT alanına eklemeliyiz.');
  const button = $('lookupEspnMatchBtn');
  button.disabled = true;
  message($('matchFormMessage'), 'ESPN maç bilgileri alınıyor...', false);
  try {
    const response = await fetch(`${ESPN_LOOKUP_ENDPOINT}?event=${encodeURIComponent(espnId)}`);
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || 'ESPN maç bilgisi bulunamadı.');
    fetchedEspnMatch = data.match;
    $('espnMatchPreview').innerHTML = `<b>${safe(data.match.homeTeam)} - ${safe(data.match.awayTeam)}</b><br>${safe(data.match.competition)}<br>${safe(dateText(data.match.kickoff))}`;
    $('espnMatchPreview').style.display = 'block';
    $('createEspnMatchBtn').disabled = false;
    message($('matchFormMessage'), 'Maç bulundu. Bilgileri kontrol edip Maçı Ekle butonuna bas.', false);
  } catch (err) {
    fetchedEspnMatch = null;
    $('espnMatchPreview').style.display = 'none';
    $('createEspnMatchBtn').disabled = true;
    message($('matchFormMessage'), 'Maç bilgisi alınamadı: ' + err.message);
  } finally {
    button.disabled = false;
  }
});

$('matchForm').addEventListener('submit', async e => {
  e.preventDefault();
  if (!isAdmin()) return message($('matchFormMessage'), 'Yönetici yetkisi yok.');
  if (!fetchedEspnMatch || fetchedEspnMatch.espnId !== $('newMatchEspnId').value.trim()) {
    return message($('matchFormMessage'), 'Önce ESPN ID ile maç bilgilerini getir.');
  }
  const kickoff = new Date(fetchedEspnMatch.kickoff);
  const predictionOpenAt = new Date(Date.now() + 5 * 60 * 1000);
  const predictionCloseAt = new Date(kickoff.getTime() - 60 * 60 * 1000);
  if (!Number.isFinite(kickoff.getTime()) || kickoff <= new Date()) return message($('matchFormMessage'), 'Bu maçın başlangıç zamanı geçersiz veya maç başlamış.');
  if (predictionCloseAt <= predictionOpenAt) return message($('matchFormMessage'), 'Tahmin kapanışına 5 dakikadan az kalmış. Bu maç için tahmin açılamaz.');
  try {
    $('createEspnMatchBtn').disabled = true;
    const matchRef = doc(collection(db, 'groups', groupCode, 'matches'));
    await setDoc(matchRef, {
      homeTeam: fetchedEspnMatch.homeTeam,
      awayTeam: fetchedEspnMatch.awayTeam,
      competition: fetchedEspnMatch.competition,
      espnId: fetchedEspnMatch.espnId,
      espnLeagueCode: fetchedEspnMatch.leagueCode || '',
      kickoff: Timestamp.fromDate(kickoff),
      predictionOpenAt: Timestamp.fromDate(predictionOpenAt),
      predictionCloseAt: Timestamp.fromDate(predictionCloseAt),
      createdAt: serverTimestamp(),
      createdBy: uid,
      predictions: {}
    });
    e.target.reset();
    fetchedEspnMatch = null;
    $('espnMatchPreview').style.display = 'none';
    message($('matchFormMessage'), `${groupCode} ligine maç eklendi. Tahminler 5 dakika sonra açılacak.`, false);
  } catch (err) {
    console.error(err);
    message($('matchFormMessage'), 'Maç eklenemedi: ' + err.message);
  } finally {
    $('createEspnMatchBtn').disabled = true;
  }
});

function renderAdminMatches() {
  const el = $('adminMatches');
  if (!el) return;

  if (!matches.length) {
    el.innerHTML = '<div class="empty">Henüz maç yok.</div>';
    return;
  }

  const bonusIds = bonusMatchIds();

  el.innerHTML = matches.map(m => `<article class="match-card admin-match-card" data-admin-match-id="${safe(m.id)}">
    <label class="copy-match-check">
      <input type="checkbox" data-copy-match="${safe(m.id)}">
      Bu maçı kopyala
    </label>
    <div>
      <div class="match-meta">${dateText(m.kickoff)} ${bonusIds.has(m.id) ? '<span style="color:#fbbf24;font-weight:800;">⭐ BONUS 2X</span>' : ''}</div>
      <div class="teams"><span>${safe(m.homeTeam)}</span><span class="vs">VS</span><span>${safe(m.awayTeam)}</span></div>
      <div class="match-meta">${safe(predictionStatus(m))}</div>
      ${liveScoreMarkup(m)}
    </div>
    <div class="admin-match-settings">
      <label>Tahmin açılışı<input type="datetime-local" id="open-${safe(m.id)}" value="${safe(toLocalInput(m.predictionOpenAt))}"></label>
      <label>Tahmin kapanışı<input type="datetime-local" id="close-${safe(m.id)}" value="${safe(toLocalInput(m.predictionCloseAt))}"></label>
      <button class="small-btn" data-save-schedule="${safe(m.id)}">Saatleri kaydet</button>
      <label style="display:block;margin-top:10px;">ESPN maç ID'si
        <input type="text" id="espn-${safe(m.id)}" value="${safe(m.espnId || '')}" placeholder="Örn: 401861145" inputmode="numeric" autocomplete="off">
      </label>
      <button class="small-btn" type="button" data-save-espn="${safe(m.id)}">ESPN ID kaydet</button>
      <div class="match-meta" style="margin-top:5px;">${m.espnId ? 'ESPN bağlantısı tanımlı' : 'Henüz ESPN bağlantısı yok'}</div>
      <button class="danger-btn" type="button" data-delete-match="${safe(m.id)}" style="margin-top:8px;">Maçı sil</button>
      <div style="margin-top:10px;padding:12px;border:1px solid var(--border, rgba(255,255,255,.12));border-radius:10px;">
        <b style="display:block;margin-bottom:8px;">${hasResult(m) ? `Kayıtlı sonuç: ${m.homeScore} - ${m.awayScore}` : 'Maç sonucu gir'}</b>
        <div class="two-col">
          <label>Ev skoru<input id="h-${safe(m.id)}" type="number" min="0" max="30" step="1" value="${hasResult(m) ? safe(m.homeScore) : ''}" inputmode="numeric"></label>
          <label>Dep. skoru<input id="a-${safe(m.id)}" type="number" min="0" max="30" step="1" value="${hasResult(m) ? safe(m.awayScore) : ''}" inputmode="numeric"></label>
        </div>
        <button class="small-btn" type="button" data-result="${safe(m.id)}">${hasResult(m) ? 'Skoru güncelle' : 'Sonucu kaydet'}</button>
        ${hasResult(m) ? '<div class="match-meta" style="margin-top:7px;">Skoru değiştirmek puanları da yeniden hesaplar.</div>' : ''}
      </div>
    </div>
  </article>`).join('');

  if (copySelectAll) {
    copySelectAll.checked = false;
  }

  el.querySelectorAll('[data-save-schedule]').forEach(button => {
    button.addEventListener('click', async () => {
      const id = button.dataset.saveSchedule;

      const open = fromLocalInput($(`open-${id}`).value);
      const close = fromLocalInput($(`close-${id}`).value);

      const match = matches.find(m => m.id === id);

      if (!open || !close) {
        return alert('İki tahmin tarihini de gir.');
      }

      if (close <= open) {
        return alert('Kapanış açılıştan sonra olmalı.');
      }

      if (close > toDate(match.kickoff)) {
        return alert('Tahmin kapanışı maç başlangıcından sonra olamaz.');
      }

      button.disabled = true;

      try {
        await updateDoc(
          doc(db, 'groups', groupCode, 'matches', id),
          {
            predictionOpenAt: Timestamp.fromDate(open),
            predictionCloseAt: Timestamp.fromDate(close)
          }
        );

        alert('Bu maçın tahmin saatleri güncellendi.');
      } catch (err) {
        console.error(err);
        alert('Saatler kaydedilemedi: ' + err.message);
      } finally {
        button.disabled = false;
      }
    });
  });

  el.querySelectorAll('[data-save-espn]').forEach(button => {
    button.addEventListener('click', async () => {
      if (!isAdmin()) return alert('Yönetici yetkisi yok.');
      const id = button.dataset.saveEspn;
      const espnId = $(`espn-${id}`)?.value.trim() || '';
      if (espnId && !/^\d{5,20}$/.test(espnId)) {
        return alert('ESPN maç ID\'si yalnızca rakamlardan oluşmalı.');
      }
      button.disabled = true;
      try {
        await updateDoc(doc(db, 'groups', groupCode, 'matches', id), { espnId });
        alert(espnId ? 'ESPN maç ID\'si kaydedildi.' : 'ESPN maç bağlantısı kaldırıldı.');
      } catch (err) {
        console.error(err);
        alert('ESPN ID kaydedilemedi: ' + err.message);
      } finally {
        button.disabled = false;
      }
    });
  });

  el.querySelectorAll('[data-result]').forEach(button => {
    button.addEventListener('click', async () => {
      if (!isAdmin()) {
        return alert('Yönetici yetkisi yok.');
      }

      const id = button.dataset.result;
      const currentMatch = matches.find(m => m.id === id);

      if (!currentMatch) {
        return alert('Maç listede bulunamadı. Sayfayı yenileyip tekrar dene.');
      }

      const hRaw = $(`h-${id}`).value;
      const aRaw = $(`a-${id}`).value;

      const h = Number(hRaw);
      const a = Number(aRaw);

      if (
        hRaw === '' ||
        aRaw === '' ||
        !Number.isInteger(h) ||
        !Number.isInteger(a) ||
        h < 0 ||
        a < 0 ||
        h > 30 ||
        a > 30
      ) {
        return alert('0-30 arasında iki geçerli skor gir.');
      }

      const isCorrection = hasResult(currentMatch);
      const scoreChanged = currentMatch.homeScore !== h || currentMatch.awayScore !== a;

      if (isCorrection && !scoreChanged) {
        return alert('Girilen skor zaten kayıtlı. Herhangi bir değişiklik yapılmadı.');
      }

      if (isCorrection) {
        const approved = confirm(
          `${currentMatch.homeTeam} - ${currentMatch.awayTeam} maçının skorunu ${currentMatch.homeScore}-${currentMatch.awayScore} yerine ${h}-${a} olarak değiştirmek istiyor musun?

Oyuncuların puanları yeni sonuca göre güncellenecek.`
        );

        if (!approved) return;
      }

      button.disabled = true;

      try {
        const scoreUpdate = {
          homeScore: h,
          awayScore: a
        };

        // İlk sonuç girişinde zaman damgası eklenir. Sonradan yapılan
        // düzeltmeler maçın ilk sonuç kayıt zamanını değiştirmez.
        if (!isCorrection) {
          scoreUpdate.resultAt = serverTimestamp();
        }

        await updateDoc(
          doc(db, 'groups', groupCode, 'matches', id),
          scoreUpdate
        );

        alert(isCorrection
          ? `Skor ${h}-${a} olarak güncellendi. Puan tablosu yeni sonuca göre yenilenecek.`
          : 'Maç sonucu kaydedildi.');
      } catch (err) {
        console.error(err);
        alert('Sonuç kaydedilemedi: ' + err.message);
        button.disabled = false;
      }
    });
  });
}

/* Yönetici: maçı aktif ligden sil (tahminler de maçla birlikte silinir). */
$('adminMatches')?.addEventListener('click', async event => {
  const button = event.target.closest('[data-delete-match]');
  if (!button) return;

  if (!isAdmin()) return alert('Yönetici yetkisi yok.');

  const id = button.dataset.deleteMatch;
  const match = matches.find(m => m.id === id);

  if (!match) {
    return alert('Maç listede bulunamadı. Sayfayı yenileyip tekrar dene.');
  }

  const predictionCount = Object.keys(match.predictions || {}).length;

  const approved = confirm(
    `${match.homeTeam} - ${match.awayTeam} maçı ${groupCode} liginden silinecek.

` +
    `Bu maça yapılmış ${predictionCount} tahmin ve varsa girilen sonuç da silinecek, puan tablosu yeniden hesaplanacak.
` +
    `Bu işlem geri alınamaz. Devam etmek istiyor musun?`
  );

  if (!approved) return;

  button.disabled = true;

  try {
    await deleteDoc(doc(db, 'groups', groupCode, 'matches', id));

    // Bu maç bonus seçilmişse seçimleri de temizle ki oyuncu yeniden seçebilsin.
    const relatedBonuses = bonusSelections.filter(s => s.matchId === id);

    for (const selection of relatedBonuses) {
      try {
        await deleteDoc(doc(db, 'groups', groupCode, 'bonusSelections', selection.id));
      } catch (err) {
        console.warn('Bonus seçimi silinemedi:', selection.id, err);
      }
    }

    alert('Maç silindi.');
  } catch (err) {
    console.error('Maç silinemedi:', err);
    alert('Maç silinemedi: ' + (err.message || err));
    button.disabled = false;
  }
});

function pointsFor(m, p, bonusIds = bonusMatchIds()) {
  if (!hasResult(m) || !p) return 0;

  const exact = p.home === m.homeScore && p.away === m.awayScore;
  const sameOutcome = Math.sign(m.homeScore - m.awayScore) === Math.sign(p.home - p.away);
  const basePoints = exact ? 3 : (sameOutcome ? 1 : 0);

  return basePoints * (bonusIds.has(m.id) ? 2 : 1);
}

function calculateStandings() {
  const finished = matches.filter(hasResult);
  const bonusIds = bonusMatchIds();
  const allMatchIds = new Set(matches.map(match => match.id));

  return players.map(p => ({
    ...p,
    pts: finished.reduce(
      (sum, m) => sum + pointsFor(m, m.predictions?.[p.id], bonusIds),
      0
    ) + (window.FUTBOLBARBAROS_RISK_POINTS?.(p.id, allMatchIds) || 0),
    played: finished.length
  })).sort((a, b) => b.pts - a.pts || a.name.localeCompare(b.name, 'tr'));
}

function renderTable() {
  const leaderboardEl = $('leaderboard');
  if (!leaderboardEl) return;

  const totals = calculateStandings();

  leaderboardEl.innerHTML = totals.length
    ? totals.map((p, i) =>
      `<tr>
        <td>${i + 1}</td>
        <td><span class="leaderboard-player">${avatarMarkup(p.id, 'player-avatar player-avatar-small')}<span>${safe(p.name)}${p.id === uid ? ' (Sen)' : ''}</span></span></td>
        <td>${p.played}</td>
        <td><b>${p.pts}</b></td>
      </tr>`
    ).join('')
    : '<tr><td colspan="4" class="empty">Henüz oyuncu yok.</td></tr>';
}

function groupBonusSelections(selections) {
  const groups = new Map();

  for (const selection of selections) {
    if (!groups.has(selection.matchId)) {
      groups.set(selection.matchId, []);
    }

    groups.get(selection.matchId).push(selection);
  }

  return [...groups.entries()].map(([matchId, entries]) => ({
    matchId,
    entries,
    first: entries[0]
  }));
}

function renderBonusList(items, emptyText) {
  if (!items.length) {
    return `<div class="match-meta" style="padding:8px 0;">${safe(emptyText)}</div>`;
  }

  return items.map(group => {
    const first = group.first;
    const names = [...new Set(group.entries.map(x => x.playerName || 'Oyuncu'))];
    const match = matches.find(m => m.id === group.matchId);

    const home = match?.homeTeam || first.homeTeam || 'Ev sahibi';
    const away = match?.awayTeam || first.awayTeam || 'Deplasman';

    return `<div class="match-card" style="margin:8px 0;">
      <div>
        <div class="match-meta">⭐ BONUS 2X · ${safe(first.targetDate || '')}</div>
        <div class="teams"><span>${safe(home)}</span><span class="vs">VS</span><span>${safe(away)}</span></div>
        <div class="match-meta">Seçen: ${names.map(safe).join(', ')}</div>
      </div>
    </div>`;
  }).join('');
}

function getBonusContext() {
  const today = dayKey();
  const yesterday = shiftDayKey(today, -1);
  const tomorrow = shiftDayKey(today, 1);

  const standings = calculateStandings();

  const lowestPoints = standings.length
    ? Math.min(...standings.map(p => p.pts))
    : null;

  const lastPlacePlayers = lowestPoints === null
    ? []
    : standings.filter(p => p.pts === lowestPoints);

  const todayMatches = matches.filter(m => dayKey(m.kickoff) === today);
  const unfinishedToday = todayMatches.filter(m => !hasResult(m));
  const tomorrowMatches = matches.filter(m =>
    dayKey(m.kickoff) === tomorrow && !hasResult(m)
  );

  const myTodaySelection = bonusSelections.find(
    s => s.uid === uid && s.selectionDay === today
  );

  const myYesterdaySelection = bonusSelections.find(
    s => s.uid === uid && s.selectionDay === yesterday
  );

  const isLastPlace = lastPlacePlayers.some(p => p.id === uid);

  const eligiblePlayers = lastPlacePlayers.filter(p =>
    !bonusSelections.some(s => s.uid === p.id && s.selectionDay === yesterday)
  );

  return {
    today,
    yesterday,
    tomorrow,
    standings,
    lastPlacePlayers,
    eligiblePlayers,
    todayMatches,
    unfinishedToday,
    tomorrowMatches,
    myTodaySelection,
    myYesterdaySelection,
    isLastPlace
  };
}

function renderBonusPanel() {
  const todayList = $('todayBonusList');
  const tomorrowList = $('tomorrowBonusList');
  const status = $('bonusStatus');
  const options = $('bonusOptions');

  if (!todayList || !tomorrowList || !status || !options) return;

  const today = dayKey();
  const tomorrow = shiftDayKey(today, 1);

  const activeToday = groupBonusSelections(
    bonusSelections.filter(s => s.targetDate === today)
  );

  const selectedForTomorrow = groupBonusSelections(
    bonusSelections.filter(s =>
      s.selectionDay === today && s.targetDate === tomorrow
    )
  );

  todayList.innerHTML = renderBonusList(
    activeToday,
    'Bugün için henüz bonus maç seçilmedi.'
  );

  tomorrowList.innerHTML = renderBonusList(
    selectedForTomorrow,
    'Yarın için henüz bonus maç seçilmedi.'
  );

  options.innerHTML = '';

  const ctx = getBonusContext();

  if (!players.length) {
    status.textContent = 'Bonus seçimi için önce ligde oyuncu bulunmalı.';
    return;
  }

  if (ctx.myTodaySelection) {
    status.textContent =
      `Bugünkü seçimini yaptın: ${ctx.myTodaySelection.homeTeam} - ${ctx.myTodaySelection.awayTeam}. Aynı gün ikinci seçim yapamazsın.`;
    return;
  }

  if (!ctx.isLastPlace) {
    const names = ctx.lastPlacePlayers.map(p => p.name).join(', ');

    status.textContent = names
      ? `Bugünün sonuncusu: ${names}. Seçim hakkı şu an sende değil.`
      : 'Henüz sonuncu belirlenemedi.';
    return;
  }

  if (ctx.myYesterdaySelection) {
    status.textContent =
      'Dün bonus maç seçtiğin için bugün yeniden seçim yapamazsın. Yarın tekrar hak kazanabilirsin.';
    return;
  }

  if (ctx.unfinishedToday.length) {
    status.textContent =
      `Seçim, bugünün tüm maç sonuçları girildikten sonra açılacak. Sonucu girilmemiş maç sayısı: ${ctx.unfinishedToday.length}.`;
    return;
  }

  if (!ctx.tomorrowMatches.length) {
    status.textContent =
      'Yarın için henüz oynanmamış maç eklenmemiş. Fikstür eklendiğinde seçim yapabilirsin.';
    return;
  }

  status.textContent =
    'Sonuncular arasındasın! Yarın için bir bonus maç seç. Seçilen maçın puanları iki kat sayılacak.';

  options.innerHTML = ctx.tomorrowMatches.map(m => `
    <article class="match-card" style="margin:8px 0;">
      <div>
        <div class="match-meta">${safe(m.competition || 'FUTBOL')} · ${dateText(m.kickoff)}</div>
        <div class="teams"><span>${safe(m.homeTeam)}</span><span class="vs">VS</span><span>${safe(m.awayTeam)}</span></div>
      </div>
      <button class="small-btn" type="button" data-bonus-match="${safe(m.id)}">Bu maçı bonus seç</button>
    </article>
  `).join('');

  options.querySelectorAll('[data-bonus-match]').forEach(button => {
    button.addEventListener('click', () => {
      selectBonusMatch(button.dataset.bonusMatch);
    });
  });
}

async function selectBonusMatch(matchId) {
  const ctx = getBonusContext();
  const match = matches.find(m => m.id === matchId);

  if (!match) {
    return alert('Maç bulunamadı. Sayfayı yenileyip tekrar dene.');
  }

  if (!ctx.isLastPlace) {
    return alert('Bu ligde bugünün sonuncuları arasında değilsin.');
  }

  if (ctx.myTodaySelection) {
    return alert('Bugün zaten bir bonus maç seçtin.');
  }

  if (ctx.myYesterdaySelection) {
    return alert('Dün seçim yaptığın için bugün seçim yapamazsın.');
  }

  if (ctx.unfinishedToday.length) {
    return alert('Bugünün bütün maç sonuçları girilmeden seçim yapılamaz.');
  }

  if (dayKey(match.kickoff) !== ctx.tomorrow || hasResult(match)) {
    return alert('Yalnızca yarın oynanacak, sonucu girilmemiş maçlardan seçebilirsin.');
  }

  const selectionId = `${ctx.today}_${uid}`;
  const selectionRef = doc(db, 'groups', groupCode, 'bonusSelections', selectionId);
  const yesterdayRef = doc(db, 'groups', groupCode, 'bonusSelections', `${ctx.yesterday}_${uid}`);
  const matchRef = doc(db, 'groups', groupCode, 'matches', matchId);

  try {
    const [existingSnap, yesterdaySnap, latestMatchSnap] = await Promise.all([
      getDoc(selectionRef),
      getDoc(yesterdayRef),
      getDoc(matchRef)
    ]);

    if (existingSnap.exists()) {
      return alert('Bugün zaten bonus maç seçmişsin.');
    }

    if (yesterdaySnap.exists()) {
      return alert('Dün seçim yaptığın için bugün seçim yapamazsın.');
    }

    if (!latestMatchSnap.exists()) {
      return alert('Maç artık bulunamıyor.');
    }

    const latestMatch = latestMatchSnap.data();

    if (
      !latestMatch.kickoff ||
      dayKey(latestMatch.kickoff) !== ctx.tomorrow ||
      toDate(latestMatch.kickoff).getTime() <= Date.now()
    ) {
      return alert('Bu maç için seçim süresi sona ermiş.');
    }

    await setDoc(selectionRef, {
      uid,
      playerName: player.name,
      matchId,
      homeTeam: latestMatch.homeTeam,
      awayTeam: latestMatch.awayTeam,
      selectionDay: ctx.today,
      targetDate: ctx.tomorrow,
      selectedAt: serverTimestamp()
    });

    alert(`${latestMatch.homeTeam} - ${latestMatch.awayTeam} yarının bonus maçı olarak seçildi!`);
  } catch (err) {
    console.error('Bonus maç seçim hatası:', err);
    alert('Bonus maç kaydedilemedi: ' + (err.message || err));
  }
}

/* Lig yönetimi: görünen adı güncelleme. Lig kodu ve altındaki veriler değişmez. */
const leagueManagerList = $('leagueManagerList');
if (leagueManagerList) {
  leagueManagerList.addEventListener('click', async event => {
    const button = event.target.closest('[data-save-league]');
    if (!button) return;

    if (!isAdmin()) return alert('Yönetici yetkisi yok.');

    const code = button.dataset.saveLeague;
    const input = leagueManagerList.querySelector(`[data-league-name="${CSS.escape(code)}"]`);
    const newName = input?.value.trim() || '';

    if (newName.length < 2 || newName.length > 32) {
      return alert('Lig adı 2-32 karakter arasında olmalı.');
    }

    button.disabled = true;
    try {
      await updateDoc(doc(db, 'groups', code), {
        name: newName,
        updatedAt: serverTimestamp(),
        updatedBy: uid
      });

      leagueNames[code] = newName;
      const item = leagueCatalog.find(league => league.code === code);
      if (item) item.name = newName;
      leagueCatalog.sort((a, b) => a.name.localeCompare(b.name, 'tr'));

      renderLeagueManager();
      renderLeagueOptions();
      refreshCopyTargetOptions();
      message($('leagueManagerMessage'), `${code} lig adı güncellendi.`, false);
    } catch (err) {
      console.error('Lig adı güncellenemedi:', err);
      message($('leagueManagerMessage'), 'Lig adı güncellenemedi: ' + (err.message || err));
    } finally {
      button.disabled = false;
    }
  });
}

const leagueCreateForm = $('leagueCreateForm');
if (leagueCreateForm) {
  leagueCreateForm.addEventListener('submit', async event => {
    event.preventDefault();

    if (!isAdmin()) return message($('leagueCreateMessage'), 'Yönetici yetkisi yok.');

    const code = $('newLeagueCodeAdmin').value.trim().toUpperCase();
    const name = $('newLeagueNameAdmin').value.trim();

    if (!/^[A-Z0-9_-]{3,24}$/.test(code)) {
      return message($('leagueCreateMessage'), 'Lig kodu 3-24 karakter olmalı; yalnızca harf, rakam, tire ve alt çizgi kullan.');
    }
    if (name.length < 2 || name.length > 32) {
      return message($('leagueCreateMessage'), 'Lig adı 2-32 karakter arasında olmalı.');
    }

    const submit = leagueCreateForm.querySelector('button[type="submit"]');
    submit.disabled = true;

    try {
      const ref = doc(db, 'groups', code);
      const existing = await getDoc(ref);
      if (existing.exists()) {
        throw new Error('Bu lig kodu zaten kullanılıyor.');
      }

      await setDoc(ref, {
        code,
        name,
        createdAt: serverTimestamp(),
        createdBy: uid
      });

      $('newLeagueCodeAdmin').value = '';
      $('newLeagueNameAdmin').value = '';
      await loadLeagueCatalog();
      message($('leagueCreateMessage'), `${name} ligi oluşturuldu. Oyuncular ${code} koduyla katılabilir.`, false);
    } catch (err) {
      console.error('Lig oluşturulamadı:', err);
      message($('leagueCreateMessage'), 'Lig oluşturulamadı: ' + (err.message || err));
    } finally {
      submit.disabled = false;
    }
  });
}

/* Sekme geçişleri */
document.querySelectorAll('.tab').forEach(button => {
  button.addEventListener('click', () => {
    if (button.dataset.tab === 'admin' && !isAdmin()) return;
    activateTab(button.dataset.tab);
  });
});

/* Seçilen maçları istenen lige kopyala.
   Tahminler taşınmaz; hedefteki mevcut maçlar ezilmez. */
const copySelectedMatchesBtn = $('copySelectedMatchesBtn');
const copySelectAll = $('copySelectAll');

if (copySelectAll) {
  copySelectAll.addEventListener('change', () => {
    document.querySelectorAll('[data-copy-match]').forEach(input => {
      input.checked = copySelectAll.checked;
    });
  });
}

if (copySelectedMatchesBtn) {
  copySelectedMatchesBtn.addEventListener('click', async () => {
    if (!isAdmin()) {
      return alert('Yönetici yetkisi yok.');
    }

    const targetLeague = $('copyTargetLeague')?.value;

    const selectedIds = [...document.querySelectorAll('[data-copy-match]:checked')]
      .map(input => input.dataset.copyMatch);

    const status = $('copyMatchesMessage');

    if (!targetLeague || !leagueCatalog.some(item => item.code === targetLeague)) {
      return message(status, 'Geçerli bir hedef lig seç.');
    }

    if (targetLeague === groupCode) {
      return message(status, 'Kaynak ve hedef lig aynı olamaz.');
    }

    if (!selectedIds.length) {
      return message(status, 'Önce kopyalamak istediğin maçları işaretle.');
    }

    copySelectedMatchesBtn.disabled = true;

    try {
      const targetGroup = await getDoc(doc(db, 'groups', targetLeague));

      if (!targetGroup.exists()) {
        throw new Error(
          `${targetLeague} ligi hazır değil. Yönetici hesabıyla giriş yapıp tekrar dene.`
        );
      }

      let copied = 0;
      let skipped = 0;
      let failed = 0;

      for (const id of selectedIds) {
        try {
          const sourceMatch = matches.find(match => match.id === id);

          if (!sourceMatch) {
            failed++;
            continue;
          }

          const targetRef = doc(db, 'groups', targetLeague, 'matches', id);
          const targetSnap = await getDoc(targetRef);

          if (targetSnap.exists()) {
            skipped++;
            continue;
          }

          const data = { ...sourceMatch };

          delete data.id;
          delete data.predictions;

          await setDoc(targetRef, data);
          copied++;
        } catch (err) {
          console.error('Maç kopyalanamadı:', id, err);
          failed++;
        }
      }

      message(
        status,
        `Aktarım bitti. Kopyalanan: ${copied} · Hedefte zaten bulunan: ${skipped} · Hata: ${failed}`,
        failed > 0
      );

      document.querySelectorAll('[data-copy-match]').forEach(input => {
        input.checked = false;
      });

      if (copySelectAll) {
        copySelectAll.checked = false;
      }
    } catch (err) {
      console.error(err);
      message(status, 'Kopyalama yapılamadı: ' + (err.message || err));
    } finally {
      copySelectedMatchesBtn.disabled = false;
    }
  });
}

$('profileAvatarButton')?.addEventListener('click', () => {
  renderAvatarUI();
  $('avatarDialog').showModal();
});

$('avatarChoices')?.addEventListener('click', async e => {
  const button = e.target.closest('[data-avatar-id]');
  if (!button || !uid) return;

  const avatarId = button.dataset.avatarId || '';
  try {
    await setDoc(doc(db, 'users', uid), {
      avatarId,
      updatedAt: serverTimestamp()
    }, { merge: true });
    $('avatarDialog').close();
  } catch (err) {
    console.error(err);
    alert('Profil fotoğrafı kaydedilemedi: ' + (err.message || err));
  }
});

$('avatarUploadForm')?.addEventListener('submit', async e => {
  e.preventDefault();
  if (!isAdmin()) return alert('Yönetici yetkisi yok.');

  const input = $('avatarFiles');
  const files = [...(input.files || [])];
  const status = $('avatarUploadMessage');
  if (!files.length) return message(status, 'Önce fotoğraf seç.');

  const button = $('avatarUploadButton');
  button.disabled = true;
  let uploaded = 0;
  const errors = [];

  for (const file of files) {
    try {
      const { dataUrl, mimeType } = await compressAvatar(file);
      const name = file.name.replace(/\.[^.]+$/, '').slice(0, 40) || 'Avatar';
      const ref = doc(collection(db, 'avatars'));
      await setDoc(ref, {
        name,
        dataUrl,
        mimeType,
        createdAt: serverTimestamp(),
        createdBy: uid
      });
      uploaded++;
    } catch (err) {
      console.error(err);
      errors.push(`${file.name}: ${err.message || err}`);
    }
  }

  input.value = '';
  button.disabled = false;
  message(status, `Yüklenen: ${uploaded}${errors.length ? ` · Hatalı: ${errors.join(' | ')}` : ''}`, errors.length > 0);
});

$('avatarAdminList')?.addEventListener('click', async e => {
  const button = e.target.closest('[data-delete-avatar]');
  if (!button || !isAdmin()) return;
  const avatarId = button.dataset.deleteAvatar;
  const avatar = avatars.find(item => item.id === avatarId);
  if (!avatar || !confirm(`“${avatar.name || 'Avatar'}” fotoğrafı silinsin mi?`)) return;

  try {
    await deleteDoc(doc(db, 'avatars', avatarId));
  } catch (err) {
    console.error(err);
    alert('Fotoğraf silinemedi: ' + (err.message || err));
  }
});

$('closeAvatarDialog')?.addEventListener('click', () => $('avatarDialog').close());

$('editNameButton').addEventListener('click', () => {
  if (!player) return;

  $('newPlayerName').value = player.name;
  message($('nameMessage'), '');
  $('nameDialog').showModal();
});

$('closeNameDialog').addEventListener('click', () => {
  $('nameDialog').close();
});

$('nameForm').addEventListener('submit', async e => {
  e.preventDefault();

  const newName = $('newPlayerName').value.trim();
  const msg = $('nameMessage');

  if (!validName(newName)) {
    return message(msg, 'İsim 2-18 karakter arasında olmalı.');
  }

  if (newName === player.name) {
    return $('nameDialog').close();
  }

  try {
    for (const code of memberships) {
      const all = await getDocs(collection(db, 'groups', code, 'players'));

      if (all.docs.some(d =>
        d.id !== uid && (d.data().name || '').toLowerCase() === newName.toLowerCase()
      )) {
        throw new Error(`${code} liginde bu oyuncu adı zaten kullanılıyor.`);
      }
    }

    await Promise.all(memberships.map(code =>
      updateDoc(doc(db, 'groups', code, 'players', uid), {
        name: newName
      })
    ));

    player.name = newName;

    showApp();
    renderTable();
    renderBonusPanel();

    $('nameDialog').close();
  } catch (err) {
    console.error(err);
    message(msg, 'İsim değiştirilemedi: ' + err.message);
  }
});

$('leaveButton').addEventListener('click', () => {
  if (confirm('Bu cihazdaki kayıtlı lig oturumlarını sıfırlamak istiyor musun?')) {
    localStorage.removeItem('fb_leagues');
    localStorage.removeItem('fb_player');
    location.reload();
  }
});

setInterval(() => {
  if (player) {
    renderMatches();
    renderBonusPanel();
  }
}, 15000);

$('sendPushNotificationButton')?.addEventListener('click', async () => {
  const button = $('sendPushNotificationButton');
  const status = $('pushNotificationMessage');
  button.disabled = true;
  message(status, 'Bildirim gönderiliyor...', false);
  try {
    const result = await sendAdminPushNotification();
    message(status, `Gönderildi: ${result.sent || 0} · Başarısız: ${result.failed || 0}`, false);
  } catch (err) {
    console.error('Bildirim gönderme hatası:', err);
    message(status, err.message || 'Bildirim gönderilemedi.');
  } finally {
    button.disabled = false;
  }
});

boot().catch(err => {
  console.error(err);
  message($('entryMessage'), 'HATA: ' + (err.code || err.message || 'Bilinmeyen hata'));
});

window.addEventListener('fb-risk-updated', () => {
  renderTable();
  renderMatches();
});