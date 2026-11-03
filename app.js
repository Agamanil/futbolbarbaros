// FUTBOLBARBAROS - COKLU LIG SISTEMI
import { initializeApp } from 'https://www.gstatic.com/firebasejs/13.2.0/firebase-app.js';
import { getAuth, signInAnonymously, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/13.2.0/firebase-auth.js';
import {
  getFirestore, doc, getDoc, setDoc, collection, addDoc, getDocs,
  query, orderBy, onSnapshot, updateDoc, serverTimestamp, Timestamp
} from 'https://www.gstatic.com/firebasejs/13.2.0/firebase-firestore.js';
import { firebaseConfig, ADMIN_UID } from './config.js';

const $ = id => document.getElementById(id);
const hasConfig = Boolean(firebaseConfig?.apiKey && firebaseConfig?.projectId);

const SHARED_LEAGUES = ['BARBAROS26', 'ILOVE12CBRO'];
let db, uid = null, player = null, groupCode = '';
let memberships = [], matches = [], players = [], activeMatch = null;
let unsubMatches = null, unsubPlayers = null;

const isAdmin = () => Boolean(uid) && uid === ADMIN_UID;

function message(el, text, isError = true) {
  if (!el) return;
  el.textContent = text;
  el.style.color = isError ? 'var(--red)' : 'var(--green)';
}
function toDate(value) { return value?.toDate ? value.toDate() : new Date(value); }
function fromLocalInput(value) { return value ? new Date(`${value}:00+03:00`) : null; }
function toLocalInput(value) {
  if (!value) return '';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Istanbul', year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(toDate(value));
  const part = type => parts.find(p => p.type === type)?.value;
  return `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}`; } function dateText(value) { if (!value) return 'Belirlenmedi'; return toDate(value).toLocaleString('tr-TR', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Istanbul' }); } function safe(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); } function validName(name) { return name.length >= 2 && name.length <= 18; } function hasResult(m) { return m.homeScore !== undefined && m.awayScore !== undefined; } function predictionFor(m) { return m.predictions?.[uid]; }  function isLocked(m) { if (!m?.predictionOpenAt \vert{}\vert{} !m?.predictionCloseAt) return true; const now = Date.now(); return now < toDate(m.predictionOpenAt).getTime() \vert{}\vert{} now >= toDate(m.predictionCloseAt).getTime(); } function predictionStatus(m) { if (!m.predictionOpenAt \vert{}\vert{} !m.predictionCloseAt) return 'Tahmin saatleri belirlenmemiş'; const now = Date.now(), open = toDate(m.predictionOpenAt).getTime(); const close = toDate(m.predictionCloseAt).getTime(); if (now < open) return `Tahminler ${dateText(m.predictionOpenAt)} tarihinde açılacak`;
  if (now >= close) return `Tahmin süresi ${dateText(m.predictionCloseAt)} tarihinde sona erdi`;
  return `Tahminler açık · Kapanış: ${dateText(m.predictionCloseAt)}`;
}

function renderLeagueOptions() {
  const select = $('leagueSelect');
  if (!select) return;
  select.innerHTML = memberships.map(code =>
    `<option value="${safe(code)}">${safe(code)}</option>`
  ).join('');
  select.value = groupCode;
}
function showApp() {
  $('entryView').classList.add('hidden');
  $('appView').classList.remove('hidden');
  $('userBadge').textContent = player.name;
  $('userBadge').classList.remove('hidden');
  $('welcomeName').textContent = player.name;
  document.querySelectorAll('.admin-only').forEach(el => el.classList.toggle('hidden', !isAdmin()));
  renderLeagueOptions();
}
function activateTab(name) {
  document.querySelectorAll('.tab').forEach(tab => tab.classList.toggle('active', tab.dataset.tab === name));
  ['matches', 'table', 'admin'].forEach(tab => $(`${tab}Tab`).classList.toggle('hidden', tab !== name)); }  // İki ligde maç takvimi ortaktır; tahminler ise lig belgelerinde ayrı kalır. async function syncLegacyMatches() { if (!isAdmin()) return; const source = await getDocs(collection(db, 'groups', groupCode, 'matches')); for (const targetCode of SHARED_LEAGUES.filter(c => c !== groupCode)) { const targetCol = collection(db, 'groups', targetCode, 'matches'); for (const item of source.docs) { const data = { ...item.data() }; delete data.predictions; await setDoc(doc(db, 'groups', targetCode, 'matches', item.id), data, { merge: true }); } } }  async function switchLeague(code) { if (!memberships.includes(code)) throw new Error('Bu lig kayıtlı liglerinin arasında bulunamadı.'); const snap = await getDoc(doc(db, 'groups', code, 'players', uid)); if (!snap.exists()) throw new Error('Bu ligde oyuncu kaydın bulunamadı.'); if (groupCode && groupCode !== code) await syncLegacyMatches(); groupCode = code; player = { ...snap.data(), uid }; localStorage.setItem('fb_leagues', JSON.stringify(memberships)); showApp(); listen(); activateTab('matches'); }  async function boot() { if (!hasConfig) return message($('entryMessage'), 'Kurulum eksik: config.js Firebase ayarlarını kontrol et.'); const app = initializeApp(firebaseConfig), auth = getAuth(app); db = getFirestore(app); const user = await new Promise((resolve, reject) => { let unsubscribe = () => {}; unsubscribe = onAuthStateChanged(auth, u => { if (u) { unsubscribe(); resolve(u); } }, reject); if (!auth.currentUser) signInAnonymously(auth).catch(reject); }); uid = user.uid; await restoreSession(); }  async function restoreSession() { let saved = []; try { saved = JSON.parse(localStorage.getItem('fb_leagues') \vert{}\vert{} '[]'); if (!Array.isArray(saved)) saved = []; } catch { saved = []; }  if (!saved.length) { try { const old = JSON.parse(localStorage.getItem('fb_player') \vert{}\vert{} 'null'); if (old?.groupCode) saved.push(old.groupCode); } catch {} }  memberships = [...new Set(saved.filter(x => typeof x === 'string' && x))]; const valid = []; for (const code of memberships) { try { const snap = await getDoc(doc(db, 'groups', code, 'players', uid)); if (snap.exists()) valid.push(code); } catch (err) { console.error('Lig oturumu kontrolü:', code, err); } } memberships = valid; localStorage.setItem('fb_leagues', JSON.stringify(memberships)); if (memberships.length) await switchLeague(memberships[0]); }  /* İlk kez lig koduyla giriş */ $('joinForm').addEventListener('submit', async e => { e.preventDefault(); const msg = $('entryMessage'); if (!db \vert{}\vert{} !uid) return message(msg, 'Bağlantı henüz hazır değil.'); const code = $('groupCode').value.trim().toUpperCase(); const name = $('playerName').value.trim(); if (!code \vert{}\vert{} !name) return; if (!validName(name)) return message(msg, 'İsim 2-18 karakter arasında olmalı.'); try { const group = await getDoc(doc(db, 'groups', code)); if (!group.exists()) throw new Error('Bu grup koduyla bir lig bulunamadı.'); const ref = doc(db, 'groups', code, 'players', uid); const existing = await getDoc(ref); if (existing.exists()) { if (existing.data().name !== name) throw new Error('Bu cihazdaki oyuncu profili bu ligde farklı bir isimle kayıtlı. Kayıtlı ismini kullan.'); } else { const all = await getDocs(collection(db, 'groups', code, 'players')); if (all.docs.some(d => (d.data().name \vert{}\vert{} '').toLowerCase() === name.toLowerCase())) throw new Error('Bu oyuncu adı bu ligde zaten kullanılıyor.'); await setDoc(ref, { name, uid, joinedAt: serverTimestamp() }); } if (!memberships.includes(code)) memberships.push(code); memberships = [...new Set(memberships)]; localStorage.setItem('fb_leagues', JSON.stringify(memberships)); localStorage.removeItem('fb_player'); await switchLeague(code); } catch (err) { console.error(err); message(msg, err.message \vert{}\vert{} 'Giriş yapılamadı.'); } });  /* Uygulama içinden başka lige katıl */ $('leagueJoinForm').addEventListener('submit', async e => { e.preventDefault(); const code = $('newLeagueCode').value.trim().toUpperCase(); if (!code) return; try { const group = await getDoc(doc(db, 'groups', code)); if (!group.exists()) throw new Error('Bu kodla bir lig bulunamadı.'); const ref = doc(db, 'groups', code, 'players', uid); const existing = await getDoc(ref); if (existing.exists()) { if (!memberships.includes(code)) memberships.push(code); } else { const all = await getDocs(collection(db, 'groups', code, 'players')); if (all.docs.some(d => (d.data().name \vert{}\vert{} '').toLowerCase() === player.name.toLowerCase())) throw new Error('Bu oyuncu adı bu ligde zaten kullanılıyor.'); await setDoc(ref, { name: player.name, uid, joinedAt: serverTimestamp() }); memberships.push(code); } memberships = [...new Set(memberships)]; localStorage.setItem('fb_leagues', JSON.stringify(memberships)); $('newLeagueCode').value = ''; message($('leagueMessage'), 'Lige katıldın!', false); await switchLeague(code); } catch (err) { console.error(err); message($('leagueMessage'), err.message \vert{}\vert{} 'Lige katılınamadı.'); } });  $('leagueSelect').addEventListener('change', async e => { try { await switchLeague(e.target.value); message($('leagueMessage'), ''); } catch (err) { console.error(err); message($('leagueMessage'), err.message \vert{}\vert{} 'Lige geçilemedi.'); renderLeagueOptions(); } });  function listen() { if (unsubMatches) unsubMatches(); if (unsubPlayers) unsubPlayers(); matches = []; players = []; renderMatches(); renderAdminMatches(); renderTable();  unsubMatches = onSnapshot( query(collection(db, 'groups', groupCode, 'matches'), orderBy('kickoff', 'asc')), snap => { matches = snap.docs.map(d => ({ id: d.id, ...d.data() })); renderMatches(); renderAdminMatches(); renderTable(); }, err => console.error('Maç dinleme hatası:', err) ); unsubPlayers = onSnapshot( collection(db, 'groups', groupCode, 'players'), snap => { players = snap.docs.map(d => ({ id: d.id, ...d.data() })); renderTable(); }, err => console.error('Oyuncu dinleme hatası:', err) ); }  function renderMatches() { $('matchCount').textContent = `${matches.length} MAÇ`;
  const el = $('matchesList');
  if (!matches.length) { el.innerHTML = '<div class="empty">Henüz maç eklenmedi.</div>'; return; }
  
  el.innerHTML = matches.map(m => {
    const p = predictionFor(m), locked = isLocked(m);
    let buttonText = p ? 'Düzenle' : 'Tahmin et';
    if (!m.predictionOpenAt || !m.predictionCloseAt) buttonText = 'Saatler belirlenmemiş';
    else if (Date.now() < toDate(m.predictionOpenAt).getTime()) buttonText = 'Henüz açılmadı';
    else if (Date.now() >= toDate(m.predictionCloseAt).getTime()) buttonText = 'Tahmin kapandı';

    // Diğer kullanıcıların tahminleri (Sadece kullanıcı bu maça tahmin yapmışsa gösterilir)
    let othersHtml = '';
    if (p && m.predictions) {
      const otherEntries = Object.entries(m.predictions).filter(([userId]) => userId !== uid);
      if (otherEntries.length > 0) {
        othersHtml = `<div class="others-predictions" style="margin-top: 8px; font-size: 0.85rem; border-top: 1px dashed rgba(255,255,255,0.1); padding-top:
