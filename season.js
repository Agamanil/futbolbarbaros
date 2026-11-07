// FUTBOLBARBAROS - 24-26 KASIM 2026 SEZON MODULU
// Mevcut app.js ve style.css dosyalarina dokunmadan calisir.
import { getApp, getApps, initializeApp } from 'https://www.gstatic.com/firebasejs/13.2.0/firebase-app.js';
import { getAuth, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/13.2.0/firebase-auth.js';
import {
  getFirestore, doc, getDoc, setDoc, collection, onSnapshot, serverTimestamp, runTransaction
} from 'https://www.gstatic.com/firebasejs/13.2.0/firebase-firestore.js';
import { firebaseConfig, ADMIN_UID } from './config.js';

const TIME_ZONE = 'Europe/Istanbul';
const SEASON_START = '2026-11-24';
const SEASON_END = '2026-11-26';
const SEASON_DAYS = ['2026-11-24', '2026-11-25', '2026-11-26'];

const $ = id => document.getElementById(id);
const app = getApps().length ? getApp() : initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

let uid = null;
let groupCode = '';
let player = null;
let matches = [];
let players = [];
let bonusSelections = [];
let userProfiles = {};
let avatarGallery = [];
let honorMeta = null;
let honorMembers = [];
let unsubMatches = null;
let unsubPlayers = null;
let unsubBonuses = null;
let unsubHonor = null;
let unsubHonorMembers = null;
let unsubProfiles = null;
let unsubAvatars = null;
let profilesLoaded = false;
let avatarsLoaded = false;
let honorSnapshotCreating = false;
let startingGroup = false;

function toDate(value) {
  if (!value) return null;
  return value?.toDate ? value.toDate() : new Date(value);
}

function dayKey(value = new Date()) {
  const date = toDate(value);
  if (!date || Number.isNaN(date.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE,
    year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(date);
  const part = type => parts.find(item => item.type === type)?.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function shiftDay(key, amount) {
  const [year, month, day] = key.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + amount));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

function safe(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[char]));
}

function hasResult(match) {
  return match?.homeScore !== undefined && match?.homeScore !== null &&
    match?.awayScore !== undefined && match?.awayScore !== null;
}

function seasonMatches() {
  return matches.filter(match => {
    const key = dayKey(match.kickoff);
    return key >= SEASON_START && key <= SEASON_END;
  });
}

function selectedMatchIds() {
  return new Set(
    bonusSelections
      .filter(selection => selection.targetDate >= SEASON_START && selection.targetDate <= SEASON_END)
      .map(selection => selection.matchId)
      .filter(Boolean)
  );
}

function pointsFor(match, prediction, bonusIds) {
  if (!hasResult(match) || !prediction) return 0;
  const exact = Number(prediction.home) === Number(match.homeScore) &&
    Number(prediction.away) === Number(match.awayScore);
  const predictedOutcome = Math.sign(Number(prediction.home) - Number(prediction.away));
  const actualOutcome = Math.sign(Number(match.homeScore) - Number(match.awayScore));
  const base = exact ? 3 : (predictedOutcome === actualOutcome ? 1 : 0);
  return base * (bonusIds.has(match.id) ? 2 : 1);
}

function calculateDaily(date) {
  const dayMatches = seasonMatches().filter(match => dayKey(match.kickoff) === date);
  const completed = dayMatches.length > 0 && dayMatches.every(hasResult);
  const bonusIds = selectedMatchIds();
  const standings = players.map(person => ({
    id: person.id,
    name: person.name || 'Oyuncu',
    points: dayMatches.reduce((total, match) =>
      total + pointsFor(match, match.predictions?.[person.id], bonusIds), 0),
    played: dayMatches.filter(hasResult).length
  })).sort((a, b) => b.points - a.points || a.name.localeCompare(b.name, 'tr'));

  let lastPlayers = [];
  let topPlayers = [];
  if (completed && standings.length) {
    const lowest = Math.min(...standings.map(item => item.points));
    const highest = Math.max(...standings.map(item => item.points));
    lastPlayers = standings.filter(item => item.points === lowest);
    topPlayers = standings.filter(item => item.points === highest);
  }

  return {
    date,
    matches: dayMatches,
    pending: dayMatches.filter(match => !hasResult(match)),
    completed,
    standings,
    lastPlayers,
    topPlayers
  };
}

function calculateSeason() {
  const fixtures = seasonMatches();
  const finished = fixtures.filter(hasResult);
  const bonusIds = selectedMatchIds();
  const rows = players.map(person => ({
    id: person.id,
    name: person.name || 'Oyuncu',
    points: finished.reduce((total, match) =>
      total + pointsFor(match, match.predictions?.[person.id], bonusIds), 0),
    played: finished.length
  })).sort((a, b) => b.points - a.points || a.name.localeCompare(b.name, 'tr'));

  // Son gunun fiksturu gorulmeden sezon erken kapatilmasin.
  const hasFinalDayFixture = fixtures.some(match => dayKey(match.kickoff) === SEASON_END);
  const complete = dayKey() >= SEASON_END && fixtures.length > 0 && hasFinalDayFixture && finished.length === fixtures.length;
  let winners = [];
  let lastPlayers = [];
  if (complete && rows.length) {
    const highest = Math.max(...rows.map(row => row.points));
    const lowest = Math.min(...rows.map(row => row.points));
    winners = rows.filter(row => row.points === highest);
    lastPlayers = rows.filter(row => row.points === lowest);
  }
  return { fixtures, finished, rows, complete, winners, lastPlayers };
}

function formatDay(date) {
  const [year, month, day] = date.split('-');
  return `${day}.${month}.${year}`;
}

function renderDailySummary() {
  const container = $('dailySummary');
  if (!container) return;

  container.innerHTML = SEASON_DAYS.map(date => {
    const result = calculateDaily(date);
    let detail = 'Fikstür bekleniyor';
    let state = 'pending';
    if (result.matches.length) {
      if (!result.completed) {
        detail = `${result.pending.length} maçın sonucu bekleniyor`;
      } else {
        const lastNames = result.lastPlayers.map(person => person.name).join(' / ');
        const topNames = result.topPlayers.map(person => person.name).join(' / ');
        detail = `Günün lideri: ${topNames || '—'}<br>Günün sonuncusu: ${lastNames || '—'}`;
        state = 'done';
      }
    }
    return `<article class="season-day-card ${state}">
      <div class="season-day-date">${formatDay(date)}</div>
      <div class="season-day-count">${result.matches.length} maç</div>
      <div class="season-day-detail">${detail}</div>
    </article>`;
  }).join('');
}

function renderSeasonLeaderboard(season) {
  const body = $('seasonLeaderboard');
  if (!body) return;
  if (!players.length) {
    body.innerHTML = '<tr><td colspan="4">Henüz oyuncu bulunmuyor.</td></tr>';
    return;
  }
  let previousPoints = null;
  let currentRank = 0;
  body.innerHTML = season.rows.map((person, index) => {
    if (person.points !== previousPoints) currentRank = index + 1;
    previousPoints = person.points;
    const self = person.id === uid ? ' <span class="season-you">(Sen)</span>' : '';
    return `<tr>
      <td>${currentRank}</td>
      <td>${safe(person.name)}${self}</td>
      <td>${person.played}/${season.fixtures.length}</td>
      <td><strong>${person.points}</strong></td>
    </tr>`;
  }).join('');
}

function setSvgName(elementId, name) {
  const element = $(elementId);
  if (!element) return;
  element.textContent = name || '?';
  const length = String(name || '?').length;
  const size = length <= 5 ? 13 : Math.max(6, 13 - (length - 5) * 0.48);
  element.setAttribute('font-size', String(size));
}

function honorSeasonId() {
  return `${SEASON_START}_${SEASON_END}`;
}

function snapshotAvatarFor(userId) {
  const avatarId = userProfiles[userId]?.avatarId;
  return avatarGallery.find(item => item.id === avatarId) || null;
}

async function ensureHonorSnapshot(season) {
  if (!uid || uid !== ADMIN_UID || !groupCode || !season.complete ||
      !profilesLoaded || !avatarsLoaded || honorMeta || honorSnapshotCreating) return;

  honorSnapshotCreating = true;
  const seasonId = honorSeasonId();
  const honorRef = doc(db, 'groups', groupCode, 'seasonHonor', seasonId);
  const winners = season.winners || [];
  const lastPlayers = season.lastPlayers || [];
  const all = new Map();

  for (const person of winners) {
    all.set(person.id, { person, roles: ['winner'] });
  }
  for (const person of lastPlayers) {
    const existing = all.get(person.id);
    if (existing) existing.roles.push('last');
    else all.set(person.id, { person, roles: ['last'] });
  }

  const records = [...all.entries()].map(([playerId, entry]) => {
    const avatar = snapshotAvatarFor(playerId);
    return {
      playerId,
      name: entry.person.name || 'Oyuncu',
      roles: entry.roles,
      avatarDataUrl: avatar?.dataUrl || '',
      avatarName: avatar?.name || '',
      savedAt: serverTimestamp()
    };
  });

  try {
    await runTransaction(db, async transaction => {
      const existing = await transaction.get(honorRef);
      if (existing.exists()) return;

      transaction.set(honorRef, {
        seasonId,
        winnerIds: winners.map(person => person.id),
        lastIds: lastPlayers.map(person => person.id),
        memberIds: records.map(record => record.playerId),
        createdAt: serverTimestamp(),
        createdBy: uid
      });

      for (const record of records) {
        const memberRef = doc(honorRef, 'members', record.playerId);
        transaction.set(memberRef, record);
      }
    });
  } catch (error) {
    console.error('Onur Köşesi PP sabitleme hatası:', error);
  } finally {
    honorSnapshotCreating = false;
  }
}

function setHonorAvatar(imageId, textId, record) {
  const image = $(imageId);
  const text = $(textId);
  if (!image || !text) return;

  if (record?.avatarDataUrl) {
    image.setAttribute('href', record.avatarDataUrl);
    image.style.display = '';
    text.textContent = '';
  } else {
    image.setAttribute('href', '');
    image.style.display = 'none';
    text.textContent = record?.name || '?';
  }
}

function renderHonor(season) {
  const status = $('honorStatus');
  const winnerLabel = $('honorWinnerLabel');
  const lastLabel = $('honorLastLabel');
  if (!status || !winnerLabel || !lastLabel) return;

  if (!season.complete || !season.rows.length) {
    setHonorAvatar('winnerHeadImage', 'winnerHeadText', null);
    setHonorAvatar('lastHeadImage', 'lastHeadText', null);
    setSvgName('winnerHeadText', '?');
    setSvgName('lastHeadText', '?');
    winnerLabel.textContent = '?';
    lastLabel.textContent = '?';
    status.textContent = 'Taht ve son sıra, 24–26 Kasım maçlarının bütün sonuçları girilince açılacak.';
    return;
  }

  if (!honorMeta) {
    setHonorAvatar('winnerHeadImage', 'winnerHeadText', null);
    setHonorAvatar('lastHeadImage', 'lastHeadText', null);
    setSvgName('winnerHeadText', '?');
    setSvgName('lastHeadText', '?');
    winnerLabel.textContent = '?';
    lastLabel.textContent = '?';
    status.textContent = 'Sezon tamamlandı. Onur Köşesi fotoğrafları sabitleniyor...';
    return;
  }

  const expected = honorMeta.memberIds || [];
  if (honorMembers.length < expected.length) {
    setHonorAvatar('winnerHeadImage', 'winnerHeadText', null);
    setHonorAvatar('lastHeadImage', 'lastHeadText', null);
    status.textContent = 'Onur Köşesi kayıtları yükleniyor...';
    return;
  }

  const recordById = Object.fromEntries(honorMembers.map(record => [record.playerId, record]));
  const winners = (honorMeta.winnerIds || []).map(id => recordById[id]).filter(Boolean);
  const lastPlayers = (honorMeta.lastIds || []).map(id => recordById[id]).filter(Boolean);
  const winnerNames = winners.map(person => person.name);
  const lastNames = lastPlayers.map(person => person.name);

  const winnerInside = winnerNames.length > 1
    ? `${winnerNames[0]} +${winnerNames.length - 1}`
    : (winnerNames[0] || '?');
  const lastInside = lastNames.length > 1
    ? `${lastNames[0]} +${lastNames.length - 1}`
    : (lastNames[0] || '?');

  setHonorAvatar('winnerHeadImage', 'winnerHeadText', winners.find(person => person.avatarDataUrl) || winners[0]);
  setHonorAvatar('lastHeadImage', 'lastHeadText', lastPlayers.find(person => person.avatarDataUrl) || lastPlayers[0]);
  if (!winners.some(person => person.avatarDataUrl)) setSvgName('winnerHeadText', winnerInside);
  if (!lastPlayers.some(person => person.avatarDataUrl)) setSvgName('lastHeadText', lastInside);

  winnerLabel.textContent = winnerNames.join(' / ') || '?';
  lastLabel.textContent = lastNames.join(' / ') || '?';
  status.textContent = 'SEZON TAMAMLANDI · Fotoğraflar sezon puanları kesinleştiği anda sabitlendi.';
}

function groupedSelections(targetDate) {
  const relevant = bonusSelections.filter(selection => selection.targetDate === targetDate);
  const groups = new Map();
  for (const selection of relevant) {
    if (!groups.has(selection.matchId)) groups.set(selection.matchId, []);
    groups.get(selection.matchId).push(selection);
  }
  return [...groups.entries()].map(([matchId, entries]) => ({ matchId, entries }));
}

function renderSelectedBonuses(targetDate) {
  const container = $('seasonSelectedBonuses');
  if (!container) return;
  const groups = groupedSelections(targetDate);
  if (!groups.length) {
    container.innerHTML = '<p class="season-muted">Bu tarih için henüz bonus maç seçilmedi.</p>';
    return;
  }
  container.innerHTML = groups.map(group => {
    const match = matches.find(item => item.id === group.matchId);
    const first = group.entries[0];
    const home = match?.homeTeam || first.homeTeam || 'Ev sahibi';
    const away = match?.awayTeam || first.awayTeam || 'Deplasman';
    const names = [...new Set(group.entries.map(item => item.playerName || 'Oyuncu'))];
    return `<article class="season-bonus-match">
      <div><strong>${safe(home)} - ${safe(away)}</strong>
      <small>${formatDay(targetDate)} · Seçen: ${names.map(safe).join(', ')}</small></div>
      <span>2X</span>
    </article>`;
  }).join('');
}

function getTodayContext() {
  const today = dayKey();
  const yesterday = shiftDay(today, -1);
  const tomorrow = shiftDay(today, 1);
  const daily = calculateDaily(today);
  const myTodaySelection = bonusSelections.find(item => item.uid === uid && item.selectionDay === today);
  const myYesterdaySelection = bonusSelections.find(item => item.uid === uid && item.selectionDay === yesterday);
  const isLastPlace = daily.lastPlayers.some(item => item.id === uid);
  const nextDayMatches = matches.filter(match =>
    dayKey(match.kickoff) === tomorrow &&
    !hasResult(match) &&
    toDate(match.kickoff)?.getTime() > Date.now()
  );
  return { today, yesterday, tomorrow, daily, myTodaySelection, myYesterdaySelection, isLastPlace, nextDayMatches };
}

function renderBonusControls() {
  const status = $('seasonBonusStatus');
  const choices = $('seasonBonusChoices');
  if (!status || !choices) return;
  choices.innerHTML = '';
  const today = dayKey();

  if (today < SEASON_START) {
    status.textContent = `Sezon ${formatDay(SEASON_START)} tarihinde başlayacak. İlk bonus hakkı 24 Kasım maçları tamamlandıktan sonra açılacak.`;
    return;
  }
  if (today > SEASON_END) {
    status.textContent = 'Sezon dönemi sona erdi. Yeni bonus maç seçimi yapılamaz.';
    return;
  }
  if (today === SEASON_END) {
    status.textContent = '26 Kasım sezonun son günü. Bu gün için yeni bonus seçimi verilmeyecek.';
    return;
  }

  const context = getTodayContext();
  if (!context.daily.matches.length) {
    status.textContent = 'Bugünün fikstürü henüz eklenmemiş.';
    return;
  }
  if (!context.daily.completed) {
    status.textContent = `Bugünün bütün maç sonuçları girilince sonuncular belirlenecek. Bekleyen sonuç: ${context.daily.pending.length}.`;
    return;
  }
  if (context.myTodaySelection) {
    status.textContent = `Seçimini yaptın: ${context.myTodaySelection.homeTeam} - ${context.myTodaySelection.awayTeam}. Bugün ikinci seçim yapamazsın.`;
    return;
  }
  if (!context.isLastPlace) {
    const names = context.daily.lastPlayers.map(person => person.name).join(', ');
    status.textContent = `Bugünün sonuncuları: ${names || '—'}. Seçim hakkı şu an sende değil.`;
    return;
  }
  if (context.myYesterdaySelection) {
    status.textContent = 'Dün bonus maç seçtiğin için bugün yeniden seçim yapamazsın.';
    return;
  }
  if (!context.nextDayMatches.length) {
    status.textContent = 'Yarın için henüz seçilebilir maç yok. Yarınki maçlar eklenince seçim burada görünecek.';
    return;
  }

  status.textContent = 'Sonuncular arasındasın. Yarın oynanacak maçlardan birini seçebilirsin. Seçilen maçta doğru tahmin yapan herkes 2 kat puan alır.';
  choices.innerHTML = context.nextDayMatches.map(match => `
    <article class="season-choice-card">
      <div><small>${safe(match.competition || 'FUTBOL')} · ${safe(new Date(toDate(match.kickoff)).toLocaleString('tr-TR', { dateStyle: 'medium', timeStyle: 'short', timeZone: TIME_ZONE }))}</small>
      <strong>${safe(match.homeTeam)} - ${safe(match.awayTeam)}</strong></div>
      <button class="season-select-btn" type="button" data-season-bonus-match="${safe(match.id)}">Bonus seç</button>
    </article>`).join('');

  choices.querySelectorAll('[data-season-bonus-match]').forEach(button => {
    button.addEventListener('click', () => selectBonusMatch(button.dataset.seasonBonusMatch));
  });
}

async function selectBonusMatch(matchId) {
  const context = getTodayContext();
  const match = matches.find(item => item.id === matchId);
  if (!match) return alert('Maç bulunamadı. Sayfayı yenileyip tekrar dene.');
  if (context.today < SEASON_START || context.today >= SEASON_END) return alert('Bu tarihte bonus seçimi yapılamaz.');
  if (!context.daily.completed) return alert('Bugünün tüm maç sonuçları girilmeden seçim yapılamaz.');
  if (!context.isLastPlace) return alert('Bu ligde bugünün sonuncuları arasında değilsin.');
  if (context.myTodaySelection) return alert('Bugün zaten seçim yaptın.');
  if (context.myYesterdaySelection) return alert('Dün seçim yaptığın için bugün yeniden seçim yapamazsın.');
  if (dayKey(match.kickoff) !== context.tomorrow || hasResult(match) || toDate(match.kickoff).getTime() <= Date.now()) {
    return alert('Yalnızca yarın oynanacak ve henüz başlamamış bir maçı seçebilirsin.');
  }

  const selectionId = `${context.today}_${uid}`;
  const selectionRef = doc(db, 'groups', groupCode, 'bonusSelections', selectionId);
  const yesterdayRef = doc(db, 'groups', groupCode, 'bonusSelections', `${context.yesterday}_${uid}`);
  const matchRef = doc(db, 'groups', groupCode, 'matches', matchId);
  try {
    const [existing, yesterday, latestMatch] = await Promise.all([
      getDoc(selectionRef), getDoc(yesterdayRef), getDoc(matchRef)
    ]);
    if (existing.exists()) return alert('Bugün zaten bonus maç seçmişsin.');
    if (yesterday.exists()) return alert('Dün seçim yaptığın için bugün seçim yapamazsın.');
    if (!latestMatch.exists()) return alert('Maç artık bulunamıyor.');
    const latest = latestMatch.data();
    if (!latest.kickoff || dayKey(latest.kickoff) !== context.tomorrow ||
        hasResult(latest) || toDate(latest.kickoff).getTime() <= Date.now()) {
      return alert('Bu maç için seçim süresi sona ermiş.');
    }

    await setDoc(selectionRef, {
      uid,
      playerName: player?.name || 'Oyuncu',
      matchId,
      homeTeam: latest.homeTeam,
      awayTeam: latest.awayTeam,
      selectionDay: context.today,
      targetDate: context.tomorrow,
      selectedAt: serverTimestamp()
    });
    alert(`${latest.homeTeam} - ${latest.awayTeam} bonus maç olarak seçildi.`);
  } catch (error) {
    console.error('Sezon bonus seçimi:', error);
    alert('Bonus maç kaydedilemedi: ' + (error.message || error));
  }
}

function renderAll() {
  const season = calculateSeason();
  renderDailySummary();
  renderSeasonLeaderboard(season);
  renderHonor(season);
  ensureHonorSnapshot(season);
  renderBonusControls();
  renderSelectedBonuses(dayKey());
  const status = $('seasonStatus');
  if (status) {
    if (season.complete) {
      status.textContent = 'Sezon tamamlandı. 24–26 Kasım arasındaki bütün maçların sonuçları girildi.';
    } else if (dayKey() < SEASON_START) {
      status.textContent = 'Sezon 24 Kasım 2026 tarihinde başlayacak. Bu tablo yalnızca 24–26 Kasım maçlarını sayar.';
    } else {
      const pending = season.fixtures.filter(match => !hasResult(match)).length;
      status.textContent = `${formatDay(SEASON_START)} – ${formatDay(SEASON_END)} · ${season.finished.length}/${season.fixtures.length} maçın sonucu girildi. Sezon bütün sonuçlar girilince tamamlanır.`;
    }
  }
}

function stopListeners() {
  if (unsubMatches) unsubMatches();
  if (unsubPlayers) unsubPlayers();
  if (unsubBonuses) unsubBonuses();
  if (unsubHonor) unsubHonor();
  if (unsubHonorMembers) unsubHonorMembers();
  unsubMatches = unsubPlayers = unsubBonuses = unsubHonor = unsubHonorMembers = null;
}

async function attachLeague(code) {
  if (!uid || !code || code === groupCode || startingGroup) return;
  startingGroup = true;
  stopListeners();
  groupCode = code;
  matches = [];
  players = [];
  bonusSelections = [];
  honorMeta = null;
  honorMembers = [];
  player = null;
  renderAll();
  try {
    const playerSnap = await getDoc(doc(db, 'groups', code, 'players', uid));
    if (!playerSnap.exists()) {
      groupCode = '';
      return;
    }
    player = { ...playerSnap.data(), uid };
    unsubMatches = onSnapshot(collection(db, 'groups', code, 'matches'), snapshot => {
      matches = snapshot.docs.map(item => ({ id: item.id, ...item.data() }));
      renderAll();
    }, error => console.error('Sezon maçları okunamadı:', error));
    unsubPlayers = onSnapshot(collection(db, 'groups', code, 'players'), snapshot => {
      players = snapshot.docs.map(item => ({ id: item.id, ...item.data() }));
      renderAll();
    }, error => console.error('Sezon oyuncuları okunamadı:', error));
    unsubBonuses = onSnapshot(collection(db, 'groups', code, 'bonusSelections'), snapshot => {
      bonusSelections = snapshot.docs.map(item => ({ id: item.id, ...item.data() }));
      renderAll();
    }, error => {
      console.error('Sezon bonus seçimleri okunamadı:', error);
      const status = $('seasonBonusStatus');
      if (status) status.textContent = 'Bonus kayıtları okunamadı. Firestore Rules dosyasını güncelle.';
    });
    const honorRef = doc(db, 'groups', code, 'seasonHonor', honorSeasonId());
    unsubHonor = onSnapshot(honorRef, snapshot => {
      honorMeta = snapshot.exists() ? snapshot.data() : null;
      if (unsubHonorMembers) {
        unsubHonorMembers();
        unsubHonorMembers = null;
      }
      honorMembers = [];
      if (snapshot.exists()) {
        unsubHonorMembers = onSnapshot(collection(honorRef, 'members'), memberSnapshot => {
          honorMembers = memberSnapshot.docs.map(item => ({ playerId: item.id, ...item.data() }));
          renderAll();
        }, error => console.error('Onur Köşesi fotoğrafları okunamadı:', error));
      }
      renderAll();
    }, error => console.error('Onur Köşesi kaydı okunamadı:', error));
  } catch (error) {
    console.error('Sezon ligi açılamadı:', error);
    const status = $('seasonStatus');
    if (status) status.textContent = 'Sezon verileri yüklenemedi: ' + (error.message || error);
  } finally {
    startingGroup = false;
    const selectedCode = $('leagueSelect')?.value || '';
    if (uid && selectedCode && selectedCode !== groupCode) {
      setTimeout(tryAttachCurrentLeague, 0);
    }
  }
}

onAuthStateChanged(auth, user => {
  if (unsubProfiles) unsubProfiles();
  if (unsubAvatars) unsubAvatars();
  profilesLoaded = false;
  avatarsLoaded = false;
  userProfiles = {};
  avatarGallery = [];
  uid = user?.uid || null;
  if (!uid) {
    stopListeners();
    groupCode = '';
    return;
  }

  unsubProfiles = onSnapshot(collection(db, 'users'), snapshot => {
    userProfiles = Object.fromEntries(snapshot.docs.map(item => [item.id, item.data()]));
    profilesLoaded = true;
    renderAll();
  }, error => console.error('Profil fotoğrafları okunamadı:', error));

  unsubAvatars = onSnapshot(collection(db, 'avatars'), snapshot => {
    avatarGallery = snapshot.docs.map(item => ({ id: item.id, ...item.data() }));
    avatarsLoaded = true;
    renderAll();
  }, error => console.error('Avatar galerisi okunamadı:', error));

  tryAttachCurrentLeague();
});

function tryAttachCurrentLeague() {
  const select = $('leagueSelect');
  const appView = $('appView');
  if (!uid || !select || !select.value || !appView || appView.classList.contains('hidden')) return;
  attachLeague(select.value);
}

const leagueSelect = $('leagueSelect');
if (leagueSelect) leagueSelect.addEventListener('change', () => {
  // app.js de ayni olayi dinler; bu modul secilen ligi bagimsiz izler.
  const code = leagueSelect.value;
  if (code) attachLeague(code);
});

// app.js giris ve lig secimini asenkron tamamladigi icin ilk acilisi da yakala.
const initPoll = setInterval(() => {
  if (uid && $('leagueSelect')?.value && !$('appView')?.classList.contains('hidden')) {
    tryAttachCurrentLeague();
    if (groupCode) clearInterval(initPoll);
  }
}, 500);

// Sekme degistirilince hesaplar guncel kalir; normal veri akisi onSnapshot ile izlenir.
window.addEventListener('focus', renderAll);
