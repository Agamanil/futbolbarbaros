// FUTBOLBARBAROS - Firebase bağlantısı kurulduğunda ortak çevrimiçi veri kullanır.
// İlk kurulum için config.js dosyasını doldurun.
import { initializeApp } from 'https://www.gstatic.com/firebasejs/13.2.0/firebase-app.js';
import { getAuth, signInAnonymously, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/13.2.0/firebase-auth.js';
import { getFirestore, doc, getDoc, setDoc, collection, addDoc, getDocs, query, orderBy, onSnapshot, updateDoc, serverTimestamp, Timestamp } from 'https://www.gstatic.com/firebasejs/13.2.0/firebase-firestore.js';
import { firebaseConfig, ADMIN_UID, DEFAULT_GROUP_CODE } from './config.js';

const $ = id => document.getElementById(id);
const hasConfig = firebaseConfig && firebaseConfig.apiKey && firebaseConfig.projectId;
let auth, db, uid, player = null, groupCode = '', matches = [], players = [], activeMatch = null, unsubMatches, unsubPlayers;
const entryView=$('entryView'), appView=$('appView');
function message(el,text,isError=true){el.textContent=text;el.style.color=isError?'var(--red)':'var(--green)'}
function dateText(value){const d=value?.toDate?value.toDate():new Date(value);return d.toLocaleString('tr-TR',{dateStyle:'medium',timeStyle:'short'})}
function isLocked(m){const kickoff=m.kickoff?.toDate?m.kickoff.toDate():new Date(m.kickoff);return Date.now()>=kickoff.getTime()}
function safe(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function showApp(){entryView.classList.add('hidden');appView.classList.remove('hidden');$('userBadge').textContent=player.name+' | UID: '+uid;$('userBadge').classList.remove('hidden');$('welcomeName').textContent=player.name;document.querySelectorAll('.admin-only').forEach(x=>x.classList.toggle('hidden',uid!==ADMIN_UID));}
function showEntry(){appView.classList.add('hidden');entryView.classList.remove('hidden')}
async function boot(){if(!hasConfig){message($('entryMessage'),'Kurulum eksik: config.js içine Firebase ayarları eklenmeli. README dosyasına bak.',true);return}
 const app=initializeApp(firebaseConfig);auth=getAuth(app);db=getFirestore(app);
 await signInAnonymously(auth);
console.log("BENİM UID:", user.uid);
                      onAuthStateChanged(auth,async user=>{if(!user)return;uid=user.uid;console.log("BENİM UID:", uid);const saved=localStorage.getItem('fb_player');if(saved){try{const p=JSON.parse(saved);const snap=await getDoc(doc(db,'groups',p.groupCode,'players',uid));if(snap.exists()){player=snap.data();groupCode=p.groupCode;showApp();listen();return}else localStorage.removeItem('fb_player')}catch(e){console.error(e)}}});
}
$('joinForm').addEventListener('submit',async e=>{e.preventDefault();if(!db)return message($('entryMessage'),'Önce Firebase kurulumu tamamlanmalı.');const code=$('groupCode').value.trim().toUpperCase(),name=$('playerName').value.trim();if(!code||!name)return;
 try{const g=await getDoc(doc(db,'groups',code));if(!g.exists())throw Error('Bu grup koduyla bir lig bulunamadı. Kodu yöneticinden kontrol et.');const ref=doc(db,'groups',code,'players',uid),existing=await getDoc(ref);if(existing.exists()&&existing.data().name!==name)throw Error('Bu cihaz başka bir oyuncu adına kayıtlı.');if(!existing.exists()){const all=await getDocs(collection(db,'groups',code,'players'));if(all.docs.some(d=>d.data().name.toLowerCase()===name.toLowerCase()))throw Error('Bu oyuncu adı zaten kullanılıyor.');await setDoc(ref,{name,uid,joinedAt:serverTimestamp(),points:0});}player={name,uid};groupCode=code;localStorage.setItem('fb_player',JSON.stringify({groupCode:code}));showApp();listen();}catch(err){message($('entryMessage'),err.message||'Giriş yapılamadı.');}
});
function listen(){if(unsubMatches)unsubMatches();if(unsubPlayers)unsubPlayers();unsubMatches=onSnapshot(query(collection(db,'groups',groupCode,'matches'),orderBy('kickoff','asc')),s=>{matches=s.docs.map(d=>({id:d.id,...d.data()}));renderMatches();renderAdminMatches();});unsubPlayers=onSnapshot(collection(db,'groups',groupCode,'players'),s=>{players=s.docs.map(d=>({id:d.id,...d.data()}));renderTable();});}
function predictionFor(m){return m.predictions?.[uid]}
function renderMatches(){ $('matchCount').textContent=`${matches.length} MAÇ`;const el=$('matchesList');if(!matches.length){el.innerHTML='<div class="empty">Henüz maç eklenmedi. Yönetici fikstürü hazırlıyor.</div>';return;}el.innerHTML=matches.map(m=>{const p=predictionFor(m),locked=isLocked(m),result=m.homeScore!==undefined;return `<article class="match-card"><div><div class="match-meta">${safe(m.competition||'FUTBOL')} · ${dateText(m.kickoff)} ${locked?'· KİLİTLİ':''}</div><div class="teams"><span>${safe(m.homeTeam)}</span><span class="vs">VS</span><span>${safe(m.awayTeam)}</span></div></div><div class="match-actions"><div class="prediction-label">${p?`Tahminin: <b>${p.home}-${p.away}</b>`:'Henüz tahmin yok'}${result?`<br>Sonuç: <b>${m.homeScore}-${m.awayScore}</b>`:''}</div><button class="small-btn" data-predict="${m.id}" ${locked?'disabled':''}>${locked?'Kilitli':p?'Düzenle':'Tahmin et'}</button></div></article>`}).join('');el.querySelectorAll('[data-predict]').forEach(b=>b.addEventListener('click',()=>openPrediction(b.dataset.predict)));}
function openPrediction(id){activeMatch=matches.find(m=>m.id===id);if(!activeMatch||isLocked(activeMatch))return;const p=predictionFor(activeMatch);$('predictionTitle').textContent=`${activeMatch.homeTeam} - ${activeMatch.awayTeam}`;$('predictionKickoff').textContent=dateText(activeMatch.kickoff);$('homePrediction').value=p?.home??'';$('awayPrediction').value=p?.away??'';message($('predictionMessage'),'');$('predictionDialog').showModal();}
$('predictionForm').addEventListener('submit',async e=>{e.preventDefault();if(!activeMatch||isLocked(activeMatch))return message($('predictionMessage'),'Maç başladı, tahmin kapandı.');const h=Number($('homePrediction').value),a=Number($('awayPrediction').value);if(!Number.isInteger(h)||!Number.isInteger(a)||h<0||a<0||h>30||a>30)return message($('predictionMessage'),'0 ile 30 arasında tam sayı gir.');try{const ref=doc(db,'groups',groupCode,'matches',activeMatch.id);await updateDoc(ref,{[`predictions.${uid}`]:{home:h,away:a,playerName:player.name,updatedAt:Date.now()}});$('predictionDialog').close();}catch(err){message($('predictionMessage'),'Tahmin kaydedilemedi.');}});
function pointsFor(m,p){if(m.homeScore===undefined||m.awayScore===undefined||!p)return 0;if(p.home===m.homeScore&&p.away===m.awayScore)return 3;const actual=Math.sign(m.homeScore-m.awayScore),guess=Math.sign(p.home-p.away);return actual===guess?1:0;}
function renderTable(){const totals=players.map(p=>{let pts=0,played=0;for(const m of matches){const pred=m.predictions?.[p.id];if(m.homeScore!==undefined&&m.awayScore!==undefined){played++;pts+=pointsFor(m,pred)}}return {...p,pts,played}}).sort((a,b)=>b.pts-a.pts||a.name.localeCompare(b.name,'tr'));$('leaderboard').innerHTML=totals.length?totals.map((p,i)=>`<tr><td>${i+1}</td><td>${safe(p.name)}${p.id===uid?' <span style="color:var(--green)">(Sen)</span>':''}</td><td>${p.played}</td><td>${p.pts}</td></tr>`).join(''):'<tr><td colspan="4" class="empty">Henüz oyuncu yok.</td></tr>';}
$('matchForm').addEventListener('submit',async e=>{e.preventDefault();if(uid!==ADMIN_UID)return alert('Yönetici yetkisi yok.');const kickoff=new Date($('kickoff').value);if(!Number.isFinite(kickoff.getTime())||kickoff<=new Date())return alert('Maç tarihi gelecekte olmalı.');try{await addDoc(collection(db,'groups',groupCode,'matches'),{homeTeam:$('homeTeam').value.trim(),awayTeam:$('awayTeam').value.trim(),competition:$('competition').value.trim()||'Futbol',kickoff:Timestamp.fromDate(kickoff),createdAt:serverTimestamp(),createdBy:uid,predictions:{}});e.target.reset();}catch(err){alert('Maç eklenemedi: '+err.message)}});
function renderAdminMatches(){const el=$('adminMatches');if(!matches.length){el.innerHTML='<div class="empty">Henüz maç yok.</div>';return;}el.innerHTML=matches.map(m=>`<article class="match-card"><div><div class="match-meta">${dateText(m.kickoff)}</div><div class="teams"><span>${safe(m.homeTeam)}</span><span class="vs">VS</span><span>${safe(m.awayTeam)}</span></div></div><div class="match-actions">${m.homeScore!==undefined?`<b>${m.homeScore} - ${m.awayScore}</b>`:`<input aria-label="Ev sahibi skoru" id="h-${m.id}" type="number" min="0" placeholder="Ev" style="width:62px"><input aria-label="Deplasman skoru" id="a-${m.id}" type="number" min="0" placeholder="Dep" style="width:62px"><button class="small-btn" data-result="${m.id}">Sonucu kaydet</button>`}</div></article>`).join('');el.querySelectorAll('[data-result]').forEach(b=>b.addEventListener('click',async()=>{const id=b.dataset.result,m=matches.find(x=>x.id===id),h=Number($(`h-${id}`).value),a=Number($(`a-${id}`).value);if(!isLocked(m))return alert('Maç başlamadan sonuç girilemez.');if(!Number.isInteger(h)||!Number.isInteger(a)||h<0||a<0)return alert('İki skoru da gir.');await updateDoc(doc(db,'groups',groupCode,'matches',id),{homeScore:h,awayScore:a,resultAt:serverTimestamp()});}));}
document.querySelectorAll('.tab').forEach(b=>b.addEventListener('click',()=>{document.querySelectorAll('.tab').forEach(x=>x.classList.toggle('active',x===b));['matches','table','admin'].forEach(t=>$(`${t}Tab`).classList.toggle('hidden',t!==b.dataset.tab));}));
$('leaveButton').addEventListener('click',()=>{if(confirm('Bu cihazdaki oyuncu kaydını sıfırlamak istiyor musun? Aynı anonim hesap Firebase tarafında kalır.')){localStorage.removeItem('fb_player');location.reload();}});
$('editNameButton').addEventListener('click', () => {
  $('newPlayerName').value = player.name;
  message($('nameMessage'), '');
  $('nameDialog').showModal();
});

$('closeNameDialog').addEventListener('click', () => {
  $('nameDialog').close();
});

$('nameForm').addEventListener('submit', async e => {
  e.preventDefault();

  const newName = $('newPlayerName').value.trim();

  if (newName.length < 2 || newName.length > 18) {
    return message($('nameMessage'), 'İsim 2-18 karakter arasında olmalı.');
  }

  if (newName === player.name) {
    return $('nameDialog').close();
  }

  try {
    const all = await getDocs(
      collection(db, 'groups', groupCode, 'players')
    );

    const duplicate = all.docs.some(d =>
      d.id !== uid &&
      d.data().name.toLowerCase() === newName.toLowerCase()
    );

    if (duplicate) {
      return message($('nameMessage'), 'Bu oyuncu adı zaten kullanılıyor.');
    }

    await updateDoc(
      doc(db, 'groups', groupCode, 'players', uid),
      { name: newName }
    );

    player.name = newName;
    showApp();
    renderTable();
    $('nameDialog').close();

  } catch (err) {
    console.error(err);
    message($('nameMessage'), 'İsim değiştirilemedi: ' + err.message);
  }
});
boot().catch(e=>{console.error(e);message($('entryMessage'),'Firebase başlatılamadı. README kurulum adımlarını kontrol et.');});
