
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
  { code: 'uefa.nations', names: ['nations league', 'uluslar ligi'] }
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
  return new Date(value).getTime();
}

function parseScore(value) {
  const number = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(number) && number >= 0 ? number : null;
}

function extractKeyEvents(competitions, data, home, away) {
  const detailLists = [
    ...competitions.map(item => item?.details),
    data?.keyEvents,
    data?.keyevents,
    ...(Array.isArray(data?.events)
      ? data.events.flatMap(item => (item?.competitions || []).map(comp => comp?.details))
      : [])
  ].filter(Array.isArray);

  // Summary farklı bölümlerde aynı olayı tekrarlayabilir.
  // Tüm listeleri birleştirip aşağıda kararlı anahtarla tekilleştiriyoruz.
  const details = detailLists.flat();
  const homeId = String(home?.team?.id || home?.id || '');
  const awayId = String(away?.team?.id || away?.id || '');
  const events = [];
  const seen = new Set();

  for (const detail of details) {
    if (!detail || detail.shootout === true) continue;

    const typeId = String(detail.type?.id || '');
    const typeText = normalize(detail.type?.text || '');
    const isSecondYellow = typeText.includes('second yellow') || typeText.includes('second caution');
    const isRedCard = detail.redCard === true || typeId === '95'
      || typeText.includes('red card') || isSecondYellow;
    const isGoal = detail.scoringPlay === true
      || ['70', '71', '72'].includes(typeId)
      || typeText.includes('goal');

    if (!isRedCard && !isGoal) continue;

    const kind = isRedCard
      ? 'redCard'
      : detail.ownGoal
        ? 'ownGoal'
        : detail.penaltyKick
          ? 'penaltyGoal'
          : 'goal';

    const athlete = Array.isArray(detail.athletesInvolved) ? detail.athletesInvolved[0] : null;
    const player = String(athlete?.displayName || athlete?.fullName || athlete?.shortName || '');
    const minute = String(
      detail.clock?.displayValue || detail.time?.displayValue || detail.displayClock || ''
    );
    const teamId = String(detail.team?.id || detail.teamId || '');
    const side = teamId && teamId === homeId
      ? 'home'
      : teamId && teamId === awayId
        ? 'away'
        : null;
    const teamName = String(detail.team?.displayName || detail.team?.name || '');
    const key = String(detail.id || [kind, minute, player, teamId || teamName].join('|'));

    if (seen.has(key)) continue;
    seen.add(key);

    events.push({ key, kind, minute, player, side, teamId, teamName });
  }

  return events;
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

  const competition = competitions.find(item =>
    Array.isArray(item?.competitors) && item.competitors.length >= 2
  );
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
    awayScore: parseScore(away.score),
    keyEvents: extractKeyEvents(competitions, data, home, away)
  };
}

async function fetchJson(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'FUTBOLBARBAROS-live-score/1.0',
        'Accept': 'application/json'
      }
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

  if (Array.isArray(event.keyEvents) && event.keyEvents.length > 0) {
    update.espnKeyEvents = event.keyEvents;
    update.espnKeyEventsUpdatedAt = admin.firestore.FieldValue.serverTimestamp();
  }

  if (event.state === 'in' && event.homeScore !== null && event.awayScore !== null) {
    update.liveHomeScore = event.homeScore;
    update.liveAwayScore = event.awayScore;
  }

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

  if (!rawCredentials) {
    throw new Error('FIREBASE_SERVICE_ACCOUNT GitHub Secret tanımlı değil.');
  }

  const credentials = JSON.parse(rawCredentials);

  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert(credentials)
    });
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

      if (!Number.isFinite(kickoffMs) || kickoffMs < minTime || kickoffMs > maxTime) {
        continue;
      }

      checked++;

      const event = await fetchEvent(
        String(match.espnId),
        match.competition,
        match.espnLeagueCode
      );

      if (!event) {
        skipped++;
        console.log(
          `EŞLEŞME BULUNAMADI: ${groupDoc.id}/${matchDoc.id} ESPN=${match.espnId}`
        );
        continue;
      }

      if (event.homeScore === null || event.awayScore === null) {
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

      console.log(
        `${groupDoc.id} | ${match.homeTeam || '?'} ${event.homeScore}-${event.awayScore} ${match.awayTeam || '?'} | ${event.state}${event.completed ? ' FINAL' : ''} | ESPN ${match.espnId}`
      );
    }
  }

  console.log('--- FUTBOLBARBAROS ESPN ÖZET ---');
  console.log(
    `Grup: ${groupsSnapshot.size} | Kontrol edilen maç: ${checked} | Güncellenen: ${updated} | Biten: ${finished} | Eşleşmeyen/atlanan: ${skipped}`
  );
}

main().catch(error => {
  console.error('CANLI SKOR MOTORU HATASI:', error);
  process.exitCode = 1;
});
