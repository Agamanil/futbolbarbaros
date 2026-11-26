// Pure daily bonus scoring shared by the browser and Cloudflare Workers.
export const TIME_ZONE = 'Europe/Istanbul';

export function toDate(value) {
  if (!value) return null;
  const result = value?.toDate ? value.toDate() : new Date(value);
  return Number.isNaN(result.getTime()) ? null : result;
}

export function dayKey(value = new Date()) {
  const date = toDate(value);
  if (!date) return '';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(date);
  const part = type => parts.find(item => item.type === type)?.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

export function shiftDayKey(value, amount) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '') || !Number.isInteger(amount)) return '';
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) return '';
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

function validDayKey(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    shiftDayKey(value, 0) === value;
}

function timestampMillis(value) {
  const date = toDate(value);
  return date ? date.getTime() : NaN;
}

/**
 * Validate one bonus document against the authoritative local match, player,
 * and season documents. Legacy normal records without earnedDate/seasonId are
 * normalized from their existing selectionDay and target match where possible.
 */
export function validateBonusSelection(selection, {
  matches = [], players = [], seasons = [], now = Date.now(), adminUid = ''
} = {}) {
  if (!selection || typeof selection !== 'object' || Array.isArray(selection)) return null;
  const uid = selection.uid;
  const selectionDay = selection.selectionDay;
  const targetDate = selection.targetDate;
  const selectionId = selection.id;
  if (typeof uid !== 'string' || !uid || !validDayKey(selectionDay) ||
      !validDayKey(targetDate) || !validDayKey(selection.earnedDate || selectionDay) ||
      typeof selectionId !== 'string') return null;

  const manual = selection.manual === true;
  const expectedId = manual ? `${selectionDay}_MANUAL_ADMIN` : `${selectionDay}_${uid}`;
  if (selectionId !== expectedId ||
      (manual && (!selection.manualBy || typeof selection.manualBy !== 'string' ||
        (adminUid && selection.manualBy !== adminUid))) ||
      (!manual && (selection.manual === true || selection.manualBy !== undefined))) return null;

  const selectedAtMs = timestampMillis(selection.selectedAt);
  if (!Number.isFinite(selectedAtMs) || selectedAtMs > now ||
      dayKey(new Date(selectedAtMs)) !== selectionDay) return null;
  const earnedDate = selection.earnedDate || selectionDay;
  if (!validDayKey(earnedDate) || earnedDate > selectionDay) return null;
  const earnedDays = (Date.parse(`${selectionDay}T00:00:00Z`) -
    Date.parse(`${earnedDate}T00:00:00Z`)) / 86400000;
  if (!Number.isInteger(earnedDays) || earnedDays < 0 || earnedDays > 2) return null;

  const match = matches.find(item => item && item.id === selection.matchId);
  const player = players.find(item => item && item.id === uid);
  const kickoffMs = timestampMillis(match?.kickoff);
  if (!match || !player || !Number.isFinite(kickoffMs) || selectedAtMs >= kickoffMs ||
      dayKey(new Date(kickoffMs)) !== targetDate ||
      typeof match.homeTeam !== 'string' || !match.homeTeam.trim() ||
      typeof match.awayTeam !== 'string' || !match.awayTeam.trim() ||
      typeof player.name !== 'string' || !player.name.trim() || targetDate < selectionDay) return null;

  let season = null;
  if (typeof selection.seasonId === 'string' && selection.seasonId) {
    season = seasons.find(item => item?.id === selection.seasonId) || null;
    if (!season) return null;
  } else {
    const candidates = seasons.filter(item => item?.startDate && item?.endDate &&
      targetDate >= item.startDate && targetDate <= item.endDate &&
      (!match.seasonId || match.seasonId === item.id));
    if (candidates.length !== 1) return null;
    [season] = candidates;
  }
  if (!season || season.bonusEnabled !== true ||
      !season.startDate || !season.endDate ||
      targetDate < season.startDate || targetDate > season.endDate ||
      earnedDate < season.startDate || earnedDate > season.endDate ||
      (match.seasonId && match.seasonId !== season.id)) return null;

  return {
    ...selection,
    id: selectionId,
    uid,
    selectionDay,
    earnedDate,
    targetDate,
    seasonId: season.id,
    matchId: match.id,
    playerName: player.name,
    homeTeam: match.homeTeam,
    awayTeam: match.awayTeam,
    selectedAtMs,
    match,
    player,
    season
  };
}

/** Return unique, structurally valid selections in selection-time order. */
export function validateBonusSelections(selections, context = {}) {
  const validated = (selections || [])
    .map(item => validateBonusSelection(item, context))
    .filter(Boolean)
    .sort((a, b) => a.selectedAtMs - b.selectedAtMs || a.id.localeCompare(b.id));
  const manualDays = new Set(validated.filter(item => item.manual).map(item => item.selectionDay));
  const normalDays = new Set(validated.filter(item => !item.manual).map(item => item.selectionDay));
  const conflictingDays = new Set([...manualDays].filter(day => normalDays.has(day)));
  const seenIds = new Set();
  const seenPlayerDays = new Set();
  return validated.filter(item => {
    if (conflictingDays.has(item.selectionDay)) return false;
    const playerDay = `${item.selectionDay}:${item.uid}`;
    if (seenIds.has(item.id) || seenPlayerDays.has(playerDay)) return false;
    seenIds.add(item.id);
    seenPlayerDays.add(playerDay);
    return true;
  });
}

