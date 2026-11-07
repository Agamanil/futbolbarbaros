// FUTBOLBARBAROS - LIG ICINDE COKLU SEZON YONETIMI
// Sezonlar groups/{groupCode}/seasons altinda tutulur.
// Eski maclar tasinmaz: maclar baslangic/b itis tarihine gore sezona dahil edilir.
import { getApp, getApps, initializeApp } from 'https://www.gstatic.com/firebasejs/13.2.0/firebase-app.js';
import { getAuth, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/13.2.0/firebase-auth.js';
import {
  getFirestore, doc, getDoc, getDocs, setDoc, updateDoc, collection,
  onSnapshot, serverTimestamp, runTransaction, writeBatch
} from 'https://www.gstatic.com/firebasejs/13.2.0/firebase-firestore.js';
import { firebaseConfig, ADMIN_UID } from './config.js';

const TIME_ZONE = 'Europe/Istanbul';
const LEGACY_SEASON_ID = '2026-11-24_2026-11-26';
const LEGACY_SEASON = {
  seasonId: LEGACY_SEASON_ID,
  name: '24–26 Kasım 2026 Sezonu',
  startDate: '2026-11-24',
  endDate: '2026-11-26',
  bonusEnabled: true
};
const MAX_SEASON_DAYS = 60;

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
let seasons = [];
let groupData = {};
let activeSeasonId = '';
let selectedSeasonId = '';
let userProfiles = {};
let avatarGallery = [];
let honorMeta = null;
let honorMembers = [];
let unsubGroup = null;
let unsubSeasons = null;
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
let honorListenerKey = '';

const isAdmin = () => Boolean(uid) && uid === ADMIN_UID;

function toDate(value) {
  if (!value) return null;
  const result = value?.toDate ? value.toDate() : new Date(value);
  return Number.isNaN(result.getTime()) ? null : result;
}

function dayKey(value = new Date()) {
  const date = toDate(value);
  if (!date) return '';
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

function formatDay(date) {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return '—';
  const [year, month, day] = date.split('-');
  return `${day}.${month}.${year}`;
}

function seasonDays(startDate, endDate) {
  const result = [];
  const [sy, sm, sd] = startDate.split('-').map(Number);
  const [ey, em, ed] = endDate.split('-').map(Number);
  const start = Date.UTC(sy, sm - 1, sd);
  const end = Date.UTC(ey, em - 1, ed);
  for (let time = start; time <= end; time += 86400000) {
    const date = new Date(time);
    result.push(`${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`);
  }
  return result;
}

function getSelectedSeason() {
  return seasons.find(item => item.id === selectedSeasonId) || null;
}

function seasonMatches() {
  const season = getSelectedSeason();
  if (!season) return [];
  return matches.filter(match => {
    if (match.seasonId) return match.seasonId === season.id;
    const key = dayKey(match.kickoff);
    return key >= season.startDate && key <= season.endDate;
  });
}

function seasonSelections() {
  const season = getSelectedSeason();
  if (!season) return [];
  return bonusSelections.filter(selection => {
    if (selection.seasonId) return selection.seasonId === season.id;
    const target = selection.targetDate || selection.selectionDay || '';
    return target >= season.startDate && target <= season.endDate;
  });
}

function selectedMatchIds() {
  return new Set(seasonSelections().map(selection => selection.matchId).filter(Boolean));
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
    date, matches: dayMatches, pending: dayMatches.filter(match => !hasResult(match)),
    completed, standings, lastPlayers, topPlayers
  };
}

function calculateSeason() {
  const season = getSelectedSeason();
  if (!season) return { fixtures: [], finished: [], rows: [], complete: false, winners: [], lastPlayers: [] };

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

  const complete = dayKey() >= season.endDate && fixtures.length > 0 && finished.length === fixtures.length;
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

function renderSeasonPicker() {
  const select = $('seasonViewSelect');
  if (!select) return;

  const validSelected = seasons.some(item => item.id === selectedSeasonId);
  if (!validSelected) {
    selectedSeasonId = seasons.some(item => item.id === activeSeasonId)
      ? activeSeasonId
      : (seasons[0]?.id || '');
  }

  select.innerHTML = seasons.length
    ? seasons.map(item => `<option value="${safe(item.id)}">${safe(item.name)}${item.id === activeSeasonId ? ' · AKTİF' : ''}</option>`).join('')
    : '<option value="">Bu ligde henüz sezon yok</option>';
  select.value = selectedSeasonId;
  select.disabled = !seasons.length;
}

function renderDailySummary() {
  const container = $('dailySummary');
  if (!container) return;
  const season = getSelectedSeason();
  if (!season) {
    container.innerHTML = '<p class="season-muted">Görüntülenecek sezon bulunmuyor.</p>';
    return;
  }

  container.innerHTML = seasonDays(season.startDate, season.endDate).map(date => {
    const result = calculateDaily(date);
    let detail = 'Fikstür bekleniyor';
    let state = 'pending';
    if (result.matches.length) {
      if (!result.completed) {
        detail = `${result.pending.length} maçın sonucu bekleniyor`;
      } else {
        const lastNames = result.lastPlayers.map(person => person.name).join(' / ');
        const topNames = result.topPlayers.map(person => person.name).join(' / ');
        detail = `Günün lideri: ${safe(topNames || '—')}<br>Günün sonuncusu: ${safe(lastNames || '—')}`;
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

function renderSeasonLeaderboard(seasonResult) {
  const body = $('seasonLeaderboard');
  if (!body) return;
  if (!getSelectedSeason()) {
    body.innerHTML = '<tr><td colspan="4">Henüz sezon oluşturulmamış.</td></tr>';
    return;
  }
  if (!players.length) {
    body.innerHTML = '<tr><td colspan="4">Henüz oyuncu bulunmuyor.</td></tr>';
    return;
  }
  let previousPoints = null;
  let currentRank = 0;
  body.innerHTML = seasonResult.rows.map((person, index) => {
    if (person.points !== previousPoints) currentRank = index + 1;
    previousPoints = person.points;
    const self = person.id === uid ? ' <span class="season-you">(Sen)</span>' : '';
    return `<tr>
      <td>${currentRank}</td>
      <td>${safe(person.name)}${self}</td>
      <td>${person.played}/${seasonResult.fixtures.length}</td>
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

function snapshotAvatarFor(userId) {
  const avatarId = userProfiles[userId]?.avatarId;
  return avatarGallery.find(item => item.id === avatarId) || null;
}

function syncHonorListener() {
  const season = getSelectedSeason();
  const nextKey = season && groupCode ? `${groupCode}:${season.id}` : '';
  if (nextKey === honorListenerKey) return;

  if (unsubHonor) unsubHonor();
  if (unsubHonorMembers) unsubHonorMembers();
  unsubHonor = unsubHonorMembers = null;
  honorListenerKey = nextKey;
  honorMeta = null;
  honorMembers = [];
  if (!nextKey) return;

  const honorRef = doc(db, 'groups', groupCode, 'seasonHonor', season.id);
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
}

async function ensureHonorSnapshot(seasonResult) {
  const season = getSelectedSeason();
  if (!uid || !isAdmin() || !groupCode || !season || !seasonResult.complete ||
      !profilesLoaded || !avatarsLoaded || honorMeta || honorSnapshotCreating) return;

  honorSnapshotCreating = true;
  const honorRef = doc(db, 'groups', groupCode, 'seasonHonor', season.id);
  const winners = seasonResult.winners || [];
  const lastPlayers = seasonResult.lastPlayers || [];
  const all = new Map();

  for (const person of winners) all.set(person.id, { person, roles: ['winner'] });
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
        seasonId: season.id,
        winnerIds: winners.map(person => person.id),
        lastIds: lastPlayers.map(person => person.id),
        memberIds: records.map(record => record.playerId),
        createdAt: serverTimestamp(),
        createdBy: uid
      });
      for (const record of records) {
        transaction.set(doc(honorRef, 'members', record.playerId), record);
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

function renderHonor(seasonResult) {
  const status = $('honorStatus');
  const winnerLabel = $('honorWinnerLabel');
  const lastLabel = $('honorLastLabel');
  const season = getSelectedSeason();
  if (!status || !winnerLabel || !lastLabel) return;

  if (!season || !seasonResult.complete || !seasonResult.rows.length) {
    setHonorAvatar('winnerHeadImage', 'winnerHeadText', null);
    setHonorAvatar('lastHeadImage', 'lastHeadText', null);
    setSvgName('winnerHeadText', '?');
    setSvgName('lastHeadText', '?');
    winnerLabel.textContent = '?';
    lastLabel.textContent = '?';
    status.textContent = season
      ? `${season.name} tamamlandığında, bütün maç sonuçları girilince açıklanacak.`
      : 'Bir sezon seçildiğinde Onur Köşesi burada görünür.';
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

  const byId = Object.fromEntries(honorMembers.map(record => [record.playerId, record]));
  const winners = (honorMeta.winnerIds || []).map(id => byId[id]).filter(Boolean);
  const lastPlayers = (honorMeta.lastIds || []).map(id => byId[id]).filter(Boolean);
  const winnerNames = winners.map(person => person.name);
  const lastNames = lastPlayers.map(person => person.name);
  const winnerInside = winnerNames.length > 1 ? `${winnerNames[0]} +${winnerNames.length - 1}` : (winnerNames[0] || '?');
  const lastInside = lastNames.length > 1 ? `${lastNames[0]} +${lastNames.length - 1}` : (lastNames[0] || '?');

  setHonorAvatar('winnerHeadImage', 'winnerHeadText', winners.find(person => person.avatarDataUrl) || winners[0]);
  setHonorAvatar('lastHeadImage', 'lastHeadText', lastPlayers.find(person => person.avatarDataUrl) || lastPlayers[0]);
  if (!winners.some(person => person.avatarDataUrl)) setSvgName('winnerHeadText', winnerInside);
  if (!lastPlayers.some(person => person.avatarDataUrl)) setSvgName('lastHeadText', lastInside);
  winnerLabel.textContent = winnerNames.join(' / ') || '?';
  lastLabel.textContent = lastNames.join(' / ') || '?';
  status.textContent = 'SEZON TAMAMLANDI · Fotoğraflar sezon puanları kesinleştiği anda sabitlendi.';
}

function groupedSelections(targetDate) {
  const relevant = seasonSelections().filter(selection => selection.targetDate === targetDate);
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
    const match = seasonMatches().find(item => item.id === group.matchId);
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
  const season = getSelectedSeason();
  const today = dayKey();
  const yesterday = shiftDay(today, -1);
  const tomorrow = shiftDay(today, 1);
  const daily = calculateDaily(today);
  const selections = seasonSelections();
  const myTodaySelection = selections.find(item => item.uid === uid && item.selectionDay === today);
  const myYesterdaySelection = selections.find(item => item.uid === uid && item.selectionDay === yesterday);
  const isLastPlace = daily.lastPlayers.some(item => item.id === uid);
  const nextDayMatches = seasonMatches().filter(match =>
    dayKey(match.kickoff) === tomorrow && !hasResult(match) &&
    toDate(match.kickoff)?.getTime() > Date.now()
  );
  return { season, today, yesterday, tomorrow, daily, myTodaySelection, myYesterdaySelection, isLastPlace, nextDayMatches };
}

function renderBonusControls() {
  const status = $('seasonBonusStatus');
  const choices = $('seasonBonusChoices');
  const season = getSelectedSeason();
  if (!status || !choices) return;
  choices.innerHTML = '';

  if (!season) {
    status.textContent = 'Önce bir sezon oluşturulmalı.';
    return;
  }
  if (!season.bonusEnabled) {
    status.textContent = 'Bu sezonda günlük bonus sistemi kapalı.';
    return;
  }

  const today = dayKey();
  if (selectedSeasonId !== activeSeasonId) {
    status.textContent = 'Bonus seçimi yalnızca ligde aktif olan sezonda yapılabilir.';
    return;
  }
  if (today < season.startDate) {
    status.textContent = `Sezon ${formatDay(season.startDate)} tarihinde başlayacak. İlk bonus hakkı günlük maçların sonuçları girilince açılacak.`;
    return;
  }
  if (today >= season.endDate) {
    status.textContent = 'Sezonun son günündesin veya sezon dönemi sona erdi. Yeni bonus seçimi yapılamaz.';
    return;
  }

  const context = getTodayContext();
  if (!context.daily.matches.length) {
    status.textContent = 'Bugünün bu sezon için fikstürü henüz eklenmemiş.';
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
    status.textContent = 'Yarın için henüz seçilebilir maç yok. Fikstür eklendiğinde seçim burada görünecek.';
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
  const match = seasonMatches().find(item => item.id === matchId);
  const season = context.season;
  if (!season || !season.bonusEnabled || selectedSeasonId !== activeSeasonId) {
    return alert('Aktif bonus sezonu bulunamadı.');
  }
  if (!match) return alert('Maç bulunamadı. Sayfayı yenileyip tekrar dene.');
  if (context.today < season.startDate || context.today >= season.endDate) return alert('Bu tarihte bonus seçimi yapılamaz.');
  if (!context.daily.completed) return alert('Bugünün tüm maç sonuçları girilmeden seçim yapılamaz.');
  if (!context.isLastPlace) return alert('Bu ligde bugünün sonuncuları arasında değilsin.');
  if (context.myTodaySelection) return alert('Bugün zaten seçim yaptın.');
  if (context.myYesterdaySelection) return alert('Dün seçim yaptığın için bugün seçim yapamazsın.');
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
    if (!latest.kickoff || dayKey(latest.kickoff) !== context.tomorrow || hasResult(latest) ||
        toDate(latest.kickoff).getTime() <= Date.now()) {
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
      seasonId: season.id,
      selectedAt: serverTimestamp()
    });
    alert(`${latest.homeTeam} - ${latest.awayTeam} bonus maç olarak seçildi.`);
  } catch (error) {
    console.error('Sezon bonus seçimi:', error);
    alert('Bonus maç kaydedilemedi: ' + (error.message || error));
  }
}

function renderSeasonAdminList() {
  const container = $('seasonAdminList');
  if (!container) return;
  if (!isAdmin()) {
    container.innerHTML = '';
    return;
  }
  if (!seasons.length) {
    container.innerHTML = '<p class="season-muted">Bu ligde henüz sezon oluşturulmamış.</p>';
    return;
  }
  container.innerHTML = seasons.map(season => {
    const active = season.id === activeSeasonId;
    const state = active ? 'AKTİF' : (dayKey() > season.endDate ? 'ARŞİV' : 'PLANLANDI');
    return `<article class="season-admin-row">
      <div class="season-admin-info">
        <strong>${safe(season.name)}</strong>
        <small>${formatDay(season.startDate)} – ${formatDay(season.endDate)} · ${season.bonusEnabled ? 'Bonus açık' : 'Bonus kapalı'} · ${state}</small>
      </div>
      <div class="season-admin-actions">
        <button type="button" class="secondary-btn" data-view-season="${safe(season.id)}">Görüntüle</button>
        ${active ? '<span class="season-active-label">Aktif sezon</span>' : `<button type="button" class="small-btn" data-activate-season="${safe(season.id)}">Aktif yap</button>`}
      </div>
    </article>`;
  }).join('');
}

function renderAll() {
  renderSeasonPicker();
  const season = getSelectedSeason();
  const status = $('seasonStatus');
  const kicker = $('seasonKicker');
  const tableHeading = $('seasonTableHeading');
  const explanation = $('seasonExplanation');
  const seasonResult = calculateSeason();

  if (season) {
    if (kicker) kicker.textContent = `${formatDay(season.startDate)} – ${formatDay(season.endDate)} · SEZON ÖZELİ`;
    if (tableHeading) tableHeading.textContent = `${season.name} · Puan Tablosu`;
    if (explanation) {
      explanation.textContent = `Bu tablo yalnızca ${formatDay(season.startDate)} – ${formatDay(season.endDate)} arasındaki maçları sayar. Genel tablo tüm lig maçlarını içerir. Bonus açıkken seçilen maçta doğru skor 6, doğru sonuç 2 puandır.`;
    }
    if (status) {
      if (seasonResult.complete) {
        status.textContent = `${season.name} tamamlandı. ${seasonResult.finished.length}/${seasonResult.fixtures.length} maçın sonucu girildi.`;
      } else {
        const pending = seasonResult.fixtures.length - seasonResult.finished.length;
        status.textContent = `${formatDay(season.startDate)} – ${formatDay(season.endDate)} · ${seasonResult.finished.length}/${seasonResult.fixtures.length} maçın sonucu girildi. Bekleyen sonuç: ${pending}.`;
      }
    }
  } else {
    if (kicker) kicker.textContent = 'SEZON TANIMLANMADI';
    if (tableHeading) tableHeading.textContent = 'Sezon Puan Tablosu';
    if (explanation) explanation.textContent = 'Sezonlar liglerden bağımsız olarak seçili lig içinde yönetilir. Yönetici bir sezon oluşturduğunda burada görünür.';
    if (status) status.textContent = isAdmin()
      ? 'Bu lig için henüz sezon yok. İlk sezon otomatik olarak tanımlanabilir veya yönetim panelinden yeni sezon açılabilir.'
      : 'Bu lig için henüz sezon tanımlanmamış. Yönetici sezon oluşturduğunda burada görünecek.';
  }

  renderDailySummary();
  renderSeasonLeaderboard(seasonResult);
  renderHonor(seasonResult);
  syncHonorListener();
  ensureHonorSnapshot(seasonResult);
  renderBonusControls();
  renderSelectedBonuses(dayKey());
  renderSeasonAdminList();
}

function stopListeners() {
  for (const unsubscribe of [unsubGroup, unsubSeasons, unsubMatches, unsubPlayers, unsubBonuses, unsubHonor, unsubHonorMembers]) {
    if (unsubscribe) unsubscribe();
  }
  unsubGroup = unsubSeasons = unsubMatches = unsubPlayers = unsubBonuses = unsubHonor = unsubHonorMembers = null;
  honorListenerKey = '';
}

async function ensureInitialSeason(code) {
  if (!isAdmin()) return;
  const seasonCollection = collection(db, 'groups', code, 'seasons');
  const existing = await getDocs(seasonCollection);
  const groupRef = doc(db, 'groups', code);
  const groupSnap = await getDoc(groupRef);
  const currentActiveId = groupSnap.exists() ? groupSnap.data().activeSeasonId : '';

  if (existing.empty) {
    const legacyRef = doc(db, 'groups', code, 'seasons', LEGACY_SEASON_ID);
    await setDoc(legacyRef, {
      ...LEGACY_SEASON,
      createdAt: serverTimestamp(),
      createdBy: uid
    });
    await updateDoc(groupRef, { activeSeasonId: LEGACY_SEASON_ID, activeSeasonUpdatedAt: serverTimestamp() });
    return;
  }

  if (!currentActiveId || !existing.docs.some(item => item.id === currentActiveId)) {
    const sorted = existing.docs
      .map(item => ({ id: item.id, ...item.data() }))
      .sort((a, b) => b.startDate.localeCompare(a.startDate));
    if (sorted[0]) {
      await updateDoc(groupRef, { activeSeasonId: sorted[0].id, activeSeasonUpdatedAt: serverTimestamp() });
    }
  }
}

async function attachLeague(code) {
  if (!uid || !code || (code === groupCode && (unsubGroup || startingGroup)) || startingGroup) return;
  startingGroup = true;
  stopListeners();
  groupCode = code;
  matches = [];
  players = [];
  bonusSelections = [];
  seasons = [];
  groupData = {};
  activeSeasonId = '';
  selectedSeasonId = '';
  player = null;
  honorMeta = null;
  honorMembers = [];
  renderAll();

  try {
    const playerSnap = await getDoc(doc(db, 'groups', code, 'players', uid));
    if (!playerSnap.exists()) {
      groupCode = '';
      return;
    }
    player = { ...playerSnap.data(), uid };
    await ensureInitialSeason(code);

    unsubGroup = onSnapshot(doc(db, 'groups', code), snapshot => {
      groupData = snapshot.exists() ? snapshot.data() : {};
      activeSeasonId = groupData.activeSeasonId || '';
      renderAll();
    }, error => console.error('Lig sezon ayarı okunamadı:', error));

    unsubSeasons = onSnapshot(collection(db, 'groups', code, 'seasons'), snapshot => {
      seasons = snapshot.docs.map(item => ({ id: item.id, ...item.data() }))
        .filter(item => item.startDate && item.endDate)
        .sort((a, b) => a.startDate.localeCompare(b.startDate));
      if (!seasons.some(item => item.id === selectedSeasonId)) {
        selectedSeasonId = seasons.some(item => item.id === activeSeasonId)
          ? activeSeasonId
          : (seasons[0]?.id || '');
      }
      renderAll();
    }, error => console.error('Sezon listesi okunamadı:', error));

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
      const bonusStatus = $('seasonBonusStatus');
      if (bonusStatus) bonusStatus.textContent = 'Bonus kayıtları okunamadı. Firestore Rules dosyasını kontrol et.';
    });
  } catch (error) {
    console.error('Sezon ligi açılamadı:', error);
    if ($('seasonStatus')) $('seasonStatus').textContent = 'Sezon verileri yüklenemedi: ' + (error.message || error);
  } finally {
    startingGroup = false;
    const chosenCode = $('leagueSelect')?.value || '';
    if (uid && chosenCode && chosenCode !== groupCode) setTimeout(tryAttachCurrentLeague, 0);
  }
}

function tryAttachCurrentLeague() {
  const select = $('leagueSelect');
  const appView = $('appView');
  if (!uid || !select || !select.value || !appView || appView.classList.contains('hidden')) return;
  attachLeague(select.value);
}

// Sezon görüntüleme seçimi: yalnızca bu cihazdaki görünümü değiştirir.
$('seasonViewSelect')?.addEventListener('change', event => {
  selectedSeasonId = event.target.value || '';
  renderAll();
});

// Yönetici seçili lig için yeni sezon açar. Tarih aralıkları çakışamaz.
$('seasonCreateForm')?.addEventListener('submit', async event => {
  event.preventDefault();
  const status = $('seasonAdminMessage');
  if (!isAdmin()) return messageSeason(status, 'Yönetici yetkisi yok.');
  if (!groupCode) return messageSeason(status, 'Önce bir lig seç.');

  const name = $('newSeasonName')?.value.trim() || '';
  const startDate = $('newSeasonStart')?.value || '';
  const endDate = $('newSeasonEnd')?.value || '';
  const bonusEnabled = Boolean($('newSeasonBonus')?.checked);

  if (name.length < 2 || name.length > 40) return messageSeason(status, 'Sezon adı 2–40 karakter arasında olmalı.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
    return messageSeason(status, 'Başlangıç ve bitiş tarihlerini seç.');
  }
  if (endDate < startDate) return messageSeason(status, 'Bitiş tarihi başlangıç tarihinden önce olamaz.');
  const durationDays = seasonDays(startDate, endDate).length;
  if (durationDays > MAX_SEASON_DAYS) return messageSeason(status, `Bir sezon en fazla ${MAX_SEASON_DAYS} gün olabilir.`);
  if (bonusEnabled && durationDays < 2) return messageSeason(status, 'Günlük bonus için sezon en az 2 gün sürmeli.');

  const overlap = seasons.find(item => startDate <= item.endDate && endDate >= item.startDate);
  if (overlap) return messageSeason(status, `Tarih aralığı “${overlap.name}” sezonuyla çakışıyor. Sezon tarihleri ayrı olmalı.`);

  const seasonId = `${startDate}_${endDate}`;
  const scope = $('seasonTargetScope')?.value || 'current';
  const button = event.target.querySelector('button[type="submit"]');
  if (button) button.disabled = true;
  try {
    let targetGroups = [{ id: groupCode, name: groupData.name || groupCode }];
    if (scope === 'all') {
      const groupSnapshot = await getDocs(collection(db, 'groups'));
      targetGroups = groupSnapshot.docs.map(item => ({ id: item.id, name: item.data().name || item.id }));
    }
    if (!targetGroups.length) throw new Error('İşlem yapılacak lig bulunamadı.');
    if (targetGroups.length * 3 > 450) throw new Error('Toplu işlem güvenli işlem sınırını aşıyor. Ligleri daha küçük gruplar hâlinde güncelle.');

    // Önce bütün liglerin tarih aralıklarını kontrol et; bir ligde çakışma varsa hiçbirine yazma.
    const plans = [];
    for (const target of targetGroups) {
      const snapshot = await getDocs(collection(db, 'groups', target.id, 'seasons'));
      const targetSeasons = snapshot.docs.map(item => ({ id: item.id, ...item.data() }));
      const baseline = snapshot.empty ? [{ ...LEGACY_SEASON, id: LEGACY_SEASON_ID }] : targetSeasons;
      const overlapInTarget = baseline.find(item => startDate <= item.endDate && endDate >= item.startDate);
      if (overlapInTarget) {
        throw new Error(`${target.name} liginde tarih aralığı “${overlapInTarget.name}” sezonuyla çakışıyor. Hiçbir lige yeni kayıt yazılmadı.`);
      }
      if (targetSeasons.some(item => item.id === seasonId)) {
        throw new Error(`${target.name} liginde bu sezon zaten bulunuyor. Hiçbir lige yeni kayıt yazılmadı.`);
      }
      plans.push({ ...target, needsBaseline: snapshot.empty });
    }

    const batch = writeBatch(db);
    const createdAt = serverTimestamp();
    for (const target of plans) {
      const seasonsPath = collection(db, 'groups', target.id, 'seasons');
      if (target.needsBaseline) {
        batch.set(doc(seasonsPath, LEGACY_SEASON_ID), {
          ...LEGACY_SEASON,
          createdAt,
          createdBy: uid
        });
      }
      batch.set(doc(seasonsPath, seasonId), {
        seasonId,
        name,
        startDate,
        endDate,
        bonusEnabled,
        createdAt,
        createdBy: uid
      });
      batch.update(doc(db, 'groups', target.id), {
        activeSeasonId: seasonId,
        activeSeasonUpdatedAt: createdAt
      });
    }
    await batch.commit();

    selectedSeasonId = seasonId;
    event.target.reset();
    if ($('newSeasonBonus')) $('newSeasonBonus').checked = true;
    const targetText = scope === 'all' ? `${plans.length} mevcut ligde` : `${groupCode} liginde`;
    messageSeason(status, `${name} ${targetText} oluşturuldu ve aktif edildi. Eski sezon kayıtları korundu.`, false);
    renderAll();
  } catch (error) {
    console.error('Sezon oluşturma hatası:', error);
    messageSeason(status, 'Sezon oluşturulamadı: ' + (error.message || error));
  } finally {
    if (button) button.disabled = false;
  }
});

function messageSeason(element, text, isError = true) {
  if (!element) return;
  element.textContent = text;
  element.style.color = isError ? 'var(--red)' : 'var(--green)';
}

$('seasonAdminList')?.addEventListener('click', async event => {
  const viewButton = event.target.closest('[data-view-season]');
  const activateButton = event.target.closest('[data-activate-season]');
  if (viewButton) {
    selectedSeasonId = viewButton.dataset.viewSeason;
    renderAll();
    return;
  }
  if (!activateButton) return;
  if (!isAdmin()) return alert('Yönetici yetkisi yok.');
  const seasonId = activateButton.dataset.activateSeason;
  if (!seasons.some(item => item.id === seasonId)) return alert('Sezon bulunamadı.');
  activateButton.disabled = true;
  try {
    await updateDoc(doc(db, 'groups', groupCode), {
      activeSeasonId: seasonId,
      activeSeasonUpdatedAt: serverTimestamp()
    });
    selectedSeasonId = seasonId;
    messageSeason($('seasonAdminMessage'), 'Sezon aktif hâle getirildi.', false);
    renderAll();
  } catch (error) {
    console.error('Sezon etkinleştirilemedi:', error);
    messageSeason($('seasonAdminMessage'), 'Sezon etkinleştirilemedi: ' + (error.message || error));
  } finally {
    activateButton.disabled = false;
  }
});

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
    seasons = [];
    selectedSeasonId = '';
    activeSeasonId = '';
    renderAll();
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

const leagueSelect = $('leagueSelect');
if (leagueSelect) leagueSelect.addEventListener('change', () => {
  const code = leagueSelect.value;
  if (code) attachLeague(code);
});

// app.js anonim oturum ve lig seçimini hazırladıktan sonra ilk grubu bağla.
const initPoll = setInterval(() => {
  if (uid && $('leagueSelect')?.value && !$('appView')?.classList.contains('hidden')) {
    tryAttachCurrentLeague();
    if (groupCode) clearInterval(initPoll);
  }
}, 500);

window.addEventListener('focus', renderAll);
setInterval(() => {
  if (groupCode) renderAll();
}, 30000);
