import { getApp, getApps, initializeApp } from 'https://www.gstatic.com/firebasejs/13.2.0/firebase-app.js';
import { getAuth, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/13.2.0/firebase-auth.js';
import { getFirestore, doc, collection, onSnapshot } from 'https://www.gstatic.com/firebasejs/13.2.0/firebase-firestore.js';
import { firebaseConfig } from './config.js';

const $ = id => document.getElementById(id);
const app = getApps().length ? getApp() : initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
let currentCode = '', gazetteUnsub = null, docsUnsub = null;
let currentGazette = null, documentaries = [];

function todayKey() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Istanbul', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date());
  const get = type => parts.find(item => item.type === type).value;
  return get('year') + '-' + get('month') + '-' + get('day');
}
function esc(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}
function parse(value) {
  try { return JSON.parse(value || '{}'); } catch (e) { return {}; }
}
function safePhoto(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname.toLowerCase().includes('espn') ? url.href : '';
  } catch (e) { return ''; }
}
function renderGazette() {
  const root = $('dailyGazetteContent');
  if (!root) return;
  if (!currentGazette || currentGazette.status !== 'published' || currentGazette.date !== todayKey()) {
    root.innerHTML = '<section class="card"><h3>📰 FUTBOLBARBAROS Gazetesi</h3><p class="match-meta">Günün bütün maçlarının sonuçları girildiğinde gazete otomatik yayımlanacak.</p></section>';
    return;
  }
  const p = parse(currentGazette.payloadJson);
  const photos = Array.isArray(p.photos) ? p.photos : [];
  const stories = Array.isArray(p.stories) ? p.stories : [];
  const war = Array.isArray(p.newspaperWar) ? p.newspaperWar : [];
  const photoHtml = photos.map(photo => {
    const src = safePhoto(photo.url);
    if (!src) return '';
    const source = safePhoto(photo.sourceUrl);
    return '<figure class="gazette-photo"><img loading="lazy" referrerpolicy="no-referrer" src="' +
      esc(src) + '" alt="' + esc(photo.alt || 'Maç fotoğrafı') + '"><figcaption>' +
      esc(photo.caption || 'Maçtan kare') + '<span>' +
      (source ? '<a href="' + esc(source) + '" target="_blank" rel="noopener noreferrer">Fotoğraf kaynağı</a>' : esc(photo.source || 'ESPN')) +
      '</span></figcaption></figure>';
  }).join('');
  root.innerHTML = '<article class="gazette-paper">' +
    '<header class="gazette-masthead"><small>ARKADAŞLARIN LİGİNDEN HABERLER</small><h2>FUTBOLBARBAROS</h2><div class="gazette-date">' +
    esc(p.date || currentGazette.date) + ' · GÜNLÜK SPOR GAZETESİ</div></header>' +
    '<h1 class="gazette-headline">' + esc(p.headline || 'Günün Manşeti') + '</h1>' +
    '<div class="gazette-subheadline">' + esc(p.subheadline || '') + '</div>' +
    '<p class="gazette-lead">' + esc(p.lead || '') + '</p>' +
    (photoHtml ? '<div class="gazette-photo-grid">' + photoHtml + '</div>' : '') +
    '<div class="gazette-columns">' + stories.map(item =>
      '<section class="gazette-story"><h3>' + esc(item.title || '') + '</h3><p>' + esc(item.body || '') + '</p></section>'
    ).join('') + '</div>' +
    '<section class="gazette-war"><h3>🗞️ BASIN MANŞETLERİ SAVAŞI</h3><div class="gazette-war-grid">' +
    war.map(item => '<article class="gazette-war-card"><strong>' + esc(item.paper || 'Gazete') +
      '</strong><h4>' + esc(item.headline || '') + '</h4><p>' + esc(item.comment || '') + '</p></article>').join('') +
    '</div></section><p class="gazette-lead"><b>YARININ GÜNDEMİ:</b> ' +
    esc(p.tomorrowPreview || 'Yeni maçlar ve yeni hikâyeler bekleniyor.') +
    '</p><footer class="gazette-footer">FUTBOLBARBAROS · Günlük yayın</footer></article>';
}
function renderDocumentaries() {
  const root = $('seasonDocumentaryWall');
  if (!root) return;
  const published = documentaries.filter(item => item.status === 'published');
  if (!published.length) {
    root.innerHTML = '<p class="match-meta">Henüz sezon belgeseli yok. Sezon tamamlandığında otomatik eklenecek.</p>';
    return;
  }
  published.sort((a,b) => String(b.seasonId).localeCompare(String(a.seasonId)));
  root.innerHTML = published.map(item => {
    const p = parse(item.payloadJson);
    const chapters = Array.isArray(p.chapters) ? p.chapters : [];
    const awards = Array.isArray(p.seasonAwards) ? p.seasonAwards : [];
    return '<article class="documentary-card"><h3>🎬 ' + esc(p.title || item.seasonName || 'Sezon Belgeseli') + '</h3>' +
      '<p class="documentary-opening">' + esc(p.opening || '') + '</p>' +
      chapters.map(ch => '<section class="documentary-chapter"><h4>' + esc(ch.heading || '') +
        '</h4><p>' + esc(ch.text || '') + '</p></section>').join('') +
      (awards.length ? '<section class="documentary-chapter"><h4>Sezon Ödülleri</h4><div class="documentary-awards">' +
        awards.map(a => '🏅 ' + esc(a.title || '') + ': <b>' + esc(a.winner || '') +
          '</b> · ' + esc(a.reason || '')).join('<br>') + '</div></section>' : '') +
      '<section class="documentary-chapter"><p>' + esc(p.finale || '') + '</p></section></article>';
  }).join('');
}
function listenLeague(code) {
  if (!code || code === currentCode) return;
  currentCode = code;
  if (gazetteUnsub) gazetteUnsub();
  if (docsUnsub) docsUnsub();
  currentGazette = null;
  documentaries = [];
  renderGazette();
  renderDocumentaries();
  gazetteUnsub = onSnapshot(doc(db, 'groups', code, 'dailyMedia', 'current'), snapshot => {
    currentGazette = snapshot.exists() ? snapshot.data() : null;
    renderGazette();
  }, error => console.error('Gazete okunamadı:', error));
  docsUnsub = onSnapshot(collection(db, 'groups', code, 'seasonDocumentaries'), snapshot => {
    documentaries = snapshot.docs.map(item => ({ id: item.id, ...item.data() }));
    renderDocumentaries();
  }, error => console.error('Belgeseller okunamadı:', error));
}
window.addEventListener('fb:league-changed', event => {
  if (event.detail && event.detail.code) listenLeague(event.detail.code);
});
const leagueSelect = $('leagueSelect');
if (leagueSelect) leagueSelect.addEventListener('change', () => listenLeague(leagueSelect.value));
onAuthStateChanged(auth, () => {
  if (leagueSelect && leagueSelect.value) listenLeague(leagueSelect.value);
});
