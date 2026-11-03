// FUTBOLBARBAROS - COKLU LIG SISTEMI
import { initializeApp } from 'https://www.gstatic.com/firebasejs/13.2.0/firebase-app.js';
import { getAuth, signInAnonymously, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/13.2.0/firebase-auth.js';
import {
  getFirestore, doc, getDoc, setDoc, collection, addDoc, getDocs,
  query, orderBy, onSnapshot, updateDoc, serverTimestamp, Timestamp
} from 'https://www.gstatic.com/firebasejs/13.2.0/firebase-firestore.js';
import { firebaseConfig, ADMIN_UID } from './config.js';

const $ = id => document.getElementById(id);
const hasConfig = Boolean(firebaseConfig?.apiKey && firebaseConfig?.projectId);

const SHARED_LEAGUES = ['BARBAROS26', 'ILOVE12CBRO'];
let db, uid = null, player = null, groupCode = '';
let memberships = [], matches = [], players = [], activeMatch = null;
let unsubMatches = null, unsubPlayers = null;

const isAdmin = () => Boolean(uid) && uid === ADMIN_UID;

function message(el, text, isError = true) {
  if (!el) return;
  el.textContent = text;
  el.style.color = isError ? 'var(--red)' : 'var(--green)';
}
function toDate(value) { return value?.toDate ? value.toDate() : new Date(value); }
function fromLocalInput(value) { return value ? new Date(`${value}:00+03:00`) : null; }
function toLocalInput(value) {
  if (!value) return '';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Istanbul', year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(toDate(value));
  const part = type => parts.find(p => p.type === type)?.value;
  return `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}`;
}
function dateText(value) {
  if (!value) return 'Belirlenmedi';
  return toDate(value).toLocaleString('tr-TR', {
    dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Istanbul'
  });
}
function safe(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}
function validName(name) { return name.length >= 2 && name.length <= 18; }
function hasResult(m) { return m.homeScore !== undefined && m.awayScore !== undefined; }
function predictionFor(m) { return m.predictions?.[uid]; }

function isLocked(m) {
  if (!m?.predictionOpenAt || !m?.predictionCloseAt) return true;
  const now = Date.now();
  return now < toDate(m.predictionOpenAt).getTime() ||
         now >= toDate(m.predictionCloseAt).getTime();
}
function predictionStatus(m) {
  if (!m.predictionOpenAt || !m.predictionCloseAt) return 'Tahmin saatleri belirlenmemiş';
  const now = Date.now(), open = toDate(m.predictionOpenAt).getTime();
  const close = toDate(m.predictionCloseAt).getTime();
  if (now < open) return `Tahminler ${dateText(m.predictionOpenAt)} tarihinde açılacak`;
  if (now >= close) return `Tahmin süresi ${dateText(m.predictionCloseAt)} tarihinde sona erdi`;
  return `Tahminler açık · Kapanış: ${dateText(m.predictionCloseAt)}`;
}

function renderLeagueOptions() {
  const select = $('leagueSelect');
  if (!select) return;
  select.innerHTML = memberships.map(code =>
    `<option value="${safe(code)}">${safe(code)}</option>`
  ).join('');
  select.value = groupCode;
}

function showApp() {
  $('entryView').classList.add('hidden');
  $('appView').classList.remove('hidden');
  $('userBadge').textContent = player?.name || 'Oyuncu';
  $('userBadge').classList.remove('hidden');
  document.querySelectorAll('.admin-only').forEach(el => el.classList.toggle('hidden', !isAdmin()));
  renderLeagueOptions();
}

function activateTab(name) {
  document.querySelectorAll('.tab').forEach(tab => tab.classList.toggle('active', tab.dataset.tab === name));
  ['matches', 'table', 'admin'].forEach(tab => $(`${tab}Tab`).classList.toggle('hidden', tab !== name));
}

async function syncLegacyMatches() {
  if (!isAdmin() || !groupCode) return;
  try {
    const source = await getDocs(collection(db, 'groups', groupCode, 'matches'));
    for (const targetCode of SHARED_LEAGUES.filter(c => c !== groupCode)) {
      const targetCol = collection(db, 'groups', targetCode, 'matches');
      for (const item of source.docs) {
        const data = { ...item.data() };
        delete data.predictions;
        await setDoc(doc(db, 'groups', targetCode, 'matches', item.id), data, { merge: true });
      }
    }
  } catch (err) {
    console.error('Senkronizasyon hatası:', err);
  }
}

async function switchLeague(code) {
  if (!code) return;
  const snap = await getDoc(doc(db, 'groups', code, 'players', uid));
  if (!snap.exists()) throw new Error('Bu ligde oyuncu kaydın bulunamadı.');
  if (groupCode && groupCode !== code) await syncLegacyMatches();
  groupCode = code;
  player = { ...snap.data(), uid };
  if (!memberships.includes(code)) memberships.push(code);
  localStorage.setItem('fb_leagues', JSON.stringify(memberships));
  showApp();
  listen();
  activateTab('matches');
}

async function boot() {
  if (!hasConfig) return message($('entryMessage'), 'Kurulum eksik: config.js Firebase ayarlarını kontrol et.');
  const app = initializeApp(firebaseConfig), auth = getAuth(app);
  db = getFirestore(app);
  const user = await new Promise((resolve, reject) => {
    let unsubscribe = () => {};
    unsubscribe = onAuthStateChanged(auth, u => {
      if (u) { unsubscribe(); resolve(u); }
    }, reject);
    if (!auth.currentUser) signInAnonymously(auth).catch(reject);
  });
  uid = user.uid;
  await restoreSession();
}

async function restoreSession() {
  let saved = [];
  try {
    saved = JSON.parse(localStorage.getItem('fb_leagues') || '[]');
    if (!Array.isArray(saved)) saved = [];
  } catch { saved = []; }

  // Eski ILOVE12C kalıntılarını yeni ILOVE12CBRO ile değiştir
  saved = saved.map(c => c === 'ILOVE12C' ? 'ILOVE12CBRO' : c);

  memberships = [...new Set(saved.filter(x => typeof x === 'string' && x))];
  const valid = [];
  for (const code of memberships) {
    try {
      const snap = await getDoc(doc(db, 'groups', code, 'players', uid));
      if (snap.exists()) valid.push(code);
    } catch (err) { console.error('Lig oturumu kontrolü:', code, err); }
  }
  memberships = valid;
  localStorage.setItem('fb_leagues', JSON.stringify(memberships));

  if (memberships.length) {
    await switchLeague(memberships[0]);
  } else {
    // Hiç geçerli oturum yoksa giriş ekranında kal
    $('entryView').classList.remove('hidden');
    $('appView').classList.add('hidden');
  }
}

/* İlk kez lig koduyla giriş */
$('joinForm').addEventListener('submit', async e => {
  e.preventDefault();
  const msg = $('entryMessage');
  if (!db || !uid) return message(msg, 'Bağlantı henüz hazır değil.');
  const code = $('groupCode').value.trim().toUpperCase();
  const name = $('playerName').value.trim();
  if (!code || !name) return;
  if (!validName(name)) return message(msg, 'İsim 2-18 karakter arasında olmalı.');
  try {
    const group = await getDoc(doc(db, 'groups', code));
    if (!group.exists()) throw new Error('Bu grup koduyla bir lig bulunamadı.');
    const ref = doc(db, 'groups', code, 'players', uid);
    const existing = await getDoc(ref);
    if (existing.exists()) {
      if (existing.data().name !== name) throw new Error('Bu cihazdaki oyuncu profili bu ligde farklı bir isimle kayıtlı. Kayıtlı ismini kullan.');
    } else {
      const all = await getDocs(collection(db, 'groups', code, 'players'));
      if (all.docs.some(d => (d.data().name || '').toLowerCase() === name.toLowerCase()))
        throw new Error('Bu oyuncu adı bu ligde zaten kullanılıyor.');
      await setDoc(ref, { name, uid, joinedAt: serverTimestamp() });
    }
    if (!memberships.includes(code)) memberships.push(code);
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
    if (!group.exists()) throw new Error('Bu kodla bir lig bulunamadı.');
    const ref = doc(db, 'groups', code, 'players', uid);
    const existing = await getDoc(ref);
    if (existing.exists()) {
      if (!memberships.includes(code)) memberships.push(code);
    } else {
      const all = await getDocs(collection(db, 'groups', code, 'players'));
      if (all.docs.some(d => (d.data().name || '').toLowerCase() === player.name.toLowerCase()))
        throw new Error('Bu oyuncu adı bu ligde zaten kullanılıyor.');
      await setDoc(ref, { name: player.name, uid, joinedAt: serverTimestamp() });
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
  matches = []; players = [];
  renderMatches(); renderAdminMatches(); renderTable();

  if (!groupCode) return;

  unsubMatches = onSnapshot(
    query(collection(db, 'groups', groupCode, 'matches'), orderBy('kickoff', 'asc')),
    snap => {
      matches = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      renderMatches(); renderAdminMatches(); renderTable();
    },
    err => console.error('Maç dinleme hatası:', err)
  );
  unsubPlayers = onSnapshot(
    collection(db, 'groups', groupCode, 'players'),
    snap => { players = snap.docs.map(d => ({ id: d.id, ...d.data() })); renderTable(); },
    err => console.error('Oyuncu dinleme hatası:', err)
  );
}

function renderMatches() {
  const countEl = $('matchCount');
  if (countEl) countEl.textContent = `${matches.length} MAÇ`;
  const el = $('matchesList');
  if (!el) return;
  if (!matches.length) { el.innerHTML = '<div class="empty">Henüz maç eklenmedi.</div>'; return; }
  
  el.innerHTML = matches.map(m => {
    const p = predictionFor(m), locked = isLocked(m);
    let buttonText = p ? 'Düzenle' : 'Tahmin et';
    if (!m.predictionOpenAt || !m.predictionCloseAt) buttonText = 'Saatler belirlenmemiş';
    else if (Date.now() < toDate(m.predictionOpenAt).getTime()) buttonText = 'Henüz açılmadı';
    else if (Date.now() >= toDate(m.predictionCloseAt).getTime()) buttonText = 'Tahmin kapandı';

    let othersHtml = '';
    if (p && m.predictions) {
      const otherEntries = Object.entries(m.predictions).filter(([userId]) => userId !== uid);
      if (otherEntries.length > 0) {
        othersHtml = `<div class="others-predictions" style="margin-top: 8px; font-size: 0.85rem; border-top: 1px dashed rgba(255,255,255,0.1); padding-top: 6px;">
          <div style="font-weight: bold; margin-bottom: 4px; color: var(--accent, #3b82f6);">Diğer Oyuncuların Tahminleri:</div>
          <ul style="list-style: none; padding: 0; margin: 0;">
            ${otherEntries.map(([userId, pred]) => `<li><b>${safe(pred.playerName || 'Oyuncu')}:</b> ${pred.home} - ${pred.away}</li>`).join('')}
          </ul>
        </div>`;
      } else {
        othersHtml = `<div class="others-predictions" style="margin-top: 8px; font-size: 0.85rem; color: #888;">Diğer oyuncular henüz bu maça tahmin yapmamış.</div>`;
      }
    } else {
      othersHtml = `<div class="others-predictions-warning" style="margin-top: 8px; font-size: 0.8rem; color: #f59e0b; background: rgba(245, 158, 11, 0.1); padding: 6px; border-radius: 4px;">⚠️ Diğer kullanıcıların tahminlerini görebilmek için önce kendi tahminini yapmalısın!</div>`;
    }

    return `<article class="match-card">
      <div>
        <div class="match-meta">${safe(m.competition || 'FUTBOL')} · ${dateText(m.kickoff)}</div>
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
      <div style="grid-column: 1 / -1; width: 100%;">
        ${othersHtml}
      </div>
    </article>`;
  }).join('');

  el.querySelectorAll('[data-predict]').forEach(b => b.addEventListener('click', () => openPrediction(b.dataset.predict)));
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
      modalWarning.textContent = '⚠️ Not: Tahminini kaydettikten sonra bu maç için diğer kullanıcıların tahminlerini de görüntüleyebileceksin.';
    } else {
      modalWarning.style.display = 'none';
    }
  }

  $('predictionDialog').showModal();
}

$('predictionForm').addEventListener('submit', async e => {
  e.preventDefault();
  const msg = $('predictionMessage');
  if (!activeMatch || isLocked(activeMatch)) return message(msg, 'Bu maçın tahmin süresi açık değil veya sona erdi.');
  const hRaw = $('homePrediction').value, aRaw = $('awayPrediction').value;
  const h = Number(hRaw), a = Number(aRaw);
  const invalid = n => !Number.isInteger(n) || n < 0 || n > 30;
  if (hRaw === '' || aRaw === '' || invalid(h) || invalid(a)) return message(msg, '0 ile 30 arasında tam sayı gir.');
  try {
    await updateDoc(doc(db, 'groups', groupCode, 'matches', activeMatch.id), {
      [`predictions.${uid}`]: { home: h, away: a, playerName: player.name, updatedAt: Date.now() }
    });
    $('predictionDialog').close();
  } catch (err) {
    console.error(err); message(msg, 'Tahmin kaydedilemedi: ' + err.message);
  }
});

$('matchForm').addEventListener('submit', async e => {
  e.preventDefault();
  if (!isAdmin()) return alert('Yönetici yetkisi yok.');
  const kickoff = fromLocalInput($('kickoff').value);
  const predictionOpenAt = fromLocalInput($('predictionOpenAt').value);
  const predictionCloseAt = fromLocalInput($('predictionCloseAt').value);
  const homeTeam = $('homeTeam').value.trim(), awayTeam = $('awayTeam').value.trim();
  const competition = $('competition').value.trim() || 'Futbol';
  if (!homeTeam || !awayTeam) return message($('matchFormMessage'), 'İki takımın adını da gir.');
  if (!kickoff || !predictionOpenAt || !predictionCloseAt) return message($('matchFormMessage'), 'Bütün tarih alanlarını doldur.');
  if (kickoff <= new Date()) return message($('matchFormMessage'), 'Maç tarihi gelecekte olmalı.');
  if (predictionCloseAt <= predictionOpenAt) return message($('matchFormMessage'), 'Tahmin kapanışı açılıştan sonra olmalı.');
  if (predictionCloseAt > kickoff) return message($('matchFormMessage'), 'Tahmin kapanışı maç başlangıcından sonra olamaz.');
  try {
    const matchRef = doc(collection(db, 'groups', groupCode, 'matches'));
    const matchData = {
      homeTeam, awayTeam, competition, kickoff: Timestamp.fromDate(kickoff),
      predictionOpenAt: Timestamp.fromDate(predictionOpenAt),
      predictionCloseAt: Timestamp.fromDate(predictionCloseAt),
      createdAt: serverTimestamp(), createdBy: uid, predictions: {}
    };
    await Promise.all(SHARED_LEAGUES.map(code =>
      setDoc(doc(db, 'groups', code, 'matches', matchRef.id), matchData)
    ));
    e.target.reset();
    message($('matchFormMessage'), 'Maç ve tahmin takvimi eklendi.', false);
  } catch (err) {
    console.error(err); message($('matchFormMessage'), 'Maç eklenemedi: ' + err.message);
  }
});

function renderAdminMatches() {
  const el = $('adminMatches');
  if (!el) return;
  if (!matches.length) { el.innerHTML = '<div class="empty">Henüz maç yok.</div>'; return; }
  el.innerHTML = matches.map(m => `<article class="match-card admin-match-card">
    <div><div class="match-meta">${dateText(m.kickoff)}</div>
    <div class="teams"><span>${safe(m.homeTeam)}</span><span class="vs">VS</span><span>${safe(m.awayTeam)}</span></div>
    <div class="match-meta">${safe(predictionStatus(m))}</div></div>
    <div class="admin-match-settings">
      <label>Tahmin açılışı<input type="datetime-local" id="open-${safe(m.id)}" value="${safe(toLocalInput(m.predictionOpenAt))}"></label>
      <label>Tahmin kapanışı<input type="datetime-local" id="close-${safe(m.id)}" value="${safe(toLocalInput(m.predictionCloseAt))}"></label>
      <button class="small-btn" data-save-schedule="${safe(m.id)}">Saatleri kaydet</button>
      ${hasResult(m) ? `<b>Sonuç: ${m.homeScore} - ${m.awayScore}</b>` : `
        <div class="two-col"><label>Ev skoru<input id="h-${safe(m.id)}" type="number" min="0" max="30"></label>
        <label>Dep. skoru<input id="a-${safe(m.id)}" type="number" min="0" max="30"></label></div>
        <button class="small-btn" data-result="${safe(m.id)}">Sonucu kaydet</button>`}
    </div></article>`).join('');

  el.querySelectorAll('[data-save-schedule]').forEach(button => button.addEventListener('click', async () => {
    const id = button.dataset.saveSchedule;
    const open = fromLocalInput($(`open-${id}`).value), close = fromLocalInput($(`close-${id}`).value);
    const match = matches.find(m => m.id === id);
    if (!open || !close) return alert('İki tahmin tarihini de gir.');
    if (close <= open) return alert('Kapanış açılıştan sonra olmalı.');
    if (close > toDate(match.kickoff)) return alert('Tahmin kapanışı maç başlangıcından sonra olamaz.');
    button.disabled = true;
    try {
      await Promise.all(SHARED_LEAGUES.map(code => updateDoc(doc(db, 'groups', code, 'matches', id), {
        predictionOpenAt: Timestamp.fromDate(open), predictionCloseAt: Timestamp.fromDate(close)
      })));
      alert('Bu maçın tahmin saatleri güncellendi.');
    } catch (err) { console.error(err); alert('Saatler kaydedilemedi: ' + err.message); }
    finally { button.disabled = false; }
  }));

  el.querySelectorAll('[data-result]').forEach(button => button.addEventListener('click', async () => {
    if (!isAdmin()) return alert('Yönetici yetkisi yok.');
    const id = button.dataset.result, hRaw = $(`h-${id}`).value, aRaw = $(`a-${id}`).value;
    const h = Number(hRaw), a = Number(aRaw);
    if (hRaw === '' || aRaw === '' || !Number.isInteger(h) || !Number.isInteger(a) || h < 0 || a < 0 || h > 30 || a > 30)
      return alert('0-30 arasında iki geçerli skor gir.');
    button.disabled = true;
    try {
      await Promise.all(SHARED_LEAGUES.map(code => updateDoc(doc(db, 'groups', code, 'matches', id), {
        homeScore: h, awayScore: a, resultAt: serverTimestamp()
      })));
    } catch (err) { console.error(err); alert('Sonuç kaydedilemedi: ' + err.message); button.disabled = false; }
  }));
}

function pointsFor(m, p) {
  if (!hasResult(m) || !p) return 0;
  if (p.home === m.homeScore && p.away === m.awayScore) return 3;
  return Math.sign(m.homeScore - m.awayScore) === Math.sign(p.home - p.away) ? 1 : 0;
}

function renderTable() {
  const leaderboardEl = $('leaderboard');
  if (!leaderboardEl) return;
  const finished = matches.filter(hasResult);
  const totals = players.map(p => ({
    ...p,
    pts: finished.reduce((sum, m) => sum + pointsFor(m, m.predictions?.[p.id]), 0),
    played: finished.length
  })).sort((a, b) => b.pts - a.pts || a.name.localeCompare(b.name, 'tr'));
  leaderboardEl.innerHTML = totals.length ? totals.map((p, i) =>
    `<tr><td>${i + 1}</td><td>${safe(p.name)}${p.id === uid ? ' (Sen)' : ''}</td><td>${p.played}</td><td>${p.pts}</td></tr>`
  ).join('') : '<tr><td colspan="4" class="empty">Henüz oyuncu yok.</td></tr>';
}

document.querySelectorAll('.tab').forEach(button => button.addEventListener('click', () => {
  if (button.dataset.tab === 'admin' && !isAdmin()) return;
  activateTab(button.dataset.tab);
}));

/* Eski maçları diğer lige aktar butonu işlevselliği */
const bulkMigrateBtn = $('bulkMigrateBtn');
if (bulkMigrateBtn) {
  bulkMigrateBtn.addEventListener('click', async () => {
    if (!isAdmin()) return alert('Yönetici yetkisi yok.');
    
    const sourceLeague = 'BARBAROS26';
    const targetLeague = 'ILOVE12CBRO';

    if (!confirm(`groups/${sourceLeague}/matches koleksiyonundaki bütün maçlar groups/${targetLeague}/matches koleksiyonuna (tahminler hariç, mevcut maçların üzerine yazılmadan) aktarılacaktır. Emin misiniz?`)) {
      return;
    }

    bulkMigrateBtn.disabled = true;
    try {
      const sourceSnapshot = await getDocs(collection(db, 'groups', sourceLeague, 'matches'));
      let copiedCount = 0;
      let skippedCount = 0;

      for (const sourceDoc of sourceSnapshot.docs) {
        const matchId = sourceDoc.id;
        const targetRef = doc(db, 'groups', targetLeague, 'matches', matchId);
        const targetSnap = await getDoc(targetRef);

        if (targetSnap.exists()) {
          skippedCount++;
        } else {
          const data = { ...sourceDoc.data() };
          delete data.predictions;
          await setDoc(targetRef, data);
          copiedCount++;
        }
      }

      alert(`Aktarım tamamlandı!\nKopyalanan maç sayısı: ${copiedCount}\nZaten mevcut olduğu için atlanan maç sayısı: ${skippedCount}`);
    } catch (err) {
      console.error(err);
      alert('Maç aktarımı sırasında hata oluştu: ' + (err.message || err));
    } finally {
      bulkMigrateBtn.disabled = false;
    }
  });
}

$('editNameButton').addEventListener('click', () => {
  if (!player) return;
  $('newPlayerName').value = player.name;
  message($('nameMessage'), '');
  $('nameDialog').showModal();
});
$('closeNameDialog').addEventListener('click', () => $('nameDialog').close());

$('nameForm').addEventListener('submit', async e => {
  e.preventDefault();
  const newName = $('newPlayerName').value.trim(), msg = $('nameMessage');
  if (!validName(newName)) return message(msg, 'İsim 2-18 karakter arasında olmalı.');
  if (newName === player.name) return $('nameDialog').close();
  try {
    for (const code of memberships) {
      const all = await getDocs(collection(db, 'groups', code, 'players'));
      if (all.docs.some(d => d.id !== uid && (d.data().name || '').toLowerCase() === newName.toLowerCase()))
        throw new Error(`${code} liginde bu oyuncu adı zaten kullanılıyor.`);
    }
    await Promise.all(memberships.map(code =>
      updateDoc(doc(db, 'groups', code, 'players', uid), { name: newName })
    ));
    player.name = newName; showApp(); renderTable(); $('nameDialog').close();
  } catch (err) { console.error(err); message(msg, 'İsim değiştirilemedi: ' + err.message); }
});

$('leaveButton').addEventListener('click', () => {
  if (confirm('Bu cihazdaki kayıtlı lig oturumlarını sıfırlamak istiyor musun?')) {
    localStorage.removeItem('fb_leagues');
    localStorage.removeItem('fb_player');
    location.reload();
  }
});

setInterval(() => { if (player) renderMatches(); }, 15000);
boot().catch(err => {
  console.error(err);
  message($('entryMessage'), 'HATA: ' + (err.code || err.message || 'Bilinmeyen hata'));
});
