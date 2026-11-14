// FUTBOLBARBAROS - KULLANICI YONETIMI
// Ligden cikarma secili lig icin; kalici ban ve timeout site genelindedir.
import { getApp, getApps, initializeApp } from 'https://www.gstatic.com/firebasejs/13.2.0/firebase-app.js';
import { getAuth, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/13.2.0/firebase-auth.js';
import {
  getFirestore, doc, getDoc, setDoc, deleteDoc, updateDoc,
  collection, onSnapshot, orderBy, query, serverTimestamp, Timestamp, deleteField
} from 'https://www.gstatic.com/firebasejs/13.2.0/firebase-firestore.js';
import { subscribeSharedSnapshot } from './shared-firestore-listeners.js';
import { firebaseConfig, ADMIN_UID } from './config.js';

const $ = id => document.getElementById(id);
const app = getApps().length ? getApp() : initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

let uid = null;
let groupCode = '';
let players = [];
let matches = [];
let bonusSelections = [];
let moderation = {};
let unsubPlayers = null;
let unsubMatches = null;
let unsubBonuses = null;
let unsubModeration = null;
let unsubOwnModeration = null;
let ownModerationData = null;
let generation = 0;

const isAdmin = () => Boolean(uid) && uid === ADMIN_UID;

function safe(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[char]));
}

function toDate(value) {
  if (!value) return null;
  const date = value?.toDate ? value.toDate() : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function restrictedState(data) {
  if (!data) return null;
  if (data.banned === true) return { type: 'ban', text: 'Kalıcı ban' };
  const until = toDate(data.timeoutUntil);
  if (until && until.getTime() > Date.now()) {
    return { type: 'timeout', text: `Timeout · ${until.toLocaleString('tr-TR')}` };
  }
  return null;
}

function showRestriction(data) {
  let overlay = $('userRestrictionOverlay');
  const state = restrictedState(data);
  if (!state) {
    overlay?.remove();
    return;
  }
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'userRestrictionOverlay';
    overlay.className = 'fb-restriction-overlay';
    document.body.appendChild(overlay);
  }
  const until = toDate(data.timeoutUntil);
  overlay.innerHTML = `
    <section class="fb-restriction-card">
      <div class="fb-restriction-icon">⛔</div>
      <h2>FUTBOLBARBAROS erişimi kısıtlandı</h2>
      <p>${state.type === 'ban' ? 'Hesabın yönetici tarafından kalıcı olarak yasaklandı.' : `Hesabın geçici olarak zaman aşımına alındı. Bitiş: ${safe(until?.toLocaleString('tr-TR') || 'Belirtilmedi')}`}</p>
      ${data.reason ? `<p class="fb-restriction-reason">Neden: ${safe(data.reason)}</p>` : ''}
      <small>Erişim kısıtlaması kaldırılana veya süresi dolana kadar liglere katılamazsın.</small>
    </section>`;
}

function stopGroupListeners() {
  for (const unsubscribe of [unsubPlayers, unsubMatches, unsubBonuses]) {
    if (unsubscribe) unsubscribe();
  }
  unsubPlayers = unsubMatches = unsubBonuses = null;
  players = [];
  matches = [];
  bonusSelections = [];
  renderUserManagement();
}

function renderUserManagement() {
  const container = $('userManagementList');
  if (!container) return;
  if (!isAdmin()) {
    container.innerHTML = '';
    return;
  }
  if (!groupCode) {
    container.innerHTML = '<p class="match-meta">Önce bir lig seç.</p>';
    return;
  }
  if (!players.length) {
    container.innerHTML = '<p class="match-meta">Bu ligde henüz oyuncu yok.</p>';
    return;
  }
  container.innerHTML = players.map(person => {
    const state = restrictedState(moderation[person.id]);
    const stateHtml = state
      ? `<small class="fb-mod-state ${state.type}">${safe(state.text)}</small>`
      : '<small class="fb-mod-state">Kısıtlama yok</small>';
    return `<article class="fb-mod-row">
      <div class="fb-mod-person">
        <strong>${safe(person.name || 'Oyuncu')}</strong>
        <small>UID: ${safe(person.id)}</small>
        ${stateHtml}
      </div>
      <div class="fb-mod-actions">
        <button type="button" class="fb-mod-kick" data-mod-kick="${safe(person.id)}">Bu ligden çıkar</button>
        <button type="button" class="fb-mod-ban" data-mod-ban="${safe(person.id)}">Kalıcı ban</button>
        <select aria-label="Timeout süresi" data-mod-hours="${safe(person.id)}">
          <option value="1">1 saat</option>
          <option value="24" selected>24 saat</option>
          <option value="168">7 gün</option>
          <option value="720">30 gün</option>
        </select>
        <button type="button" class="fb-mod-timeout" data-mod-timeout="${safe(person.id)}">Timeout uygula</button>
        ${state ? `<button type="button" class="fb-mod-clear" data-mod-clear="${safe(person.id)}">Kısıtlamayı kaldır</button>` : ''}
      </div>
    </article>`;
  }).join('');
}

