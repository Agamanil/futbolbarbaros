// FUTBOLBARBAROS - MAÇ BAZLI TAHMİN TAKVİMİ

import { initializeApp } from 'https://www.gstatic.com/firebasejs/13.2.0/firebase-app.js';
import {
  getAuth, signInAnonymously, onAuthStateChanged
} from 'https://www.gstatic.com/firebasejs/13.2.0/firebase-auth.js';
import {
  getFirestore, doc, getDoc, setDoc, collection, addDoc, getDocs,
  query, orderBy, onSnapshot, updateDoc, serverTimestamp, Timestamp
} from 'https://www.gstatic.com/firebasejs/13.2.0/firebase-firestore.js';
import { firebaseConfig, ADMIN_UID } from './config.js';

const $ = id => document.getElementById(id);
const hasConfig = Boolean(firebaseConfig?.apiKey && firebaseConfig?.projectId);

let db;
let uid = null;
let player = null;
let groupCode = '';
let matches = [];
let players = [];
let activeMatch = null;

let unsubMatches = null;
let unsubPlayers = null;

const isAdmin = () => Boolean(uid) && uid === ADMIN_UID;

function message(el, text, isError = true) {
  if (!el) return;
  el.textContent = text;
  el.style.color = isError ? 'var(--red)' : 'var(--green)';
}

function toDate(value) {
  return value?.toDate ? value.toDate() : new Date(value);
}

function fromLocalInput(value) {
  if (!value) return null;
  return new Date(`${value}:00+03:00`);
}

function toLocalInput(value) {
  if (!value) return '';

  const d = toDate(value);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Istanbul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(d);

  const part = type => parts.find(p => p.type === type)?.value;

  return `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}`;
}

function dateText(value) {
  if (!value) return 'Belirlenmedi';

  return toDate(value).toLocaleString('tr-TR', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Europe/Istanbul'
  });
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

// Her maç kendi tahmin saatlerini kontrol eder.
function isLocked(m) {
  if (!m?.predictionOpenAt || !m?.predictionCloseAt) return true;

  const now = Date.now();
  const open = toDate(m.predictionOpenAt).getTime();
  const close = toDate(m.predictionCloseAt).getTime();

  return now < open || now >= close;
}

function predictionStatus(m) {
  if (!m.predictionOpenAt || !m.predictionCloseAt) {
    return 'Tahmin saatleri belirlenmemiş';
  }

  const now = Date.now();
  const open = toDate(m.predictionOpenAt).getTime();
  const close = toDate(m.predictionCloseAt).getTime();

  if (now < open) return `Tahminler ${dateText(m.predictionOpenAt)} tarihinde açılacak`;
  if (now >= close) return `Tahmin süresi ${dateText(m.predictionCloseAt)} tarihinde sona erdi`;

  return `Tahminler açık · Kapanış: ${dateText(m.predictionCloseAt)}`;
}

function showApp() {
  $('entryView').classList.add('hidden');
  $('appView').classList.remove('hidden');

  $('userBadge').textContent = player.name;
  $('userBadge').classList.remove('hidden');
  $('welcomeName').textContent = player.name;

  document.querySelectorAll('.admin-only').forEach(el => {
    el.classList.toggle('hidden', !isAdmin());
  });
}

/* -------------------- BAŞLATMA -------------------- */

async function boot() {
  if (!hasConfig) {
    message($('entryMessage'), 'Kurulum eksik: config.js Firebase ayarlarını kontrol et.');
    return;
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
  } catch (err) {
    console.error(err);
    message($('entryMessage'), 'Oturum yüklenemedi: ' + err.message);
  }
}

/* -------------------- LİGE KATILMA -------------------- */

$('joinForm').addEventListener('submit', async e => {
  e.preventDefault();

  const msg = $('entryMessage');

  if (!db || !uid) {
    return message(msg, 'Bağlantı henüz hazır değil. Birkaç saniye sonra tekrar dene.');
  }

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
      if (existing.data().name !== name) {
        throw new Error('Bu cihaz başka bir oyuncu adına kayıtlı.');
      }
    } else {
      const all = await getDocs(collection(db, 'groups', code, 'players'));

      if (all.docs.some(d =>
        (d.data().name || '').toLowerCase() === name.toLowerCase()
      )) {
        throw new Error('Bu oyuncu adı zaten kullanılıyor.');
      }

      await setDoc(ref, {
        name,
        uid,
        joinedAt: serverTimestamp()
      });
    }

    player = { name, uid };
    groupCode = code;

    localStorage.setItem('fb_player', JSON.stringify({
      groupCode: code
    }));

    showApp();
    listen();
  } catch (err) {
    message(msg, err.message || 'Giriş yapılamadı.');
  }
});