export function hasResult(match) {
  // Deliberately mirrors season.js: only null/undefined means no result.
  // Numeric validity is not checked here so existing records keep their behavior.
  return match?.homeScore !== undefined && match?.homeScore !== null &&
    match?.awayScore !== undefined && match?.awayScore !== null;
}

export function seasonMatchesForDay(matches, season, date) {
  if (!season) return [];
  return matches.filter(match => {
    const inSeason = match.seasonId
      ? match.seasonId === season.id
      : dayKey(match.kickoff) >= season.startDate && dayKey(match.kickoff) <= season.endDate;
    return inSeason && dayKey(match.kickoff) === date;
  });
}

export function seasonSelectionMatchIds(selections, season) {
  if (!season) return new Set();
  return new Set(selections.filter(selection => {
    if (selection.seasonId) return selection.seasonId === season.id;
    const target = selection.targetDate || selection.selectionDay || '';
    return target >= season.startDate && target <= season.endDate;
  }).map(selection => selection.matchId).filter(Boolean));
}

export function pointsFor(match, prediction, bonusIds = new Set()) {
  // Number() coercion (including its handling of null, empty strings and bad strings)
  // is intentional compatibility behavior from season.js.
  if (!hasResult(match) || !prediction) return 0;
  const exact = Number(prediction.home) === Number(match.homeScore) &&
    Number(prediction.away) === Number(match.awayScore);
  const predictedOutcome = Math.sign(Number(prediction.home) - Number(prediction.away));
  const actualOutcome = Math.sign(Number(match.homeScore) - Number(match.awayScore));
  const base = exact ? 3 : (predictedOutcome === actualOutcome ? 1 : 0);
  return base * (bonusIds.has(match.id) ? 2 : 1);
}

function valuesOf(events) {
  return events instanceof Map ? events.values() : (events || []);
}

function matchIdSet(matchIds) {
  return matchIds instanceof Set ? matchIds : new Set(matchIds || []);
}

export function riskPointsFor(events, userId, matchIds) {
  if (!userId || !matchIds) return 0;
  const ids = matchIdSet(matchIds);
  let total = 0;
  for (const event of valuesOf(events)) {
    if (!ids.has(event.matchId) || event.status !== 'resolved' || typeof event.outcome !== 'boolean') continue;
    const participation = (event.participants || []).find(item => item.id === userId);
    if (!participation) continue;
    const predictedYes = participation.choice === 'yes';
    total += predictedYes === event.outcome ? Number(event.plusPoints || 0) : Number(event.minusPoints || 0);
  }
  return total;
}

export function riskPendingFor(events, matchIds) {
  if (!matchIds) return 0;
  const ids = matchIdSet(matchIds);
  return [...valuesOf(events)].filter(item => ids.has(item.matchId) && item.status === 'open').length;
}

export function riskFinalizedAtFor(events, matchIds) {
  if (!matchIds) return null;
  const ids = matchIdSet(matchIds);
  const times = [...valuesOf(events)]
    .filter(item => ids.has(item.matchId) && item.status === 'resolved')
    .map(item => toDate(item.resolvedAt)?.getTime())
    .filter(Number.isFinite);
  return times.length ? Math.max(...times) : null;
}

export function calculateDailyAward({
  date, dayMatches, players, bonusIds = new Set(), riskReady = false,
  pendingRisks = 0, riskPoints = () => 0, riskFinalizedAt = null
}) {
  // Inputs are already decoded plain data: matches carry predictions, players carry
  // id/name, bonusIds is a Set of match IDs, and Risk events are supplied through
  // the injected callbacks. Timestamp-like Firestore values may expose toDate().
  const matches = dayMatches || [];
  const dayMatchIds = new Set(matches.map(match => match.id));
  const completed = matches.length > 0 && matches.every(hasResult) && riskReady === true && pendingRisks === 0;
  const allStandings = (players || []).map(person => ({
    id: person.id,
    name: person.name || 'Oyuncu',
    points: matches.reduce((total, match) => total + pointsFor(match, match.predictions?.[person.id], bonusIds), 0) + (riskPoints(person.id, dayMatchIds) || 0),
    played: matches.filter(hasResult).length
  })).sort((a, b) => b.points - a.points || a.name.localeCompare(b.name, 'tr'));

  // AFK is finalized only after all daily matches and Risk events are complete.
  const hasPrediction = person => matches.some(match => Boolean(match.predictions?.[person.id]));
  const afkPlayers = completed ? allStandings.filter(person => !hasPrediction(person)) : [];
  const afkIds = new Set(afkPlayers.map(person => person.id));
  const standings = completed ? allStandings.filter(person => !afkIds.has(person.id)) : allStandings;

  const completionTimes = matches
    .map(match => toDate(match.resultAt)?.getTime() ?? toDate(match.kickoff)?.getTime() ?? null)
    .filter(Number.isFinite);
  if (Number.isFinite(riskFinalizedAt)) completionTimes.push(riskFinalizedAt);
  const completedAtMs = completed && completionTimes.length ? Math.max(...completionTimes) : null;

  let lastPlayers = [];
  let topPlayers = [];
  if (completed && standings.length) {
    const lowest = Math.min(...standings.map(item => item.points));
    const highest = Math.max(...standings.map(item => item.points));
    lastPlayers = standings.filter(item => item.points === lowest);
    topPlayers = standings.filter(item => item.points === highest);
  }
  return {
    date, matches, pending: matches.filter(match => !hasResult(match)), afkPlayers,
    completed, completedAtMs, standings, lastPlayers, topPlayers
  };
}
