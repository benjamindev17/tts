// ─── FIREBASE ─────────────────────────────────────────────────────────────────

import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.13.0/firebase-app.js';
import {
  getFirestore,
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
  deleteDoc,
  onSnapshot,
  serverTimestamp,
  query,
  where,
  arrayUnion,
} from 'https://www.gstatic.com/firebasejs/12.13.0/firebase-firestore.js';
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
  onAuthStateChanged,
} from 'https://www.gstatic.com/firebasejs/12.13.0/firebase-auth.js';

const firebaseConfig = {
  apiKey: 'AIzaSyCbb-aiF4tsijmfA_PQpukuimB6-aDBMqc',
  authDomain: 'jeu-tts.firebaseapp.com',
  projectId: 'jeu-tts',
  storageBucket: 'jeu-tts.firebasestorage.app',
  messagingSenderId: '512763827046',
  appId: '1:512763827046:web:70cb196aca8f3639cdeea7',
};

const fbApp = initializeApp(firebaseConfig);
const db   = getFirestore(fbApp);
const auth     = getAuth(fbApp);
const provider = new GoogleAuthProvider();
const pollsCol = collection(db, 'polls');

// ─── USER IDENTITY (localStorage) ────────────────────────────────────────────
// Each browser gets a persistent anonymous userId. The display name is asked
// once on first visit and can be changed from the dashboard.

const user = (() => {
  const anonId = (() => {
    let id = localStorage.getItem('picka_uid');
    if (!id) {
      id = 'u' + Date.now().toString(36) + Math.random().toString(36).slice(2, 9);
      localStorage.setItem('picka_uid', id);
    }
    return id;
  })();
  return {
    get id()      { return state?.googleUser?.uid ?? anonId; },
    get name()    { return state?.googleUser?.displayName ?? localStorage.getItem('picka_name') ?? ''; },
    set name(v)   { localStorage.setItem('picka_name', v); },
  };
})();

// ─── CONSTANTS ────────────────────────────────────────────────────────────────

const MONTHS = [
  'Janvier','Février','Mars','Avril','Mai','Juin',
  'Juillet','Août','Septembre','Octobre','Novembre','Décembre',
];
const DAYS = ['Lun','Mar','Mer','Jeu','Ven','Sam','Dim'];

// ─── STATE ────────────────────────────────────────────────────────────────────

const state = {
  view: 'loading',       // 'loading'|'welcome'|'dashboard'|'create'|'poll'
  myPolls: [],           // polls where creatorId === user.id
  myParticipations: [],  // polls where user.id ∈ participantIds (excl. created)
  pollCache: {},         // { [pollId]: pollData } — updated by onSnapshot
  currentPollId: null,
  pollTab: 'calendar',   // 'calendar' | 'results'
  calYear: new Date().getFullYear(),
  calMonth: new Date().getMonth(),
  creTitle: '',
  creDates: new Set(),
  voteName: '',
  voteSelections: {},    // dateKey -> 'available' | 'maybe'
  googleUser: null,      // null = non connecté, objet Firebase User = connecté
  editingPoll: false,    // owner edit mode
  editingVote: false,    // re-vote mode
  loading: false,
  unsubPoll: null,       // onSnapshot unsubscribe fn
};

// ─── UTILITIES ────────────────────────────────────────────────────────────────

const esc = (s) =>
  String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