/* -------------------- CANLI VERİLER -------------------- */

function listen() {
  if (unsubMatches) unsubMatches();
  if (unsubPlayers) unsubPlayers();

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
    },
    err => console.error('Oyuncu dinleme hatası:', err)
  );
}

/* -------------------- OYUNCU MAÇ EKRANI -------------------- */

function renderMatches() {
  $('matchCount').textContent = `${matches.length} MAÇ`;

  const el = $('matchesList');

  if (!matches.length) {
    el.innerHTML = '<div class="empty">Henüz maç eklenmedi.</div>';
    return;
  }

  el.innerHTML = matches.map(m => {
    const p = predictionFor(m);
    const locked = isLocked(m);

    let buttonText = p ? 'Düzenle' : 'Tahmin et';

    if (!m.predictionOpenAt || !m.predictionCloseAt) {
      buttonText = 'Saatler belirlenmedi';
    } else if (Date.now() < toDate(m.predictionOpenAt).getTime()) {
      buttonText = 'Henüz açılmadı';
    } else if (Date.now() >= toDate(m.predictionCloseAt).getTime()) {
      buttonText = 'Tahmin kapandı';
    }

    return `
      <article class="match-card">
        <div>
          <div class="match-meta">
            ${safe(m.competition || 'FUTBOL')} · ${dateText(m.kickoff)}
          </div>

          <div class="teams">
            <span>${safe(m.homeTeam)}</span>
            <span class="vs">VS</span>
            <span>${safe(m.awayTeam)}</span>
          </div>

          <div class="match-meta">${safe(predictionStatus(m))}</div>
        </div>

        <div class="match-actions">
          <div class="prediction-label">
            ${p ? `Tahminin: <b>${p.home}-${p.away}</b>` : 'Henüz tahmin yok'}
            ${hasResult(m) ? `<br>Sonuç: <b>${m.homeScore}-${m.awayScore}</b>` : ''}
          </div>

          <button class="small-btn"
            data-predict="${safe(m.id)}"
            ${locked ? 'disabled' : ''}>
            ${buttonText}
          </button>
        </div>
      </article>
    `;
  }).join('');

  el.querySelectorAll('[data-predict]').forEach(button => {
    button.addEventListener('click', () => {
      openPrediction(button.dataset.predict);
    });
  });
}

function openPrediction(id) {
  activeMatch = matches.find(m => m.id === id);

  if (!activeMatch || isLocked(activeMatch)) return;

  const p = predictionFor(activeMatch);

  $('predictionTitle').textContent =
    `${activeMatch.homeTeam} - ${activeMatch.awayTeam}`;

  $('predictionKickoff').textContent = dateText(activeMatch.kickoff);
  $('homePrediction').value = p?.home ?? '';
  $('awayPrediction').value = p?.away ?? '';

  message($('predictionMessage'), '');
  $('predictionDialog').showModal();
}

/* -------------------- TAHMİN KAYDETME -------------------- */

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

  const invalid = v => !Number.isInteger(v) || v < 0 || v > 30;

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

/* -------------------- YÖNETİCİ: YENİ MAÇ EKLEME -------------------- */

$('matchForm').addEventListener('submit', async e => {
  e.preventDefault();

  if (!isAdmin()) return alert('Yönetici yetkisi yok.');

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
    await addDoc(
      collection(db, 'groups', groupCode, 'matches'),
      {
        homeTeam,
        awayTeam,
        competition,
        kickoff: Timestamp.fromDate(kickoff),
        predictionOpenAt: Timestamp.fromDate(predictionOpenAt),
        predictionCloseAt: Timestamp.fromDate(predictionCloseAt),
        createdAt: serverTimestamp(),
        createdBy: uid,
        predictions: {}
      }
    );

    e.target.reset();
    message($('matchFormMessage'), 'Maç ve tahmin takvimi eklendi.', false);
  } catch (err) {
    console.error(err);
    message($('matchFormMessage'), 'Maç eklenemedi: ' + err.message);
  }
});

/* -------------------- YÖNETİCİ: MAÇLARI YÖNET -------------------- */

