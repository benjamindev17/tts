// ─── FIREBASE ─────────────────────────────────────────────────────────────────

import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import {
  getFirestore,
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
  onSnapshot,
  serverTimestamp,
  query,
  where,
  arrayUnion,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';

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
const pollsCol = collection(db, 'polls');

// ─── USER IDENTITY (localStorage) ────────────────────────────────────────────
// Each browser gets a persistent anonymous userId. The display name is asked
// once on first visit and can be changed from the dashboard.

const user = (() => {
  let id = localStorage.getItem('doodle_uid');
  if (!id) {
    id = 'u' + Date.now().toString(36) + Math.random().toString(36).slice(2, 9);
    localStorage.setItem('doodle_uid', id);
  }
  return {
    id,
    get name()    { return localStorage.getItem('doodle_name') || ''; },
    set name(v)   { localStorage.setItem('doodle_name', v); },
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
  calYear: new Date().getFullYear(),
  calMonth: new Date().getMonth(),
  creTitle: '',
  creDates: new Set(),
  voteName: '',
  voteSelections: {},    // dateKey -> 'available' | 'maybe'
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
function uid() {
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

async function seedDefaultPoll() {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth();
  const data = {
    title: "Barbecue de l'été",
    dates: [mkDate(y,m,8), mkDate(y,m,9), mkDate(y,m,15), mkDate(y,m,22)],
    votes: {
      Alice:  { [mkDate(y,m,8)]:'available', [mkDate(y,m,9)]:'maybe',     [mkDate(y,m,15)]:'available' },
      Bob:    { [mkDate(y,m,8)]:'maybe',     [mkDate(y,m,15)]:'available', [mkDate(y,m,22)]:'available' },
      Claire: { [mkDate(y,m,8)]:'available', [mkDate(y,m,9)]:'available',  [mkDate(y,m,22)]:'maybe'     },
    },
    createdAt: serverTimestamp(),
    creatorId: user.id,
    creatorName: user.name,
    participantIds: [],
    voterNames: {},
  };
  await setDoc(doc(db, 'polls', 'default'), data);
  const poll = { id: 'default', ...data, createdAt: now };
  state.pollCache['default'] = poll;
  state.myPolls.unshift(poll);
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

    if (mode === 'create') {
      cls += 'clickable cursor-pointer ';
      if (state.creDates.has(key))   cls += 'bg-indigo-500 text-white font-semibold shadow-sm shadow-indigo-200';
      else if (isWE)                 cls += 'bg-gray-100 text-gray-500 hover:bg-indigo-100';
      else                           cls += 'text-gray-700 hover:bg-indigo-100';
      attr = `data-date="${key}"`;
    } else {
      const proposed = Array.isArray(pollDates) && pollDates.includes(key);
      if (proposed) {
        cls += 'clickable cursor-pointer ';
        const vs = state.voteSelections[key];
        if (vs === 'available')       cls += 'bg-green-500 text-white font-semibold ring-2 ring-green-200';
        else if (vs === 'maybe')      cls += 'bg-orange-400 text-white font-semibold ring-2 ring-orange-200';
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
          <h1 class="text-2xl font-bold text-gray-900">Doodle</h1>
          <p class="text-sm text-gray-400 mt-1">Organisez vos événements facilement.</p>
        </div>
        <div class="bg-white rounded-2xl p-6 shadow-sm border border-gray-100">
          <h2 class="text-base font-semibold text-gray-800 mb-1">Bienvenue !</h2>
          <p class="text-sm text-gray-400 mb-4">Comment vous appelez-vous ?</p>
          <input id="welcome-name" type="text" placeholder="Votre prénom…" autofocus
                 class="w-full px-4 py-3 rounded-xl border border-gray-200
                        focus:outline-none focus:ring-2 focus:ring-indigo-300 focus:border-transparent
                        text-gray-800 placeholder-gray-300 text-sm transition mb-3">
          <button id="btn-welcome-go"
                  class="w-full bg-indigo-500 hover:bg-indigo-600 active:bg-indigo-700
                         text-white font-semibold py-3 rounded-xl transition-all
                         shadow-sm hover:shadow-lg hover:shadow-indigo-200">
            Commencer
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
                border border-gray-100 hover:border-indigo-200 hover:shadow-md transition-all cursor-pointer"
         data-poll-id="${p.id}">
      <div class="flex-1 min-w-0">
        <p class="font-semibold text-gray-900 truncate">${esc(p.title)}</p>
        <div class="flex items-center gap-2 mt-1 flex-wrap">
          <p class="text-xs text-gray-400">
            ${dates.length} date${dates.length>1?'s':''} &middot; ${vc} participant${vc>1?'s':''}
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
    <div class="min-h-screen bg-gradient-to-br from-slate-50 via-white to-indigo-50 p-4 md:p-8 fade-in">
      <div class="max-w-md mx-auto">

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
              <h1 class="text-xl font-bold text-gray-900 tracking-tight">Doodle</h1>
            </div>
            <p class="text-xs text-gray-400 ml-9">Bonjour,
              <span class="font-medium text-gray-600">${esc(user.name)}</span>
            </p>
          </div>
          <button id="btn-edit-name" title="Modifier le prénom"
                  class="p-2 rounded-xl hover:bg-gray-100 transition text-gray-400 hover:text-gray-600">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                    d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"/>
            </svg>
          </button>
        </header>

        <!-- Create button -->
        <button id="btn-create"
                class="w-full flex items-center justify-center gap-2 bg-indigo-500 hover:bg-indigo-600
                       active:bg-indigo-700 text-white font-semibold py-3.5 px-6 rounded-2xl
                       transition-all shadow-sm hover:shadow-lg hover:shadow-indigo-200 mb-8">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M12 4v16m8-8H4"/>
          </svg>
          Créer un sondage
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
  const btnOn  = 'bg-indigo-500 hover:bg-indigo-600 active:bg-indigo-700 text-white shadow-sm hover:shadow-lg hover:shadow-indigo-200';
  const btnOff = 'bg-gray-100 text-gray-400 cursor-not-allowed';

  return `
    <div class="min-h-screen bg-gradient-to-br from-slate-50 via-white to-indigo-50 p-4 md:p-8 fade-in">
      <div class="max-w-md mx-auto">

        <div class="flex items-center gap-3 mb-6 pt-2">
          <button id="btn-back"
                  class="w-9 h-9 flex items-center justify-center rounded-xl hover:bg-gray-100 transition text-gray-500">
            <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7"/>
            </svg>
          </button>
          <h1 class="text-xl font-bold text-gray-900">Nouveau sondage</h1>
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
                class="w-full flex items-center justify-center gap-2 font-semibold
                       py-3.5 rounded-2xl transition-all ${count>0?btnOn:btnOff}">
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

  const resultItems = results.map(({date, score, participants}) => {
    const badges = participants.map(({name, status}) =>
      `<span class="inline-flex items-center text-xs px-2.5 py-0.5 rounded-full font-medium
                    ${status==='available'
                      ? 'bg-green-100 text-green-700 border border-green-200'
                      : 'bg-orange-100 text-orange-700 border border-orange-200'}">${esc(name)}</span>`
    ).join('');
    const scoreTag =
      score >= 4 ? 'text-green-600 bg-green-50 border border-green-100' :
      score >= 2 ? 'text-orange-500 bg-orange-50 border border-orange-100' :
                   'text-gray-400 bg-gray-50 border border-gray-100';
    return `
      <div class="p-3.5 rounded-xl bg-gray-50 hover:bg-gray-100 transition-colors">
        <div class="flex items-start justify-between gap-3 mb-2">
          <p class="text-sm font-medium text-gray-800 leading-snug">${fmtLong(date)}</p>
          <span class="text-xs font-bold px-2 py-0.5 rounded-full flex-shrink-0 ${scoreTag}">
            ${score} pt${score>1?'s':''}
          </span>
        </div>
        ${participants.length > 0
          ? `<div class="flex flex-wrap gap-1">${badges}</div>`
          : '<p class="text-xs text-gray-400">Aucun vote</p>'}
      </div>`;
  }).join('');

  return `
    <div class="min-h-screen bg-gradient-to-br from-slate-50 via-white to-indigo-50 p-4 md:p-8 fade-in">
      <div class="max-w-5xl mx-auto">

        <!-- Header -->
        <div class="flex items-start gap-3 mb-4 pt-2">
          <button id="btn-back"
                  class="w-9 h-9 flex-shrink-0 flex items-center justify-center rounded-xl
                         hover:bg-gray-100 transition text-gray-500 mt-0.5">
            <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7"/>
            </svg>
          </button>
          <div class="flex-1 min-w-0">
            <h1 class="text-xl font-bold text-gray-900">${esc(poll.title)}</h1>
            <p class="text-xs text-gray-400 mt-0.5">
              ${(poll.dates||[]).length} date${(poll.dates||[]).length>1?'s':''} proposée${(poll.dates||[]).length>1?'s':''}
              &middot; ${vc} participant${vc>1?'s':''}
              ${isOwner ? '<span class="text-indigo-400">&middot; Votre sondage</span>' : ''}
            </p>
          </div>
        </div>

        <!-- Share URL banner -->
        <div class="bg-indigo-50 border border-indigo-100 rounded-xl px-4 py-3
                    flex items-center gap-3 mb-5">
          <svg class="w-4 h-4 text-indigo-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                  d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1"/>
          </svg>
          <span class="text-xs text-indigo-600 font-mono truncate flex-1 select-all">${esc(shareUrl)}</span>
          <button id="btn-copy-link"
                  class="text-xs font-semibold text-indigo-600 hover:text-indigo-800
                         bg-white border border-indigo-200 hover:border-indigo-400
                         px-3 py-1.5 rounded-lg transition flex-shrink-0">
            Copier
          </button>
        </div>

        <!-- Content grid -->
        <div class="grid grid-cols-1 lg:grid-cols-2 gap-5">

          <!-- LEFT : Vote -->
          <div class="space-y-4">
            <div class="bg-white rounded-2xl p-5 shadow-sm border border-gray-100">
              <h2 class="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-4">Votre vote</h2>
              <input id="voter-name" type="text" value="${esc(state.voteName)}"
                     placeholder="Votre prénom…"
                     class="w-full px-4 py-3 rounded-xl border border-gray-200
                            focus:outline-none focus:ring-2 focus:ring-indigo-300 focus:border-transparent
                            text-gray-800 placeholder-gray-300 text-sm transition mb-4">
              <div class="flex flex-wrap gap-4 text-xs text-gray-400 mb-4">
                <span class="flex items-center gap-1.5">
                  <span class="w-2.5 h-2.5 rounded-full bg-green-400 inline-block"></span>Disponible
                </span>
                <span class="flex items-center gap-1.5">
                  <span class="w-2.5 h-2.5 rounded-full bg-orange-400 inline-block"></span>Peut-être
                </span>
                <span class="flex items-center gap-1.5">
                  <span class="w-2.5 h-2.5 rounded-full bg-gray-200 inline-block ring-2 ring-indigo-200"></span>Indisponible
                </span>
              </div>
              ${renderCalendar('vote', poll.dates)}
            </div>
            <button id="btn-submit-vote"
                    class="w-full flex items-center justify-center gap-2 bg-indigo-500 hover:bg-indigo-600
                           active:bg-indigo-700 text-white font-semibold py-3.5 rounded-2xl
                           transition-all shadow-sm hover:shadow-lg hover:shadow-indigo-200">
              Valider mon vote
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M5 13l4 4L19 7"/>
              </svg>
            </button>
          </div>

          <!-- RIGHT : Results (live via onSnapshot) -->
          <div>
            <div class="bg-white rounded-2xl p-5 shadow-sm border border-gray-100">
              <h2 class="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-4">
                Participants &amp; disponibilités
              </h2>
              ${results.length > 0
                ? `<div class="space-y-2">${resultItems}</div>`
                : '<p class="text-sm text-gray-400">Aucune date proposée.</p>'}
            </div>
          </div>

        </div>
      </div>
    </div>`;
}

// ─── EVENT BINDING ────────────────────────────────────────────────────────────

function attachEvents() {
  const $ = (id) => document.getElementById(id);

  // Welcome screen
  if ($('btn-welcome-go')) {
    const go = async () => {
      const name = ($('welcome-name')?.value ?? '').trim();
      if (!name) { $('welcome-name')?.focus(); return; }
      user.name = name;
      await loadDashboard();
      // Seed demo poll only on first ever use
      if (!localStorage.getItem('doodle_seeded') && state.myPolls.length === 0) {
        localStorage.setItem('doodle_seeded', '1');
        await seedDefaultPoll();
        render();
      }
    };
    $('btn-welcome-go').addEventListener('click', go);
    $('welcome-name')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  }

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
      } else if (state.view === 'poll') {
        const cur = state.voteSelections[date];
        if (!cur)               state.voteSelections[date] = 'available';
        else if (cur==='available') state.voteSelections[date] = 'maybe';
        else                    delete state.voteSelections[date];
        render();
      }
    })
  );

  // Create / vote / copy
  $('btn-save-poll')?.addEventListener('click',   () => createPoll());
  $('btn-submit-vote')?.addEventListener('click', () => submitVote());
  $('btn-copy-link')?.addEventListener('click',   () => {
    navigator.clipboard.writeText(getShareUrl(state.currentPollId))
      .then(() => showToast('Lien copié dans le presse-papiers !'))
      .catch(() => showToast('Impossible de copier automatiquement.'));
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

  const id   = uid();
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

  try {
    await updateDoc(doc(db, 'polls', state.currentPollId), {
      [`votes.${name}`]:       voteObj,          // vote data (keyed by display name)
      [`voterNames.${user.id}`]: name,           // userId -> display name mapping
      participantIds: arrayUnion(user.id),       // enables dashboard "participations" query
    });
    // Persist name for future visits
    if (name !== user.name) user.name = name;
    state.voteName = ''; state.voteSelections = {};
    showToast(`Vote de ${name} enregistré !`);
    render(); // clear form; onSnapshot refreshes results
  } catch (e) {
    console.error(e);
    showToast('Erreur lors du vote. Réessayez.');
  }
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function openPoll(id) {
  if (state.unsubPoll) { state.unsubPoll(); state.unsubPoll = null; }

  state.currentPollId = id;
  state.view          = 'poll';
  state.voteName      = user.name;
  state.voteSelections = {};

  const poll = state.pollCache[id];
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
  const t = document.getElementById('poll-title');  if (t) state.creTitle = t.value;
  const n = document.getElementById('voter-name');  if (n) state.voteName  = n.value;
}

// ─── RENDER ───────────────────────────────────────────────────────────────────

function render() {
  const app = document.getElementById('app');
  if (!app) return;
  if (state.loading) { app.innerHTML = renderLoading(); return; }
  switch (state.view) {
    case 'welcome':   app.innerHTML = renderWelcome();   break;
    case 'dashboard': app.innerHTML = renderDashboard(); break;
    case 'create':    app.innerHTML = renderCreate();    break;
    case 'poll':      app.innerHTML = renderPoll();      break;
    default:          app.innerHTML = renderLoading();
  }
  attachEvents();
}

// ─── INIT ─────────────────────────────────────────────────────────────────────

async function init() {
  const urlPollId = getUrlPollId();

  // Direct link → open poll immediately (even without a name)
  if (urlPollId) {
    await loadAndOpenPoll(urlPollId);
    return;
  }

  // First visit → ask for name
  if (!user.name) {
    state.view = 'welcome';
    render();
    return;
  }

  await loadDashboard();
}

init();
