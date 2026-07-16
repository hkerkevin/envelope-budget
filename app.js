// ============================================
// CONFIGURATION
// ============================================

// To enable sync between devices, create a free Firebase project and paste your config here.
// See: https://console.firebase.google.com
// Steps: Create project → Build → Firestore Database → Create → Start in test mode
//        Then: Project Settings → Your apps → Web app → Copy config
const FIREBASE_CONFIG = {
  apiKey: 'AIzaSyD3EU0Kr7ypDuqGmVO4mCYc_4RwvAppAsE',
  authDomain: 'envelope-budget-c2b58.firebaseapp.com',
  projectId: 'envelope-budget-c2b58',
  storageBucket: 'envelope-budget-c2b58.firebasestorage.app',
  messagingSenderId: '278247768167',
  appId: '1:278247768167:web:b357b6a36e2618fa9e94c2',
};

const DEFAULT_ENVELOPES = [
  { name: 'Groceries', budget: 700, color: '#34C759' },
  { name: 'Dining Out', budget: 550, color: '#FF9500' },
  { name: 'Coffee/Tea/Matcha', budget: 80, color: '#5AC8FA' },
  { name: 'Household/Amazon', budget: 500, color: '#AF52DE' },
];

const COLORS = [
  '#007AFF', '#34C759', '#FF9500', '#FF3B30', '#AF52DE',
  '#5AC8FA', '#FF2D55', '#FFCC00', '#30B0C7', '#A2845E',
];

// ============================================
// STATE
// ============================================
const state = {
  user: null,
  householdId: null,
  householdCode: null,
  members: {},
  envelopes: [],
  transactions: [],
  currentView: 'setup',
};

let db = null;
let useFirebase = false;
let unsubscribers = [];
let editingEnvelopeId = null;
let editingTransactionId = null;
let selectedEnvelopeId = null;
let selectedColor = COLORS[0];
let selectedEnvelopeType = 'monthly';

// ============================================
// UTILITIES
// ============================================
const $ = id => document.getElementById(id);

function getCurrentPeriod() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function getPeriodLabel(period) {
  const [y, m] = period.split('-');
  return new Date(y, m - 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

function formatCurrency(n) {
  return '$' + Math.abs(n).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function parseAmount(str) {
  const cleaned = String(str).replace(/[^0-9.]/g, '');
  const num = parseFloat(cleaned);
  return isNaN(num) ? 0 : Math.round(num * 100) / 100;
}

function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 2000);
}

function formatDate(dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);

  if (dateStr === today.toISOString().split('T')[0]) return 'Today';
  if (dateStr === yesterday.toISOString().split('T')[0]) return 'Yesterday';
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

// ============================================
// LOCAL STORAGE
// ============================================
function saveLocal() {
  localStorage.setItem('envelope_budget', JSON.stringify({
    user: state.user,
    householdId: state.householdId,
    householdCode: state.householdCode,
    members: state.members,
    envelopes: state.envelopes,
    transactions: state.transactions,
  }));
}

function loadLocal() {
  try {
    const raw = localStorage.getItem('envelope_budget');
    if (!raw) return false;
    const data = JSON.parse(raw);
    Object.assign(state, data);
    return !!state.householdId;
  } catch {
    return false;
  }
}

// ============================================
// FIREBASE INIT
// ============================================
function initFirebase() {
  if (!FIREBASE_CONFIG.apiKey || typeof firebase === 'undefined') return false;
  try {
    firebase.initializeApp(FIREBASE_CONFIG);
    db = firebase.firestore();
    db.enablePersistence({ synchronizeTabs: true }).catch(() => {});
    return true;
  } catch {
    return false;
  }
}

// ============================================
// DATA OPERATIONS
// ============================================
async function createHousehold(userName) {
  const code = generateCode();

  if (useFirebase) {
    const cred = await firebase.auth().signInAnonymously();
    const uid = cred.user.uid;
    const ref = await db.collection('households').add({
      code,
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      members: { [uid]: userName },
    });
    state.householdId = ref.id;
    state.householdCode = code;
    state.user = { name: userName, uid };
    state.members = { [uid]: userName };

    for (let i = 0; i < DEFAULT_ENVELOPES.length; i++) {
      await db.collection('households').doc(ref.id).collection('envelopes').add({
        ...DEFAULT_ENVELOPES[i],
        order: i,
      });
    }
  } else {
    state.householdId = 'local_' + Date.now();
    state.householdCode = code;
    state.user = { name: userName, uid: 'local' };
    state.members = { local: userName };
    state.envelopes = DEFAULT_ENVELOPES.map((e, i) => ({ ...e, id: 'env_' + i, order: i }));
    state.transactions = [];
  }

  saveLocal();
}

async function joinHousehold(code, userName) {
  if (!useFirebase) {
    toast('Firebase required for joining. Configure it first.');
    return false;
  }

  const snap = await db.collection('households').where('code', '==', code.toUpperCase()).limit(1).get();
  if (snap.empty) {
    toast('Household not found');
    return false;
  }

  const cred = await firebase.auth().signInAnonymously();
  const uid = cred.user.uid;
  const doc = snap.docs[0];

  await doc.ref.update({ [`members.${uid}`]: userName });

  state.householdId = doc.id;
  state.householdCode = code.toUpperCase();
  state.user = { name: userName, uid };
  state.members = { ...doc.data().members, [uid]: userName };

  saveLocal();
  return true;
}

async function addTransactionData(envelopeId, amount, note, date) {
  const txn = {
    envelopeId,
    amount: parseAmount(amount),
    note: note || '',
    date: date || new Date().toISOString().split('T')[0],
    period: getCurrentPeriod(),
    addedBy: state.user.name,
  };

  if (txn.amount <= 0) {
    toast('Enter a valid amount');
    return false;
  }

  if (useFirebase) {
    txn.createdAt = firebase.firestore.FieldValue.serverTimestamp();
    await db.collection('households').doc(state.householdId).collection('transactions').add(txn);
  } else {
    txn.id = 'txn_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5);
    txn.createdAt = new Date().toISOString();
    state.transactions.push(txn);
    saveLocal();
    renderAll();
  }
  return true;
}

async function updateTransactionData(id, updates) {
  if (useFirebase) {
    await db.collection('households').doc(state.householdId).collection('transactions').doc(id).update(updates);
  } else {
    const txn = state.transactions.find(t => t.id === id);
    if (txn) Object.assign(txn, updates);
    saveLocal();
    renderAll();
  }
}

async function deleteTransactionData(id) {
  if (useFirebase) {
    await db.collection('households').doc(state.householdId).collection('transactions').doc(id).delete();
  } else {
    state.transactions = state.transactions.filter(t => t.id !== id);
    saveLocal();
    renderAll();
  }
}

async function addEnvelopeData(name, budget, color, type) {
  const env = { name, budget: parseAmount(budget), color, order: state.envelopes.length, type: type || 'monthly' };

  if (useFirebase) {
    await db.collection('households').doc(state.householdId).collection('envelopes').add(env);
  } else {
    env.id = 'env_' + Date.now();
    state.envelopes.push(env);
    saveLocal();
    renderAll();
  }
}

async function updateEnvelopeData(id, updates) {
  if (useFirebase) {
    await db.collection('households').doc(state.householdId).collection('envelopes').doc(id).update(updates);
  } else {
    const env = state.envelopes.find(e => e.id === id);
    if (env) Object.assign(env, updates);
    saveLocal();
    renderAll();
  }
}

async function deleteEnvelopeData(id) {
  if (useFirebase) {
    await db.collection('households').doc(state.householdId).collection('envelopes').doc(id).delete();
    const txns = await db.collection('households').doc(state.householdId)
      .collection('transactions').where('envelopeId', '==', id).get();
    const batch = db.batch();
    txns.forEach(d => batch.delete(d.ref));
    await batch.commit();
  } else {
    state.envelopes = state.envelopes.filter(e => e.id !== id);
    state.transactions = state.transactions.filter(t => t.envelopeId !== id);
    saveLocal();
    renderAll();
  }
}

async function resetMonthData() {
  const period = getCurrentPeriod();
  if (useFirebase) {
    const txns = await db.collection('households').doc(state.householdId)
      .collection('transactions').where('period', '==', period).get();
    const batch = db.batch();
    txns.forEach(d => batch.delete(d.ref));
    await batch.commit();
  } else {
    state.transactions = state.transactions.filter(t => t.period !== period);
    saveLocal();
    renderAll();
  }
}

function leaveHouseholdData() {
  unsubscribers.forEach(fn => fn());
  unsubscribers = [];
  state.user = null;
  state.householdId = null;
  state.householdCode = null;
  state.members = {};
  state.envelopes = [];
  state.transactions = [];
  localStorage.removeItem('envelope_budget');
}

// ============================================
// FIREBASE REAL-TIME LISTENERS
// ============================================
function setupListeners() {
  if (!useFirebase || !state.householdId) return;

  unsubscribers.forEach(fn => fn());
  unsubscribers = [];

  // Household doc (for members)
  unsubscribers.push(
    db.collection('households').doc(state.householdId).onSnapshot(doc => {
      if (doc.exists) {
        state.members = doc.data().members || {};
        renderSettings();
      }
    })
  );

  // Envelopes
  unsubscribers.push(
    db.collection('households').doc(state.householdId)
      .collection('envelopes').orderBy('order')
      .onSnapshot(snap => {
        state.envelopes = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        saveLocal();
        renderAll();
      })
  );

  // Transactions (current period + recent)
  unsubscribers.push(
    db.collection('households').doc(state.householdId)
      .collection('transactions')
      .orderBy('createdAt', 'desc')
      .limit(500)
      .onSnapshot(snap => {
        state.transactions = snap.docs.map(d => {
          const data = d.data();
          return {
            id: d.id,
            ...data,
            createdAt: data.createdAt?.toDate?.()?.toISOString() || data.createdAt || '',
          };
        });
        saveLocal();
        renderAll();
      })
  );
}

// ============================================
// UI: DASHBOARD
// ============================================
function getCurrentYear() {
  return String(new Date().getFullYear());
}

function getSpent(envelopeId) {
  const env = state.envelopes.find(e => e.id === envelopeId);
  if (env?.type === 'annual') {
    const year = getCurrentYear();
    return state.transactions
      .filter(t => t.envelopeId === envelopeId && (t.period || '').startsWith(year))
      .reduce((s, t) => s + t.amount, 0);
  }
  const period = getCurrentPeriod();
  return state.transactions
    .filter(t => t.envelopeId === envelopeId && t.period === period)
    .reduce((s, t) => s + t.amount, 0);
}

function renderDashboard() {
  $('period-label').textContent = getPeriodLabel(getCurrentPeriod());
  $('household-code-btn').textContent = state.householdCode || '';

  let monthlyBudget = 0, monthlySpent = 0;
  const container = $('envelopes-container');
  container.innerHTML = '';

  if (state.envelopes.length === 0) {
    container.innerHTML = '<div class="empty-state"><div class="empty-state-icon">✉️</div><p>No envelopes yet.<br>Add some in Settings.</p></div>';
    $('total-remaining').textContent = '$0.00';
    $('total-remaining').className = 'overview-amount';
    $('total-budget').textContent = '$0';
    $('total-spent').textContent = '$0';
    $('total-bar').style.width = '0%';
    return;
  }

  state.envelopes.forEach(env => {
    const spent = getSpent(env.id);
    const remaining = env.budget - spent;
    const pct = env.budget > 0 ? Math.min((spent / env.budget) * 100, 100) : 0;
    const isAnnual = env.type === 'annual';

    if (!isAnnual) {
      monthlyBudget += env.budget;
      monthlySpent += spent;
    }

    const barColor = pct > 90 ? '#FF3B30' : pct > 75 ? '#FF9500' : env.color;

    const card = document.createElement('div');
    card.className = 'envelope-card';
    card.addEventListener('click', () => {
      $('history-filter').value = env.id;
      navigate('history');
      renderHistory();
    });

    const leftLabel = remaining < 0 ? 'over' : isAnnual ? 'left this year' : 'left';

    card.innerHTML = `
      <div class="envelope-header">
        <div class="envelope-name" style="color:${env.color}">${esc(env.name)}${isAnnual ? ' <span class="envelope-badge">Annual</span>' : ''}</div>
        <div class="envelope-remaining ${remaining < 0 ? 'negative' : ''}">
          ${remaining < 0 ? '-' : ''}${formatCurrency(remaining)} ${leftLabel}
        </div>
      </div>
      <div class="progress-bar">
        <div class="progress-fill" style="width:${pct}%;background:${barColor}"></div>
      </div>
      <div class="envelope-detail">
        ${formatCurrency(spent)} of ${formatCurrency(env.budget)}${isAnnual ? ' (year)' : ''}
      </div>
    `;
    container.appendChild(card);
  });

  const monthlyRemaining = monthlyBudget - monthlySpent;
  const monthlyPct = monthlyBudget > 0 ? Math.min((monthlySpent / monthlyBudget) * 100, 100) : 0;

  $('total-remaining').textContent = (monthlyRemaining < 0 ? '-' : '') + formatCurrency(monthlyRemaining);
  $('total-remaining').className = 'overview-amount' + (monthlyRemaining < 0 ? ' negative' : '');
  $('total-budget').textContent = formatCurrency(monthlyBudget);
  $('total-spent').textContent = formatCurrency(monthlySpent);

  const bar = $('total-bar');
  bar.style.width = monthlyPct + '%';
  bar.style.background = monthlyPct > 90 ? '#FF3B30' : monthlyPct > 75 ? '#FF9500' : '#5856D6';
}

// ============================================
// UI: HISTORY
// ============================================
function renderHistory() {
  const filter = $('history-filter');
  const currentVal = filter.value;

  // Rebuild filter options
  filter.innerHTML = '<option value="all">All Envelopes</option>';
  state.envelopes.forEach(env => {
    const opt = document.createElement('option');
    opt.value = env.id;
    opt.textContent = env.name;
    filter.appendChild(opt);
  });
  filter.value = currentVal;
  if (!filter.value) filter.value = 'all';

  const period = getCurrentPeriod();
  const year = getCurrentYear();
  const filterEnv = filter.value !== 'all' ? state.envelopes.find(e => e.id === filter.value) : null;
  const showYear = filterEnv?.type === 'annual';

  let txns = showYear
    ? state.transactions.filter(t => (t.period || '').startsWith(year))
    : state.transactions.filter(t => t.period === period);
  if (filter.value !== 'all') txns = txns.filter(t => t.envelopeId === filter.value);

  txns.sort((a, b) => (b.date || '').localeCompare(a.date || '') || (b.createdAt || '').localeCompare(a.createdAt || ''));

  const list = $('history-list');
  list.innerHTML = '';

  if (txns.length === 0) {
    list.innerHTML = '<div class="empty-state"><div class="empty-state-icon">📭</div><p>No transactions this month.</p></div>';
    return;
  }

  const grouped = {};
  txns.forEach(t => {
    const key = t.date || 'Unknown';
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(t);
  });

  Object.entries(grouped).forEach(([date, items]) => {
    const group = document.createElement('div');
    group.className = 'history-date-group';
    group.innerHTML = `<div class="history-date">${formatDate(date)}</div>`;

    items.forEach(t => {
      const env = state.envelopes.find(e => e.id === t.envelopeId);
      const row = document.createElement('div');
      row.className = 'history-item';
      row.innerHTML = `
        <div class="history-dot" style="background:${env?.color || '#999'}"></div>
        <div class="history-info">
          <div class="history-envelope-name">${esc(env?.name || 'Unknown')}</div>
          ${t.note ? `<div class="history-note">${esc(t.note)}</div>` : ''}
        </div>
        <div class="history-right">
          <div class="history-amount">${formatCurrency(t.amount)}</div>
          <div class="history-who">${esc(t.addedBy || '')}</div>
        </div>
        <button class="history-delete" data-id="${t.id}">Delete</button>
      `;
      row.addEventListener('click', () => showEditTransaction(t));
      group.appendChild(row);
    });

    list.appendChild(group);
  });

  list.querySelectorAll('.history-delete').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      if (confirm('Delete this transaction?')) {
        await deleteTransactionData(btn.dataset.id);
        toast('Deleted');
      }
    });
  });
}

// ============================================
// UI: SETTINGS
// ============================================
function renderSettings() {
  $('settings-code').textContent = state.householdCode || '-';
  $('settings-members').textContent = Object.values(state.members).join(', ') || state.user?.name || '-';
  $('settings-sync').textContent = useFirebase ? 'Real-time (Firebase)' : 'Local only';

  const list = $('envelope-settings-list');
  list.innerHTML = '';

  state.envelopes.forEach(env => {
    const row = document.createElement('div');
    row.className = 'envelope-setting-row';
    row.addEventListener('click', () => showEnvelopeModal(env));
    row.innerHTML = `
      <div class="envelope-setting-color" style="background:${env.color}"></div>
      <div class="envelope-setting-name">${esc(env.name)}</div>
      <div class="envelope-setting-budget">${formatCurrency(env.budget)}/mo</div>
    `;
    list.appendChild(row);
  });
}

// ============================================
// UI: RENDER ALL
// ============================================
function renderAll() {
  renderDashboard();
  renderHistory();
  renderSettings();
  renderEnvelopePicker();
}

// ============================================
// MODALS
// ============================================
function showModal(id) {
  $(id).classList.add('active');
}

function hideModal(id) {
  $(id).classList.remove('active');
}

function showAddTransaction(preselectedEnvelopeId) {
  editingTransactionId = null;
  $('add-modal-title').textContent = 'Add Expense';
  $('input-amount').value = '';
  $('input-note').value = '';
  $('input-date').value = new Date().toISOString().split('T')[0];
  selectedEnvelopeId = preselectedEnvelopeId || (state.envelopes[0]?.id || null);
  renderEnvelopePicker();
  showModal('modal-add');
  setTimeout(() => $('input-amount').focus(), 300);
}

function showEditTransaction(txn) {
  editingTransactionId = txn.id;
  $('add-modal-title').textContent = 'Edit Expense';
  $('input-amount').value = txn.amount.toFixed(2);
  $('input-note').value = txn.note || '';
  $('input-date').value = txn.date || new Date().toISOString().split('T')[0];
  selectedEnvelopeId = txn.envelopeId;
  renderEnvelopePicker();
  showModal('modal-add');
  setTimeout(() => $('input-amount').focus(), 300);
}

function renderEnvelopePicker() {
  const picker = $('envelope-picker');
  if (!picker) return;
  picker.innerHTML = '';
  state.envelopes.forEach(env => {
    const chip = document.createElement('button');
    chip.className = 'picker-chip' + (selectedEnvelopeId === env.id ? ' selected' : '');
    chip.textContent = env.name;
    if (selectedEnvelopeId === env.id) {
      chip.style.background = env.color;
      chip.style.borderColor = env.color;
    }
    chip.addEventListener('click', () => {
      selectedEnvelopeId = env.id;
      renderEnvelopePicker();
    });
    picker.appendChild(chip);
  });
}

async function saveTransaction() {
  const amount = $('input-amount').value;
  const note = $('input-note').value.trim();
  const date = $('input-date').value;

  if (!selectedEnvelopeId) { toast('Select an envelope'); return; }
  if (!parseAmount(amount)) { toast('Enter an amount'); return; }

  if (editingTransactionId) {
    await updateTransactionData(editingTransactionId, {
      envelopeId: selectedEnvelopeId,
      amount: parseAmount(amount),
      note,
      date,
    });
    hideModal('modal-add');
    toast('Updated');
  } else {
    const ok = await addTransactionData(selectedEnvelopeId, amount, note, date);
    if (ok) {
      hideModal('modal-add');
      toast('Added');
    }
  }
}

function showEnvelopeModal(env) {
  editingEnvelopeId = env?.id || null;
  $('envelope-modal-title').textContent = env ? 'Edit Envelope' : 'Add Envelope';
  $('input-envelope-name').value = env?.name || '';
  $('input-envelope-budget').value = env?.budget || '';
  selectedColor = env?.color || COLORS[0];
  selectedEnvelopeType = env?.type || 'monthly';
  $('btn-delete-envelope').style.display = env ? 'block' : 'none';
  $('budget-label').textContent = selectedEnvelopeType === 'annual' ? 'Annual Budget' : 'Monthly Budget';

  renderColorPicker();
  renderTypePicker();
  showModal('modal-envelope');
}

function renderTypePicker() {
  const picker = $('type-picker');
  picker.innerHTML = '';
  [{ key: 'monthly', label: 'Monthly' }, { key: 'annual', label: 'Annual' }].forEach(opt => {
    const chip = document.createElement('button');
    chip.className = 'picker-chip' + (selectedEnvelopeType === opt.key ? ' selected' : '');
    chip.textContent = opt.label;
    if (selectedEnvelopeType === opt.key) {
      chip.style.background = 'var(--primary)';
      chip.style.borderColor = 'var(--primary)';
    }
    chip.addEventListener('click', () => {
      selectedEnvelopeType = opt.key;
      $('budget-label').textContent = opt.key === 'annual' ? 'Annual Budget' : 'Monthly Budget';
      renderTypePicker();
    });
    picker.appendChild(chip);
  });
}

