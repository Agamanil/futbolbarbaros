import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const workerPath = path.resolve('cloudflare-worker/worker.js');
const workerRuntimePath = path.resolve(`tests/.worker-gazette-runtime-${process.pid}.mjs`);
const workerRuntimeSource = (await readFile(workerPath, 'utf8'))
  .replace("'./firestore-data.mjs'", `'${pathToFileURL(path.resolve('cloudflare-worker/firestore-data.mjs')).href}'`)
  .replace("'./gazette-core.mjs'", `'${pathToFileURL(path.resolve('cloudflare-worker/gazette-core.mjs')).href}'`);
await writeFile(workerRuntimePath, workerRuntimeSource, 'utf8');
let legacyWorker;
let runMediaAutomationForToken;
try {
  ({ default: legacyWorker, runMediaAutomationForToken } = await import(pathToFileURL(workerRuntimePath).href));
} finally {
  await unlink(workerRuntimePath).catch(() => {});
}

const groupPath = 'groups/LEAGUE';
const today = '2026-11-26';
const yesterday = '2026-11-25';
const now = new Date('2026-11-26T12:00:00Z');
const serviceToken = 'test-worker-token';
const firestoreRoot = '/v1/projects/futbolbarbarosdenemesi/databases/(default)/documents';

function encodeValue(value) {
  if (value === null || value === undefined) return { nullValue: 'NULL_VALUE' };
  if (typeof value === 'string') return { stringValue: value };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (typeof value === 'number') {
    return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  }
  if (Array.isArray(value)) return { arrayValue: { values: value.map(encodeValue) } };
  return { mapValue: { fields: Object.fromEntries(Object.entries(value).map(([key, child]) => [key, encodeValue(child)])) } };
}

function encodeFields(values) {
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, encodeValue(value)]));
}

function decodeValue(value) {
  if (value?.stringValue !== undefined) return value.stringValue;
  if (value?.integerValue !== undefined) return Number(value.integerValue);
  if (value?.doubleValue !== undefined) return Number(value.doubleValue);
  if (value?.booleanValue !== undefined) return value.booleanValue;
  if (value?.timestampValue !== undefined) return value.timestampValue;
  if (value?.nullValue !== undefined) return null;
  if (value?.arrayValue) return (value.arrayValue.values || []).map(decodeValue);
  if (value?.mapValue) return Object.fromEntries(Object.entries(value.mapValue.fields || {}).map(([key, child]) => [key, decodeValue(child)]));
  return null;
}

function decodeFields(fields = {}) {
  return Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, decodeValue(value)]));
}

function resourceName(documentPath) {
  return `projects/futbolbarbarosdenemesi/databases/(default)/documents/${documentPath}`;
}

