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
  const part = type => parts.find(p => p.type === type)?.