function renderColorPicker() {
  const picker = $('color-picker');
  picker.innerHTML = '';
  COLORS.forEach(c => {
    const dot = document.createElement('div');
    dot.className = 'color-dot' + (selectedColor === c ? ' selected' : '');
    dot.style.background = c;
    dot.addEventListener('click', () => {
      selectedColor = c;
      renderColorPicker();
    });
    picker.appendChild(dot);
  });
}

async function saveEnvelope() {
  const name = $('input-envelope-name').value.trim();
  const budget = $('input-envelope-budget').value;

  if (!name) { toast('Enter a name'); return; }
  if (!parseAmount(budget)) { toast('Enter a budget'); return; }

  if (editingEnvelopeId) {
    await updateEnvelopeData(editingEnvelopeId, { name, budget: parseAmount(budget), color: selectedColor, type: selectedEnvelopeType });
  } else {
    await addEnvelopeData(name, budget, selectedColor, selectedEnvelopeType);
  }

  hideModal('modal-envelope');
  toast(editingEnvelopeId ? 'Updated' : 'Added');
}

// ============================================
// NAVIGATION
// ============================================
function navigate(viewName) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  $('view-' + viewName)?.classList.add('active');
  document.querySelector(`.nav-btn[data-view="${viewName}"]`)?.classList.add('active');
  state.currentView = viewName;
}

// ============================================
// EXPORT & IMPORT
// ============================================
function csvEscape(str) {
  str = String(str || '');
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

function downloadFile(content, filename, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function exportTransactionsCSV(allMonths) {
  const period = getCurrentPeriod();
  let txns = allMonths
    ? [...state.transactions]
    : state.transactions.filter(t => t.period === period);

  if (txns.length === 0) {
    toast('No transactions to export');
    return;
  }

  txns.sort((a, b) => (a.period || '').localeCompare(b.period || '') || (a.date || '').localeCompare(b.date || ''));

  const headers = ['Envelope', 'Amount', 'Note', 'Date', 'Period', 'Added By'];
  const rows = txns.map(t => {
    const env = state.envelopes.find(e => e.id === t.envelopeId);
    return [
      csvEscape(env?.name || 'Unknown'),
      t.amount.toFixed(2),
      csvEscape(t.note),
      t.date || '',
      t.period || '',
      csvEscape(t.addedBy),
    ].join(',');
  });

  const csv = [headers.join(','), ...rows].join('\n');
  const filename = allMonths ? 'envelope-budget-all.csv' : `envelope-budget-${period}.csv`;
  downloadFile(csv, filename, 'text/csv');
  toast('Exported ' + txns.length + ' transactions');
}

function exportEnvelopesJSON() {
  const data = state.envelopes.map(e => ({
    name: e.name,
    budget: e.budget,
    color: e.color,
    order: e.order,
    type: e.type || 'monthly',
  }));
  downloadFile(JSON.stringify(data, null, 2), 'envelope-config.json', 'application/json');
  toast('Exported ' + data.length + ' envelopes');
}

function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') { current += '"'; i++; }
      else if (ch === '"') { inQuotes = false; }
      else { current += ch; }
    } else {
      if (ch === '"') { inQuotes = true; }
      else if (ch === ',') { result.push(current); current = ''; }
      else { current += ch; }
    }
  }
  result.push(current);
  return result;
}

function parseCSV(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return [];
  const headers = parseCSVLine(lines[0]).map(h => h.trim());
  return lines.slice(1).map(line => {
    const vals = parseCSVLine(line);
    const row = {};
    headers.forEach((h, i) => row[h] = (vals[i] || '').trim());
    return row;
  });
}