function mkDate(year, month, day) {
  return `${year}-${String(month+1).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
}
function splitDate(key) {
  const [y,m,d] = key.split('-').map(Number);
  return { year:y, month:m-1, day:d };
}
function fmtShort(key) {
  const {year,month,day} = splitDate(key);
  return new Date(year,month,day).toLocaleDateString('fr-FR',{weekday:'short',day:'numeric',month:'short'});
}
function fmtLong(key) {
  const {year,month,day} = splitDate(key);
  const s = new Date(year,month,day).toLocaleDateString('fr-FR',{weekday:'long',day:'numeric',month:'long'});
  return s.charAt(0).toUpperCase()+s.slice(1);
}
function generatePollId() {
  return 'p'+Date.now().toString(36)+Math.random().toString(36).slice(2,7);
}
function sortByCreatedAt(arr) {
  return [...arr].sort((a,b) => {
    const ta = a.createdAt?.toMillis?.() ?? a.createdAt?.getTime?.() ?? 0;
    const tb = b.createdAt?.toMillis?.() ?? b.createdAt?.getTime?.() ?? 0;
    return tb - ta;
  });
}

// ─── TOAST ────────────────────────────────────────────────────────────────────

function showToast(msg) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.remove('hidden');
  void el.offsetWidth;
  el.classList.add('toast-visible');
  clearTimeout(el._timer);
  el._timer = setTimeout(() => {
    el.classList.remove('toast-visible');
    setTimeout(() => el.classList.add('hidden'), 260);
  }, 3000);
}

// ─── URL ROUTING ──────────────────────────────────────────────────────────────

function getUrlPollId() {
  return new URLSearchParams(window.location.search).get('id');
}
function pushUrlPoll(id) {
  history.pushState({ pollId: id }, '', `?id=${encodeURIComponent(id)}`);
}
function pushUrlHome() {
  history.pushState({ pollId: null }, '', location.pathname);
}
function getShareUrl(pollId) {
  return `${location.origin}${location.pathname}?id=${encodeURIComponent(pollId)}`;
}

window.addEventListener('popstate', () => {
  const id = getUrlPollId();
  if (id) {
    loadAndOpenPoll(id);
  } else {
    if (state.unsubPoll) { state.unsubPoll(); state.unsubPoll = null; }
    if (user.name) loadDashboard();
    else { state.view = 'welcome'; render(); }
  }
});

// ─── COMPUTED ─────────────────────────────────────────────────────────────────

function computeResults(poll) {
  return [...(poll.dates || [])].map((date) => {
    let score = 0;
    const participants = [];
    for (const [name, votes] of Object.entries(poll.votes || {})) {
      const s = votes[date];
      if (s === 'available') { score += 2; participants.push({name, status:'available'}); }
      else if (s === 'maybe')  { score += 1; participants.push({name, status:'maybe'}); }
    }
    return { date, score, participants };
  }).sort((a,b) => b.score - a.score);
}

// ─── FIRESTORE OPERATIONS ─────────────────────────────────────────────────────

async function loadDashboard() {
  state.loading = true;
  render();
  try {
    const [createdSnap, participatedSnap] = await Promise.all([
      getDocs(query(pollsCol, where('creatorId', '==', user.id))),
      getDocs(query(pollsCol, where('participantIds', 'array-contains', user.id))),
    ]);

    const createdIds = new Set();
    state.myPolls = sortByCreatedAt(createdSnap.docs.map((d) => {
      createdIds.add(d.id);
      const p = { id: d.id, ...d.data() };
      state.pollCache[d.id] = p;
      return p;
    }));
    state.myParticipations = sortByCreatedAt(
      participatedSnap.docs
        .filter((d) => !createdIds.has(d.id))
        .map((d) => {
          const p = { id: d.id, ...d.data() };
          state.pollCache[d.id] = p;
          return p;
        })
    );
  } catch (e) {
    console.error(e);
    showToast('Erreur de chargement.');
  }
  state.view = 'dashboard';
  state.loading = false;
  render();
}

async function loadAndOpenPoll(id) {
  // Use cache if already loaded
  if (state.pollCache[id]) { openPoll(id); return; }
  state.loading = true;
  render();
  try {
    const snap = await getDoc(doc(db, 'polls', id));
    if (!snap.exists()) {
      showToast('Sondage introuvable.');
      state.loading = false;
      if (user.name) { await loadDashboard(); } else { state.view = 'welcome'; render(); }
      return;
    }
    state.pollCache[id] = { id, ...snap.data() };
  } catch (e) {
    console.error(e);
    showToast('Erreur de chargement.');
    state.loading = false;
    render();
    return;
  }
  state.loading = false;
  openPoll(id);
}


// ─── CALENDAR COMPONENT ───────────────────────────────────────────────────────

function renderCalendar(mode, pollDates) {
  const y = state.calYear, m = state.calMonth;
  const firstDow = new Date(y,m,1).getDay();
  const offset   = firstDow === 0 ? 6 : firstDow - 1;
  const total    = new Date(y,m+1,0).getDate();

  const headers = DAYS.map(
    (d) => `<div class="text-center text-xs font-medium text-gray-400 py-0.5">${d}</div>`
  ).join('');

  let cells = '';
  for (let i = 0; i < offset; i++) cells += '<div></div>';

  for (let day = 1; day <= total; day++) {
    const key  = mkDate(y,m,day);
    const dow  = new Date(y,m,day).getDay();
    const isWE = dow === 0 || dow === 6;
    let cls = 'cal-cell ', attr = '';

    if (mode === 'create' || mode === 'edit') {
      cls += 'clickable cursor-pointer ';
      const selected = mode === 'edit' ? state.editDates.has(key) : state.creDates.has(key);
      if (selected)   cls += 'bg-indigo-500 text-white font-semibold shadow-sm shadow-indigo-200';
      else if (isWE)  cls += 'bg-gray-100 text-gray-500 hover:bg-indigo-100';
      else            cls += 'text-gray-700 hover:bg-indigo-100';
      attr = `data-date="${key}"`;
    } else {
      const proposed = Array.isArray(pollDates) && pollDates.includes(key);
      if (proposed) {
        cls += 'clickable cursor-pointer ';
        const vs = state.voteSelections[key];
        if (vs === 'available')       cls += 'bg-green-500 text-white font-semibold ring-2 ring-green-300';
        else if (vs === 'maybe')      cls += 'bg-orange-500 text-white font-semibold ring-2 ring-orange-200';
        else cls += (isWE ? 'bg-gray-100 ' : 'bg-white ') + 'text-gray-700 hover:bg-green-100 ring-2 ring-indigo-200';
        attr = `data-date="${key}"`;
      } else {
        cls += isWE ? 'bg-gray-50 text-gray-300' : 'text-gray-300';
      }
    }
    cells += `<div class="${cls}" ${attr}>${day}</div>`;
  }

  return `
    <div>
      <div class="flex items-center justify-between mb-4">
        <button id="cal-prev" class="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-gray-100 text-gray-500 text-xl transition select-none">&#8249;</button>
        <span class="text-sm font-semibold text-gray-800">${MONTHS[m]} ${y}</span>
        <button id="cal-next" class="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-gray-100 text-gray-500 text-xl transition select-none">&#8250;</button>
      </div>
      <div class="grid grid-cols-7 gap-1 mb-1">${headers}</div>
      <div class="grid grid-cols-7 gap-1">${cells}</div>
    </div>`;
}

// ─── VIEWS ────────────────────────────────────────────────────────────────────

function renderLoading() {
  return `
    <div class="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-50 via-white to-indigo-50">
      <div class="flex flex-col items-center gap-3 text-gray-400">
        <div class="w-8 h-8 border-2 border-indigo-200 border-t-indigo-500 rounded-full animate-spin"></div>
        <p class="text-sm">Chargement…</p>
      </div>
    </div>`;
}

function renderWelcome() {
  return `
    <div class="min-h-screen flex items-center justify-center
                bg-gradient-to-br from-slate-50 via-white to-indigo-50 p-4 fade-in">
      <div class="w-full max-w-sm">
        <div class="text-center mb-8">
          <div class="w-14 h-14 bg-indigo-500 rounded-2xl flex items-center justify-center
                      shadow-lg shadow-indigo-200 mx-auto mb-4">
            <svg class="w-7 h-7 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                    d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"/>
            </svg>
          </div>
          <h1 class="text-2xl font-bold text-gray-900">Picka</h1>
          <p class="text-sm text-gray-400 mt-1">Organisez vos événements facilement.</p>
        </div>
        <div class="bg-white rounded-2xl p-6 shadow-sm border border-gray-100">
          <h2 class="text-base font-semibold text-gray-800 mb-1">Bienvenue !</h2>
          <p class="text-sm text-gray-400 mb-4">Connectez-vous pour créer un sondage.</p>
          <button id="btn-google-signin"
                  class="w-full flex items-center justify-center gap-3 py-3 px-4
                         bg-white border border-gray-200 rounded-xl text-sm font-semibold
                         text-gray-700 hover:bg-gray-50 transition shadow-sm">
            <svg class="w-5 h-5" viewBox="0 0 24 24">
              <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
              <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
              <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
              <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
            </svg>
            Continuer avec Google
          </button>
        </div>
      </div>
    </div>`;
}

function pollCard(p) {
  const vc   = Object.keys(p.votes || {}).length;
  const dates = p.dates || [];
  const top  = dates.length > 0 ? computeResults(p)[0] : null;
  const chip = top && top.score > 0
    ? `<span class="text-xs text-green-600 bg-green-50 border border-green-100 px-2 py-0.5 rounded-full font-medium">${fmtShort(top.date)}</span>`
    : '';
  return `
    <div class="poll-item group flex items-center gap-4 p-4 bg-white rounded-2xl
                border border-indigo-200 shadow-sm hover:shadow-md transition-all cursor-pointer poll-card-shine"
         data-poll-id="${p.id}">
      <div class="flex-1 min-w-0">
        <p class="font-semibold text-gray-900 truncate">${esc(p.title)}</p>
        <div class="flex items-center gap-2 mt-1 flex-wrap">
          <p class="text-xs text-gray-400">
            ${dates.length} date${dates.length>1?'s':''} &middot; ${vc} participant${vc>1?'s':''}
            ${p.createdAt ? `&middot; Créé le ${(p.createdAt.toDate ? p.createdAt.toDate() : p.createdAt).toLocaleDateString('fr-FR', {day:'numeric', month:'short'})}` : ''}
          </p>
          ${chip}
        </div>
      </div>
      <svg class="w-4 h-4 text-gray-300 group-hover:text-indigo-400 transition flex-shrink-0"
           fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/>
      </svg>
    </div>`;
}

function renderDashboard() {
  const hasContent = state.myPolls.length > 0 || state.myParticipations.length > 0;

  return `
    <div class="min-h-screen bg-gradient-to-br from-slate-50 via-white to-indigo-50 p-4 fade-in">
      <div class="app-container">

        <!-- Header -->
        <header class="mb-8 pt-4 flex items-center justify-between">
          <div>
            <div class="flex items-center gap-2.5 mb-0.5">
              <div class="w-7 h-7 bg-indigo-500 rounded-lg flex items-center justify-center shadow-sm shadow-indigo-200">
                <svg class="w-3.5 h-3.5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                        d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"/>
                </svg>
              </div>
              <h1 class="text-xl font-bold text-gray-900 tracking-tight">Picka</h1>
            </div>
            <p class="text-xs text-gray-400 ml-9">Bonjour,
              <span class="font-medium text-gray-600">${esc(user.name)}</span>
            </p>
          </div>
          ${state.googleUser
            ? `<button id="btn-signout" title="Se déconnecter"
                      class="p-2 rounded-xl hover:bg-gray-100 transition text-gray-400 hover:text-gray-600">
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                        d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1"/>
                </svg>
              </button>`
            : `<button id="btn-edit-name" title="Modifier le prénom"
                      class="p-2 rounded-xl hover:bg-gray-100 transition text-gray-400 hover:text-gray-600">
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                        d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"/>
                </svg>
              </button>`
          }
        </header>

        <!-- Create button -->
        <button id="btn-create"
                class="btn-primary w-full flex items-center justify-center gap-2 py-3.5 px-6 mb-8">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M12 4v16m8-8H4"/>
          </svg>
          Créer un sondage
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 7l5 5m0 0l-5 5m5-5H6"/>
          </svg>
        </button>

        ${state.myPolls.length > 0 ? `
          <section class="mb-6">
            <h2 class="text-xs font-semibold text-gray-400 uppercase tracking-widest mb-3 px-1">
              Mes sondages
            </h2>
            <div class="space-y-2">${state.myPolls.map(pollCard).join('')}</div>
          </section>` : ''}

        ${state.myParticipations.length > 0 ? `
          <section class="mb-6">
            <h2 class="text-xs font-semibold text-gray-400 uppercase tracking-widest mb-3 px-1">
              Mes participations
            </h2>
            <div class="space-y-2">${state.myParticipations.map(pollCard).join('')}</div>
          </section>` : ''}

        ${!hasContent ? `
          <div class="text-center py-16 text-gray-300">
            <svg class="w-12 h-12 mx-auto mb-3 opacity-40" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"
                    d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"/>
            </svg>
            <p class="text-sm">Aucun sondage pour l'instant.</p>
            <p class="text-xs mt-1 opacity-60">Créez-en un ou ouvrez un lien partagé.</p>
          </div>` : ''}

      </div>
    </div>`;
}

function renderCreate() {
  const sorted = [...state.creDates].sort();
  const count  = sorted.length;
  const chips  = sorted.map((d) =>
    `<span class="inline-flex items-center bg-indigo-50 text-indigo-600 border border-indigo-100
                  text-xs font-medium px-2.5 py-1 rounded-full">${fmtShort(d)}</span>`
  ).join('');
  const btnOn  = 'btn-primary';
  const btnOff = 'bg-gray-100 text-gray-400 cursor-not-allowed';

  return `
    <div class="min-h-screen bg-gradient-to-br from-slate-50 via-white to-indigo-50 p-4 fade-in">
      <div class="app-container">

        <div class="flex items-center gap-3 mb-6 pt-2">
          <button id="btn-back"
                  class="w-9 h-9 flex items-center justify-center rounded-xl hover:bg-gray-100 transition text-gray-500">
            <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7"/>
            </svg>
          </button>
        </div>

        <div class="bg-white rounded-2xl p-5 shadow-sm border border-gray-100 mb-4">
          <label class="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
            Titre du sondage
          </label>
          <input id="poll-title" type="text" value="${esc(state.creTitle)}"
                 placeholder="Ex : Barbecue de l'été, Réunion d'équipe…"
                 class="w-full px-4 py-3 rounded-xl border border-gray-200
                        focus:outline-none focus:ring-2 focus:ring-indigo-300 focus:border-transparent
                        text-gray-800 placeholder-gray-300 text-sm transition">
        </div>

        <div class="bg-white rounded-2xl p-5 shadow-sm border border-gray-100 mb-4">
          <label class="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-4">
            Dates à proposer — cliquez pour sélectionner
          </label>
          ${renderCalendar('create', null)}
          ${count > 0 ? `
            <div class="mt-4 pt-4 border-t border-gray-50">
              <p class="text-xs text-gray-400 mb-2">
                ${count} date${count>1?'s':''} sélectionnée${count>1?'s':''}
              </p>
              <div class="flex flex-wrap gap-1.5">${chips}</div>
            </div>` : ''}
        </div>

        <button id="btn-save-poll" ${count===0?'disabled':''}
                class="w-full flex items-center justify-center gap-2
                       py-3.5 ${count>0?btnOn:btnOff}">
          Créer le sondage
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 7l5 5m0 0l-5 5m5-5H6"/>
          </svg>
        </button>

      </div>
    </div>`;
}

