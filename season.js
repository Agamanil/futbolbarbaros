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
const BONUS_WINDOW_MS = 48 * 60 * 60 * 1000;

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

function timestampMillis(value) {
  const date = toDate(value);
  return date ? date.getTime() : null;
}

function formatDateTime(value) {
  const date = new Date(value);
  return date.toLocaleString('tr-TR', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: TIME_ZONE
  });
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

// GUNLUK PUAN HESABI - RISK PUAN ENTEGRASYONU
function calculateDaily(date) {
  const dayMatches = seasonMatches().filter(match => dayKey(match.kickoff) === date);
  const dayMatchIds = new Set(dayMatches.map(match => match.id));
  const riskReady = window.FUTBOLBARBAROS_RISK_READY === true;
  const pendingRisks = window.FUTBOLBARBAROS_RISK_PENDING?.(dayMatchIds) || 0;
  const riskPoints = (userId) => window.FUTBOLBARBAROS_RISK_POINTS?.(userId, dayMatchIds) || 0;

  const completed = dayMatches.length > 0
    && dayMatches.every(hasResult)
    && riskReady
    && pendingRisks === 0;

  const bonusIds = selectedMatchIds();

  const standings = players.map(person => ({
    id: person.id,
    name: person.name || 'Oyuncu',
    points: dayMatches.reduce((total, match) =>
      total + pointsFor(match, match.predictions?.[person.id], bonusIds), 0) + riskPoints(person.id),
    played: dayMatches.filter(hasResult).length
  })).sort((a, b) => b.points - a.points || a.name.localeCompare(b.name, 'tr'));

  // Hak süresi, takvim gününün değiştiği andan değil son maç/risk sonucunun
  // Firestore'a kaydedildiği andan itibaren hesaplanır. Eski kayıtlarda
  // resultAt yoksa maç başlangıcı geriye dönük uyumluluk için kullanılır.
  const completionTimes = dayMatches
    .map(match => timestampMillis(match.resultAt) ?? timestampMillis(match.kickoff))
    .filter(value => Number.isFinite(value));

  const riskFinalizedAt = window.FUTBOLBARBAROS_RISK_FINALIZED_AT?.(dayMatchIds);
  if (Number.isFinite(riskFinalizedAt)) completionTimes.push(riskFinalizedAt);

  const completedAtMs = completed && completionTimes.length
    ? Math.max(...completionTimes)
    : null;

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
    completedAtMs,
    standings,
    lastPlayers,
    topPlayers
  };
}

function getActiveDailyAwards() {
  const season = getSelectedSeason();
  if (!season) return [];

  const now = Date.now();

  return seasonDays(season.startDate, season.endDate).map(date => {
    const result = calculateDaily(date);
    if (!result.completed || !Number.isFinite(result.completedAtMs)) return null;

    const expiresAtMs = result.completedAtMs + BONUS_WINDOW_MS;
    if (now < result.completedAtMs || now >= expiresAtMs) return null;

    return { ...result, earnedDate: date, expiresAtMs };
  }).filter(Boolean);
}

function selectionEarnedDate(selection) {
  if (selection?.earnedDate) return selection.earnedDate;
  return selection?.selectionDay ? shiftDay(selection.selectionDay, -1) : '';
}

function hasUsedDailyAward(earnedDate, playerId, selections) {
  return selections.some(selection =>
    selection.uid === playerId && selectionEarnedDate(selection) === earnedDate
  );
}

function manualAwardChoices(context) {
  return context.activeAwards.flatMap(award =>
    award.lastPlayers.map(person => ({
      earnedDate: award.earnedDate,
      expiresAtMs: award.expiresAtMs,
      person
    }))
  ).filter(entry =>
    !hasUsedDailyAward(entry.earnedDate, entry.person.id, context.selections) &&
    !context.selections.some(selection =>
      selection.uid === entry.person.id &&
      [context.today, context.yesterday].includes(selection.selectionDay)
    )
  ).sort((a, b) => a.expiresAtMs - b.expiresAtMs);
}