async function importTransactionsCSV(file) {
  const text = await file.text();
  const rows = parseCSV(text);

  if (rows.length === 0) {
    toast('No data found in file');
    return;
  }

  const envMap = {};
  state.envelopes.forEach(e => { envMap[e.name.toLowerCase()] = e.id; });

  const valid = [];
  const unmatched = new Set();
  for (const row of rows) {
    const envName = row['Envelope'] || '';
    const envId = envMap[envName.toLowerCase()];
    if (!envId) { unmatched.add(envName); continue; }
    const amount = parseAmount(row['Amount']);
    if (amount <= 0) continue;
    valid.push({
      envelopeId: envId,
      amount,
      note: row['Note'] || '',
      date: row['Date'] || new Date().toISOString().split('T')[0],
      period: row['Period'] || getCurrentPeriod(),
      addedBy: row['Added By'] || state.user.name,
    });
  }

  if (valid.length === 0) {
    const msg = unmatched.size
      ? 'No valid rows. Unmatched envelopes: ' + [...unmatched].join(', ')
      : 'No valid rows found';
    toast(msg);
    return;
  }

  let msg = `Import ${valid.length} transactions?`;
  if (unmatched.size) msg += ` (${unmatched.size} rows skipped — unmatched envelopes: ${[...unmatched].join(', ')})`;
  msg += '\nThis adds to your existing data.';
  if (!confirm(msg)) return;

  for (const txn of valid) {
    if (useFirebase) {
      txn.createdAt = firebase.firestore.FieldValue.serverTimestamp();
      await db.collection('households').doc(state.householdId).collection('transactions').add(txn);
    } else {
      txn.id = 'txn_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5);
      txn.createdAt = new Date().toISOString();
      state.transactions.push(txn);
    }
  }

  if (!useFirebase) { saveLocal(); renderAll(); }
  toast('Imported ' + valid.length + ' transactions');
}

async function importEnvelopesJSON(file) {
  const text = await file.text();
  let data;
  try { data = JSON.parse(text); } catch { toast('Invalid JSON file'); return; }
  if (!Array.isArray(data)) { toast('Invalid format — expected an array'); return; }

  const valid = data.filter(d => d.name && d.budget);
  if (valid.length === 0) { toast('No valid envelopes found'); return; }

  const existing = valid.filter(d => state.envelopes.some(e => e.name.toLowerCase() === d.name.toLowerCase()));
  const fresh = valid.filter(d => !state.envelopes.some(e => e.name.toLowerCase() === d.name.toLowerCase()));

  let msg = `Import ${valid.length} envelopes?`;
  if (existing.length) msg += `\n${existing.length} existing will be updated (budget/color).`;
  if (fresh.length) msg += `\n${fresh.length} new will be added.`;
  if (!confirm(msg)) return;

  let added = 0, updated = 0;
  for (const item of valid) {
    const match = state.envelopes.find(e => e.name.toLowerCase() === item.name.toLowerCase());
    if (match) {
      await updateEnvelopeData(match.id, {
        budget: parseAmount(item.budget),
        color: item.color || match.color,
        type: item.type || match.type || 'monthly',
      });
      updated++;
    } else {
      await addEnvelopeData(item.name, item.budget, item.color || COLORS[added % COLORS.length], item.type || 'monthly');
      added++;
    }
  }

  toast(`${added} added, ${updated} updated`);
}

// ============================================
// SECURITY HELPER
// ============================================
function esc(str) {
  const d = document.createElement('div');
  d.textContent = str || '';
  return d.innerHTML;
}

