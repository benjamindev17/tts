// ─── FIREBASE ─────────────────────────────────────────────────────────────────

import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import {
  getFirestore,
  collection,
  doc,
  getDocs,
  setDoc,
  updateDoc,
  onSnapshot,
  serverTimestamp,
  query,
  orderBy,
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
const db = getFirestore(fbApp);
const pollsCol = collection(db, 'polls');

// ─── CONSTANTS ────────────────────────────────────────────────────────────────

const MONTHS = [
  'Janvier', 'Février', 'Mars', 'Avril', 'Mai', 'Juin',
  'Juillet', 'Août', 'Septembre', 'Octobre', 'Novembre', 'Décembre',
];
const DAYS = ['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim'];

// ─── STATE ────────────────────────────────────────────────────────────────────

const state = {
  view: 'dashboard',   // 'dashboard' | 'create' | 'poll'
  polls: [],
  currentPollId: null,
  calYear: new Date().getFullYear(),
  calMonth: new Date().getMonth(),
  creTitle: '',
  creDates: new Set(),
  voteName: '',
  voteSelections: {},  // dateKey -> 'available' | 'maybe'
  loading: false,
  unsubPoll: null,     // onSnapshot unsubscribe fn for the current poll
};

// ─── UTILITIES ────────────────────────────────────────────────────────────────

const esc = (s) =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

function mkDate(year, month, day) {
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function splitDate(key) {
  const [y, m, d] = key.split('-').map(Number);
  return { year: y, month: m - 1, day: d };
}

function fmtShort(key) {
  const { year, month, day } = splitDate(key);
  return new Date(year, month, day)
    .toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' });
}

function fmtLong(key) {
  const { year, month, day } = splitDate(key);
  const s = new Date(year, month, day)
    .toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function uid() {
  return 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function showToast(msg) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.remove('hidden');
  void el.offsetWidth; // force reflow so CSS transition fires
  el.classList.add('toast-visible');
  clearTimeout(el._timer);
  el._timer = setTimeout(() => {
    el.classList.remove('toast-visible');
    setTimeout(() => el.classList.add('hidden'), 260);
  }, 3000);
}

// ─── COMPUTED ─────────────────────────────────────────────────────────────────

function computeResults(poll) {
  return [...(poll.dates || [])]
    .map((date) => {
      let score = 0;
      const participants = [];
      for (const [name, votes] of Object.entries(poll.votes || {})) {
        const s = votes[date];
        if (s === 'available') {
          score += 2;
          participants.push({ name, status: 'available' });
        } else if (s === 'maybe') {
          score += 1;
          participants.push({ name, status: 'maybe' });
        }
      }
      return { date, score, participants };
    })
    .sort((a, b) => b.score - a.score);
}

// ─── FIRESTORE OPERATIONS ─────────────────────────────────────────────────────

async function loadPolls() {
  const snap = await getDocs(query(pollsCol, orderBy('createdAt', 'desc')));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

async function seedDefaultPoll() {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth();
  const data = {
    title: "Barbecue de l'été",
    dates: [mkDate(y, m, 8), mkDate(y, m, 9), mkDate(y, m, 15), mkDate(y, m, 22)],
    votes: {
      Alice:  { [mkDate(y, m, 8)]: 'available', [mkDate(y, m, 9)]: 'maybe',     [mkDate(y, m, 15)]: 'available' },
      Bob:    { [mkDate(y, m, 8)]: 'maybe',     [mkDate(y, m, 15)]: 'available', [mkDate(y, m, 22)]: 'available' },
      Claire: { [mkDate(y, m, 8)]: 'available', [mkDate(y, m, 9)]: 'available',  [mkDate(y, m, 22)]: 'maybe'     },
    },
    createdAt: serverTimestamp(),
  };
  await setDoc(doc(db, 'polls', 'default'), data);
  // Return a local copy with a JS Date (serverTimestamp isn't readable client-side until next fetch)
  return [{ id: 'default', ...data, createdAt: now }];
}

// ─── CALENDAR COMPONENT ───────────────────────────────────────────────────────

function renderCalendar(mode, pollDates) {
  const y = state.calYear;
  const m = state.calMonth;
  const firstDow = new Date(y, m, 1).getDay();       // 0 = Sun
  const offset = firstDow === 0 ? 6 : firstDow - 1; // Mon-based offset
  const daysTotal = new Date(y, m + 1, 0).getDate();

  const headers = DAYS.map(
    (d) => `<div class="text-center text-xs font-medium text-gray-400 py-0.5">${d}</div>`
  ).join('');

  let cells = '';
  for (let i = 0; i < offset; i++) cells += '<div></div>';

  for (let day = 1; day <= daysTotal; day++) {
    const key = mkDate(y, m, day);
    const dow = new Date(y, m, day).getDay();
    const isWE = dow === 0 || dow === 6;

    let cls = 'cal-cell ';
    let attr = '';

    if (mode === 'create') {
      cls += 'clickable cursor-pointer ';
      if (state.creDates.has(key)) {
        cls += 'bg-indigo-500 text-white font-semibold shadow-sm shadow-indigo-200';
      } else if (isWE) {
        cls += 'bg-gray-100 text-gray-500 hover:bg-indigo-100';
      } else {
        cls += 'text-gray-700 hover:bg-indigo-100';
      }
      attr = `data-date="${key}"`;
    } else {
      const proposed = Array.isArray(pollDates) && pollDates.includes(key);
      if (proposed) {
        cls += 'clickable cursor-pointer ';
        const vs = state.voteSelections[key];
        if (vs === 'available') {
          cls += 'bg-green-500 text-white font-semibold ring-2 ring-green-200';
        } else if (vs === 'maybe') {
          cls += 'bg-orange-400 text-white font-semibold ring-2 ring-orange-200';
        } else {
          cls +=
            (isWE ? 'bg-gray-100 ' : 'bg-white ') +
            'text-gray-700 hover:bg-green-100 ring-2 ring-indigo-200';
        }
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
        <button id="cal-prev"
                class="w-8 h-8 flex items-center justify-center rounded-lg
                       hover:bg-gray-100 text-gray-500 text-xl transition select-none">&#8249;</button>
        <span class="text-sm font-semibold text-gray-800">${MONTHS[m]} ${y}</span>
        <button id="cal-next"
                class="w-8 h-8 flex items-center justify-center rounded-lg
                       hover:bg-gray-100 text-gray-500 text-xl transition select-none">&#8250;</button>
      </div>
      <div class="grid grid-cols-7 gap-1 mb-1">${headers}</div>
      <div class="grid grid-cols-7 gap-1">${cells}</div>
    </div>`;
}

// ─── LOADING VIEW ─────────────────────────────────────────────────────────────

function renderLoading() {
  return `
    <div class="min-h-screen flex items-center justify-center
                bg-gradient-to-br from-slate-50 via-white to-indigo-50">
      <div class="flex flex-col items-center gap-3 text-gray-400">
        <div class="w-8 h-8 border-2 border-indigo-200 border-t-indigo-500
                    rounded-full animate-spin"></div>
        <p class="text-sm">Chargement…</p>
      </div>
    </div>`;
}

// ─── DASHBOARD ────────────────────────────────────────────────────────────────

function renderDashboard() {
  const items = state.polls
    .map((p) => {
      const vc = Object.keys(p.votes || {}).length;
      return `
        <div class="poll-item group flex items-center gap-4 p-4 bg-white rounded-2xl
                    border border-gray-100 hover:border-indigo-200 hover:shadow-md
                    transition-all cursor-pointer"
             data-poll-id="${p.id}">
          <div class="flex-1 min-w-0">
            <p class="font-semibold text-gray-900 truncate">${esc(p.title)}</p>
            <p class="text-xs text-gray-400 mt-0.5">
              ${(p.dates || []).length} date${(p.dates || []).length > 1 ? 's' : ''}&nbsp;&middot;&nbsp;${vc} participant${vc > 1 ? 's' : ''}
            </p>
          </div>
          <svg class="w-4 h-4 text-gray-300 group-hover:text-indigo-400 transition flex-shrink-0"
               fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/>
          </svg>
        </div>`;
    })
    .join('');

  return `
    <div class="min-h-screen bg-gradient-to-br from-slate-50 via-white to-indigo-50 p-4 md:p-8 fade-in">
      <div class="max-w-md mx-auto">
        <header class="mb-8 pt-4">
          <div class="flex items-center gap-2.5 mb-1">
            <div class="w-8 h-8 bg-indigo-500 rounded-xl flex items-center justify-center shadow-sm shadow-indigo-200">
              <svg class="w-4 h-4 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                      d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"/>
              </svg>
            </div>
            <h1 class="text-2xl font-bold text-gray-900 tracking-tight">Doodle</h1>
          </div>
          <p class="text-sm text-gray-400 ml-11">Trouvez le moment idéal pour se réunir.</p>
        </header>

        <button id="btn-create"
                class="w-full flex items-center justify-center gap-2 bg-indigo-500 hover:bg-indigo-600
                       active:bg-indigo-700 text-white font-semibold py-3.5 px-6 rounded-2xl
                       transition-all shadow-sm hover:shadow-lg hover:shadow-indigo-200 mb-8">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M12 4v16m8-8H4"/>
          </svg>
          Créer un sondage
        </button>

        ${
          state.polls.length > 0
            ? `<section>
                 <h2 class="text-xs font-semibold text-gray-400 uppercase tracking-widest mb-3 px-1">
                   Sondages actifs
                 </h2>
                 <div class="space-y-2">${items}</div>
               </section>`
            : `<div class="text-center py-16 text-gray-300">
                 <svg class="w-12 h-12 mx-auto mb-3 opacity-40" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                   <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"
                         d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"/>
                 </svg>
                 <p class="text-sm">Aucun sondage pour l'instant.</p>
               </div>`
        }
      </div>
    </div>`;
}

// ─── CREATE ───────────────────────────────────────────────────────────────────

function renderCreate() {
  const sorted = [...state.creDates].sort();
  const count = sorted.length;

  const chips = sorted
    .map(
      (d) =>
        `<span class="inline-flex items-center bg-indigo-50 text-indigo-600 border border-indigo-100
                      text-xs font-medium px-2.5 py-1 rounded-full">${fmtShort(d)}</span>`
    )
    .join('');

  const btnActive =
    'bg-indigo-500 hover:bg-indigo-600 active:bg-indigo-700 text-white shadow-sm hover:shadow-lg hover:shadow-indigo-200';
  const btnInactive = 'bg-gray-100 text-gray-400 cursor-not-allowed';

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
          ${
            count > 0
              ? `<div class="mt-4 pt-4 border-t border-gray-50">
                   <p class="text-xs text-gray-400 mb-2">
                     ${count} date${count > 1 ? 's' : ''} sélectionnée${count > 1 ? 's' : ''}
                   </p>
                   <div class="flex flex-wrap gap-1.5">${chips}</div>
                 </div>`
              : ''
          }
        </div>

        <button id="btn-save-poll" ${count === 0 ? 'disabled' : ''}
                class="w-full flex items-center justify-center gap-2 font-semibold
                       py-3.5 rounded-2xl transition-all ${count > 0 ? btnActive : btnInactive}">
          Créer le sondage
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 7l5 5m0 0l-5 5m5-5H6"/>
          </svg>
        </button>

      </div>
    </div>`;
}

// ─── POLL VIEW ────────────────────────────────────────────────────────────────

function renderPoll() {
  const poll = state.polls.find((p) => p.id === state.currentPollId);
  if (!poll) {
    state.view = 'dashboard';
    return renderDashboard();
  }

  const results = computeResults(poll);
  const vc = Object.keys(poll.votes || {}).length;

  const resultItems = results
    .map(({ date, score, participants }) => {
      const badges = participants
        .map(
          ({ name, status }) =>
            `<span class="inline-flex items-center text-xs px-2.5 py-0.5 rounded-full font-medium
                          ${
                            status === 'available'
                              ? 'bg-green-100 text-green-700 border border-green-200'
                              : 'bg-orange-100 text-orange-700 border border-orange-200'
                          }">${esc(name)}</span>`
        )
        .join('');

      const scoreTag =
        score >= 4
          ? 'text-green-600 bg-green-50 border border-green-100'
          : score >= 2
          ? 'text-orange-500 bg-orange-50 border border-orange-100'
          : 'text-gray-400 bg-gray-50 border border-gray-100';

      return `
        <div class="p-3.5 rounded-xl bg-gray-50 hover:bg-gray-100 transition-colors">
          <div class="flex items-start justify-between gap-3 mb-2">
            <p class="text-sm font-medium text-gray-800 leading-snug">${fmtLong(date)}</p>
            <span class="text-xs font-bold px-2 py-0.5 rounded-full flex-shrink-0 ${scoreTag}">
              ${score} pt${score > 1 ? 's' : ''}
            </span>
          </div>
          ${
            participants.length > 0
              ? `<div class="flex flex-wrap gap-1">${badges}</div>`
              : '<p class="text-xs text-gray-400">Aucun vote</p>'
          }
        </div>`;
    })
    .join('');

  return `
    <div class="min-h-screen bg-gradient-to-br from-slate-50 via-white to-indigo-50 p-4 md:p-8 fade-in">
      <div class="max-w-5xl mx-auto">

        <div class="flex items-start gap-3 mb-6 pt-2">
          <button id="btn-back"
                  class="w-9 h-9 flex-shrink-0 flex items-center justify-center rounded-xl
                         hover:bg-gray-100 transition text-gray-500 mt-0.5">
            <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7"/>
            </svg>
          </button>
          <div>
            <h1 class="text-xl font-bold text-gray-900">${esc(poll.title)}</h1>
            <p class="text-xs text-gray-400 mt-0.5">
              ${(poll.dates || []).length} date${(poll.dates || []).length > 1 ? 's' : ''} proposée${(poll.dates || []).length > 1 ? 's' : ''}
              &middot; ${vc} participant${vc > 1 ? 's' : ''}
            </p>
          </div>
        </div>

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
              ${
                results.length > 0
                  ? `<div class="space-y-2">${resultItems}</div>`
                  : '<p class="text-sm text-gray-400">Aucune date proposée.</p>'
              }
            </div>
          </div>

        </div>
      </div>
    </div>`;
}

// ─── EVENT BINDING ────────────────────────────────────────────────────────────

function attachEvents() {
  const $ = (id) => document.getElementById(id);

  $('btn-create')?.addEventListener('click', () => {
    state.view = 'create';
    state.creTitle = '';
    state.creDates = new Set();
    resetCal();
    render();
  });

  document.querySelectorAll('.poll-item').forEach((el) =>
    el.addEventListener('click', () => openPoll(el.dataset.pollId))
  );

  $('btn-back')?.addEventListener('click', () => backToDashboard());

  $('cal-prev')?.addEventListener('click', () => {
    saveTempInputs();
    if (state.calMonth === 0) { state.calMonth = 11; state.calYear--; }
    else state.calMonth--;
    render();
  });

  $('cal-next')?.addEventListener('click', () => {
    saveTempInputs();
    if (state.calMonth === 11) { state.calMonth = 0; state.calYear++; }
    else state.calMonth++;
    render();
  });

  document.querySelectorAll('.cal-cell[data-date]').forEach((el) =>
    el.addEventListener('click', () => {
      const date = el.dataset.date;
      saveTempInputs();
      if (state.view === 'create') {
        if (state.creDates.has(date)) state.creDates.delete(date);
        else state.creDates.add(date);
        render();
      } else if (state.view === 'poll') {
        const cur = state.voteSelections[date];
        if (!cur) state.voteSelections[date] = 'available';
        else if (cur === 'available') state.voteSelections[date] = 'maybe';
        else delete state.voteSelections[date];
        render();
      }
    })
  );

  $('btn-save-poll')?.addEventListener('click', () => createPoll());
  $('btn-submit-vote')?.addEventListener('click', () => submitVote());
}

// ─── FIRESTORE ACTIONS ────────────────────────────────────────────────────────

async function createPoll() {
  const title = (document.getElementById('poll-title')?.value ?? '').trim();
  if (!title) {
    const el = document.getElementById('poll-title');
    el?.focus();
    el?.classList.add('ring-2', 'ring-red-300', 'border-red-200');
    return;
  }
  if (state.creDates.size === 0) {
    showToast('Sélectionnez au moins une date.');
    return;
  }

  const id = uid();
  const data = {
    title,
    dates: [...state.creDates].sort(),
    votes: {},
    createdAt: serverTimestamp(),
  };

  try {
    await setDoc(doc(db, 'polls', id), data);
    state.polls.unshift({ id, ...data, createdAt: new Date() });
    openPoll(id);
    showToast('Sondage créé avec succès !');
  } catch (e) {
    console.error(e);
    showToast('Erreur Firestore — vérifiez les règles de sécurité.');
  }
}

async function submitVote() {
  const name = (document.getElementById('voter-name')?.value ?? '').trim();
  if (!name) {
    const el = document.getElementById('voter-name');
    el?.focus();
    el?.classList.add('ring-2', 'ring-red-300', 'border-red-200');
    return;
  }

  const poll = state.polls.find((p) => p.id === state.currentPollId);
  if (!poll) return;

  // Build vote map for this person (only dates they interacted with)
  const voteObj = {};
  (poll.dates || []).forEach((d) => {
    if (state.voteSelections[d]) voteObj[d] = state.voteSelections[d];
  });

  try {
    // Dot-notation path updates only this voter's entry without overwriting others
    await updateDoc(doc(db, 'polls', state.currentPollId), {
      [`votes.${name}`]: voteObj,
    });
    // onSnapshot will refresh the results panel automatically
    state.voteName = '';
    state.voteSelections = {};
    showToast(`Vote de ${name} enregistré !`);
    render(); // clear the form immediately
  } catch (e) {
    console.error(e);
    showToast('Erreur lors du vote. Réessayez.');
  }
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function openPoll(id) {
  // Tear down previous listener if any
  if (state.unsubPoll) {
    state.unsubPoll();
    state.unsubPoll = null;
  }

  state.currentPollId = id;
  state.view = 'poll';
  state.voteName = '';
  state.voteSelections = {};

  const poll = state.polls.find((p) => p.id === id);
  if (poll?.dates?.length > 0) {
    const { year, month } = splitDate(poll.dates[0]);
    state.calYear = year;
    state.calMonth = month;
  } else {
    resetCal();
  }

  // Real-time listener — fires immediately then on every remote change
  state.unsubPoll = onSnapshot(doc(db, 'polls', id), (snap) => {
    if (!snap.exists()) return;
    const updated = { id, ...snap.data() };
    const idx = state.polls.findIndex((p) => p.id === id);
    if (idx >= 0) state.polls[idx] = updated;
    else state.polls.unshift(updated);

    if (state.view === 'poll' && state.currentPollId === id) {
      saveTempInputs(); // preserve name input before re-render
      render();
    }
  });

  render();
}

async function backToDashboard() {
  if (state.unsubPoll) {
    state.unsubPoll();
    state.unsubPoll = null;
  }
  state.loading = true;
  render();
  try {
    state.polls = await loadPolls();
  } catch (_) {
    // keep cached list on network error
  }
  state.view = 'dashboard';
  state.loading = false;
  render();
}

function resetCal() {
  state.calYear = new Date().getFullYear();
  state.calMonth = new Date().getMonth();
}

function saveTempInputs() {
  const titleEl = document.getElementById('poll-title');
  if (titleEl) state.creTitle = titleEl.value;
  const nameEl = document.getElementById('voter-name');
  if (nameEl) state.voteName = nameEl.value;
}

// ─── RENDER ───────────────────────────────────────────────────────────────────

function render() {
  const app = document.getElementById('app');
  if (!app) return;
  if (state.loading) { app.innerHTML = renderLoading(); return; }
  switch (state.view) {
    case 'dashboard': app.innerHTML = renderDashboard(); break;
    case 'create':    app.innerHTML = renderCreate();    break;
    case 'poll':      app.innerHTML = renderPoll();      break;
  }
  attachEvents();
}

// ─── INIT ─────────────────────────────────────────────────────────────────────

async function init() {
  state.loading = true;
  render();
  try {
    state.polls = await loadPolls();
    // Seed demo data only on a fresh empty project
    if (state.polls.length === 0) {
      state.polls = await seedDefaultPoll();
    }
  } catch (e) {
    console.error('Firestore init error:', e);
    showToast('Impossible de charger les données.');
  }
  state.loading = false;
  render();
}

// ES modules are deferred — DOM is ready when this executes
init();