// SEZON PUAN HESABI - RISK PUAN ENTEGRASYONU
function calculateSeason() {
  const season = getSelectedSeason();

  if (!season) {
    return {
      fixtures: [],
      finished: [],
      rows: [],
      complete: false,
      winners: [],
      lastPlayers: []
    };
  }

  const fixtures = seasonMatches();
  const finished = fixtures.filter(hasResult);
  const fixtureIds = new Set(fixtures.map(match => match.id));

  const riskReady = window.FUTBOLBARBAROS_RISK_READY === true;
  const pendingRisks = window.FUTBOLBARBAROS_RISK_PENDING?.(fixtureIds) || 0;
  const riskPoints = (userId) => window.FUTBOLBARBAROS_RISK_POINTS?.(userId, fixtureIds) || 0;

  const bonusIds = selectedMatchIds();

  const rows = players.map(person => ({
    id: person.id,
    name: person.name || 'Oyuncu',
    points: finished.reduce((total, match) =>
      total + pointsFor(match, match.predictions?.[person.id], bonusIds), 0) + riskPoints(person.id),
    played: finished.length
  })).sort((a, b) => b.points - a.points || a.name.localeCompare(b.name, 'tr'));

  const complete = dayKey() >= season.endDate
    && fixtures.length > 0
    && finished.length === fixtures.length
    && riskReady
    && pendingRisks === 0;

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

  const badgesByPlayer = new Map();
  for (const award of getActiveDailyAwards()) {
    for (const person of award.topPlayers) {
      if (!badgesByPlayer.has(person.id)) badgesByPlayer.set(person.id, []);
      badgesByPlayer.get(person.id).push(
        `<span class="daily-award-badge daily-award-first">🏆 ${formatDay(award.earnedDate)} Günün birincisi</span>`
      );
    }
    for (const person of award.lastPlayers) {
      if (!badgesByPlayer.has(person.id)) badgesByPlayer.set(person.id, []);
      badgesByPlayer.get(person.id).push(
        `<span class="daily-award-badge daily-award-last">🪫 ${formatDay(award.earnedDate)} Günün sonuncusu</span>`
      );
    }
  }

  let previousPoints = null;
  let currentRank = 0;

  body.innerHTML = seasonResult.rows.map((person, index) => {
    if (person.points !== previousPoints) currentRank = index + 1;
    previousPoints = person.points;
    const self = person.id === uid ? ' <span class="season-you">(Sen)</span>' : '';
    const badges = badgesByPlayer.get(person.id) || [];

    return `<tr>
      <td>${currentRank}</td>
      <td>
        <div class="season-player-cell">
          <span class="season-player-name">${safe(person.name)}${self}</span>
          ${badges.length ? `<div class="season-player-badges">${badges.join('')}</div>` : ''}
        </div>
      </td>
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

function renderSelectedBonuses() {
  const container = $('seasonSelectedBonuses');
  if (!container) return;

  const today = dayKey();
  const relevant = seasonSelections()
    .filter(selection => selection.targetDate && selection.targetDate >= today)
    .sort((a, b) => a.targetDate.localeCompare(b.targetDate));

  if (!relevant.length) {
    container.innerHTML = '<p class="season-muted">Henüz seçilmiş yaklaşan bonus maç yok.</p>';
    return;
  }

  const groups = new Map();
  for (const selection of relevant) {
    if (!groups.has(selection.matchId)) groups.set(selection.matchId, []);
    groups.get(selection.matchId).push(selection);
  }

  container.innerHTML = [...groups.entries()].map(([matchId, entries]) => {
    const match = seasonMatches().find(item => item.id === matchId);
    const first = entries[0];
    const home = match?.homeTeam || first.homeTeam || 'Ev sahibi';
    const away = match?.awayTeam || first.awayTeam || 'Deplasman';
    const names = [...new Set(entries.map(item => item.playerName || 'Oyuncu'))];
    const earnedDate = first.earnedDate || selectionEarnedDate(first);

    return `<article class="season-bonus-match">
      <div>
        <strong>${safe(home)} - ${safe(away)}</strong>
        <small>${formatDay(first.targetDate)} · Hakkın kazanıldığı gün: ${formatDay(earnedDate)} · Seçen: ${names.map(safe).join(', ')}</small>
      </div>
      <span>2X</span>
    </article>`;
  }).join('');
}

function getTodayContext() {
  const season = getSelectedSeason();
  const today = dayKey();
  const yesterday = shiftDay(today, -1);
  const selections = seasonSelections();
  const activeAwards = getActiveDailyAwards();

  const myTodaySelection = selections.find(item =>
    item.uid === uid && item.selectionDay === today
  );
  const myYesterdaySelection = selections.find(item =>
    item.uid === uid && item.selectionDay === yesterday
  );
  const manualTodaySelection = selections.find(item =>
    item.manual === true && item.selectionDay === today
  );

  const myAvailableAwards = activeAwards
    .filter(award => award.lastPlayers.some(person => person.id === uid))
    .filter(award => !hasUsedDailyAward(award.earnedDate, uid, selections))
    .sort((a, b) => a.expiresAtMs - b.expiresAtMs);

  const futureMatches = seasonMatches()
    .filter(match => {
      const kickoff = toDate(match.kickoff);
      return kickoff && kickoff.getTime() > Date.now() && !hasResult(match);
    })
    .sort((a, b) => toDate(a.kickoff).getTime() - toDate(b.kickoff).getTime());

  const context = {
    season,
    today,
    yesterday,
    selections,
    activeAwards,
    myTodaySelection,
    myYesterdaySelection,
    manualTodaySelection,
    myAvailableAwards,
    futureMatches,
    daily: calculateDaily(today)
  };

  context.manualAwardChoices = manualAwardChoices(context);
  return context;
}

function renderBonusControls() {
  const status = $('seasonBonusStatus');
  const choices = $('seasonBonusChoices');
  const awardLabel = $('dailyBonusAwardLabel');
  const awardSelect = $('dailyBonusAwardSelect');
  const season = getSelectedSeason();

  if (!status || !choices) return;
  choices.innerHTML = '';
  if (awardLabel) awardLabel.hidden = true;

  if (!season) {
    status.textContent = 'Önce bir sezon oluşturulmalı.';
    return;
  }

  if (!season.bonusEnabled) {
    status.textContent = 'Bu sezonda günlük bonus sistemi kapalı.';
    return;
  }

  if (selectedSeasonId !== activeSeasonId) {
    status.textContent = 'Bonus hakkı yalnızca ligde aktif olan sezonda kullanılabilir.';
    return;
  }

  const context = getTodayContext();

  if (context.myTodaySelection) {
    status.textContent = `Bugünkü bonus hakkını kullandın: ${context.myTodaySelection.homeTeam} - ${context.myTodaySelection.awayTeam}.`;
    return;
  }

  if (context.manualTodaySelection) {
    status.textContent = 'Bugünün bonus maçı yönetici tarafından seçildi. Aynı gün ikinci bir seçim yapılamaz.';
    return;
  }

  if (context.myYesterdaySelection) {
    status.textContent = 'Dün bonus maç seçtiğin için bugün yeniden seçim yapamazsın.';
    return;
  }

  if (!context.myAvailableAwards.length) {
    const alreadyEarned = context.activeAwards.some(award =>
      award.lastPlayers.some(person => person.id === uid)
    );

    if (alreadyEarned) {
      status.textContent = 'Günün sonuncusu olarak kazandığın bonus hakkını zaten kullandın.';
    } else if (context.activeAwards.length) {
      status.textContent = 'Yalnızca günün sonuncusu bonus maç seçebilir.';
    } else {
      status.textContent = 'Henüz son 48 saat içinde kesinleşmiş bir günlük sonuç yok. Günlük maçlar ve etkinlik puanları tamamlanınca birinci ve sonuncu belirlenir.';
    }
    return;
  }

  if (awardLabel && awardSelect) {
    awardLabel.hidden = false;
    awardSelect.innerHTML = context.myAvailableAwards.map(award =>
      `<option value="${safe(award.earnedDate)}">${formatDay(award.earnedDate)} · Son kullanım: ${safe(formatDateTime(award.expiresAtMs))}</option>`
    ).join('');
    awardSelect.value = context.myAvailableAwards[0].earnedDate;
  }

  const selectedAward = context.myAvailableAwards.find(award =>
    award.earnedDate === (awardSelect?.value || context.myAvailableAwards[0].earnedDate)
  ) || context.myAvailableAwards[0];

  if (!context.futureMatches.length) {
    status.textContent = `${formatDay(selectedAward.earnedDate)} gününün sonuncususun. Hakkın ${formatDateTime(selectedAward.expiresAtMs)} tarihine kadar geçerli; henüz başlamamış uygun maç bulunmuyor.`;
    return;
  }

  status.textContent = `${formatDay(selectedAward.earnedDate)} gününün sonuncususun. Bonus hakkın 48 saat geçerli ve ${formatDateTime(selectedAward.expiresAtMs)} tarihine kadar kullanılabilir. Henüz başlamamış bir maç seçebilirsin.`;

  choices.innerHTML = context.futureMatches.map(match => `
    <article class="season-choice-card">
      <div>
        <small>${safe(match.competition || 'FUTBOL')} · ${safe(new Date(toDate(match.kickoff)).toLocaleString('tr-TR', { dateStyle: 'medium', timeStyle: 'short', timeZone: TIME_ZONE }))}</small>
        <strong>${safe(match.homeTeam)} - ${safe(match.awayTeam)}</strong>
      </div>
      <button class="season-select-btn" type="button" data-season-bonus-match="${safe(match.id)}">Bonus seç</button>
    </article>`).join('');

  choices.querySelectorAll('[data-season-bonus-match]').forEach(button => {
    button.addEventListener('click', () => selectBonusMatch(button.dataset.seasonBonusMatch));
  });
}

function renderManualBonusAdmin() {
  const awardSelect = $('manualBonusAwardSelect');
  const matchSelect = $('manualBonusMatchSelect');
  const button = $('manualBonusSelectBtn');
  const status = $('manualBonusAdminStatus');
  if (!awardSelect || !matchSelect || !button || !status) return;

  awardSelect.innerHTML = '';
  matchSelect.innerHTML = '';
  button.disabled = true;

  if (!isAdmin()) {
    status.textContent = 'Bu alan yalnızca yöneticiye açıktır.';
    return;
  }

  const context = getTodayContext();
  if (!context.season || !context.season.bonusEnabled || selectedSeasonId !== activeSeasonId) {
    status.textContent = 'Bonus sistemi açık olan aktif bir sezon seçili olmalı.';
    return;
  }

  if (context.selections.some(item => item.selectionDay === context.today)) {
    status.textContent = 'Bugünün bonus seçimi zaten yapılmış. Aynı gün ikinci seçim yapılamaz.';
    return;
  }

  if (!context.manualAwardChoices.length) {
    status.textContent = 'Son 48 saat içinde yönetici tarafından kullanılabilecek, henüz seçilmemiş bir günlük sonuncu hakkı yok.';
    return;
  }

  if (!context.futureMatches.length) {
    status.textContent = 'Henüz başlamamış uygun bonus maçı bulunmuyor.';
    return;
  }

  awardSelect.innerHTML = context.manualAwardChoices.map(entry =>
    `<option value="${safe(entry.earnedDate + '__' + entry.person.id)}">${formatDay(entry.earnedDate)} · ${safe(entry.person.name)}</option>`
  ).join('');

  matchSelect.innerHTML = context.futureMatches.map(match =>
    `<option value="${safe(match.id)}">${safe(match.homeTeam)} - ${safe(match.awayTeam)} · ${safe(new Date(toDate(match.kickoff)).toLocaleString('tr-TR', { dateStyle: 'short', timeStyle: 'short', timeZone: TIME_ZONE }))}</option>`
  ).join('');

  button.disabled = false;
  status.textContent = 'Hesabına erişilemeyen günün sonuncusu adına, 48 saatlik hakkı dolmadan henüz başlamamış bir maç seçebilirsin.';
}

async function adminSelectBonusMatch() {
  if (!isAdmin()) return alert('Yönetici yetkisi yok.');

  const context = getTodayContext();
  const awardSelect = $('manualBonusAwardSelect');
  const matchSelect = $('manualBonusMatchSelect');
  const button = $('manualBonusSelectBtn');

  if (!context.season || !context.season.bonusEnabled || selectedSeasonId !== activeSeasonId) {
    return alert('Bonus sistemi açık olan aktif sezon bulunamadı.');
  }

  if (context.selections.some(item => item.selectionDay === context.today)) {
    renderManualBonusAdmin();
    return alert('Bugün için bonus maç zaten seçilmiş. İkinci bir seçim yapılamaz.');
  }

  const awardKey = awardSelect?.value || '';
  const splitAt = awardKey.indexOf('__');
  const earnedDate = splitAt > 0 ? awardKey.slice(0, splitAt) : '';
  const playerId = splitAt > 0 ? awardKey.slice(splitAt + 2) : '';
  const awardEntry = context.manualAwardChoices.find(entry =>
    entry.earnedDate === earnedDate && entry.person.id === playerId
  );

  if (!awardEntry) return alert('Seçilen günlük sonuncu hakkı artık geçerli değil.');

  const matchId = matchSelect?.value || '';
  const match = context.futureMatches.find(item => item.id === matchId);
  if (!match) return alert('Henüz başlamamış geçerli bir maç seç.');

  button.disabled = true;
  try {
    const latestRef = doc(db, 'groups', groupCode, 'matches', matchId);
    const latestSnap = await getDoc(latestRef);
    if (!latestSnap.exists()) throw new Error('Maç artık bulunamıyor.');

    const latest = latestSnap.data();
    const kickoff = toDate(latest.kickoff);
    if (!kickoff || kickoff.getTime() <= Date.now() || hasResult(latest)) {
      throw new Error('Bu maç artık seçilebilir değil.');
    }

    const selectionId = `${context.today}_MANUAL_ADMIN`;
    const selectionRef = doc(db, 'groups', groupCode, 'bonusSelections', selectionId);
    const existingSnap = await getDoc(selectionRef);
    if (existingSnap.exists()) throw new Error('Yönetici manuel seçimi zaten kaydedilmiş.');

    await setDoc(selectionRef, {
      uid: awardEntry.person.id,
      playerName: awardEntry.person.name || 'Oyuncu',
      matchId,
      homeTeam: latest.homeTeam,
      awayTeam: latest.awayTeam,
      selectionDay: context.today,
      earnedDate,
      targetDate: dayKey(latest.kickoff),
      seasonId: context.season.id,
      selectedAt: serverTimestamp(),
      manual: true,
      manualBy: uid
    });

    alert(`${latest.homeTeam} - ${latest.awayTeam}, ${awardEntry.person.name} adına bonus maç olarak seçildi.`);
    renderAll();
  } catch (error) {
    console.error('Yönetici manuel bonus seçimi:', error);
    alert('Manuel bonus seçimi kaydedilemedi: ' + (error.message || error));
    button.disabled = false;
  }
}

async function selectBonusMatch(matchId) {
  const context = getTodayContext();
  const season = context.season;
  const selectedAwardDate = $('dailyBonusAwardSelect')?.value || '';
  const award = context.myAvailableAwards.find(item => item.earnedDate === selectedAwardDate);
  const match = context.futureMatches.find(item => item.id === matchId);

  if (!season || !season.bonusEnabled || selectedSeasonId !== activeSeasonId) {
    return alert('Aktif bonus sezonu bulunamadı.');
  }
  if (context.myTodaySelection) return alert('Bugün zaten bonus hakkını kullandın.');
  if (context.manualTodaySelection) return alert('Bugünün bonus maçı yönetici tarafından zaten seçildi.');
  if (context.myYesterdaySelection) return alert('Dün bonus maç seçtiğin için bugün yeniden seçim yapamazsın.');
  if (!award) return alert('Bu günlük bonus hakkı artık geçerli değil veya daha önce kullanılmış.');
  if (!match) return alert('Yalnızca henüz başlamamış bir maç seçebilirsin.');

  const selectionId = `${context.today}_${uid}`;
  const selectionRef = doc(db, 'groups', groupCode, 'bonusSelections', selectionId);
  const yesterdayRef = doc(db, 'groups', groupCode, 'bonusSelections', `${context.yesterday}_${uid}`);
  const matchRef = doc(db, 'groups', groupCode, 'matches', matchId);

  try {
    await runTransaction(db, async transaction => {
      const [existing, yesterday, latestMatch] = await Promise.all([
        transaction.get(selectionRef),
        transaction.get(yesterdayRef),
        transaction.get(matchRef)
      ]);

      if (existing.exists()) throw new Error('Bugün zaten bonus maç seçmişsin.');
      if (yesterday.exists()) throw new Error('Dün bonus maç seçtiğin için bugün yeniden seçim yapamazsın.');
      if (!latestMatch.exists()) throw new Error('Maç artık bulunamıyor.');

      const latest = latestMatch.data();
      const kickoff = toDate(latest.kickoff);
      if (!kickoff || kickoff.getTime() <= Date.now() || hasResult(latest)) {
        throw new Error('Bu maç başlamış veya sonuçlanmış. Başka bir maç seç.');
      }

      transaction.set(selectionRef, {
        uid,
        playerName: player?.name || 'Oyuncu',
        matchId,
        homeTeam: latest.homeTeam,
        awayTeam: latest.awayTeam,
        selectionDay: context.today,
        earnedDate: award.earnedDate,
        targetDate: dayKey(latest.kickoff),
        seasonId: season.id,
        selectedAt: serverTimestamp()
      });
    });

    alert(`${match.homeTeam} - ${match.awayTeam} bonus maç olarak seçildi.`);
    renderAll();
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
  renderManualBonusAdmin();
  renderSelectedBonuses();
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

    await updateDoc(groupRef, {
      activeSeasonId: LEGACY_SEASON_ID,
      activeSeasonUpdatedAt: serverTimestamp()
    });

    return;
  }

  if (!currentActiveId || !existing.docs.some(item => item.id === currentActiveId)) {
    const sorted = existing.docs
      .map(item => ({ id: item.id, ...item.data() }))
      .sort((a, b) => b.startDate.localeCompare(a.startDate));

    if (sorted[0]) {
      await updateDoc(groupRef, {
        activeSeasonId: sorted[0].id,
        activeSeasonUpdatedAt: serverTimestamp()
      });
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

$('manualBonusSelectBtn')?.addEventListener('click', adminSelectBonusMatch);

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

if (leagueSelect) {
  leagueSelect.addEventListener('change', () => {
    const code = leagueSelect.value;
    if (code) attachLeague(code);
  });
}

// app.js anonim oturum ve lig seçimini hazırladıktan sonra ilk grubu bağla.
const initPoll = setInterval(() => {
  if (uid && $('leagueSelect')?.value && !$('appView')?.classList.contains('hidden')) {
    tryAttachCurrentLeague();
    if (groupCode) clearInterval(initPoll);
  }
}, 500);

window.addEventListener('focus', renderAll);
window.addEventListener('fb-risk-updated', renderAll);

setInterval(() => {
  if (groupCode) renderAll();
}, 30000);

// Risk sistemi güncellendiğinde günlük ve sezon tablolarını yeniden çiz.
window.addEventListener('fb-risk-updated', () => renderAll());