// ============================================
// EVENT BINDING
// ============================================
function bindEvents() {
  // Setup
  $('btn-create').addEventListener('click', async () => {
    const name = $('input-name').value.trim();
    if (!name) { toast('Enter your name'); return; }
    $('btn-create').disabled = true;
    try {
      await createHousehold(name);
      enterApp();
    } catch (e) {
      toast('Error: ' + e.message);
    }
    $('btn-create').disabled = false;
  });

  $('btn-join').addEventListener('click', async () => {
    const name = $('input-name').value.trim();
    const code = $('input-code').value.trim();
    if (!name) { toast('Enter your name'); return; }
    if (!code) { toast('Enter a household code'); return; }
    $('btn-join').disabled = true;
    try {
      const ok = await joinHousehold(code, name);
      if (ok) enterApp();
    } catch (e) {
      toast('Error: ' + e.message);
    }
    $('btn-join').disabled = false;
  });

  // Nav
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      navigate(btn.dataset.view);
      if (btn.dataset.view === 'history') renderHistory();
    });
  });

  // FAB
  $('fab').addEventListener('click', () => showAddTransaction());

  // Add transaction modal
  $('btn-cancel-add').addEventListener('click', () => hideModal('modal-add'));
  $('btn-save-add').addEventListener('click', saveTransaction);
  $('modal-add').querySelector('.modal-overlay').addEventListener('click', () => hideModal('modal-add'));

  // Envelope modal
  $('btn-cancel-envelope').addEventListener('click', () => hideModal('modal-envelope'));
  $('btn-save-envelope').addEventListener('click', saveEnvelope);
  $('modal-envelope').querySelector('.modal-overlay').addEventListener('click', () => hideModal('modal-envelope'));

  $('btn-delete-envelope').addEventListener('click', async () => {
    if (!editingEnvelopeId) return;
    if (!confirm('Delete this envelope and all its transactions?')) return;
    await deleteEnvelopeData(editingEnvelopeId);
    hideModal('modal-envelope');
    toast('Deleted');
  });

  // Settings actions
  $('btn-add-envelope').addEventListener('click', () => showEnvelopeModal());

  // Export & Import
  $('btn-export-month').addEventListener('click', () => exportTransactionsCSV(false));
  $('btn-export-all').addEventListener('click', () => exportTransactionsCSV(true));
  $('btn-export-envelopes').addEventListener('click', exportEnvelopesJSON);

  $('btn-import-transactions').addEventListener('click', () => {
    $('file-import-transactions').value = '';
    $('file-import-transactions').click();
  });
  $('file-import-transactions').addEventListener('change', e => {
    if (e.target.files[0]) importTransactionsCSV(e.target.files[0]);
  });

  $('btn-import-envelopes').addEventListener('click', () => {
    $('file-import-envelopes').value = '';
    $('file-import-envelopes').click();
  });
  $('file-import-envelopes').addEventListener('change', e => {
    if (e.target.files[0]) importEnvelopesJSON(e.target.files[0]);
  });

  $('btn-reset-month').addEventListener('click', async () => {
    if (!confirm('Delete all transactions for this month? This cannot be undone.')) return;
    await resetMonthData();
    toast('Month reset');
  });

  $('btn-leave').addEventListener('click', () => {
    if (!confirm('Leave this household? Your local data will be cleared.')) return;
    leaveHouseholdData();
    $('bottom-nav').classList.add('hidden');
    $('fab').classList.add('hidden');
    navigate('setup');
    $('input-name').value = '';
    $('input-code').value = '';
  });

  // Copy household code
  $('household-code-btn').addEventListener('click', () => {
    if (state.householdCode) {
      navigator.clipboard?.writeText(state.householdCode).then(() => toast('Code copied!')).catch(() => {});
    }
  });

  // History filter
  $('history-filter').addEventListener('change', renderHistory);

  // Enter key on inputs
  $('input-amount').addEventListener('keydown', e => { if (e.key === 'Enter') saveTransaction(); });
  $('input-name').addEventListener('keydown', e => { if (e.key === 'Enter') $('btn-create').click(); });
  $('input-code').addEventListener('keydown', e => { if (e.key === 'Enter') $('btn-join').click(); });
}

// ============================================
// ENTER APP
// ============================================
function enterApp() {
  $('bottom-nav').classList.remove('hidden');
  $('fab').classList.remove('hidden');
  navigate('dashboard');
  setupListeners();
  if (!useFirebase) renderAll();
}

// ============================================
// INIT
// ============================================
async function init() {
  // Register service worker
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }

  useFirebase = initFirebase();
  const hasLocal = loadLocal();

  // Show sync status hint on setup
  $('setup-hint').textContent = useFirebase
    ? 'Sync enabled — data shared across devices'
    : 'Running in local mode. Add Firebase config for sync.';

  if (hasLocal && state.householdId) {
    if (useFirebase) {
      try {
        const cred = await firebase.auth().signInAnonymously();
        const uid = cred.user.uid;
        if (uid !== state.user.uid) {
          await db.collection('households').doc(state.householdId).update({
            [`members.${uid}`]: state.user.name,
          });
          state.user.uid = uid;
          state.members[uid] = state.user.name;
          saveLocal();
        }
      } catch {
        // offline — use cached data
      }
    }
    enterApp();
  } else {
    navigate('setup');
  }

  bindEvents();
}

init();
