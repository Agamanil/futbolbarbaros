// FUTBOLBARBAROS - Firebase bağlantısı kurulduğunda ortak çevrimiçi veri kullanır.
// İlk kurulum için config.js dosyasını doldurun.
import { initializeApp } from 'https://www.gstatic.com/firebasejs/13.2.0/firebase-app.js';
import { getAuth, signInAnonymously, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/13.2.0/firebase-auth.js';
import {
  getFirestore, doc, getDoc, setDoc, collection, addDoc, getDocs,
  query, orderBy, onSnapshot, updateDoc, serverTimestamp, Timestamp
} from 'https://www.gstatic.com/firebasejs/13.2.0/firebase-firestore.js';
import { firebaseConfig, ADMIN_UID } from './config.js';

/* ---------- Yardımcılar ---------- */
const $ = id => document.getElementById(id);
const hasConfig = Boolean(firebaseConfig && firebaseConfig.apiKey && firebaseConfig.projectId);

let auth, db;
let uid = null;
let player = null;
let groupCode = '';
let matches = [];
let players = [];
let activeMatch = null;
let unsubMatches = null;
let unsubPlayers = null;

const entryView = $('entryView');
const appView = $('appView');

const isAdmin = () => Boolean(uid) && uid === ADMIN_UID;

function message(el, text, isError = true) {
  el.textContent = text;
  el.style.color = isError ? 'var(--red)' : 'var(--green)';
}

function toDate(value) {
  return value?.toDate ? value.toDate() : new Date(value);
}

function dateText(value) {
  return toDate(value).toLocaleString('tr-TR', { dateStyle: 'medium', timeStyle: 'short' });
}

function isLocked(m) {
  return Date.now() >= toDate(m.kickoff).getTime();
}

function hasResult(m) {
  return m.homeScore !== undefined && m.awayScore !== undefined;
}

function safe(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function validName(name) {
  return name.length >= 2 && name.length <= 18;
}

/* ---------- Görünümler ---------- */
function showApp() {
  entryView.classList.add('hidden');
  appView.classList.remove('hidden');
  $('userBadge').textContent = player.name;
  $('userBadge').classList.remove('hidden');
  $('welcomeName').textContent = player.name;
  document.querySelectorAll('.admin-only').forEach(x => x.classList.toggle('hidden', !isAdmin()));
}

/* ---------- Başlangıç ---------- */
async function boot() {
  if (!hasConfig) {
    message($('entryMessage'), 'Kurulum eksik: config.js içine Firebase ayarları eklenmeli. README dosyasına bak.');
    return;
  }

  const app = initializeApp(firebaseConfig);
  auth = getAuth(app);
  db = getFirestore(app);

  // Anonim oturum hazır olana kadar bekle; uid garanti atanmış olsun.
  const user = await new Promise((resolve, reject) => {
    const off = onAuthStateChanged(auth, u => {
      if (u) { off(); resolve(u); }
    }, reject);
    if (!auth.currentUser) signInAnonymously(auth).catch(reject);
  });

  uid = user.uid;
  console.log('BENİM UID:', uid);

  await restoreSession();
}

async function restoreSession() {
  const saved = localStorage.getItem('fb_player');
  if (!saved) return;

  try {
    const { groupCode: code } = JSON.parse(saved);
    const snap = await getDoc(doc(db, 'groups', code, 'players', uid));
    if (snap.exists()) {
      player = snap.data();
      groupCode = code;
      showApp();
      listen();
    } else {
      localStorage.removeItem('fb_player');
    }
  } catch (e) {
    console.error(e);
    localStorage.removeItem('fb_player');
  }
}

/* ---------- Giriş ---------- */
$('joinForm').addEventListener('submit', async e => {
  e.preventDefault();
  const msg = $('entryMessage');
  if (!db || !uid) return message(msg, 'Bağlantı henüz hazır değil, birkaç saniye sonra tekrar dene.');

  const code = $('groupCode').value.trim().toUpperCase();
  const name = $('playerName').value.trim();
  if (!code || !name) return;
  if (!validName(name)) return message(msg, 'İsim 2-18 karakter arasında olmalı.');

  try {
    const group = await getDoc(doc(db, 'groups', code));
    if (!group.exists()) throw new Error('Bu grup koduyla bir lig bulunamadı. Kodu yöneticinden kontrol et.');

    const ref = doc(db, 'groups', code, 'players', uid);
    const existing = await getDoc(ref);

    if (existing.exists()) {
      if (existing.data().name !== name) throw new Error('Bu cihaz başka bir oyuncu adına kayıtlı.');
    } else {
      const all = await getDocs(collection(db, 'groups', code, 'players'));
      if (all.docs.some(d => d.data().name.toLowerCase() === name.toLowerCase())) {
        throw new Error('Bu oyuncu adı zaten kullanılıyor.');
      }
      await setDoc(ref, { name, uid, joinedAt: serverTimestamp() });
    }

    player = { name, uid };
    groupCode = code;
    localStorage.setItem('fb_player', JSON.stringify({ groupCode: code }));
    showApp();
    listen();
  } catch (err) {
    message(msg, err.message || 'Giriş yapılamadı.');
  }
});

/* ---------- Canlı dinleyiciler ---------- */
function listen() {
  if (unsubMatches) unsubMatches();
  if (unsubPlayers) unsubPlayers();

  unsubMatches = onSnapshot(
    query(collection(db, 'groups', groupCode, 'matches'), orderBy('kickoff', 'asc')),
    snap => {
      matches = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      renderMatches();
      renderAdminMatches();
      renderTable();
    },
    err => console.error('Maç dinleme hatası:', err)
  );

  unsubPlayers = onSnapshot(
    collection(db, 'groups', groupCode, 'players'),
    snap => {
      players = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      renderTable();
    },
    err => console.error('Oyuncu dinleme hatası:', err)
  );
}

/* ---------- Maçlar ve tahmin ---------- */
const predictionFor = m => m.predictions?.[uid];

function renderMatches() {
  $('matchCount').textContent = `${matches.length} MAÇ`;
  const el = $('matchesList');

  if (!matches.length) {
    el.innerHTML = '<div class="empty">Henüz maç eklenmedi. Yönetici fikstürü hazırlıyor.</div>';
    return;
  }

  el.innerHTML = matches.map(m => {
    const p = predictionFor(m);
    const locked = isLocked(m);
    const label = locked ? 'Kilitli' : p ? 'Düzenle' : 'Tahmin et';

    return `
      <article class="match-card">
        <div>
          <div class="match-meta">${safe(m.competition || 'FUTBOL')} · ${dateText(m.kickoff)} ${locked ? '· KİLİTLİ' : ''}</div>
          <div class="teams"><span>${safe(m.homeTeam)}</span><span class="vs">VS</span><span>${safe(m.awayTeam)}</span></div>
        </div>
        <div class="match-actions">
          <div class="prediction-label">
            ${p ? `Tahminin: <b>${p.home}-${p.away}</b>` : 'Henüz tahmin yok'}
            ${hasResult(m) ? `<br>Sonuç: <b>${m.homeScore}-${m.awayScore}</b>` : ''}
          </div>
          <button class="small-btn" data-predict="${m.id}" ${locked ? 'disabled' : ''}>${label}</button>
        </div>
      </article>`;
  }).join('');

  el.querySelectorAll('[data-predict]').forEach(b =>
    b.addEventListener('click', () => openPrediction(b.dataset.predict))
  );
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
  $('predictionDialog').showModal();
}

$('predictionForm').addEventListener('submit', async e => {
  e.preventDefault();
  const msg = $('predictionMessage');

  if (!activeMatch || isLocked(activeMatch)) return message(msg, 'Maç başladı, tahmin kapandı.');

  const h = Number($('homePrediction').value);
  const a = Number($('awayPrediction').value);
  const invalid = v => !Number.isInteger(v) || v < 0 || v > 30;
  if ($('homePrediction').value === '' || $('awayPrediction').value === '' || invalid(h) || invalid(a)) {
    return message(msg, '0 ile 30 arasında tam sayı gir.');
  }

  try {
    await updateDoc(doc(db, 'groups', groupCode, 'matches', activeMatch.id), {
      [`predictions.${uid}`]: { home: h, away: a, playerName: player.name, updatedAt: Date.now() }
    });
    $('predictionDialog').close();
  } catch (err) {
    console.error(err);
    message(msg, 'Tahmin kaydedilemedi.');
  }
});

/* ---------- Puan tablosu ---------- */
function pointsFor(m, p) {
  if (!hasResult(m) || !p) return 0;
  if (p.home === m.homeScore && p.away === m.awayScore) return 3;
  return Math.sign(m.homeScore - m.awayScore) === Math.sign(p.home - p.away) ? 1 : 0;
}

function renderTable() {
  const finished = matches.filter(hasResult);

  const totals = players
    .map(p => {
      const pts = finished.reduce((sum, m) => sum + pointsFor(m, m.predictions?.[p.id]), 0);
      return { ...p, pts, played: finished.length };
    })
    .sort((a, b) => b.pts - a.pts || a.name.localeCompare(b.name, 'tr'));

  $('leaderboard').innerHTML = totals.length
    ? totals.map((p, i) => `
        <tr>
          <td>${i + 1}</td>
          <td>${safe(p.name)}${p.id === uid ? ' <span style="color:var(--green)">(Sen)</span>' : ''}</td>
          <td>${p.played}</td>
          <td>${p.pts}</td>
        </tr>`).join('')
    : '<tr><td colspan="4" class="empty">Henüz oyuncu yok.</td></tr>';
}

/* ---------- Yönetici ---------- */
$('matchForm').addEventListener('submit', async e => {
  e.preventDefault();
  if (!isAdmin()) return alert('Yönetici yetkisi yok.');

  const kickoff = new Date($('kickoff').value);
  if (!Number.isFinite(kickoff.getTime()) || kickoff <= new Date()) {
    return alert('Maç tarihi gelecekte olmalı.');
  }

  const homeTeam = $('homeTeam').value.trim();
  const awayTeam = $('awayTeam').value.trim();
  if (!homeTeam || !awayTeam) return alert('İki takım adını da gir.');

  try {
    await addDoc(collection(db, 'groups', groupCode, 'matches'), {
      homeTeam,
      awayTeam,
      competition: $('competition').value.trim() || 'Futbol',
      kickoff: Timestamp.fromDate(kickoff),
      createdAt: serverTimestamp(),
      createdBy: uid,
      predictions: {}
    });
    e.target.reset();
  } catch (err) {
    alert('Maç eklenemedi: ' + err.message);
  }
});

function renderAdminMatches() {
  const el = $('adminMatches');

  if (!matches.length) {
    el.innerHTML = '<div class="empty">Henüz maç yok.</div>';
    return;
  }

  el.innerHTML = matches.map(m => `
    <article class="match-card">
      <div>
        <div class="match-meta">${dateText(m.kickoff)}</div>
        <div class="teams"><span>${safe(m.homeTeam)}</span><span class="vs">VS</span><span>${safe(m.awayTeam)}</span></div>
      </div>
      <div class="match-actions">
        ${hasResult(m)
          ? `<b>${m.homeScore} - ${m.awayScore}</b>`
          : `<input aria-label="Ev sahibi skoru" id="h-${m.id}" type="number" min="0" placeholder="Ev" style="width:62px">
             <input aria-label="Deplasman skoru" id="a-${m.id}" type="number" min="0" placeholder="Dep" style="width:62px">
             <button class="small-btn" data-result="${m.id}">Sonucu kaydet</button>`}
      </div>
    </article>`).join('');

  el.querySelectorAll('[data-result]').forEach(b =>
    b.addEventListener('click', async () => {
      if (!isAdmin()) return alert('Yönetici yetkisi yok.');

      const id = b.dataset.result;
      const m = matches.find(x => x.id === id);
      const hRaw = $(`h-${id}`).value;
      const aRaw = $(`a-${id}`).value;
      const h = Number(hRaw);
      const a = Number(aRaw);

      if (!m || !isLocked(m)) return alert('Maç başlamadan sonuç girilemez.');
      if (hRaw === '' || aRaw === '' || !Number.isInteger(h) || !Number.isInteger(a) || h < 0 || a < 0) {
        return alert('İki skoru da gir.');
      }

      b.disabled = true;
      try {
        await updateDoc(doc(db, 'groups', groupCode, 'matches', id), {
          homeScore: h,
          awayScore: a,
          resultAt: serverTimestamp()
        });
      } catch (err) {
        console.error(err);
        alert('Sonuç kaydedilemedi: ' + err.message);
        b.disabled = false;
      }
    })
  );
}

/* ---------- Sekmeler ve çıkış ---------- */
document.querySelectorAll('.tab').forEach(b =>
  b.addEventListener('click', () => {
    if (b.dataset.tab === 'admin' && !isAdmin()) return;
    document.querySelectorAll('.tab').forEach(x => x.classList.toggle('active', x === b));
    ['matches', 'table', 'admin'].forEach(t => $(`${t}Tab`).classList.toggle('hidden', t !== b.dataset.tab));
  })
);

$('leaveButton').addEventListener('click', () => {
  if (confirm('Bu cihazdaki oyuncu kaydını sıfırlamak istiyor musun? Aynı anonim hesap Firebase tarafında kalır.')) {
    localStorage.removeItem('fb_player');
    location.reload();
  }
});

/* ---------- İsim değiştirme ---------- */
$('editNameButton').addEventListener('click', () => {
  $('newPlayerName').value = player.name;
  message($('nameMessage'), '');
  $('nameDialog').showModal();
});

$('closeNameDialog').addEventListener('click', () => $('nameDialog').close());

$('nameForm').addEventListener('submit', async e => {
  e.preventDefault();
  const msg = $('nameMessage');
  const newName = $('newPlayerName').value.trim();

  if (!validName(newName)) return message(msg, 'İsim 2-18 karakter arasında olmalı.');
  if (newName === player.name) return $('nameDialog').close();

  try {
    const all = await getDocs(collection(db, 'groups', groupCode, 'players'));
    const duplicate = all.docs.some(d => d.id !== uid && d.data().name.toLowerCase() === newName.toLowerCase());
    if (duplicate) return message(msg, 'Bu oyuncu adı zaten kullanılıyor.');

    await updateDoc(doc(db, 'groups', groupCode, 'players', uid), { name: newName });

    player.name = newName;
    showApp();
    renderTable();
    $('nameDialog').close();
  } catch (err) {
    console.error(err);
    message(msg, 'İsim değiştirilemedi: ' + err.message);
  }
});

/* ---------- Çalıştır ---------- */
boot().catch(e => {
  console.error(e);
  message($('entryMessage'), 'HATA: ' + (e.code || e.message || 'Bilinmeyen hata'));
});