async function attachGroup(code) {
  const currentGeneration = ++generation;
  stopGroupListeners();
  groupCode = code;
  if (!uid || !code || !isAdmin()) return;
  try {
    unsubPlayers = subscribeSharedSnapshot(db, `groups/${code}/players`, collection(db, 'groups', code, 'players'), snapshot => {
      if (currentGeneration !== generation) return;
      players = snapshot.docs.map(item => ({ id: item.id, ...item.data() }));
      renderUserManagement();
    }, error => console.error('Oyuncu listesi okunamadi:', error));
    unsubMatches = subscribeSharedSnapshot(db, `groups/${code}/matches:by-kickoff`, query(collection(db, 'groups', code, 'matches'), orderBy('kickoff', 'asc')), snapshot => {
      if (currentGeneration !== generation) return;
      matches = snapshot.docs.map(item => ({ id: item.id, ...item.data() }));
      renderUserManagement();
    }, error => console.error('Moderasyon maclari okunamadi:', error));
    unsubBonuses = subscribeSharedSnapshot(db, `groups/${code}/bonusSelections`, collection(db, 'groups', code, 'bonusSelections'), snapshot => {
      if (currentGeneration !== generation) return;
      bonusSelections = snapshot.docs.map(item => ({ id: item.id, ...item.data() }));
      renderUserManagement();
    }, error => console.error('Moderasyon bonus secimleri okunamadi:', error));
  } catch (error) {
    console.error('Kullanici yonetimi acilamadi:', error);
    const container = $('userManagementList');
    if (container) container.textContent = 'Oyuncular yüklenemedi: ' + (error.message || error);
  }
}

async function kickFromLeague(targetUid, button) {
  if (!isAdmin() || !groupCode || targetUid === uid) {
    return alert('Bu işlem için yetki yok veya kendi hesabını çıkaramazsın.');
  }

  const target = players.find(item => item.id === targetUid);
  if (!target) return alert('Oyuncu bulunamadı.');

  const approved = confirm(
    `${target.name} bu ligden çıkarılacak.\n\n` +
    'Mevcut maç tahminleri ve bonus geçmişi korunacak. ' +
    'Kullanıcı lig koduyla yeniden katılabilir. Devam edilsin mi?'
  );
  if (!approved) return;

  button.disabled = true;
  try {
    // Yalnızca üyelik belgesini kaldır. Geçmiş tahminlere ve bonus kayıtlarına dokunma.
    await deleteDoc(doc(db, 'groups', groupCode, 'players', targetUid));
    alert(`${target.name} bu ligden çıkarıldı. Geçmiş kayıtları korundu.`);
  } catch (error) {
    console.error('Oyuncu ligden çıkarılamadı:', error);
    alert('Oyuncu çıkarılamadı: ' + (error.message || error));
  } finally {
    button.disabled = false;
  }
}

async function applyRestriction(targetUid, type, hours, button) {
  if (!isAdmin() || targetUid === uid) return alert('Kendi hesabına ban veya timeout uygulayamazsın.');
  const target = players.find(item => item.id === targetUid);
  const name = target?.name || targetUid;
  let data;
  if (type === 'ban') {
    if (!confirm(`${name} FUTBOLBARBAROS genelinde kalıcı olarak banlanacak. Tüm liglere erişimi engellenecek. Devam edilsin mi?`)) return;
    data = {
      banned: true,
      timeoutUntil: null,
      reason: 'Yönetici tarafından kalıcı ban',
      updatedAt: serverTimestamp(),
      updatedBy: uid
    };
  } else {
    const duration = Number(hours);
    if (![1, 24, 168, 720].includes(duration)) return alert('Geçerli bir timeout süresi seç.');
    if (!confirm(`${name} hesabı ${duration >= 24 ? `${duration / 24} gün` : `${duration} saat`} boyunca tüm liglerden uzaklaştırılacak. Devam edilsin mi?`)) return;
    data = {
      banned: false,
      timeoutUntil: Timestamp.fromDate(new Date(Date.now() + duration * 60 * 60 * 1000)),
      reason: `Yönetici tarafından ${duration >= 24 ? `${duration / 24} gün` : `${duration} saat`} timeout`,
      updatedAt: serverTimestamp(),
      updatedBy: uid
    };
  }
  button.disabled = true;
  try {
    await setDoc(doc(db, 'userModeration', targetUid), data, { merge: true });
    alert(type === 'ban' ? `${name} kalıcı olarak banlandı.` : `${name} için timeout uygulandı.`);
  } catch (error) {
    console.error('Kisitlama uygulanamadi:', error);
    alert('İşlem yapılamadı: ' + (error.message || error));
  } finally {
    button.disabled = false;
  }
}

