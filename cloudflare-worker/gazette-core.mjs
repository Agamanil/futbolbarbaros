export const GAZETTE_EDITIONS = Object.freeze({
  official: { label: 'Resmî Gazete', register: 'resmi', field: 'officialNote' },
  mixed: { label: 'Ortaya Karışık', register: 'dergi', field: 'magazineNote' },
  amk: { label: 'AMK Gazetesi', register: 'taslama', field: 'satiricalNote' }
});

export function gazetteDayKey(value) {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value?.toDate ? value.toDate() : value);
  if (Number.isNaN(date.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Istanbul', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(date);
  const part = type => parts.find(item => item.type === type)?.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

export function gazetteMatchesForDay(matches, date) {
  return (matches || []).filter(match => gazetteDayKey(match.kickoff) === date);
}

export function gazetteDateWindow(today, days = 7) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today || '') || !Number.isInteger(days) || days < 1 || days > 31) {
    throw new RangeError('Gazete geriye dönük tarama aralığı geçersiz.');
  }
  const end = new Date(`${today}T00:00:00Z`);
  if (Number.isNaN(end.getTime()) || end.toISOString().slice(0, 10) !== today) {
    throw new RangeError('Gazete tarihi geçersiz.');
  }
  return Array.from({ length: days }, (_, index) => {
    const day = new Date(end.getTime() - (days - index - 1) * 86400000);
    return day.toISOString().slice(0, 10);
  });
}

export function gazetteMatchIsCompleted(match, now = Date.now()) {
  if (!match) return false;
  const kickoffValue = match.kickoff?.toDate ? match.kickoff.toDate() : match.kickoff;
  const kickoff = kickoffValue instanceof Date ? kickoffValue.getTime() : Date.parse(kickoffValue || '');
  if (!Number.isFinite(kickoff) || kickoff > now) return false;

  const state = String(match.espnState || '').trim().toLowerCase();
  if (match.scoreSource === 'espn') return state === 'post';
  if (state === 'pre' || state === 'in') return false;

  const confirmedAtValue = match.manualResultConfirmedAt?.toDate
    ? match.manualResultConfirmedAt.toDate() : match.manualResultConfirmedAt;
  const confirmedAt = confirmedAtValue instanceof Date
    ? confirmedAtValue.getTime() : Date.parse(confirmedAtValue || '');
  return match.manualResultConfirmed === true &&
    typeof match.manualResultConfirmedBy === 'string' && match.manualResultConfirmedBy.length > 0 &&
    Number.isFinite(confirmedAt) && confirmedAt >= kickoff && confirmedAt <= now;
}

export function gazetteScoreIsValid(match) {
  if (!match || typeof match.homeTeam !== 'string' || !match.homeTeam.trim() ||
      typeof match.awayTeam !== 'string' || !match.awayTeam.trim()) return false;
  const validScore = value => {
    if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0;
    if (typeof value !== 'string' || !/^\d+$/.test(value.trim())) return false;
    return Number.isSafeInteger(Number(value)) && Number(value) >= 0;
  };
  return validScore(match.homeScore) && validScore(match.awayScore);
}

export function gazetteDayIsReady(matches, riskEvents, now = Date.now()) {
  if (!Array.isArray(matches) || matches.length === 0) return false;
  const ids = new Set();
  for (const match of matches) {
    if (!match || typeof match.id !== 'string' || !match.id || ids.has(match.id)) return false;
    ids.add(match.id);
    if (!gazetteMatchIsCompleted(match, now)) return false;
    if (!gazetteScoreIsValid(match)) return false;
  }
  for (const event of riskEvents || []) {
    if (!ids.has(event.matchId)) continue;
    if (event.status === 'open') return false;
    if (event.status !== 'resolved' || typeof event.outcome !== 'boolean') return false;
  }
  return true;
}