function createFirestore(t) {
  const documents = new Map();
  let revision = 0;
  let requestCount = 0;
  const nextUpdateTime = () => new Date(Date.parse('2026-11-26T00:00:00.000Z') + ++revision).toISOString();
  let failTimelineCreateCount = 0;

  const rawDocument = (documentPath, fields) => ({
    name: resourceName(documentPath), fields: encodeFields(fields), updateTime: nextUpdateTime()
  });

  const seed = (documentPath, fields) => documents.set(documentPath, rawDocument(documentPath, fields));
  const read = documentPath => {
    const raw = documents.get(documentPath);
    return raw ? decodeFields(raw.fields) : null;
  };
  const list = collectionPath => [...documents.entries()]
    .filter(([documentPath]) => documentPath.startsWith(collectionPath + '/') &&
      !documentPath.slice(collectionPath.length + 1).includes('/'))
    .map(([, raw]) => structuredClone(raw));

  function mergeFields(oldFields = {}, newFields = {}, mask) {
    const merged = structuredClone(oldFields);
    const keys = mask?.length ? mask : Object.keys(newFields);
    for (const key of keys) {
      if (Object.hasOwn(newFields, key)) merged[key] = structuredClone(newFields[key]);
    }
    return merged;
  }

  function applyCommit(writes) {
    for (const write of writes) {
      const targetPath = write.update?.name?.split('/documents/')[1];
      const current = targetPath ? documents.get(targetPath) : null;
      const precondition = write.currentDocument;
      if (precondition?.exists === false && current) return new Response('already exists', { status: 409 });
      if (precondition?.exists === true && !current) return new Response('missing', { status: 404 });
      if (precondition?.updateTime && current?.updateTime !== precondition.updateTime) {
        return new Response('failed precondition', { status: 409 });
      }
    }

    for (const write of writes) {
      const targetPath = write.update?.name?.split('/documents/')[1];
      const current = targetPath ? documents.get(targetPath) : null;
      if (!targetPath) continue;
      const mask = write.updateMask?.fieldPaths;
      const fields = mergeFields(current?.fields || {}, write.update.fields || {}, mask);
      documents.set(targetPath, {
        name: write.update.name,
        fields,
        updateTime: nextUpdateTime()
      });
    }
    return new Response(JSON.stringify({ commitTime: nextUpdateTime() }), { status: 200 });
  }

  const fetch = async (input, options = {}) => {
    requestCount++;
    const url = new URL(input);
    if (url.pathname.endsWith('/documents:commit')) {
      return applyCommit(JSON.parse(options.body || '{}').writes || []);
    }
    if (url.pathname.endsWith(':runQuery')) {
      const body = JSON.parse(options.body || '{}');
      const collectionId = body.structuredQuery?.from?.[0]?.collectionId;
      const parent = decodeURIComponent(url.pathname.slice(firestoreRoot.length + 1, -':runQuery'.length));
      const rows = [...documents.entries()]
        .filter(([documentPath]) => documentPath.startsWith(parent + '/') &&
          documentPath.split('/').at(-2) === collectionId)
        .map(([, raw]) => ({ document: structuredClone(raw) }));
      return new Response(JSON.stringify(rows), { status: 200 });
    }
    if (!url.pathname.startsWith(firestoreRoot)) return new Response('not found', { status: 404 });
    const suffix = decodeURIComponent(url.pathname.slice(firestoreRoot.length)).replace(/^\//, '');
    const method = options.method || 'GET';

    if (method === 'GET' && url.searchParams.has('pageSize')) {
      return new Response(JSON.stringify({ documents: list(suffix) }), { status: 200 });
    }
    if (method === 'GET') {
      const document = documents.get(suffix);
      return document
        ? new Response(JSON.stringify(structuredClone(document)), { status: 200 })
        : new Response('missing', { status: 404 });
    }
    if (method === 'PATCH') {
      const current = documents.get(suffix);
      if (!current) return new Response('missing', { status: 404 });
      const body = JSON.parse(options.body || '{}');
      const fields = mergeFields(current.fields, body.fields || {}, url.searchParams.getAll('updateMask.fieldPaths'));
      documents.set(suffix, { ...current, fields, updateTime: nextUpdateTime() });
      return new Response(JSON.stringify(structuredClone(documents.get(suffix))), { status: 200 });
    }
    if (method === 'POST' && url.searchParams.has('documentId')) {
      if (suffix.endsWith('/seasonTimeline') && failTimelineCreateCount > 0) {
        failTimelineCreateCount--;
        return new Response('simulated timeline failure', { status: 400 });
      }
      const documentPath = suffix + '/' + url.searchParams.get('documentId');
      if (documents.has(documentPath)) return new Response('already exists', { status: 409 });
      const body = JSON.parse(options.body || '{}');
      const created = rawDocument(documentPath, decodeFields(body.fields || {}));
      documents.set(documentPath, created);
      return new Response(JSON.stringify(structuredClone(created)), { status: 200 });
    }
    return new Response('unsupported', { status: 400 });
  };

  t.after(() => { /* The caller owns restoration of global fetch. */ });
  return {
    documents, seed, read, list, fetch,
    get requestCount() { return requestCount; },
    failNextTimelineCreate() { failTimelineCreateCount++; }
  };
}

function fixture(id, kickoff, state = 'post', extra = {}) {
  return {
    id,
    homeTeam: 'İstanbul Kartalları',
    awayTeam: 'Ankara Yıldızları',
    homeScore: 2,
    awayScore: 1,
    kickoff,
    scoreSource: 'espn',
    espnState: state,
    competition: 'Test Ligi',
    predictions: {},
    ...extra
  };
}

function generatedEdition(type, facts) {
  const sourceId = facts.factIds.find(id => id.startsWith('result:'));
  return { editionType: type, sections: sourceId ? [{ sourceId, layout: type === 'amk' ? 'irony' : 'brief' }] : [] };
}

function createEnvironment({ mutateOutput, failAI = false, gateFirstAI, responseOverride } = {}) {
  let aiCalls = 0;
  return {
    env: {
      AI: {
        async run(_model, request) {
          aiCalls++;
          if (gateFirstAI && aiCalls === 1) await gateFirstAI;
          if (failAI) throw new Error('simulated AI failure');
          const prompt = request.messages.find(item => item.role === 'system')?.content || '';
          const type = prompt.match(/editionType "(official|mixed|amk)"/)?.[1];
          const facts = JSON.parse(request.messages.find(item => item.role === 'user')?.content || '{}');
          const output = generatedEdition(type, facts);
          if (mutateOutput) mutateOutput(output, type, facts);
          return responseOverride
            ? responseOverride(output, type, facts)
            : { choices: [{ message: { content: JSON.stringify(output) } }] };
        }
      }
    },
    get aiCalls() { return aiCalls; }
  };
}

function setUp(t, { matches = [], season = false, current = null } = {}) {
  const previousFetch = globalThis.fetch;
  const previousLog = console.log;
  const previousError = console.error;
  const db = createFirestore(t);
  globalThis.fetch = db.fetch;
  console.log = () => {};
  console.error = () => {};
  t.after(() => {
    globalThis.fetch = previousFetch;
    console.log = previousLog;
    console.error = previousError;
  });
  db.seed(groupPath, season ? { activeSeasonId: 'S1' } : {});
  for (const match of matches) db.seed(`${groupPath}/matches/${match.id}`, match);
  if (season) {
    db.seed(`${groupPath}/seasons/S1`, {
      name: '2026 Sezonu', startDate: '2026-11-01', endDate: '2026-11-30', bonusEnabled: true
    });
  }
  if (current) db.seed(`${groupPath}/dailyMedia/current`, current);
  return db;
}

async function run(db, env, at = now) {
  return runMediaAutomationForToken(env, serviceToken, new Date(at));
}

function currentIssue(db) {
  return db.read(`${groupPath}/dailyMedia/current`);
}

test('tamamlanmamış dün, tamamlanmış bugünden önce gelir; hazır günler kronolojik yayımlanır', async t => {
  const yesterdayMatch = fixture('m-yesterday', '2026-11-25T18:00:00Z', 'in');
  const todayMatch = fixture('m-today', '2026-11-26T10:00:00Z');
  const db = setUp(t, { matches: [yesterdayMatch, todayMatch] });
  const ai = createEnvironment();

  await run(db, ai.env);
  assert.equal(ai.aiCalls, 0);
  assert.equal(currentIssue(db), null);

  const yesterdayRaw = db.documents.get(`${groupPath}/matches/m-yesterday`);
  yesterdayRaw.fields.espnState = { stringValue: 'post' };
  await run(db, ai.env);
  assert.equal(currentIssue(db).date, yesterday);
  assert.equal(ai.aiCalls, 3);

  await run(db, ai.env);
  assert.equal(currentIssue(db).date, today);
  assert.equal(ai.aiCalls, 6);
});

test('aynı ligde eşzamanlı tarihler tek kilidi paylaşır; süresi dolan üretim yeniden alınır ve eski Worker yeniyi geri alamaz', async t => {
  const db = setUp(t, { matches: [
    fixture('m-yesterday', '2026-11-25T18:00:00Z'),
    fixture('m-today', '2026-11-26T10:00:00Z')
  ] });
  let releaseFirst;
  let enteredFirst;
  const firstGate = new Promise(resolve => { releaseFirst = resolve; });
  const firstEntered = new Promise(resolve => { enteredFirst = resolve; });
  const firstAI = createEnvironment({ gateFirstAI: firstGate });
  const originalRun = firstAI.env.AI.run.bind(firstAI.env.AI);
  firstAI.env.AI.run = async (...args) => {
    if (firstAI.aiCalls === 0) enteredFirst();
    return originalRun(...args);
  };

  const staleRun = run(db, firstAI.env);
  await firstEntered;
  assert.equal(db.read(`${groupPath}/dailyMedia/generationLock`).date, yesterday);
  assert.equal(db.read(`${groupPath}/dailyMedia/generationLock`).status, 'generating');

  const concurrentAI = createEnvironment();
  await run(db, concurrentAI.env);
  assert.equal(concurrentAI.aiCalls, 0);
  assert.equal(currentIssue(db), null);

  const recoveredAI = createEnvironment();
  await run(db, recoveredAI.env, new Date(now.getTime() + 46 * 60 * 1000));
  assert.equal(recoveredAI.aiCalls, 3);
  assert.equal(currentIssue(db).date, yesterday);

  const newerAI = createEnvironment();
  await run(db, newerAI.env, new Date(now.getTime() + 47 * 60 * 1000));
  assert.equal(currentIssue(db).date, today);

  releaseFirst();
  await staleRun;
  assert.equal(currentIssue(db).date, today);
});

test('elle girilmiş fakat yönetici tarafından tamamlandı diye onaylanmamış skor gazeteyi bekletir', async t => {
  const manualMatch = fixture('manual-unconfirmed', '2026-11-26T09:00:00Z', '', {
    scoreSource: 'manual', espnState: '', manualResultConfirmed: false
  });
  const db = setUp(t, { matches: [manualMatch] });
  const ai = createEnvironment();

  await run(db, ai.env);
  assert.equal(ai.aiCalls, 0);
  assert.equal(currentIssue(db), null);
});

test('eski ESPN post durumu manuel skorun admin onayı olmadan yayımlanmasına yetmez', async t => {
  const manualMatch = fixture('manual-stale-post', '2026-11-26T09:00:00Z', 'post', {
    scoreSource: 'manual', manualResultConfirmed: false,
    manualResultConfirmedBy: '', manualResultConfirmedAt: ''
  });
  const db = setUp(t, { matches: [manualMatch] });
  const ai = createEnvironment();
  await run(db, ai.env);
  assert.equal(ai.aiCalls, 0);
  assert.equal(currentIssue(db), null);
});

test('günün maçında açık Risk kaydı varsa Worker AI çağırmadan yayını bekletir', async t => {
  const db = setUp(t, { matches: [fixture('m-today', '2026-11-26T10:00:00Z')] });
  db.seed(`${groupPath}/matches/m-today/risks/r1`, { status: 'open', question: 'Açık Risk' });
  const ai = createEnvironment();
  await run(db, ai.env);
  assert.equal(ai.aiCalls, 0);
  assert.equal(currentIssue(db), null);
});

test('AI yanıtı beklenirken maç kaynağı değişirse Worker eski skorla yayımlamaz', async t => {
  const db = setUp(t, { matches: [fixture('m-today', '2026-11-26T10:00:00Z')] });
  const ai = createEnvironment();
  const originalRun = ai.env.AI.run.bind(ai.env.AI);
  let changed = false;
  ai.env.AI.run = async (...args) => {
    const result = await originalRun(...args);
    if (!changed) {
      changed = true;
      db.documents.get(`${groupPath}/matches/m-today`).fields.homeScore = { integerValue: '3' };
    }
    return result;
  };
  await run(db, ai.env);
  assert.equal(ai.aiCalls, 3);
  assert.equal(currentIssue(db), null);
  assert.equal(db.read(`${groupPath}/dailyMedia/generationLock`).status, 'error');
});

test('geriye dönük tarama yedi takvim günüyle sınırlıdır', async t => {
  const outsideWindow = fixture('m-old', '2026-11-18T18:00:00Z');
  const db = setUp(t, { matches: [outsideWindow] });
  const ai = createEnvironment();

  await run(db, ai.env);
  assert.equal(ai.aiCalls, 0);
  assert.equal(currentIssue(db), null);
});

test('AI yanıt hatası güvenli varsayılan şablona düşer ve gazete üretimini durdurmaz', async t => {
  const db = setUp(t, { matches: [fixture('m-today', '2026-11-26T10:00:00Z')] });
  const failingAI = createEnvironment({ failAI: true });

  await run(db, failingAI.env);
  assert.equal(currentIssue(db).date, today);
  assert.doesNotMatch(currentIssue(db).payloadJson, /Rashford|undefined/);

  const retryAI = createEnvironment();
  await run(db, retryAI.env, new Date(now.getTime() + 61 * 60 * 1000));
  assert.equal(retryAI.aiCalls, 0);
  assert.equal(currentIssue(db).date, today);
});

test('GLM choices content şeması okunur; bozuk JSON ve eksik choices güvenli fallback kullanır', async t => {
  const db = setUp(t, { matches: [fixture('m-today', '2026-11-26T10:00:00Z')] });
  const valid = createEnvironment();
  await run(db, valid.env);
  assert.equal(currentIssue(db).date, today);
  assert.equal(valid.aiCalls, 3);

  const brokenJsonDb = setUp(t, {
    matches: [fixture('m-today', '2026-11-26T10:00:00Z')],
    current: { date: yesterday, status: 'published', payloadJson: '{}' }
  });
  const brokenJson = createEnvironment({ responseOverride: () => ({ choices: [{ message: { content: '{bad json' } }] }) });
  await run(brokenJsonDb, brokenJson.env);
  assert.equal(currentIssue(brokenJsonDb).date, today);
  assert.equal(brokenJson.aiCalls, 6);

  const missingChoicesDb = setUp(t, {
    matches: [fixture('m-today', '2026-11-26T10:00:00Z', 'post', {
      predictions: { 'test-player': { home: 2, away: 1 } }
    })],
    current: { date: yesterday, status: 'published', payloadJson: '{}' }
  });
  missingChoicesDb.seed(`${groupPath}/players/test-player`, { name: 'Testçi Oyuncu' });
  const missingChoices = createEnvironment({ responseOverride: (_output, type, facts) => ({
    response: JSON.stringify({ editionType: type, sections: [{
      sourceId: facts.factIds.find(id => id.startsWith('daily-player:')),
      layout: 'brief'
    }] })
  }) });
  await run(missingChoicesDb, missingChoices.env);
  assert.equal(currentIssue(missingChoicesDb).date, today);
  const fallbackIssue = JSON.parse(currentIssue(missingChoicesDb).payloadJson);
  assert.equal(fallbackIssue.editions.official.stories[0].factRefs[0], 'result:m-today');
  assert.equal(fallbackIssue.editions.official.stories.length, 3);
  assert.equal(missingChoices.aiCalls, 3);
});

test('kesilmiş AI JSON yanıtı bir kez yeniden denenir ve geçerli yanıt yayımlanır', async t => {
  const db = setUp(t, { matches: [fixture('m-today', '2026-11-26T10:00:00Z')] });
  let responses = 0;
  const ai = createEnvironment({ responseOverride: (output) => {
    responses++;
    return { choices: [{ message: { content: responses === 1
      ? '{"editionType":"official","sections":[{"sourceId":"result:m-today","layout":"brief'
      : JSON.stringify(output) } }] };
  } });

  await run(db, ai.env);

  assert.equal(currentIssue(db).date, today);
  assert.equal(ai.aiCalls, 4);
  assert.equal(responses, 4);
});

test('kesilmiş ilk Firestore groups JSON yanıtı bir kez yeniden okunur', async t => {
  const db = setUp(t, { matches: [fixture('m-today', '2026-11-26T10:00:00Z')] });
  const originalFetch = globalThis.fetch;
  let groupsReads = 0;
  globalThis.fetch = async (input, options) => {
    const url = new URL(input);
    if (url.pathname.endsWith('/documents/groups') && url.searchParams.has('pageSize') && groupsReads++ === 0) {
      return new Response('{"documents":[{"name":"projects/', { status: 200 });
    }
    return originalFetch(input, options);
  };
  const ai = createEnvironment();

  try {
    await run(db, ai.env);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(groupsReads, 2);
  assert.equal(currentIssue(db).date, today);
  assert.equal(ai.aiCalls, 3);
});

test('Firestore istek sayısı Free plan sınırının altında kalır ve Risk aynı ligde toplu okunur', async t => {
  const db = setUp(t, { matches: [fixture('m-today', '2026-11-26T10:00:00Z')] });
  db.seed(`${groupPath}/matches/m-today/risks/r1`, {
    status: 'resolved', outcome: true, plusPoints: 2, minusPoints: -1
  });
  db.seed(`${groupPath}/matches/m-today/risks/r1/participants/player-a`, {
    uid: 'player-a', choice: 'yes'
  });
  const ai = createEnvironment();

  await run(db, ai.env);

  assert.ok(db.requestCount < 50, `Firestore REST request count: ${db.requestCount}`);
  assert.equal(db.requestCount, 19);
  assert.equal(ai.aiCalls, 3);
  assert.equal(JSON.parse(currentIssue(db).payloadJson).editions.official.factRefs[0], 'result:m-today');
});

test('bonus haberi sahte ad ve takım alanlarını profilden ve gerçek maçtan türetir, UID ile eşleşmeyen kimliği eler', async t => {
  const earnedMatch = fixture('m-earned', '2026-11-25T18:00:00Z', 'post', {
    seasonId: 'S1', predictions: {
      'player-a': { home: 2, away: 1 },
      'player-b': { home: 0, away: 1 }
    }
  });
  const match = fixture('m-today', '2026-11-26T10:00:00Z', 'post', { seasonId: 'S1' });
  const db = setUp(t, { matches: [earnedMatch, match], season: true,
    current: { date: yesterday, status: 'published', payloadJson: '{}' } });
  db.seed(`${groupPath}/players/player-a`, { name: 'Doğrulanmış Oyuncu A' });
  db.seed(`${groupPath}/players/player-b`, { name: 'Doğrulanmış Oyuncu B' });
  const selectionDay = '2026-11-25';
  const selectedAt = '2026-11-25T20:30:00Z';
  const selection = (uid, fields = {}, id = `${selectionDay}_${uid}`) => db.seed(
    `${groupPath}/bonusSelections/${id}`,
    {
      uid, selectionDay, targetDate: today, seasonId: 'S1', matchId: 'm-today', selectedAt,
      playerName: 'SAHTE bonus adı', homeTeam: 'Yanlış Ev Sahibi', awayTeam: 'Yanlış Deplasman',
      ...fields
    }
  );
  selection('player-a', { matchId: 'missing-match' });
  selection('player-b', {
    playerName: 'Başka kişiyi göster', homeTeam: 'Sahte takım',
    manual: true, manualBy: 'MUxQ8O20qXa5DzWB7LTMMjilJ0Y2'
  }, `${selectionDay}_MANUAL_ADMIN`);
  selection('player-a', {}, `${selectionDay}_someone-else`);
  const ai = createEnvironment();

  await run(db, ai.env);
  const publishedBonuses = JSON.parse(currentIssue(db).payloadJson).officialData.bonusDecisions;
  assert.equal(publishedBonuses.length, 1);
  assert.deepEqual(publishedBonuses.map(item => item.player), ['Doğrulanmış Oyuncu B']);
  assert.ok(publishedBonuses.every(item => item.match === 'İstanbul Kartalları - Ankara Yıldızları'));
  assert.ok(publishedBonuses.every(item => item.matchId === 'm-today'));
});

test('geçersiz bonus kayıtları Worker sezon puanına, günlük puana veya gazeteye etki etmez; geçerli seçim x2 kalır', async t => {
  const earned = fixture('m-earned', '2026-11-25T18:00:00Z', 'post', {
    seasonId: 'S1', predictions: {
      'player-a': { home: 2, away: 1 },
      'player-b': { home: 0, away: 1 }
    }
  });
  const target = fixture('m-today', '2026-11-26T10:00:00Z', 'post', {
    seasonId: 'S1', predictions: {
      'player-a': { home: 0, away: 1 },
      'player-b': { home: 2, away: 1 },
      'player-c': { home: 2, away: 1 }
    }
  });
  const otherTarget = fixture('m-other', '2026-11-26T11:00:00Z', 'post', {
    seasonId: 'S1', predictions: { 'player-c': { home: 2, away: 1 } }
  });
  const db = setUp(t, { matches: [earned, target, otherTarget], season: true,
    current: { date: yesterday, status: 'published', payloadJson: '{}' } });
  db.seed(`${groupPath}/players/player-a`, { name: 'Oyuncu A' });
  db.seed(`${groupPath}/players/player-b`, { name: 'Oyuncu B' });
  db.seed(`${groupPath}/players/player-c`, { name: 'Oyuncu C' });
  const valid = {
    uid: 'player-b', playerName: 'Sahte ad', matchId: 'm-today',
    homeTeam: 'Sahte ev', awayTeam: 'Sahte deplasman',
    selectionDay: '2026-11-25', earnedDate: '2026-11-25', targetDate: today,
    seasonId: 'S1', selectedAt: '2026-11-25T20:30:00Z'
  };
  db.seed(`${groupPath}/bonusSelections/2026-11-25_player-b`, valid);
  db.seed(`${groupPath}/bonusSelections/2026-11-25_player-a`, { ...valid, uid: 'player-a' });
  db.seed(`${groupPath}/bonusSelections/2026-11-25_missing`, { ...valid, uid: 'missing' });
  db.seed(`${groupPath}/bonusSelections/2026-11-25_wrong-season`, { ...valid, seasonId: 'S2' });
  db.seed(`${groupPath}/bonusSelections/2026-11-25_wrong-match`, { ...valid, matchId: 'not-a-match' });
  db.seed(`${groupPath}/bonusSelections/2026-11-25_player-c`, {
    ...valid, uid: 'player-c', matchId: 'm-other', earnedDate: '2026-11-24'
  });

  const ai = createEnvironment();
  await run(db, ai.env);
  const payload = JSON.parse(currentIssue(db).payloadJson);
  const standings = payload.officialData.leagueTable;
  const daily = payload.playerStandings;
  assert.equal(standings.find(item => item.id === 'player-b').points, 6);
  assert.equal(standings.find(item => item.id === 'player-a').points, 3);
  assert.equal(standings.find(item => item.id === 'player-c').points, 9);
  assert.equal(daily.find(item => item.id === 'player-b').points, 6);
  assert.equal(daily.find(item => item.id === 'player-a').points, 0);
  assert.equal(daily.find(item => item.id === 'player-c').points, 9);
  assert.deepEqual(payload.officialData.bonusDecisions.map(item => item.player), ['Oyuncu B']);
  assert.doesNotMatch(currentIssue(db).payloadJson, /Sahte ad|Sahte ev|Sahte deplasman/);
});

test('ESPN açıklamasındaki doğrulanmamış serbest metin gazete olayına aktarılmaz', async t => {
  const db = setUp(t, { matches: [fixture('m-today', '2026-11-26T10:00:00Z', 'post', {
    espnKeyEvents: [{ kind: 'redCard', minute: '42', description: 'Uydurma olay Rashford atıldı 9-0' }]
  })] });
  const ai = createEnvironment();
  await run(db, ai.env);
  const payload = currentIssue(db).payloadJson;
  assert.match(payload, /Kırmızı kart/);
  assert.doesNotMatch(payload, /Uydurma olay|Rashford atıldı|9-0/);
});

test('eski günün AI yanıtı bozuk olsa da güvenli varsayılanla önce eski gün yayımlanır', async t => {
  const db = setUp(t, { matches: [
    fixture('m-yesterday', '2026-11-25T18:00:00Z'),
    fixture('m-today', '2026-11-26T10:00:00Z')
  ] });
  const failingAI = createEnvironment({ failAI: true });

  await run(db, failingAI.env);
  assert.equal(currentIssue(db).date, yesterday);
  assert.equal(db.read(`${groupPath}/dailyMedia/generationLock`).date, yesterday);

  const blockedAI = createEnvironment();
  await run(db, blockedAI.env, new Date(now.getTime() + 15 * 60 * 1000));
  assert.equal(currentIssue(db).date, today);
  assert.equal(blockedAI.aiCalls, 3);
});

test('AI serbest metindeki sahte skor ve oyuncu iddiası yayımlanan gazeteye geçmez', async t => {
  const oldIssue = { date: yesterday, status: 'published', payloadJson: '{"older":"issue"}' };
  const db = setUp(t, {
    matches: [fixture('m-today', '2026-11-26T10:00:00Z')],
    current: oldIssue
  });
  const scoreAI = createEnvironment({
    mutateOutput(output) {
      output.headline = 'Sahte skor 2-0';
      output.extraText = 'Rashford günün yıldızı oldu.';
    }
  });
  await run(db, scoreAI.env);
  assert.equal(scoreAI.aiCalls, 3);
  assert.equal(currentIssue(db).date, today);
  assert.doesNotMatch(currentIssue(db).payloadJson, /2-0|Rashford/);

  const playerAI = createEnvironment({
    mutateOutput(output) {
      output.player = 'Rashford';
      output.claim = 'Hat-trick yaptı.';
    }
  });
  await run(db, playerAI.env);
  assert.equal(currentIssue(db).date, today);
  assert.doesNotMatch(currentIssue(db).payloadJson, /Rashford|Hat-trick/);
});

test('gazete yayımlandıktan sonra zaman çizelgesi yazımı hata verir ve sonraki cron aynı olayı yeniden dener', async t => {
  const db = setUp(t, {
    matches: [fixture('m-today', '2026-11-26T10:00:00Z', 'post', { seasonId: 'S1' })],
    season: true
  });
  db.failNextTimelineCreate();
  const ai = createEnvironment();

  await run(db, ai.env);
  assert.equal(currentIssue(db).date, today);
  assert.equal(currentIssue(db).timelineStatus, 'error');
  assert.equal(db.list(`${groupPath}/seasonTimeline`).length, 0);
  assert.equal(ai.aiCalls, 3);

  await run(db, ai.env, new Date(now.getTime() + 15 * 60 * 1000));
  assert.equal(currentIssue(db).timelineStatus, 'saved');
  assert.equal(db.list(`${groupPath}/seasonTimeline`).length, 1);
  assert.equal(ai.aiCalls, 3);
});

test('eski Worker cron bildirimini çalıştırır, medya cronunu çağırmaz ve HTTP yönlendirmeleri korunur', async t => {
  const waits = [];
  await legacyWorker.scheduled({}, {}, { waitUntil(task) { waits.push(task); } });
  assert.equal(waits.length, 1);
  await Promise.all(waits);

  const options = await legacyWorker.fetch(new Request('https://worker.example/', { method: 'OPTIONS' }), {});
  assert.equal(options.status, 204);
  const wrongOrigin = await legacyWorker.fetch(new Request('https://worker.example/', {
    method: 'POST', headers: { Origin: 'https://elsewhere.example' }, body: '{}'
  }), {});
  assert.equal(wrongOrigin.status, 403);
  const invalidEvent = await legacyWorker.fetch(new Request('https://worker.example/?event=invalid'), {});
  assert.equal(invalidEvent.status, 400);

  const origin = 'https://agamanil.github.io';
  const adminLogin = await legacyWorker.fetch(new Request('https://worker.example/', {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'adminLogin' })
  }), {});
  assert.equal(adminLogin.status, 500);
  const push = await legacyWorker.fetch(new Request('https://worker.example/', {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'sendNotification' })
  }), {});
  assert.equal(push.status, 500);

  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('{}', { status: 401 });
  try {
    for (const action of ['createAccountTransfer', 'redeemAccountTransfer']) {
      const response = await legacyWorker.fetch(new Request('https://worker.example/', {
        method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, idToken: 'unit-test-token', code: 'invalid' })
      }), {});
      assert.equal(response.status, 400);
    }
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('sezon belgeseli kilidi eşzamanlı üretimi ve süresi dolan eski üretimin yazmasını engeller', async t => {
  const db = setUp(t, {
    matches: [fixture('season-match', '2026-11-26T10:00:00Z', 'post', { seasonId: 'S1' })],
    season: true,
    current: { date: today, status: 'published', payloadJson: '{}' }
  });
  let releaseFirst;
  let enteredFirst;
  const firstGate = new Promise(resolve => { releaseFirst = resolve; });
  const firstEntered = new Promise(resolve => { enteredFirst = resolve; });
  let firstAICalls = 0;
  const firstAI = { AI: { async run() {
    firstAICalls++;
    enteredFirst();
    await firstGate;
    return { choices: [{ message: { content: JSON.stringify({ title: 'Eski yanıt' }) } }] };
  } } };
  const firstRun = run(db, firstAI, new Date('2026-12-01T12:00:00Z'));
  await firstEntered;

  const lockPath = `${groupPath}/seasonDocumentaryLocks/S1`;
  assert.equal(db.read(lockPath).status, 'generating');
  const blockedAI = createEnvironment();
  await run(db, blockedAI.env, new Date('2026-12-01T12:15:00Z'));
  assert.equal(blockedAI.aiCalls, 0);

  let replacementCalls = 0;
  const replacementAI = { AI: { async run() {
    replacementCalls++;
    return { choices: [{ message: { content: JSON.stringify({ title: 'Yeni deneme' }) } }] };
  } } };
  await run(db, replacementAI, new Date('2026-12-01T12:46:00Z'));
  assert.equal(replacementCalls, 1);
  assert.equal(db.read(`${groupPath}/seasonDocumentaries/S1`).status, 'published');
  assert.equal(JSON.parse(db.read(`${groupPath}/seasonDocumentaries/S1`).payloadJson).title, 'Yeni deneme');

  releaseFirst();
  await firstRun;
  assert.equal(JSON.parse(db.read(`${groupPath}/seasonDocumentaries/S1`).payloadJson).title, 'Yeni deneme');
  assert.equal(db.read(lockPath).status, 'published');
});