function renderAdminMatches() {
  const el = $('adminMatches');

  if (!matches.length) {
    el.innerHTML = '<div class="empty">Henüz maç yok.</div>';
    return;
  }

  el.innerHTML = matches.map(m => `
    <article class="match-card admin-match-card">
      <div>
        <div class="match-meta">${dateText(m.kickoff)}</div>
        <div class="teams">
          <span>${safe(m.homeTeam)}</span>
          <span class="vs">VS</span>
          <span>${safe(m.awayTeam)}</span>
        </div>
        <div class="match-meta">${safe(predictionStatus(m))}</div>
      </div>

      <div class="admin-match-settings">
        <label>Tahmin açılışı
          <input type="datetime-local"
            id="open-${safe(m.id)}"
            value="${safe(toLocalInput(m.predictionOpenAt))}">
        </label>

        <label>Tahmin kapanışı
          <input type="datetime-local"
            id="close-${safe(m.id)}"
            value="${safe(toLocalInput(m.predictionCloseAt))}">
        </label>

        <button class="small-btn" data-save-schedule="${safe(m.id)}">
          Saatleri kaydet
        </button>

        ${
          hasResult(m)
            ? `<b>Sonuç: ${m.homeScore} - ${m.awayScore}</b>`
            : `
              <div class="two-col">
                <label>Ev skoru
                  <input id="h-${safe(m.id)}" type="number" min="0" max="30">
                </label>
                <label>Dep. skoru
                  <input id="a-${safe(m.id)}" type="number" min="0" max="30">
                </label>
              </div>
              <button class="small-btn" data-result="${safe(m.id)}">
                Sonucu kaydet
              </button>
            `
        }
      </div>
    </article>
  `).join('');

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
      if (!isAdmin()) return alert('Yönetici yetkisi yok.');

      const id = button.dataset.result;
      const hRaw = $(`h-${id}`).value;
      const aRaw = $(`a-${id}`).value;
      const h = Number(hRaw);
      const a = Number(aRaw);

      if (
        hRaw === '' || aRaw === '' ||
        !Number.isInteger(h) || !Number.isInteger(a) ||
        h < 0 || a < 0 || h > 30 || a > 30
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

/* -------------------- PUAN TABLOSU -------------------- */

function pointsFor(m, p) {
  if (!hasResult(m) || !p) return 0;

  if (p.home === m.homeScore && p.away === m.awayScore) return 3;

  return Math.sign(m.homeScore - m.awayScore) ===
    Math.sign(p.home - p.away) ? 1 : 0;
}

function renderTable() {
  const finished = matches.filter(hasResult);

  const totals = players.map(p => {
    const pts = finished.reduce(
      (sum, m) => sum + pointsFor(m, m.predictions?.[p.id]),
      0
    );

    return {
      ...p,
      pts,
      played: finished.length
    };
  }).sort((a, b) => b.pts - a.pts || a.name.localeCompare(b.name, 'tr'));

  $('leaderboard').innerHTML = totals.length
    ? totals.map((p, i) => `
        <tr>
          <td>${i + 1}</td>
          <td>${safe(p.name)}${p.id === uid ? ' (Sen)' : ''}</td>
          <td>${p.played}</td>
          <td>${p.pts}</td>
        </tr>
      `).join('')
    : '<tr><td colspan="4" class="empty">Henüz oyuncu yok.</td></tr>';
}

/* -------------------- SEKME KONTROLLERİ -------------------- */

document.querySelectorAll('.tab').forEach(button => {
  button.addEventListener('click', () => {
    if (button.dataset.tab === 'admin' && !isAdmin()) return;

    document.querySelectorAll('.tab').forEach(tab => {
      tab.classList.toggle('active', tab === button);
    });

    ['matches', 'table', 'admin'].forEach(tab => {
      $(`${tab}Tab`).classList.toggle('hidden', tab !== button.dataset.tab);
    });
  });
});

/* -------------------- OYUNCU ADI -------------------- */

$('editNameButton').addEventListener('click', () => {
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
    const all = await getDocs(collection(db, 'groups', groupCode, 'players'));

    const duplicate = all.docs.some(d =>
      d.id !== uid &&
      (d.data().name || '').toLowerCase() === newName.toLowerCase()
    );

    if (duplicate) return message(msg, 'Bu oyuncu adı zaten kullanılıyor.');

    await updateDoc(
      doc(db, 'groups', groupCode, 'players', uid),
      { name: newName }
    );

    player.name = newName;
    showApp();
    renderTable();
    $('nameDialog').close();
  } catch (err) {
    console.error(err);
    message(msg, 'İsim değiştirilemedi: ' + err.message);
  }
});

/* -------------------- OTURUMU SIFIRLA -------------------- */

$('leaveButton').addEventListener('click', () => {
  if (confirm('Bu cihazdaki oyuncu oturumunu sıfırlamak istiyor musun?')) {
    localStorage.removeItem('fb_player');
    location.reload();
  }
});

/* -------------------- ZAMAN KONTROLÜ -------------------- */

// Açılış/kapanış saati geldiğinde ekranı kendiliğinden yeniler.
setInterval(() => {
  if (player) renderMatches();
}, 15000);

/* -------------------- UYGULAMAYI ÇALIŞTIR -------------------- */

boot().catch(err => {
  console.error(err);
  message($('entryMessage'), 'HATA: ' + (err.code || err.message || 'Bilinmeyen hata'));
});
