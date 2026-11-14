// FUTBOLBARBAROS - RISK ETKINLIK SISTEMI
// Risk eventleri mac altinda saklanir; kullanici katilimi bir kez yazilir ve degistirilemez.
import { getApp, getApps, initializeApp } from 'https://www.gstatic.com/firebasejs/13.2.0/firebase-app.js';
import { getAuth, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/13.2.0/firebase-auth.js';
import {
  getFirestore, doc, getDoc, getDocs, setDoc, updateDoc, collection,
  onSnapshot, orderBy, query, runTransaction, serverTimestamp
} from 'https://www.gstatic.com/firebasejs/13.2.0/firebase-firestore.js';
import { subscribeSharedSnapshot } from './shared-firestore-listeners.js';
import { firebaseConfig, ADMIN_UID } from './config.js';

const $ = id => document.getElementById(id);
const app = getApps().length ? getApp() : initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const TIME_ZONE = 'Europe/Istanbul';

let uid = null;
let playerName = 'Oyuncu';
let groupCode = '';
let matches = [];
let unsubMatches = null;
let matchRiskUnsubs = new Map();
let participantUnsubs = new Map();
let riskEvents = new Map();
let activeRiskKey = '';
let initialMatchListLoaded = false;
let initialPendingMatchIds = new Set();
let initialPendingParticipantKeys = new Set();
let groupGeneration = 0;

window.FUTBOLBARBAROS_RISK_READY = false;
window.FUTBOLBARBAROS_RISK_POINTS = riskPointsFor;
window.FUTBOLBARBAROS_RISK_PENDING = riskPendingFor;
window.FUTBOLBARBAROS_RISK_FINALIZED_AT = riskFinalizedAtFor;

const isAdmin = () => Boolean(uid) && uid === ADMIN_UID;
const riskKey = (matchId, riskId) => `${matchId}__${riskId}`;
const matchPath = (code, matchId) => doc(db, 'groups', code, 'matches', matchId);
const risksPath = (code, matchId) => collection(db, 'groups', code, 'matches', matchId, 'risks');
const participantsPath = (code, matchId, riskId) => collection(db, 'groups', code, 'matches', matchId, 'risks', riskId, 'participants');

function safe(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[char]));
}