export function shouldSkipGazetteGeneration(date, current, lock, now = Date.now()) {
  if (current?.status === 'published' && String(current.date || '') >= date) return true;
  if (lock?.status === 'generating') {
    const leaseUntil = Date.parse(lock.leaseUntil || '');
    const attemptedAt = Date.parse(lock.attemptedAt || '');
    if ((Number.isFinite(leaseUntil) && leaseUntil > now) ||
        (!Number.isFinite(leaseUntil) && Number.isFinite(attemptedAt) && now - attemptedAt < 45 * 60 * 1000)) return true;
  }
  if (lock?.status === 'error') {
    const attemptedAt = Date.parse(lock.attemptedAt || '');
    if (String(lock.date || '') <= date && Number.isFinite(attemptedAt) &&
        now - attemptedAt < 60 * 60 * 1000) return true;
  }
  return false;
}

export function isGazettePhotoUsable(photo, matchIds) {
  if (!photo || photo.licenseVerified !== true || !matchIds?.has(photo.matchId)) return false;
  try {
    const url = new URL(photo.url);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch {
    return false;
  }
}

function collectFactsById(value, output = new Map()) {
  if (!value || typeof value !== 'object') return output;
  if (!Array.isArray(value) && typeof value.factId === 'string') output.set(value.factId, value);
  if (Array.isArray(value)) {
    for (const item of value) collectFactsById(item, output);
  } else {
    for (const child of Object.values(value)) collectFactsById(child, output);
  }
  return output;
}

function parseObject(value) {
  if (typeof value === 'string') {
    try { value = JSON.parse(value); }
    catch { throw new Error('Gazete çıktısı geçerli JSON değil.'); }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Gazete çıktısı JSON nesnesi olmalı.');
  }
  return value;
}

export function gazetteEditionPrompt(type) {
  const spec = GAZETTE_EDITIONS[type];
  if (!spec) throw new Error(`Bilinmeyen gazete türü: ${type}`);
  return `Sadece seçim JSON'u üret: {"editionType":"${type}","sections":[{"sourceId":"...","layout":"..."}]}. Kaynak ID'lerini facts.factIds içinden aynen seç. layout yalnızca "brief", "spotlight", "scorebox", "irony" değerlerinden biri olabilir; ${type === 'amk' ? 'AMK için irony tercih edilebilir' : 'irony kullanma'}. Metin, kişi/takım adı, skor, sayı, olay, başlık, açıklama, duyuru veya ek alan üretme. JSON dışı metin yazma. Üslup seçimi Worker şablonlarında uygulanır (${spec.label}).`;
}

const layouts = new Set(['brief', 'spotlight', 'scorebox', 'irony']);
const editionStyle = {
  official: { label: 'Resmî kayıt', lead: 'İlgili kayıt aşağıdaki şekilde tespit edilmiştir.', field: 'officialNote' },
  mixed: { label: 'Günün hikâyesi', lead: 'Günün futbol akışında bu kayıt öne çıktı.', field: 'magazineNote' },
  amk: { label: 'Tabela konuştu', lead: 'Taşlamanın dayanağı, doğrulanmış bu kayıtla sınırlı.', field: 'satiricalNote' }
};

function renderFact(fact, type, layout) {
  if (!fact || typeof fact.factId !== 'string') return null;
  const kind = fact.factId.split(':', 1)[0];
  const number = value => Number.isFinite(Number(value)) ? Number(value) : null;
  if (kind === 'result') {
    const homeScore = number(fact.homeScore ?? fact.score?.split?.('-')?.[0]);
    const awayScore = number(fact.awayScore ?? fact.score?.split?.('-')?.[1]);
    if (!fact.home || !fact.away || homeScore === null || awayScore === null) return null;
    const score = `${homeScore}-${awayScore}`;
    const title = layout === 'spotlight' ? 'Öne çıkan sonuç' :
      layout === 'scorebox' ? 'Skor kaydı' : `${fact.home} - ${fact.away}`;
    const text = `${title} karşılaşması ${score} tamamlandı.`;
    return { title, text, detail: type === 'amk' ? `Tabela ${score}: taşlama yalnızca bu doğrulanmış sonuç üzerinedir.` : text };
  }
  if (kind === 'daily-player' || kind === 'season-player') {
    const points = number(fact.points);
    if (!fact.name || points === null) return null;
    const title = kind === 'daily-player' ? `${fact.name}: günlük puan` : `${fact.name}: lig tablosu`;
    const text = kind === 'daily-player'
      ? `${fact.name}, günlük tabloda ${points} puan aldı.`
      : `${fact.name}, lig tablosunda ${fact.rank}. sırada ${points} puanda yer aldı.`;
    return { title, text, detail: type === 'amk' ? `${fact.name} için taşlama, yalnızca ${points} puanlık kayıtla sınırlı.` : text };
  }
  if (kind === 'bonus') {
    if (!fact.player || !fact.match) return null;
    const text = `${fact.player} için ${fact.match} maçına bonus seçimi kaydedildi.`;
    return { title: 'Bonus seçimi', text, detail: text };
  }
  if (kind === 'risk') {
    if (!fact.match || !['Gerçekleşti', 'Gerçekleşmedi'].includes(fact.outcome)) return null;
    const text = `${fact.match} maçındaki Risk sonucu: ${fact.outcome.toLocaleLowerCase('tr-TR')}.`;
    return { title: 'Risk sonucu', text, detail: text };
  }
  if (kind === 'event') {
    if (!fact.matchId || !fact.title || !fact.detail) return null;
    const text = `${fact.title}: ${fact.detail}.`;
    return { title: fact.title, text, detail: text };
  }
  if (kind === 'surprise') {
    const home = fact.home, away = fact.away;
    const score = String(fact.score || '');
    if (!home || !away || !/^\d+-\d+$/.test(score)) return null;
    const text = fact.type === 'large-margin'
      ? `${home} - ${away} maçında doğrulanmış skor ${score}; fark ${fact.margin}.`
      : fact.type === 'prediction-surprise'
        ? `${home} - ${away} maçında ${fact.totalPredictions} tahminin çoğunluğu doğru sonuçla örtüşmedi.` : null;
    return text ? { title: 'Günün sürprizi', text, detail: type === 'amk' ? `Tahmin tablosu bu maçta ters köşe oldu: ${home} - ${away}, ${score}.` : text } : null;
  }
  if (kind === 'fixture' && fact.home && fact.away) {
    const text = `${fact.home} - ${fact.away} yarının fikstüründe kayıtlı.`;
    return { title: 'Fikstür', text, detail: text };
  }
  return null;
}

function sourceIdMatchesRecord(fact) {
  if (!fact || typeof fact.factId !== 'string') return false;
  const [kind, ...rest] = fact.factId.split(':');
  const suffix = rest.join(':');
  if (kind === 'result') return fact.id && suffix === fact.id;
  if (kind === 'daily-player' || kind === 'season-player') return fact.id && suffix === fact.id;
  if (kind === 'bonus') return fact.id && fact.uid && fact.matchId && suffix === fact.id;
  if (kind === 'risk') return fact.id && fact.matchId && suffix === `${fact.matchId}:${fact.id}`;
  if (kind === 'event') return fact.matchId && fact.eventKey && suffix === `${fact.matchId}:${fact.eventKey}`;
  if (kind === 'surprise') return fact.matchId && fact.type && suffix === `${fact.matchId}:${fact.type}`;
  if (kind === 'fixture') return fact.id && suffix === fact.id;
  return false;
}

function factBelongsToIssue(fact, matches) {
  if (!sourceIdMatchesRecord(fact)) return false;
  const kind = fact.factId.split(':', 1)[0];
  if (['result', 'event', 'surprise', 'risk', 'bonus'].includes(kind)) {
    const matchId = kind === 'result' ? fact.id : fact.matchId;
    if (!(matches || []).some(match => match.id === matchId)) return false;
  }
  if (kind === 'result') {
    const match = matches.find(item => item.id === fact.id);
    return match.homeTeam === fact.home && match.awayTeam === fact.away &&
      Number(match.homeScore) === Number(fact.homeScore) && Number(match.awayScore) === Number(fact.awayScore);
  }
  return true;
}

export function validateGazetteEdition(type, rawOutput, facts = {}) {
  const spec = GAZETTE_EDITIONS[type];
  if (!spec) throw new Error(`Bilinmeyen gazete türü: ${type}`);
  const output = parseObject(rawOutput);
  if (output.editionType !== type || !Array.isArray(output.sections)) return [];
  const allowedIds = new Set(Array.isArray(facts.factIds) ? facts.factIds : []);
  const records = collectFactsById(facts);
  const used = new Set();
  const sections = [];
  for (const item of output.sections.slice(0, 12)) {
    const id = item && typeof item.sourceId === 'string' ? item.sourceId : '';
    if (!allowedIds.has(id) || !records.has(id) || used.has(id)) continue;
    const fact = records.get(id);
    if (!sourceIdMatchesRecord(fact)) continue;
    const layout = layouts.has(item.layout) ? item.layout : 'brief';
    const rendered = renderFact(fact, type, layout);
    if (!rendered) continue;
    used.add(id);
    sections.push({ sourceId: id, layout, ...rendered });
  }
  return sections;
}

export async function buildDailyGazetteIssue({
  date, matches, riskEvents = [], facts, generate, photos = [], now = Date.now(), verifySources
}) {
  if (!gazetteDayIsReady(matches, riskEvents, now)) {
    throw new Error('Gazete için maç verisi eksik/geçersiz veya açık Risk etkinliği var.');
  }
  if (typeof generate !== 'function') throw new TypeError('Gazete üretici fonksiyonu gerekli.');
  const matchIds = new Set(matches.map(match => match.id));
  const allRecords = collectFactsById(facts);
  const verifiedFactIds = (facts.factIds || []).filter(id => {
    const fact = allRecords.get(id);
    return matchIds.size && factBelongsToIssue(fact, matches);
  });
  const verifiedFacts = { ...facts, factIds: verifiedFactIds };
  const editions = {};
  for (const type of Object.keys(GAZETTE_EDITIONS)) {
    let output, useFallback = false;
    try { output = await generate({ type, prompt: gazetteEditionPrompt(type), facts }); }
    catch { useFallback = true; }
    let sections = [];
    if (!useFallback) {
      try {
        const envelope = parseObject(output);
        useFallback = envelope.editionType !== type || !Array.isArray(envelope.sections);
        if (!useFallback) sections = validateGazetteEdition(type, envelope, verifiedFacts);
      } catch { useFallback = true; }
    }
    if (useFallback) {
      const records = allRecords;
      for (const id of verifiedFactIds) {
        const rendered = renderFact(records.get(id), type, type === 'amk' ? 'irony' : 'brief');
        if (rendered) sections.push({ sourceId: id, layout: type === 'amk' ? 'irony' : 'brief', ...rendered });
        if (sections.length === 5) break;
      }
    }
    const style = editionStyle[type];
    const primary = sections[0];
    const stories = sections.slice(0, 5).map(section => ({
      title: section.title, body: section.detail, factRefs: [section.sourceId]
    }));
    editions[type] = {
      editionType: type, register: GAZETTE_EDITIONS[type].register,
      headline: primary?.title || `${GAZETTE_EDITIONS[type].label} · ${date}`,
      subheadline: primary?.text || 'Doğrulanmış kaynaklarda yayımlanabilir kayıt bulunamadı.',
      lead: primary ? `${style.lead} ${primary.text}` : style.lead,
      [style.field]: [style.lead, ...sections.map(section => section.detail)].join(' '),
      factRefs: sections.map(section => section.sourceId),
      stories,
      tomorrowPreview: 'Yarın için doğrulanmış fikstür bilgisi bu sayıda yer almıyor.'
    };
  }
  if (typeof verifySources === 'function' && !(await verifySources())) {
    throw new Error('Gazete hazırlanırken kaynak veriler değişti; eski kaynakla yayın iptal edildi.');
  }
  return {
    schemaVersion: 3,
    date,
    editions,
    photos: (photos || []).filter(photo => isGazettePhotoUsable(photo, matchIds))
  };
}

export async function generateAndStoreDailyGazette({ generateIssue, storeCurrent }) {
  if (typeof generateIssue !== 'function' || typeof storeCurrent !== 'function') {
    throw new TypeError('Gazete üretimi ve güncel yayın kaydı fonksiyonları gerekli.');
  }
  const issue = await generateIssue();
  await storeCurrent(issue);
  return issue;
}