async function clearRestriction(targetUid, button) {
  if (!isAdmin()) return alert('Yönetici yetkisi yok.');
  const target = players.find(item => item.id === targetUid);
  if (!confirm(`${target?.name || targetUid} kullanıcısının site genelindeki ban/timeout kısıtlaması kaldırılsın mı?`)) return;
  button.disabled = true;
  try {
    await setDoc(doc(db, 'userModeration', targetUid), {
      banned: false,
      timeoutUntil: null,
      reason: '',
      updatedAt: serverTimestamp(),
      updatedBy: uid
    }, { merge: true });
    alert('Kullanıcı kısıtlaması kaldırıldı.');
  } catch (error) {
    console.error('Kisitlama kaldirilamadi:', error);
    alert('Kısıtlama kaldırılamadı: ' + (error.message || error));
  } finally {
    button.disabled = false;
  }
}

document.addEventListener('click', event => {
  const kick = event.target.closest('[data-mod-kick]');
  if (kick) return kickFromLeague(kick.dataset.modKick, kick);
  const ban = event.target.closest('[data-mod-ban]');
  if (ban) return applyRestriction(ban.dataset.modBan, 'ban', 0, ban);
  const timeout = event.target.closest('[data-mod-timeout]');
  if (timeout) {
    const targetUid = timeout.dataset.modTimeout;
    const hours = document.querySelector(`[data-mod-hours="${CSS.escape(targetUid)}"]`)?.value;
    return applyRestriction(targetUid, 'timeout', hours, timeout);
  }
  const clear = event.target.closest('[data-mod-clear]');
  if (clear) return clearRestriction(clear.dataset.modClear, clear);
});

function installStyles() {
  if ($('moderationInjectedStyles')) return;
  const style = document.createElement('style');
  style.id = 'moderationInjectedStyles';
  style.textContent = `
    .fb-mod-row{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:13px 0;border-bottom:1px solid #ffffff20}
    .fb-mod-person{min-width:0;display:grid;gap:4px}.fb-mod-person strong{overflow-wrap:anywhere}.fb-mod-person small{font-size:10px;color:var(--muted,#a6b9aa);overflow-wrap:anywhere}
    .fb-mod-state{font-weight:800}.fb-mod-state.ban,.fb-mod-state.timeout{color:#fca5a5}.fb-mod-actions{display:flex;align-items:center;justify-content:flex-end;gap:7px;flex-wrap:wrap}
    .fb-mod-actions button,.fb-mod-actions select{font-size:10px;padding:8px 9px;border-radius:8px;cursor:pointer}
    .fb-mod-kick{border:1px solid #fbbf24;background:#422b0b;color:#fde68a}.fb-mod-ban{border:0;background:#991b1b;color:white}.fb-mod-timeout{border:0;background:#92400e;color:white}.fb-mod-clear{border:0;background:#166534;color:white}
    .fb-restriction-overlay{position:fixed;inset:0;z-index:99999;background:#06150ded;display:grid;place-items:center;padding:20px}
    .fb-restriction-card{width:min(100%,460px);background:#10251a;border:1px solid #d65b5b66;border-radius:18px;padding:26px;color:#f3f7f4;text-align:center;box-shadow:0 20px 70px #0009}
    .fb-restriction-icon{font-size:38px}.fb-restriction-card h2{margin:10px 0;color:#fecaca}.fb-restriction-card p{font-size:14px;line-height:1.6}.fb-restriction-card small{color:#a9b9ae}.fb-restriction-reason{color:#fcd7a1}
    @media(max-width:650px){.fb-mod-row{align-items:flex-start;flex-direction:column}.fb-mod-actions{justify-content:flex-start;width:100%}.fb-mod-actions select{min-width:90px}}
  `;
  document.head.appendChild(style);
}

function syncSelectedGroup() {
  if (!isAdmin()) return;
  const next = $('leagueSelect')?.value || '';
  if (next && next !== groupCode) attachGroup(next);
  if (!next && groupCode) {
    generation++;
    groupCode = '';
    stopGroupListeners();
  }
}

installStyles();
onAuthStateChanged(auth, user => {
  uid = user?.uid || null;
  if (unsubModeration) unsubModeration();
  if (unsubOwnModeration) unsubOwnModeration();
  unsubModeration = unsubOwnModeration = null;

  if (uid) {
    unsubOwnModeration = onSnapshot(doc(db, 'userModeration', uid), snapshot => {
      ownModerationData = snapshot.exists() ? snapshot.data() : null;
      showRestriction(ownModerationData);
    }, error => console.warn('Hesap kısıtlaması okunamadı:', error));
  } else {
    ownModerationData = null;
    showRestriction(null);
  }

  if (isAdmin()) {
    unsubModeration = onSnapshot(collection(db, 'userModeration'), snapshot => {
      moderation = Object.fromEntries(snapshot.docs.map(item => [item.id, item.data()]));
      renderUserManagement();
    }, error => {
      console.error('Kullanici kisitlamalari okunamadi:', error);
      const container = $('userManagementList');
      if (container) container.textContent = 'Kısıtlama listesi okunamadı: ' + (error.message || error);
    });
    syncSelectedGroup();
  } else {
    moderation = {};
    stopGroupListeners();
  }
});

$('leagueSelect')?.addEventListener('change', syncSelectedGroup);
setInterval(syncSelectedGroup, 700);
setInterval(() => showRestriction(ownModerationData), 15000);
