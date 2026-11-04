// FUTBOLBARBAROS - COKLU LIG + GUNLUK BONUS MAC SISTEMI
// Firebase Spark (ucretsiz plan) ile calisir. Cloud Functions gerektirmez.
import { initializeApp } from 'https://www.gstatic.com/firebasejs/13.2.0/firebase-app.js';
import { getAuth, signInAnonymously, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/13.2.0/firebase-auth.js';
import {
  getFirestore, doc, getDoc, setDoc, collection, getDocs,
  query, orderBy, onSnapshot, updateDoc, serverTimestamp, Timestamp
} from 'https://www.gstatic.com/firebasejs/13.2.0/firebase-firestore.js';
import { firebaseConfig, ADMIN_UID } from './config.js';

const $ = id => document.getElementById(id);
const hasConfig = Boolean(firebaseConfig?.apiKey && firebaseConfig?.projectId);
const TIME_ZONE = 'Europe/Istanbul';

const KNOWN_LEAGUES = [
  { code: 'BARBAROS26', label: 'BARBAROS26' },
  { code: 'ILOVE12CBRO', label: 'ILOVE12CBRO' },
  { code: 'HALILPERION', label: 'HALILPERION' }
];

const KNOWN_LEAGUE_CODES = KNOWN_LEAGUES.map(item => item.code);

let db, uid = null, player = null, groupCode = '';
let memberships = [], matches = [], players = [], bonusSelections = [], activeMatch = null;
let leagueCatalog = [];
let leagueNames = {};
let unsubMatches = null, unsubPlayers = null, unsubBonusSelections = null;

const isAdmin = () => Boolean(uid) && uid === ADMIN_UID;

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

function validName(name) {
  return name.length >= 2 && name.length <= 18;
}

function hasResult(m) {
  return m.homeScore !== undefined && m.awayScore !== undefined;
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

  document.querySelectorAll('.admin-only').forEach(el => {
    el.classList.toggle('hidden', !isAdmin());
  });

  renderLeagueOptions();
  refreshCopyTargetOptions();
}function activateTab(name) {
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
  db = getFirestore(app);

  const user = await new Promise((resolve, reject) => {
    let unsubscribe = () => {};

    unsubscribe = onAuthStateChanged(auth, u => {
      if (u) {
        unsubscribe();
        resolve(u);
      }
    }, reject);

    if (!auth.currentUser) {
      signInAnonymously(auth).catch(reject);
    }
  });

  uid = user.uid;

  if (isAdmin()) {
    try {
      await ensureKnownLeagueDocs();
      await loadLeagueCatalog();
    } catch (err) {
      console.error('Ligler hazırlanamadı:', err);
    }
  }

  await restoreSession();
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
  memberships = [...new Set(saved.filter(x => typeof x === 'string' && x))];

  const valid = [];

  for (const code of memberships) {
    try {
      const snap = await getDoc(doc(db, 'groups', code, 'players', uid));

      if (snap.exists()) {
        valid.push(code);
      }
    } catch (err) {
      console.error('Lig oturumu kontrolü:', code, err);
    }
  }

  memberships = valid;
  localStorage.setItem('fb_leagues', JSON.stringify(memberships));
  await loadMembershipLeagueNames();

  if (memberships.length) {
    await switchLeague(memberships[0]);
  } else {
    $('entryView').classList.remove('hidden');
    $('appView').classList.add('hidden');
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
}function bonusMatchIds() {
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

    return `<article class="match-card">
      <div>
        <div class="match-meta">${safe(m.competition || 'FUTBOL')} · ${dateText(m.kickoff)} ${bonusIds.has(m.id) ? '<span style="display:inline-block;margin-left:6px;padding:3px 7px;border-radius:5px;background:rgba(245,158,11,.18);color:#fbbf24;font-weight:800;">⭐ BONUS 2X</span>' : ''}</div>
        <div class="teams"><span>${safe(m.homeTeam)}</span><span class="vs">VS</span><span>${safe(m.awayTeam)}</span></div>
        <div class="match-meta">${safe(predictionStatus(m))}</div>
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

/* Yeni maç yalnızca aktif olan lige eklenir. */
$('matchForm').addEventListener('submit', async e => {
  e.preventDefault();

  if (!isAdmin()) {
    return alert('Yönetici yetkisi yok.');
  }

  const kickoff = fromLocalInput($('kickoff').value);
  const predictionOpenAt = fromLocalInput($('predictionOpenAt').value);
  const predictionCloseAt = fromLocalInput($('predictionCloseAt').value);

  const homeTeam = $('homeTeam').value.trim();
  const awayTeam = $('awayTeam').value.trim();
  const competition = $('competition').value.trim() || 'Futbol';

  if (!homeTeam || !awayTeam) {
    return message($('matchFormMessage'), 'İki takımın adını da gir.');
  }

  if (!kickoff || !predictionOpenAt || !predictionCloseAt) {
    return message($('matchFormMessage'), 'Bütün tarih alanlarını doldur.');
  }

  if (kickoff <= new Date()) {
    return message($('matchFormMessage'), 'Maç tarihi gelecekte olmalı.');
  }

  if (predictionCloseAt <= predictionOpenAt) {
    return message($('matchFormMessage'), 'Tahmin kapanışı açılıştan sonra olmalı.');
  }

  if (predictionCloseAt > kickoff) {
    return message($('matchFormMessage'), 'Tahmin kapanışı maç başlangıcından sonra olamaz.');
  }

  try {
    const matchRef = doc(collection(db, 'groups', groupCode, 'matches'));

    const matchData = {
      homeTeam,
      awayTeam,
      competition,
      kickoff: Timestamp.fromDate(kickoff),
      predictionOpenAt: Timestamp.fromDate(predictionOpenAt),
      predictionCloseAt: Timestamp.fromDate(predictionCloseAt),
      createdAt: serverTimestamp(),
      createdBy: uid,
      predictions: {}
    };

    await setDoc(matchRef, matchData);

    e.target.reset();

    message(
      $('matchFormMessage'),
      `${groupCode} ligine maç eklendi. Diğer liglere aktarmak için aşağıdaki maç kopyalama menüsünü kullan.`,
      false
    );
  } catch (err) {
    console.error(err);
    message($('matchFormMessage'), 'Maç eklenemedi: ' + err.message);
  }
});function renderAdminMatches() {
  const el = $('adminMatches');
  if (!el) return;

  if (!matches.length) {
    el.innerHTML = '<div class="empty">Henüz maç yok.</div>';
    return;
  }

  const bonusIds = bonusMatchIds();

  el.innerHTML = matches.map(m => `<article class="match-card admin-match-card">
    <label class="copy-match-check">
      <input type="checkbox" data-copy-match="${safe(m.id)}">
      Bu maçı kopyala
    </label>
    <div>
      <div class="match-meta">${dateText(m.kickoff)} ${bonusIds.has(m.id) ? '<span style="color:#fbbf24;font-weight:800;">⭐ BONUS 2X</span>' : ''}</div>
      <div class="teams"><span>${safe(m.homeTeam)}</span><span class="vs">VS</span><span>${safe(m.awayTeam)}</span></div>
      <div class="match-meta">${safe(predictionStatus(m))}</div>
    </div>
    <div class="admin-match-settings">
      <label>Tahmin açılışı<input type="datetime-local" id="open-${safe(m.id)}" value="${safe(toLocalInput(m.predictionOpenAt))}"></label>
      <label>Tahmin kapanışı<input type="datetime-local" id="close-${safe(m.id)}" value="${safe(toLocalInput(m.predictionCloseAt))}"></label>
      <button class="small-btn" data-save-schedule="${safe(m.id)}">Saatleri kaydet</button>
      ${hasResult(m) ? `<b>Sonuç: ${m.homeScore} - ${m.awayScore}</b>` : `
        <div class="two-col">
          <label>Ev skoru<input id="h-${safe(m.id)}" type="number" min="0" max="30"></label>
          <label>Dep. skoru<input id="a-${safe(m.id)}" type="number" min="0" max="30"></label>
        </div>
        <button class="small-btn" data-result="${safe(m.id)}">Sonucu kaydet</button>`}
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

  el.querySelectorAll('[data-result]').forEach(button => {
    button.addEventListener('click', async () => {
      if (!isAdmin()) {
        return alert('Yönetici yetkisi yok.');
      }

      const id = button.dataset.result;
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

      button.disabled = true;

      try {
        await updateDoc(
          doc(db, 'groups', groupCode, 'matches', id),
          {
            homeScore: h,
            awayScore: a,
            resultAt: serverTimestamp()
          }
        );
      } catch (err) {
        console.error(err);
        alert('Sonuç kaydedilemedi: ' + err.message);
        button.disabled = false;
      }
    });
  });
}

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

  return players.map(p => ({
    ...p,
    pts: finished.reduce(
      (sum, m) => sum + pointsFor(m, m.predictions?.[p.id], bonusIds),
      0
    ),
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
        <td>${safe(p.name)}${p.id === uid ? ' (Sen)' : ''}</td>
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
}function renderBonusPanel() {
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

boot().catch(err => {
  console.error(err);
  message($('entryMessage'), 'HATA: ' + (err.code || err.message || 'Bilinmeyen hata'));
});
