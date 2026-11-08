import admin from 'firebase-admin';

const LEAGUES = [
  { code: 'tur.1', names: ['super lig', 'süper lig', 'turkiye super', 'türkiye süper', 'turkish super'] },
  { code: 'eng.1', names: ['premier league', 'ingiltere premier'] },
  { code: 'esp.1', names: ['la liga', 'ispanya la liga'] },
  { code: 'ger.1', names: ['bundesliga', 'almanya bundesliga'] },
  { code: 'ita.1', names: ['serie a', 'italya serie'] },
  { code: 'uefa.champions', names: ['champions league', 'şampiyonlar ligi', 'sampiyonlar ligi'] },
  { code: 'uefa.europa', names: ['europa league', 'avrupa ligi'] },
  { code: 'uefa.europa.conf', names: ['conference league', 'konferans ligi'] },
  { code: 'uefa.nations', names: ['nations league', 'uluslar ligi', 'uluslar ligi'] }
];

const WINDOW_PAST_HOURS = 8;
const WINDOW_FUTURE_MINUTES = 45;
const TIMEOUT_MS = 15000;

function normalize(value) {
  return String(value || '').toLocaleLowerCase('tr-TR').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function leagueCandidates(competition, savedCode) {
  if (savedCode && LEAGUES.some(x => x.code === savedCode)) return [savedCode];
  const value = normalize(competition);
  const found = LEAGUES.find(league => league.names.some(name => value.includes(normalize(name))));
  if (found) return [found.code];
  return LEAGUES.map(x => x.code);
}

function toMillis(value) {
  if (!value) return NaN;
  if (typeof value.toMillis === 'function') return value.toMillis();
  if (typeof value.toDate === 'function') return value.toDate().getTime();
  const date = new Date(value);
  return date.getTime();
}

function parseScore(value) {
  const number = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(number) && number >= 0 ? number : null;
}

function extractMatch(data, expectedId) {
  const header = data?.header || {};
  const headerId = String(header.id || data?.id || data?.event?.id || '');
  if (headerId && headerId !== String(expectedId)) return null;

  const competitions = [
    ...(Array.isArray(header.competitions) ? header.competitions : []),
    ...(Array.isArray(data?.competitions) ? data.competitions : []),
    ...(Array.isArray(data?.events?.[0]?.competitions) ? data.events[0].competitions : [])
  ];
  const competition = competitions.find(item => Array.isArray(item?.competitors) && item.competitors.length >= 2);
  if (!competition) return null;

  const status = competition.status || data?.status || header.status || {};
  const type = status.type || status;
  const competitors = competition.competitors;
  const home = competitors.find(team => team.homeAway === 'home');
  const away = competitors.find(team => team.homeAway === 'away');
  if (!home || !away) return null;

  return {
    state: String(type.state || status.state || '').toLowerCase(),
    completed: type.completed === true,
    statusText: String(type.detail || type.shortDetail || type.description || status.displayClock || ''),
    clock: String(status.displayClock || type.displayClock || ''),
    period: Number(status.period || 0) || null,
    homeScore: parseScore(home.score),
    awayScore: parseScore(away.score)
  };
}

async function fetchJson(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'FUTBOLBARBAROS-live-score/1.0', 'Accept': 'application/json' }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchEvent(espnId, competition, savedCode) {
  const candidates = leagueCandidates(competition, savedCode);
  for (const league of candidates) {
    const url = `https://site.api.espn.com/apis/site/v2/sports/soccer/${league}/summary?event=${encodeURIComponent(espnId)}`;
    try {
      const data = await fetchJson(url);
      const match = extractMatch(data, espnId);
      if (match) return { ...match, league };
    } catch (error) {
      console.log(`ESPN ${espnId} / ${league}: ${error.message}`);
    }
  }
  return null;
}

async function updateMatch(ref, current, event) {
  const update = {
    espnLeagueCode: event.league,
    espnState: event.state || (event.completed ? 'post' : 'unknown'),
    espnStatus: event.statusText || '',
    espnClock: event.clock || '',
    espnPeriod: event.period,
    espnUpdatedAt: admin.firestore.FieldValue.serverTimestamp()
  };

  if (event.state === 'in' && event.homeScore !== null && event.awayScore !== null) {
    update.liveHomeScore = event.homeScore;
    update.liveAwayScore = event.awayScore;
  }

  // A live score is deliberately NOT written to homeScore/awayScore.
  // The site's existing standings count only these final-result fields.
  if (event.completed && event.homeScore !== null && event.awayScore !== null) {
    update.homeScore = event.homeScore;
    update.awayScore = event.awayScore;
    update.liveHomeScore = event.homeScore;
    update.liveAwayScore = event.awayScore;
    update.espnState = 'post';
    update.espnStatus = event.statusText || 'Final';
    update.scoreSource = 'espn';
    if (current.homeScore === undefined || current.awayScore === undefined) {
      update.resultAt = admin.firestore.FieldValue.serverTimestamp();
    }
  }

  await ref.update(update);
}

async function main() {
  const rawCredentials = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!rawCredentials) throw new Error('FIREBASE_SERVICE_ACCOUNT GitHub Secret tanımlı değil.');

  const credentials = JSON.parse(rawCredentials);
  if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.cert(credentials) });
  }
  const db = admin.firestore();
  const now = Date.now();
  const minTime = now - WINDOW_PAST_HOURS * 60 * 60 * 1000;
  const maxTime = now + WINDOW_FUTURE_MINUTES * 60 * 1000;

  const groupsSnapshot = await db.collection('groups').get();
  let checked = 0;
  let updated = 0;
  let finished = 0;
  let skipped = 0;

  for (const groupDoc of groupsSnapshot.docs) {
    const matchesSnapshot = await groupDoc.ref.collection('matches').get();
    for (const matchDoc of matchesSnapshot.docs) {
      const match = matchDoc.data();
      if (!match.espnId || !/^\d{5,20}$/.test(String(match.espnId))) continue;

      const kickoffMs = toMillis(match.kickoff);
      if (!Number.isFinite(kickoffMs) || kickoffMs < minTime || kickoffMs > maxTime) continue;

      checked++;
      const event = await fetchEvent(String(match.espnId), match.competition, match.espnLeagueCode);
      if (!event) {
        skipped++;
        console.log(`EŞLEŞME BULUNAMADI: ${groupDoc.id}/${matchDoc.id} ESPN=${match.espnId} (${match.competition || 'lig belirtilmemiş'})`);
        continue;
      }

      if (event.homeScore === null || event.awayScore === null) {
        // Pre-match events may not expose numeric scores yet; save only status metadata.
        if (event.state === 'pre') {
          await matchDoc.ref.update({
            espnLeagueCode: event.league,
            espnState: 'pre',
            espnStatus: event.statusText || 'Scheduled',
            espnUpdatedAt: admin.firestore.FieldValue.serverTimestamp()
          });
          updated++;
        } else {
          skipped++;
        }
        continue;
      }

      await updateMatch(matchDoc.ref, match, event);
      updated++;
      if (event.completed) finished++;
      console.log(`${groupDoc.id} | ${match.homeTeam || '?'} ${event.homeScore}-${event.awayScore} ${match.awayTeam || '?'} | ${event.state}${event.completed ? ' FINAL' : ''} | ESPN ${match.espnId}`);
    }
  }

  console.log('--- FUTBOLBARBAROS ESPN ÖZET ---');
  console.log(`Grup: ${groupsSnapshot.size} | Kontrol edilen maç: ${checked} | Güncellenen: ${updated} | Biten: ${finished} | Eşleşmeyen/atlanan: ${skipped}`);
}

main().catch(error => {
  console.error('CANLI SKOR MOTORU HATASI:', error);
  process.exitCode = 1;
});