function asDate(value) {
  if (!value) return null;
  const date = value?.toDate ? value.toDate() : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatDate(value) {
  const date = asDate(value);
  return date ? date.toLocaleString('tr-TR', { dateStyle: 'medium', timeStyle: 'short', timeZone: TIME_ZONE }) : 'Tarih belirlenmedi';
}

function eventListForMatch(matchId) {
  return [...riskEvents.values()]
    .filter(item => item.matchId === matchId)
    .sort((a, b) => (a.createdAt?.seconds || 0) - (b.createdAt?.seconds || 0));
}

function riskPointsFor(userId, matchIds) {
  if (!userId || !matchIds) return 0;
  const ids = matchIds instanceof Set ? matchIds : new Set(matchIds);
  let total = 0;
  for (const event of riskEvents.values()) {
    if (!ids.has(event.matchId) || event.status !== 'resolved' || typeof event.outcome !== 'boolean') continue;
    const participation = (event.participants || []).find(item => item.id === userId);
    if (!participation) continue;
    const predictedYes = participation.choice === 'yes';
    total += predictedYes === event.outcome ? Number(event.plusPoints || 0) : Number(event.minusPoints || 0);
  }
  return total;
}

function riskPendingFor(matchIds) {
  if (!matchIds) return 0;
  const ids = matchIds instanceof Set ? matchIds : new Set(matchIds);
  return [...riskEvents.values()].filter(item => ids.has(item.matchId) && item.status === 'open').length;
}

function riskFinalizedAtFor(matchIds) {
  if (!matchIds) return null;
  const ids = matchIds instanceof Set ? matchIds : new Set(matchIds);
  const times = [...riskEvents.values()]
    .filter(item => ids.has(item.matchId) && item.status === 'resolved')
    .map(item => asDate(item.resolvedAt)?.getTime())
    .filter(Number.isFinite);
  return times.length ? Math.max(...times) : null;
}

function notifyRiskUpdate() {
  window.dispatchEvent(new CustomEvent('fb-risk-updated'));
  renderRiskUI();
}

function markRiskReady() {
  if (!initialMatchListLoaded || initialPendingMatchIds.size || initialPendingParticipantKeys.size) return;
  if (window.FUTBOLBARBAROS_RISK_READY) return;
  window.FUTBOLBARBAROS_RISK_READY = true;
  window.dispatchEvent(new CustomEvent('fb-risk-updated'));
}

function clearGroupListeners() {
  if (unsubMatches) unsubMatches();
  unsubMatches = null;
  for (const unsubscribe of matchRiskUnsubs.values()) unsubscribe();
  for (const unsubscribe of participantUnsubs.values()) unsubscribe();
  matchRiskUnsubs.clear();
  participantUnsubs.clear();
  riskEvents.clear();
  matches = [];
  initialMatchListLoaded = false;
  initialPendingMatchIds.clear();
  initialPendingParticipantKeys.clear();
  window.FUTBOLBARBAROS_RISK_READY = false;
  notifyRiskUpdate();
}

function subscribeToParticipants(matchId, eventDoc, isInitialGroupLoad) {
  const key = riskKey(matchId, eventDoc.id);
  const current = riskEvents.get(key) || { id: eventDoc.id, matchId, ...eventDoc.data(), participants: [] };
  current.id = eventDoc.id;
  current.matchId = matchId;
  Object.assign(current, eventDoc.data());
  riskEvents.set(key, current);

  if (participantUnsubs.has(key)) return;
  if (isInitialGroupLoad) initialPendingParticipantKeys.add(key);
  let firstSnapshot = true;
  const unsubscribe = subscribeSharedSnapshot(db, `groups/${groupCode}/matches/${matchId}/risks/${eventDoc.id}/participants`, participantsPath(groupCode, matchId, eventDoc.id), snapshot => {
    const latest = riskEvents.get(key);
    if (latest) {
      latest.participants = snapshot.docs.map(item => ({ id: item.id, ...item.data() }));
      riskEvents.set(key, latest);
    }
    if (firstSnapshot) {
      firstSnapshot = false;
      initialPendingParticipantKeys.delete(key);
      markRiskReady();
    }
    notifyRiskUpdate();
  }, error => {
    console.error('Risk katilimlari okunamadi:', error);
    if (firstSnapshot) {
      firstSnapshot = false;
      initialPendingParticipantKeys.delete(key);
      markRiskReady();
    }
  });
  participantUnsubs.set(key, unsubscribe);
}

function subscribeToMatchRisks(matchId, isInitialGroupLoad) {
  if (matchRiskUnsubs.has(matchId)) return;
  if (isInitialGroupLoad) initialPendingMatchIds.add(matchId);
  let firstSnapshot = true;
  const unsubscribe = subscribeSharedSnapshot(db, `groups/${groupCode}/matches/${matchId}/risks`, risksPath(groupCode, matchId), snapshot => {
    const currentKeys = new Set(snapshot.docs.map(item => riskKey(matchId, item.id)));
    for (const [key, event] of [...riskEvents.entries()]) {
      if (event.matchId === matchId && !currentKeys.has(key)) {
        participantUnsubs.get(key)?.();
        participantUnsubs.delete(key);
        riskEvents.delete(key);
      }
    }
    for (const eventDoc of snapshot.docs) {
      subscribeToParticipants(matchId, eventDoc, isInitialGroupLoad && firstSnapshot);
    }
    if (firstSnapshot) {
      firstSnapshot = false;
      initialPendingMatchIds.delete(matchId);
      markRiskReady();
    }
    notifyRiskUpdate();
  }, error => {
    console.error('Risk etkinlikleri okunamadi:', error);
    if (firstSnapshot) {
      firstSnapshot = false;
      initialPendingMatchIds.delete(matchId);
      markRiskReady();
    }
  });
  matchRiskUnsubs.set(matchId, unsubscribe);
}

function syncMatchRiskListeners(nextMatches) {
  const ids = new Set(nextMatches.map(item => item.id));
  for (const [matchId, unsubscribe] of [...matchRiskUnsubs.entries()]) {
    if (!ids.has(matchId)) {
      unsubscribe();
      matchRiskUnsubs.delete(matchId);
      for (const [key, event] of [...riskEvents.entries()]) {
        if (event.matchId === matchId) {
          participantUnsubs.get(key)?.();
          participantUnsubs.delete(key);
          riskEvents.delete(key);
        }
      }
    }
  }
  for (const match of nextMatches) subscribeToMatchRisks(match.id, !initialMatchListLoaded);
  if (!initialMatchListLoaded) {
    initialMatchListLoaded = true;
    markRiskReady();
  }
}

async function attachGroup(code) {
  const generation = ++groupGeneration;
  clearGroupListeners();
  groupCode = code;
  if (!uid || !code) return;

  try {
    const playerSnap = await getDoc(doc(db, 'groups', code, 'players', uid));
    if (generation !== groupGeneration) return;
    if (!playerSnap.exists()) {
      groupCode = '';
      return;
    }
    playerName = playerSnap.data().name || 'Oyuncu';

    unsubMatches = subscribeSharedSnapshot(db, `groups/${code}/matches:by-kickoff`, query(collection(db, 'groups', code, 'matches'), orderBy('kickoff', 'asc')), snapshot => {
      if (generation !== groupGeneration) return;
      matches = snapshot.docs.map(item => ({ id: item.id, ...item.data() }));
      syncMatchRiskListeners(matches);
      notifyRiskUpdate();
    }, error => console.error('Risk maclari okunamadi:', error));
  } catch (error) {
    console.error('Risk ligi baglanamadi:', error);
  }
}

function ensureDialogs() {
  if (!$('riskHelpDialog')) {
    document.body.insertAdjacentHTML('beforeend', `
      <dialog id="riskHelpDialog" class="risk-dialog">
        <div class="risk-dialog-inner">
          <button type="button" class="risk-dialog-close" data-risk-close="help" aria-label="Kapat">×</button>
          <div class="risk-kicker">🎲 FUTBOLBARBAROS</div>
          <h3>RİSK nasıl çalışır?</h3>
          <p>Risk, yöneticinin bir maç için oluşturduğu özel tahmin etkinliğidir. Etkinliğin altında yazan soruya <b>Evet</b> veya <b>Hayır</b> cevabı verirsin.</p>
          <ul>
            <li>Tahminin doğruysa etkinlikte belirtilen artı puanı kazanırsın.</li>
            <li>Tahminin yanlışsa belirtilen eksi puan uygulanır.</li>
            <li><b>İptal</b>, onay penceresini kapatır ve katılım kaydı oluşturmaz.</li>
            <li>Evet/Hayır seçimini onaylayıp katıldığında kararın kesinleşir. Sonradan değiştiremez veya etkinlikten ayrılamazsın.</li>
            <li>Katılmazsan puanın değişmez. Sonucu yönetici açıklar.</li>
          </ul>
          <button type="button" class="risk-primary" data-risk-close="help">Anladım</button>
        </div>
      </dialog>
      <dialog id="riskConfirmDialog" class="risk-dialog">
        <div class="risk-dialog-inner">
          <button type="button" class="risk-dialog-close" data-risk-close="confirm" aria-label="Kapat">×</button>
          <div class="risk-kicker">🎲 KATILIM ONAYI</div>
          <h3 id="riskConfirmTitle">Risk etkinliği</h3>
          <p>Seçimini yaptıktan sonra değiştiremez veya iptal edemezsin.</p>
          <div class="risk-payoff-table">
            <div><b>Seçimin</b><b>Gerçekleşirse</b><b>Gerçekleşmezse</b></div>
            <div><span>Evet</span><strong id="riskYesSuccess">+3</strong><strong id="riskYesFailure">-3</strong></div>
            <div><span>Hayır</span><strong id="riskNoSuccess">-3</strong><strong id="riskNoFailure">+3</strong></div>
          </div>
          <p class="risk-final-warning">Aşağıdaki Evet veya Hayır düğmesine bastığında katılımın kesinleşir.</p>
          <div class="risk-dialog-actions">
            <button type="button" class="risk-yes" data-risk-choice="yes">EVET</button>
            <button type="button" class="risk-no" data-risk-choice="no">HAYIR</button>
            <button type="button" class="risk-cancel" data-risk-close="confirm">İPTAL</button>
          </div>
          <div id="riskConfirmMessage" class="risk-message" aria-live="polite"></div>
        </div>
      </dialog>
    `);
  }
}

function riskMarkup(event, match) {
  const participant = (event.participants || []).find(item => item.id === uid);
  const kickoff = asDate(match?.kickoff);
  const canJoin = event.status === 'open' && kickoff && kickoff.getTime() > Date.now() && !participant;
  let stateHtml = '';
  if (participant) {
    const choiceText = participant.choice === 'yes' ? 'EVET' : 'HAYIR';
    if (event.status === 'resolved' && typeof event.outcome === 'boolean') {
      const correct = (participant.choice === 'yes') === event.outcome;
      const points = correct ? Number(event.plusPoints) : Number(event.minusPoints);
      stateHtml = `<div class="risk-user-state">Katılımın: <b>${choiceText}</b> · <strong class="${points >= 0 ? 'risk-positive' : 'risk-negative'}">${points > 0 ? '+' : ''}${points} puan</strong></div>`;
    } else {
      stateHtml = `<div class="risk-user-state">Katılımın kayıtlı: <b>${choiceText}</b> · Sonuç bekleniyor. Değiştirilemez.</div>`;
    }
  } else if (event.status === 'resolved') {
    stateHtml = '<div class="risk-user-state">Etkinlik sonuçlandı. Katılmadığın için puanın değişmedi.</div>';
  } else if (canJoin) {
    stateHtml = `<button type="button" class="risk-join-btn" data-risk-join="${safe(event.id)}" data-risk-match="${safe(event.matchId)}">RİSK'E KATIL</button>`;
  } else {
    stateHtml = '<div class="risk-user-state">Katılım süresi sona erdi.</div>';
  }

  const resultText = event.status === 'resolved'
    ? `<div class="risk-result-label">Yönetici sonucu: <b>${event.outcome ? 'GERÇEKLEŞTİ' : 'GERÇEKLEŞMEDİ'}</b></div>`
    : '<div class="risk-result-label">Sonuç bekleniyor</div>';

  return `<section class="risk-event-card" data-risk-event-card="${safe(event.id)}">
    <div class="risk-event-heading"><span>🎲 RİSK</span><button type="button" class="risk-help-btn" data-risk-help aria-label="Risk kuralları" title="Risk nasıl çalışır?">?</button></div>
    <div class="risk-question">${safe(event.question)}</div>
    <div class="risk-odds"><span>Doğru: <b class="risk-positive">+${safe(event.plusPoints)}</b></span><span>Yanlış: <b class="risk-negative">${safe(event.minusPoints)}</b></span></div>
    ${resultText}
    ${stateHtml}
  </section>`;
}

function renderAdminRiskTools(article, match) {
  if (!isAdmin()) return;
  let container = article.querySelector(':scope > .risk-admin-tools');
  if (!container) {
    container = document.createElement('section');
    container.className = 'risk-admin-tools';
    container.innerHTML = `
      <div class="risk-admin-title">🎲 Risk etkinliği yönetimi</div>
      <label>Etkinlik sorusu
        <input type="text" maxlength="160" data-risk-question placeholder="Örn: Arda Güler gol atar mı?">
      </label>
      <div class="risk-admin-points">
        <label>Doğru tahmin (+)<input type="number" min="1" max="50" step="1" value="3" data-risk-plus></label>
        <label>Yanlış tahmin (-)<input type="number" min="-50" max="-1" step="1" value="-3" data-risk-minus></label>
      </div>
      <button type="button" class="risk-admin-create" data-risk-admin-create="${safe(match.id)}">Risk etkinliği oluştur</button>
      <div class="risk-admin-event-list"></div>
    `;
    article.appendChild(container);
  }
  const list = container.querySelector('.risk-admin-event-list');
  const html = eventListForMatch(match.id).map(event => {
    const count = (event.participants || []).length;
    const outcomeText = event.status === 'resolved'
      ? (event.outcome ? 'Gerçekleşti' : 'Gerçekleşmedi')
      : 'Sonuç bekliyor';
    const controls = event.status === 'resolved'
      ? `<div class="risk-admin-actions"><button type="button" data-risk-set-result="true" data-risk-match="${safe(match.id)}" data-risk-id="${safe(event.id)}">Gerçekleşti olarak düzelt</button><button type="button" data-risk-set-result="false" data-risk-match="${safe(match.id)}" data-risk-id="${safe(event.id)}">Gerçekleşmedi olarak düzelt</button></div>`
      : `<div class="risk-admin-actions"><button type="button" data-risk-set-result="true" data-risk-match="${safe(match.id)}" data-risk-id="${safe(event.id)}">Gerçekleşti</button><button type="button" data-risk-set-result="false" data-risk-match="${safe(match.id)}" data-risk-id="${safe(event.id)}">Gerçekleşmedi</button></div>`;
    return `<div class="risk-admin-event"><b>${safe(event.question)}</b><small>+${safe(event.plusPoints)} / ${safe(event.minusPoints)} · Katılan: ${count} · ${outcomeText}</small>${controls}</div>`;
  }).join('');
  if (list && list.dataset.html !== html) {
    list.innerHTML = html || '<small>Bu maç için henüz Risk etkinliği yok.</small>';
    list.dataset.html = html;
  }
  const kickoff = asDate(match.kickoff);
  const createButton = container.querySelector('[data-risk-admin-create]');
  if (createButton) createButton.disabled = !kickoff || kickoff.getTime() <= Date.now();
}

function renderRiskUI() {
  if (!document.body) return;
  const matchContainer = $('matchesList');
  if (matchContainer) {
    matchContainer.querySelectorAll('article.match-card[data-match-id]').forEach(article => {
      const matchId = article.dataset.matchId;
      const match = matches.find(item => item.id === matchId);
      if (!match) return;
      let container = article.querySelector(':scope > .risk-inline-list');
      if (!container) {
        container = document.createElement('div');
        container.className = 'risk-inline-list';
        article.appendChild(container);
      }
      const html = eventListForMatch(matchId).map(event => riskMarkup(event, match)).join('');
      if (container.dataset.html !== html) {
        container.innerHTML = html;
        container.dataset.html = html;
      }
    });
  }

  const adminContainer = $('adminMatches');
  if (adminContainer && isAdmin()) {
    adminContainer.querySelectorAll('article.admin-match-card[data-admin-match-id]').forEach(article => {
      const match = matches.find(item => item.id === article.dataset.adminMatchId);
      if (match) renderAdminRiskTools(article, match);
    });
  }
}

function installStyles() {
  if ($('riskInjectedStyles')) return;
  const style = document.createElement('style');
  style.id = 'riskInjectedStyles';
  style.textContent = `
    .risk-inline-list{grid-column:1/-1;width:100%;display:grid;gap:9px;margin-top:10px}
    .risk-event-card{background:#dceeff;color:#173b5e;border:1px solid #a9c9e8;border-radius:13px;padding:12px 14px;box-shadow:0 4px 14px #00000012}
    .risk-event-heading{display:flex;align-items:center;justify-content:space-between;color:#174b78;font-size:12px;font-weight:900;letter-spacing:1px}
    .risk-help-btn{width:25px;height:25px;border:1px solid #8db5da;border-radius:50%;background:#f4faff;color:#174b78;font-weight:900;cursor:pointer}
    .risk-question{font-weight:900;font-size:15px;margin:7px 0;color:#173b5e}
    .risk-odds{display:flex;gap:16px;flex-wrap:wrap;font-size:12px;color:#24527a}
    .risk-positive{color:#16733b!important}.risk-negative{color:#b42318!important}
    .risk-result-label,.risk-user-state{font-size:12px;color:#24527a;margin-top:7px}
    .risk-join-btn{margin-top:10px;border:0;border-radius:9px;padding:9px 14px;background:#185b91;color:white;font-weight:900;cursor:pointer}
    .risk-join-btn:hover{filter:brightness(1.08)}
    .risk-admin-tools{grid-column:1/-1;margin-top:12px;padding:13px;border:1px solid #8db5da;border-radius:12px;background:#eaf4ff;color:#173b5e;display:grid;gap:9px}
    .risk-admin-title{font-weight:900;color:#174b78}.risk-admin-tools label{display:grid;gap:5px;font-size:12px;font-weight:700}
    .risk-admin-tools input{width:100%;min-width:0;padding:9px;border:1px solid #a9c9e8;border-radius:8px;background:white;color:#173b5e}
    .risk-admin-points{display:grid;grid-template-columns:1fr 1fr;gap:9px}
    .risk-admin-create,.risk-admin-actions button{border:0;border-radius:8px;padding:8px 11px;background:#185b91;color:white;font-weight:800;cursor:pointer}
    .risk-admin-create:disabled{opacity:.5;cursor:not-allowed}
    .risk-admin-event{padding:9px 0;border-top:1px solid #bdd4ea;display:grid;gap:6px;font-size:12px}
    .risk-admin-event small{color:#315d82}.risk-admin-actions{display:flex;gap:7px;flex-wrap:wrap}.risk-admin-actions button{font-size:11px}
    .risk-dialog{border:0;padding:0;border-radius:17px;width:min(92vw,520px);max-width:520px;background:transparent;color:#173b5e}
    .risk-dialog::backdrop{background:#061524bb;backdrop-filter:blur(3px)}
    .risk-dialog-inner{position:relative;background:#eaf4ff;border:1px solid #a9c9e8;border-radius:17px;padding:22px;color:#173b5e;max-height:85vh;overflow:auto}
    .risk-dialog-inner h3{margin:5px 32px 10px 0;color:#174b78}.risk-dialog-inner p,.risk-dialog-inner li{font-size:13px;line-height:1.55}
    .risk-kicker{color:#2870a9;font-size:10px;font-weight:900;letter-spacing:1.4px}.risk-dialog-close{position:absolute;right:12px;top:10px;border:0;background:transparent;color:#174b78;font-size:26px;cursor:pointer}
    .risk-dialog-inner ul{padding-left:19px}.risk-dialog-inner li{margin:5px 0}.risk-primary{margin-top:8px;width:100%;border:0;border-radius:9px;padding:10px;background:#185b91;color:white;font-weight:900;cursor:pointer}
    .risk-payoff-table{display:grid;border:1px solid #a9c9e8;border-radius:10px;overflow:hidden;margin:13px 0}
    .risk-payoff-table>div{display:grid;grid-template-columns:1.1fr 1fr 1fr;gap:5px;padding:10px;background:#f7fbff;border-top:1px solid #c8dced;font-size:12px}
    .risk-payoff-table>div:first-child{background:#d5eaff;border-top:0;color:#174b78}.risk-payoff-table strong{text-align:center}.risk-final-warning{font-weight:800;color:#9b3c24!important}
    .risk-dialog-actions{display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px}.risk-dialog-actions button{border:0;border-radius:9px;padding:11px 5px;font-weight:900;cursor:pointer}
    .risk-yes{background:#c9f1d7;color:#176b37}.risk-no{background:#f9d6d6;color:#a51e1e}.risk-cancel{background:#dce3eb;color:#374151}
    .risk-message{min-height:18px;margin-top:8px;font-size:12px;color:#b42318}
    @media(max-width:520px){.risk-admin-points{grid-template-columns:1fr}.risk-dialog-inner{padding:18px}.risk-payoff-table>div{font-size:10px;padding:8px 5px}}
  `;
  document.head.appendChild(style);
}

function showDialog(id) {
  const dialog = $(id);
  if (dialog && !dialog.open) dialog.showModal();
}

async function joinRisk(choice) {
  const event = riskEvents.get(activeRiskKey);
  if (!event || !groupCode || !uid || !['yes', 'no'].includes(choice)) return;
  const message = $('riskConfirmMessage');
  document.querySelectorAll('[data-risk-choice]').forEach(button => button.disabled = true);
  if (message) message.textContent = 'Katılım kaydediliyor...';
  const riskRef = doc(db, 'groups', groupCode, 'matches', event.matchId, 'risks', event.id);
  const participantRef = doc(db, 'groups', groupCode, 'matches', event.matchId, 'risks', event.id, 'participants', uid);
  const matchRef = matchPath(groupCode, event.matchId);
  try {
    await runTransaction(db, async transaction => {
      const [riskSnap, participantSnap, matchSnap] = await Promise.all([
        transaction.get(riskRef), transaction.get(participantRef), transaction.get(matchRef)
      ]);
      if (!riskSnap.exists() || !matchSnap.exists()) throw new Error('Risk etkinliği veya maç artık bulunamıyor.');
      if (participantSnap.exists()) throw new Error('Bu etkinliğe zaten katıldın. Seçimin değiştirilemez.');
      if (riskSnap.data().status !== 'open') throw new Error('Bu etkinliğin katılımı kapanmış.');
      const kickoff = asDate(matchSnap.data().kickoff);
      if (!kickoff || kickoff.getTime() <= Date.now() || matchSnap.data().homeScore !== undefined || matchSnap.data().awayScore !== undefined) {
        throw new Error('Maç başladığı veya sonuçlandığı için katılım kapandı.');
      }
      transaction.set(participantRef, {
        uid,
        playerName,
        choice,
        acceptedAt: serverTimestamp()
      });
    });
    $('riskConfirmDialog')?.close();
    alert(`Risk katılımın kaydedildi: ${choice === 'yes' ? 'EVET' : 'HAYIR'}. Bu seçim artık değiştirilemez.`);
  } catch (error) {
    console.error('Risk katilimi kaydedilemedi:', error);
    if (message) message.textContent = error.message || 'Katılım kaydedilemedi.';
  } finally {
    document.querySelectorAll('[data-risk-choice]').forEach(button => button.disabled = false);
  }
}

async function createRisk(matchId, button) {
  if (!isAdmin()) return alert('Yönetici yetkisi yok.');
  const article = document.querySelector(`[data-admin-match-id="${CSS.escape(matchId)}"]`);
  if (!article) return alert('Maç yönetim kartı bulunamadı.');
  const question = article.querySelector('[data-risk-question]')?.value.trim() || '';
  const plusPoints = Number(article.querySelector('[data-risk-plus]')?.value);
  const minusPoints = Number(article.querySelector('[data-risk-minus]')?.value);
  const match = matches.find(item => item.id === matchId);
  const kickoff = asDate(match?.kickoff);
  if (question.length < 4 || question.length > 160) return alert('Risk sorusu 4-160 karakter arasında olmalı.');
  if (!Number.isInteger(plusPoints) || plusPoints < 1 || plusPoints > 50) return alert('Doğru tahmin puanı 1-50 arasında tam sayı olmalı.');
  if (!Number.isInteger(minusPoints) || minusPoints < -50 || minusPoints > -1) return alert('Yanlış tahmin puanı -50 ile -1 arasında tam sayı olmalı.');
  if (!kickoff || kickoff.getTime() <= Date.now() || match?.homeScore !== undefined || match?.awayScore !== undefined) {
    return alert('Yalnızca başlamamış ve sonucu girilmemiş maçlara Risk etkinliği ekleyebilirsin.');
  }
  button.disabled = true;
  try {
    const ref = doc(collection(db, 'groups', groupCode, 'matches', matchId, 'risks'));
    await setDoc(ref, {
      matchId,
      question,
      plusPoints,
      minusPoints,
      status: 'open',
      createdAt: serverTimestamp(),
      createdBy: uid
    });
    article.querySelector('[data-risk-question]').value = '';
    alert('Risk etkinliği oluşturuldu ve maçın altında yayınlandı.');
  } catch (error) {
    console.error('Risk etkinligi olusturulamadi:', error);
    alert('Risk etkinliği oluşturulamadı: ' + (error.message || error));
  } finally {
    button.disabled = false;
  }
}

async function setRiskOutcome(matchId, riskId, outcome, button) {
  if (!isAdmin()) return alert('Yönetici yetkisi yok.');
  const event = riskEvents.get(riskKey(matchId, riskId));
  const match = matches.find(item => item.id === matchId);
  const kickoff = asDate(match?.kickoff);
  if (!event || !match) return alert('Risk veya maç bulunamadı.');
  if (!kickoff || kickoff.getTime() > Date.now()) return alert('Maç başlamadan Risk sonucu girilemez.');
  const label = outcome ? 'GERÇEKLEŞTİ' : 'GERÇEKLEŞMEDİ';
  if (!confirm(`“${event.question}” etkinliğinin sonucu ${label} olarak kaydedilsin mi?\n\nKatılımcı puanları otomatik güncellenecek.`)) return;
  button.disabled = true;
  try {
    await updateDoc(doc(db, 'groups', groupCode, 'matches', matchId, 'risks', riskId), {
      status: 'resolved',
      outcome,
      resolvedAt: serverTimestamp(),
      resolvedBy: uid
    });
    alert('Risk sonucu kaydedildi. Puanlar otomatik hesaplanacak.');
  } catch (error) {
    console.error('Risk sonucu kaydedilemedi:', error);
    alert('Risk sonucu kaydedilemedi: ' + (error.message || error));
  } finally {
    button.disabled = false;
  }
}

document.addEventListener('click', event => {
  const help = event.target.closest('[data-risk-help]');
  if (help) {
    ensureDialogs();
    showDialog('riskHelpDialog');
    return;
  }
  const close = event.target.closest('[data-risk-close]');
  if (close) {
    $(close.dataset.riskClose === 'help' ? 'riskHelpDialog' : 'riskConfirmDialog')?.close();
    return;
  }
  const join = event.target.closest('[data-risk-join]');
  if (join) {
    const key = riskKey(join.dataset.riskMatch, join.dataset.riskJoin);
    const item = riskEvents.get(key);
    if (!item) return alert('Risk etkinliği bulunamadı.');
    const existing = (item.participants || []).some(person => person.id === uid);
    if (existing) return alert('Bu etkinliğe zaten katıldın.');
    activeRiskKey = key;
    $('riskConfirmTitle').textContent = item.question;
    $('riskYesSuccess').textContent = `+${item.plusPoints}`;
    $('riskYesFailure').textContent = item.minusPoints;
    $('riskNoSuccess').textContent = item.minusPoints;
    $('riskNoFailure').textContent = `+${item.plusPoints}`;
    $('riskConfirmMessage').textContent = '';
    ensureDialogs();
    showDialog('riskConfirmDialog');
    return;
  }
  const choice = event.target.closest('[data-risk-choice]');
  if (choice) {
    joinRisk(choice.dataset.riskChoice);
    return;
  }
  const create = event.target.closest('[data-risk-admin-create]');
  if (create) {
    createRisk(create.dataset.riskAdminCreate, create);
    return;
  }
  const result = event.target.closest('[data-risk-set-result]');
  if (result) {
    setRiskOutcome(result.dataset.riskMatch, result.dataset.riskId, result.dataset.riskSetResult === 'true', result);
  }
});

function setupObservers() {
  const targets = [$('matchesList'), $('adminMatches')].filter(Boolean);
  for (const target of targets) {
    const observer = new MutationObserver(() => renderRiskUI());
    observer.observe(target, { childList: true, subtree: true });
  }
}

function syncSelectedGroup() {
  const next = $('leagueSelect')?.value || '';
  if (next && next !== groupCode) attachGroup(next);
  if (!next && groupCode) {
    groupGeneration++;
    groupCode = '';
    clearGroupListeners();
  }
}

installStyles();
ensureDialogs();
setupObservers();

onAuthStateChanged(auth, user => {
  uid = user?.uid || null;
  syncSelectedGroup();
});
$('leagueSelect')?.addEventListener('change', syncSelectedGroup);
setInterval(syncSelectedGroup, 700);