function renderPoll() {
  const poll = state.pollCache[state.currentPollId];
  if (!poll) { state.view = 'dashboard'; return renderDashboard(); }

  const results  = computeResults(poll);
  const vc       = Object.keys(poll.votes || {}).length;
  const shareUrl = getShareUrl(poll.id);
  const isOwner  = poll.creatorId === user.id;

  const maxScore = results.length > 0 ? Math.max(...results.map(r => r.score)) : 0;

  const resultItems = results.map(({date, score, participants}, idx) => {
    const badges = participants.map(({name, status}) =>
      `<span class="inline-flex items-center gap-0.5 text-xs px-2.5 py-0.5 rounded-full font-medium
                    ${status==='available'
                      ? 'bg-green-100 text-green-700 border border-green-200'
                      : 'bg-orange-100 text-orange-700 border border-orange-200'}">
        ${esc(name)}${status === 'maybe' ? '<span class="opacity-60">?</span>' : ''}
      </span>`
    ).join('');
    const availCount = participants.filter(p => p.status === 'available').length;
    const maybeCount = participants.filter(p => p.status === 'maybe').length;
    const totalVoters = vc || 1;
    const availPct = Math.round(availCount / totalVoters * 100);
    const maybePct = Math.round(maybeCount / totalVoters * 100);
    const isBest   = score > 0 && score === maxScore;
    const bar = `
      <div class="flex rounded-full overflow-hidden h-1.5 bg-gray-200 mt-2">
        ${availPct > 0 ? `<div style="width:${availPct}%" class="bg-green-500"></div>` : ''}
        ${maybePct > 0 ? `<div style="width:${maybePct}%" class="bg-orange-400"></div>` : ''}
      </div>`;
    return `
      <div class="p-3.5 rounded-xl bg-white transition-colors"
           style="border:1px solid #d1d5db;${isBest
             ? 'box-shadow:0 6px 24px rgba(34,197,94,0.30),0 2px 8px rgba(34,197,94,0.15)'
             : 'box-shadow:0 1px 4px rgba(0,0,0,0.05)'}">
        <div class="flex items-start justify-between gap-3 mb-2">
          <div class="flex items-center gap-2 min-w-0">
            <span class="text-xs font-bold text-gray-400 flex-shrink-0">${idx + 1}.</span>
            <p class="text-sm font-medium text-gray-800 leading-snug">${fmtLong(date)}</p>
          </div>
          <div class="flex items-center gap-1.5 flex-shrink-0">
            ${score > 0 ? `<span class="text-xs font-semibold ${isBest ? 'text-green-600' : 'text-gray-400'}">${availCount + maybeCount}/${vc}</span>` : ''}
            ${isBest ? `<span class="text-xs font-semibold text-green-600 bg-green-50 border border-green-200 px-2 py-0.5 rounded-full">Meilleure date</span>` : ''}
          </div>
        </div>
        ${participants.length > 0
          ? `<div class="flex flex-wrap gap-1">${badges}</div>${bar}`
          : '<p class="text-xs text-gray-400">Aucun vote</p>'}
      </div>`;
  }).join('');

  const hasVotedNow = !!(poll.voterNames?.[user.id]);
  const calendarTabHtml = (hasVotedNow && !state.editingVote)
    ? `<div class="space-y-4">
        <div class="relative bg-white rounded-2xl p-5 shadow-sm border border-gray-100">
          <div class="opacity-30 pointer-events-none select-none">${renderCalendar('vote', poll.dates)}</div>
          <div class="absolute inset-0 flex items-center justify-center rounded-2xl">
            <button id="btn-edit-vote" class="btn-primary flex items-center justify-center gap-2 px-6 py-3.5">
              Modifier mon vote
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 7l5 5m0 0l-5 5m5-5H6"/>
              </svg>
            </button>
          </div>
        </div>
      </div>`
    : `<div class="space-y-4">
        <div class="bg-white rounded-2xl p-5 shadow-sm border border-gray-100">
          <input id="voter-name" type="text" value="${esc(state.voteName)}"
                 placeholder="Votre prénom…"
                 class="w-full px-4 py-3 rounded-xl border border-gray-200
                        focus:outline-none focus:ring-2 focus:ring-indigo-300 focus:border-transparent
                        text-gray-800 placeholder-gray-300 text-sm transition mb-4">
          <div class="flex flex-wrap gap-4 text-xs text-gray-400 mb-4">
            <span class="flex items-center gap-1.5"><span class="w-2.5 h-2.5 rounded-full bg-green-400 inline-block"></span>1 clic = Disponible</span>
            <span class="flex items-center gap-1.5"><span class="w-2.5 h-2.5 rounded-full bg-orange-500 inline-block"></span>2 clics = Peut-être</span>
            <span class="flex items-center gap-1.5"><span class="w-2.5 h-2.5 rounded-full bg-gray-200 inline-block ring-2 ring-indigo-200"></span>3 clics = Indisponible</span>
          </div>
          ${renderCalendar('vote', poll.dates)}
        </div>
        <button id="btn-submit-vote" class="btn-primary w-full flex items-center justify-center gap-2 py-3.5">
          Valider mon vote
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M5 13l4 4L19 7"/>
          </svg>
        </button>
      </div>`;

  return `
    <div class="min-h-screen bg-gradient-to-br from-slate-50 via-white to-indigo-50 p-4 fade-in">
      <div class="app-container">

        <!-- Header -->
        <div class="flex items-start gap-3 mb-4 pt-2">
          <button id="btn-back"
                  class="w-9 h-9 flex-shrink-0 flex items-center justify-center rounded-xl hover:bg-gray-100 transition text-gray-500 mt-0.5">
            <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7"/>
            </svg>
          </button>
          <div class="flex-1 min-w-0">
            <div class="flex items-center gap-1.5">
              <h1 class="text-xl font-bold text-gray-900">${esc(poll.title)}</h1>
              ${isOwner ? `
              <button id="btn-edit-poll" title="Modifier le sondage"
                      class="w-6 h-6 flex items-center justify-center rounded-lg hover:bg-gray-100 transition text-gray-300 hover:text-indigo-400 flex-shrink-0">
                <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                        d="M15.232 5.232l3.536 3.536M9 13l6.586-6.586a2 2 0 012.828 2.828L11.828 15.828a2 2 0 01-1.414.586H9v-2a2 2 0 01.586-1.414z"/>
                </svg>
              </button>` : ''}
            </div>
            <p class="text-xs text-gray-400 mt-0.5">
              ${(poll.dates||[]).length} date${(poll.dates||[]).length>1?'s':''} proposée${(poll.dates||[]).length>1?'s':''}
              &middot; ${vc} participant${vc>1?'s':''}
              ${isOwner ? '<span class="text-indigo-400">&middot; Votre sondage</span>' : ''}
            </p>
          </div>
          ${isOwner ? `
          <button id="btn-delete-poll" title="Supprimer le sondage"
                  class="w-9 h-9 flex-shrink-0 flex items-center justify-center rounded-xl
                         hover:bg-red-50 transition text-gray-300 hover:text-red-400 mt-0.5">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                    d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/>
            </svg>
          </button>` : ''}
        </div>

        ${isOwner && state.editingPoll ? `
        <!-- Edit panel -->
        <div class="bg-white rounded-2xl p-5 shadow-sm border border-indigo-100 mb-4">
          <p class="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">Modifier le sondage</p>
          <input id="edit-poll-title" type="text" value="${esc(state.editTitle)}"
                 placeholder="Titre du sondage"
                 class="w-full px-4 py-2.5 rounded-xl border border-gray-200
                        focus:outline-none focus:ring-2 focus:ring-indigo-300 focus:border-transparent
                        text-gray-800 text-sm mb-4">
          <p class="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Dates proposées</p>
          ${renderCalendar('edit', null)}
          <div class="flex gap-2 mt-4">
            <button id="btn-cancel-edit"
                    class="flex-1 py-2.5 text-sm font-semibold rounded-xl border border-gray-200
                           bg-gray-50 hover:bg-gray-100 text-gray-600 transition">
              Annuler
            </button>
            <button id="btn-save-edit"
                    class="btn-primary flex-1 py-2.5 text-sm">
              Enregistrer
            </button>
          </div>
        </div>` : ''}

        <!-- Share button -->
        <button id="btn-copy-link"
                class="w-full flex items-center justify-center gap-2 mb-5
                       text-sm font-semibold text-indigo-600
                       bg-indigo-50 hover:bg-indigo-100 border border-indigo-100
                       px-4 py-2.5 rounded-xl transition">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                  d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1"/>
          </svg>
          Copier le lien du sondage
        </button>

        <!-- Tab bar -->
        <div class="flex bg-gray-100 p-1 rounded-2xl mb-5">
          <button id="btn-tab-cal"
                  class="flex-1 py-2.5 text-sm font-semibold rounded-xl transition-all
                         ${state.pollTab === 'calendar'
                           ? 'bg-white text-gray-900 shadow-sm'
                           : 'text-gray-400 hover:text-gray-600'}">
            Calendrier
          </button>
          <button id="btn-tab-res"
                  class="flex-1 flex items-center justify-center gap-2 py-2.5 text-sm font-semibold rounded-xl transition-all
                         ${state.pollTab === 'results'
                           ? 'bg-white text-gray-900 shadow-sm'
                           : 'text-gray-400 hover:text-gray-600'}">
            Disponibilités
            ${vc > 0 ? `<span class="text-xs font-bold px-1.5 py-0.5 rounded-full
                                    ${state.pollTab === 'results' ? 'bg-indigo-100 text-indigo-600' : 'bg-gray-200 text-gray-500'}">${vc}</span>` : ''}
          </button>
        </div>

        <!-- Tab content -->
        ${state.pollTab === 'calendar' ? calendarTabHtml : `
          <div class="bg-white rounded-2xl p-5 shadow-sm border border-gray-100">
            ${results.length > 0
              ? `<div class="space-y-2">${resultItems}</div>`
              : `<div class="text-center py-8 text-gray-300">
                   <svg class="w-10 h-10 mx-auto mb-2 opacity-40" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                     <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"
                           d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z"/>
                   </svg>
                   <p class="text-sm">Aucun vote pour l'instant.</p>
                 </div>`}
          </div>
        `}

      </div>
    </div>`;
}

// ─── EVENT BINDING ────────────────────────────────────────────────────────────

function attachEvents() {
  const $ = (id) => document.getElementById(id);

  // Welcome screen
  $('btn-google-signin')?.addEventListener('click', async () => {
    try {
      await signInWithPopup(auth, provider);
    } catch (e) {
      if (e.code !== 'auth/popup-closed-by-user') showToast('Erreur de connexion Google.');
    }
  });

  // Sign out
  $('btn-signout')?.addEventListener('click', async () => {
    await signOut(auth);
  });

  // Dashboard
  $('btn-create')?.addEventListener('click', () => {
    state.view = 'create';
    state.creTitle = '';
    state.creDates = new Set();
    resetCal();
    render();
  });

  $('btn-edit-name')?.addEventListener('click', () => {
    const name = prompt('Votre prénom :', user.name);
    if (name?.trim()) { user.name = name.trim(); render(); }
  });

  document.querySelectorAll('.poll-item').forEach((el) =>
    el.addEventListener('click', () => {
      const id = el.dataset.pollId;
      const existing = [...state.myPolls, ...state.myParticipations].find((p) => p.id === id);
      if (existing) state.pollCache[id] = existing;
      loadAndOpenPoll(id);
    })
  );

  // Back
  $('btn-back')?.addEventListener('click', () => backToDashboard());

  // Calendar nav
  $('cal-prev')?.addEventListener('click', () => {
    saveTempInputs();
    if (state.calMonth === 0) { state.calMonth = 11; state.calYear--; } else state.calMonth--;
    render();
  });
  $('cal-next')?.addEventListener('click', () => {
    saveTempInputs();
    if (state.calMonth === 11) { state.calMonth = 0; state.calYear++; } else state.calMonth++;
    render();
  });

  // Calendar day clicks
  document.querySelectorAll('.cal-cell[data-date]').forEach((el) =>
    el.addEventListener('click', () => {
      const date = el.dataset.date;
      saveTempInputs();
      if (state.view === 'create') {
        if (state.creDates.has(date)) state.creDates.delete(date); else state.creDates.add(date);
        render();
      } else if (state.view === 'poll' && state.editingPoll) {
        if (state.editDates.has(date)) state.editDates.delete(date); else state.editDates.add(date);
        render();
      } else if (state.view === 'poll') {
        const cur = state.voteSelections[date];
        if (!cur)               state.voteSelections[date] = 'available';
        else if (cur==='available') state.voteSelections[date] = 'maybe';
        else                    delete state.voteSelections[date];
        render();
      }
    })
  );

  // Create / vote / delete / edit
  $('btn-save-poll')?.addEventListener('click',   () => createPoll());
  $('btn-submit-vote')?.addEventListener('click', () => submitVote());
  $('btn-delete-poll')?.addEventListener('click', () => deletePoll());

  $('btn-edit-poll')?.addEventListener('click', () => {
    const poll = state.pollCache[state.currentPollId];
    state.editTitle   = poll.title;
    state.editDates   = new Set(poll.dates || []);
    state.editingPoll = true;
    const { year, month } = splitDate((poll.dates || [])[0] || mkDate(state.calYear, state.calMonth, 1));
    state.calYear = year; state.calMonth = month;
    render();
  });

  $('btn-cancel-edit')?.addEventListener('click', () => {
    state.editingPoll = false;
    render();
  });

  $('btn-edit-vote')?.addEventListener('click', () => {
    state.editingVote = true;
    render();
  });

  $('btn-save-edit')?.addEventListener('click', () => savePollEdit());

  // Poll tabs
  $('btn-tab-cal')?.addEventListener('click', () => {
    if (state.pollTab === 'calendar') return;
    saveTempInputs();
    state.pollTab = 'calendar';
    render();
  });
  $('btn-tab-res')?.addEventListener('click', () => {
    if (state.pollTab === 'results') return;
    saveTempInputs();
    state.pollTab = 'results';
    render();
  });
  $('btn-copy-link')?.addEventListener('click', () => {
    const url = getShareUrl(state.currentPollId);
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(url)
        .then(() => showToast('Lien copié dans le presse-papiers !'))
        .catch(() => fallbackCopy(url));
    } else {
      fallbackCopy(url);
    }
  });
}

// ─── FIRESTORE ACTIONS ────────────────────────────────────────────────────────

async function createPoll() {
  const title = (document.getElementById('poll-title')?.value ?? '').trim();
  if (!title) {
    const el = document.getElementById('poll-title');
    el?.focus(); el?.classList.add('ring-2','ring-red-300','border-red-200');
    return;
  }
  if (state.creDates.size === 0) { showToast('Sélectionnez au moins une date.'); return; }

  const id   = generatePollId();
  const data = {
    title,
    dates: [...state.creDates].sort(),
    votes: {},
    createdAt: serverTimestamp(),
    creatorId: user.id,
    creatorName: user.name,
    participantIds: [],
    voterNames: {},
  };

  const btn = document.getElementById('btn-save-poll');
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<div class="w-4 h-4 border-2 border-white/40 border-t-white rounded-full animate-spin"></div> Création…';
  }
  try {
    await setDoc(doc(db, 'polls', id), data);
    const poll = { id, ...data, createdAt: new Date() };
    state.pollCache[id] = poll;
    state.myPolls.unshift(poll);
    openPoll(id);
    showToast('Sondage créé ! Partagez le lien.');
  } catch (e) {
    console.error(e);
    showToast('Erreur Firestore — vérifiez les règles de sécurité.');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = 'Créer le sondage <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 7l5 5m0 0l-5 5m5-5H6"/></svg>';
    }
  }
}

function fallbackCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
  document.body.appendChild(ta);
  ta.focus(); ta.select();
  try {
    document.execCommand('copy');
    showToast('Lien copié dans le presse-papiers !');
  } catch {
    showToast('Impossible de copier automatiquement.');
  }
  ta.remove();
}

function showConfirmModal(message, onConfirm) {
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;z-index:999;opacity:0;transition:opacity 0.15s ease';
  overlay.innerHTML = `
    <div style="background:#fff;border-radius:1.25rem;padding:1.5rem;max-width:20rem;width:calc(100% - 2rem);
                box-shadow:0 20px 60px rgba(0,0,0,0.2);transform:scale(0.95);
                transition:transform 0.15s ease;text-align:center">
      <p style="font-size:0.9375rem;font-weight:600;color:#111827;margin-bottom:0.5rem">Supprimer le sondage ?</p>
      <p style="font-size:0.8125rem;color:#6b7280;margin-bottom:1.25rem">${message}</p>
      <div style="display:flex;gap:0.75rem">
        <button id="modal-cancel"
                style="flex:1;padding:0.625rem;border-radius:9999px;border:1px solid #e5e7eb;
                       background:#f9fafb;font-size:0.875rem;font-weight:600;color:#374151;cursor:pointer">
          Annuler
        </button>
        <button id="modal-confirm"
                style="flex:1;padding:0.625rem;border-radius:9999px;border:none;
                       background:#ef4444;font-size:0.875rem;font-weight:600;color:#fff;cursor:pointer">
          Supprimer
        </button>
      </div>
    </div>`;

  const remove = () => overlay.remove();
  const card   = overlay.querySelector('div');

  requestAnimationFrame(() => {
    overlay.style.opacity = '1';
    card.style.transform  = 'scale(1)';
  });

  overlay.addEventListener('click', (e) => { if (e.target === overlay) remove(); });
  overlay.querySelector('#modal-cancel').addEventListener('click', remove);
  overlay.querySelector('#modal-confirm').addEventListener('click', () => { remove(); onConfirm(); });

  document.body.appendChild(overlay);
}

async function deletePoll() {
  showConfirmModal('Cette action est irréversible.', async () => {
    const id = state.currentPollId;
    try {
      await deleteDoc(doc(db, 'polls', id));
      delete state.pollCache[id];
      state.myPolls = state.myPolls.filter((p) => p.id !== id);
      if (state.unsubPoll) { state.unsubPoll(); state.unsubPoll = null; }
      showToast('Sondage supprimé.');
      pushUrlHome();
      await loadDashboard();
    } catch (e) {
      console.error(e);
      showToast('Erreur lors de la suppression.');
    }
  });
}

async function savePollEdit() {
  const title = (document.getElementById('edit-poll-title')?.value ?? '').trim();
  if (!title) { document.getElementById('edit-poll-title')?.focus(); return; }
  if (state.editDates.size === 0) { showToast('Sélectionnez au moins une date.'); return; }

  const btn = document.getElementById('btn-save-edit');
  if (btn) { btn.disabled = true; btn.textContent = 'Enregistrement…'; }

  try {
    const dates = [...state.editDates].sort();
    await updateDoc(doc(db, 'polls', state.currentPollId), { title, dates });
    state.editingPoll = false;
    showToast('Sondage mis à jour !');
  } catch (e) {
    console.error(e);
    showToast('Erreur lors de la mise à jour.');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Enregistrer'; }
  }
}

async function submitVote() {
  const name = (document.getElementById('voter-name')?.value ?? '').trim();
  if (!name) {
    const el = document.getElementById('voter-name');
    el?.focus(); el?.classList.add('ring-2','ring-red-300','border-red-200');
    return;
  }

  const poll = state.pollCache[state.currentPollId];
  if (!poll) return;

  const voteObj = {};
  (poll.dates || []).forEach((d) => { if (state.voteSelections[d]) voteObj[d] = state.voteSelections[d]; });

  const btn = document.getElementById('btn-submit-vote');
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<div class="w-4 h-4 border-2 border-white/40 border-t-white rounded-full animate-spin"></div> Envoi…';
  }
  try {
    await updateDoc(doc(db, 'polls', state.currentPollId), {
      [`votes.${name}`]:       voteObj,
      [`voterNames.${user.id}`]: name,
      participantIds: arrayUnion(user.id),
    });
    if (name !== user.name) user.name = name;
    state.voteName = ''; state.voteSelections = {};
    state.pollTab    = 'results';
    state.editingVote = false;
    showToast(`Vote de ${name} enregistré !`);
    render();
  } catch (e) {
    console.error(e);
    showToast('Erreur lors du vote. Réessayez.');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = 'Valider mon vote <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M5 13l4 4L19 7"/></svg>';
    }
  }
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function openPoll(id) {
  if (state.unsubPoll) { state.unsubPoll(); state.unsubPoll = null; }

  state.currentPollId  = id;
  state.view           = 'poll';
  state.voteName       = user.name;
  state.voteSelections = {};
  state.editingPoll    = false;
  state.editingVote    = false;

  const poll = state.pollCache[id];
  const hasVoted = !!(poll?.voterNames?.[user.id]);
  state.pollTab = hasVoted ? 'results' : 'calendar';

  if (poll) {
    const voterName = poll.voterNames?.[user.id];
    if (voterName && poll.votes?.[voterName]) {
      state.voteSelections = { ...poll.votes[voterName] };
    }
  }
  if (poll?.dates?.length > 0) {
    const {year, month} = splitDate(poll.dates[0]);
    state.calYear = year; state.calMonth = month;
  } else { resetCal(); }

  // Update URL (enables sharing and browser history)
  if (getUrlPollId() !== id) pushUrlPoll(id);

  // Live results via Firestore
  state.unsubPoll = onSnapshot(doc(db, 'polls', id), (snap) => {
    if (!snap.exists()) return;
    state.pollCache[id] = { id, ...snap.data() };
    if (state.view === 'poll' && state.currentPollId === id) {
      saveTempInputs();
      render();
    }
  });

  render();
}

async function backToDashboard() {
  if (state.unsubPoll) { state.unsubPoll(); state.unsubPoll = null; }
  pushUrlHome();
  if (user.name) await loadDashboard();
  else { state.view = 'welcome'; render(); }
}

function resetCal() {
  state.calYear  = new Date().getFullYear();
  state.calMonth = new Date().getMonth();
}

function saveTempInputs() {
  const t = document.getElementById('poll-title');       if (t) state.creTitle  = t.value;
  const n = document.getElementById('voter-name');       if (n) state.voteName  = n.value;
  const e = document.getElementById('edit-poll-title');  if (e) state.editTitle = e.value;
  document.querySelectorAll('.cal-cell[data-date]').forEach((el) => {
    const date = el.dataset.date;
    if (el.classList.contains('bg-green-500'))       state.voteSelections[date] = 'available';
    else if (el.classList.contains('bg-orange-500')) state.voteSelections[date] = 'maybe';
  });
}

// ─── RENDER ───────────────────────────────────────────────────────────────────

function render() {
  const app = document.getElementById('app');
  if (!app) return;
  if (state.loading) { app.innerHTML = renderLoading(); return; }
  const sameView = app.dataset.view === state.view;
  switch (state.view) {
    case 'welcome':   app.innerHTML = renderWelcome();   break;
    case 'dashboard': app.innerHTML = renderDashboard(); break;
    case 'create':    app.innerHTML = renderCreate();    break;
    case 'poll':      app.innerHTML = renderPoll();      break;
    default:          app.innerHTML = renderLoading();
  }
  app.dataset.view = state.view;
  if (sameView && (state.view === 'poll' || state.view === 'create')) {
    app.querySelector('.fade-in')?.classList.remove('fade-in');
  }
  attachEvents();
}

// ─── INIT ─────────────────────────────────────────────────────────────────────

async function init() {
  onAuthStateChanged(auth, async (googleUser) => {
    state.googleUser = googleUser ?? null;
    const urlPollId = getUrlPollId();
    if (urlPollId) { await loadAndOpenPoll(urlPollId); return; }
    if (!state.googleUser) { state.view = 'welcome'; render(); return; }
    await loadDashboard();
  });
}

init();
