'use strict';

// ─── State ────────────────────────────────────────────────────────────────────
const state = {
  isDictating: false,
  engineConnected: false,
  finalText: '',
  history: [],
  qrVisible: true,
};

// ─── DOM refs ─────────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);

const btnDictate      = $('btn-dictate');
const btnClose        = $('btn-close');
const btnMinimize     = $('btn-minimize');
const btnClearTrans   = $('btn-clear-transcript');
const btnClearHistory = $('btn-clear-history');
const btnQrToggle     = $('btn-qr-toggle');
const selectLang      = $('select-lang');
const selectEngine    = $('select-engine');
const waveform        = $('waveform');
const transcriptFinal = $('transcript-final');
const transcriptInter = $('transcript-interim');
const downloadSection = $('download-section');
const downloadLabel   = $('download-label');
const downloadBar     = $('download-progress');
const qrSection       = $('qr-section');
const qrImageWrap     = $('qr-image-wrap');
const qrUrl           = $('qr-url');
const historyList     = $('history-list');
const engineStatusDot = $('engine-status-dot');
const engineStatusTxt = $('engine-status-text');
const engineDot       = $('engine-dot');
const engineDotLabel  = $('engine-dot-label');
const toastContainer  = $('toast-container');
const updateBanner    = $('update-banner');
const updateBannerTxt = $('update-banner-text');
const updateBtn       = $('update-btn');
const updateDismiss   = $('update-dismiss');
const appVersionEl    = $('app-version');

// ─── Init ─────────────────────────────────────────────────────────────────────
(async function init() {
  loadHistory();
  loadPreferences();
  bindEvents();
  setupVoicetyperListeners();
  await requestPhoneUrl();
  await loadAppVersion();
})();

// ─── Event bindings ───────────────────────────────────────────────────────────
function bindEvents() {
  btnDictate.addEventListener('click', toggleDictation);

  btnClose.addEventListener('click', () => window.voicetyper.closeWindow());
  btnMinimize.addEventListener('click', () => window.voicetyper.minimizeWindow());

  btnClearTrans.addEventListener('click', () => {
    state.finalText = '';
    transcriptFinal.textContent = '';
    transcriptInter.textContent = '';
  });

  btnClearHistory.addEventListener('click', () => {
    state.history = [];
    saveHistory();
    renderHistory();
    toast('Historique effacé');
  });

  btnQrToggle.addEventListener('click', () => {
    state.qrVisible = !state.qrVisible;
    const inner = qrSection.querySelector('.qr-inner');
    if (inner) inner.style.display = state.qrVisible ? '' : 'none';
    btnQrToggle.textContent = state.qrVisible ? 'Masquer' : 'Afficher';
    btnQrToggle.classList.toggle('active', state.qrVisible);
  });

  selectLang.addEventListener('change', () => {
    window.voicetyper.setLanguage(selectLang.value);
    savePreferences();
    toast(`Langue : ${selectLang.options[selectLang.selectedIndex].text}`);
  });

  selectEngine.addEventListener('change', () => {
    window.voicetyper.setEngine(selectEngine.value);
    savePreferences();
    toast(`Moteur : ${selectEngine.options[selectEngine.selectedIndex].text}`);
  });

  qrUrl.addEventListener('click', () => {
    const url = qrUrl.textContent;
    if (url && url !== '—') {
      navigator.clipboard.writeText(url).catch(() => {});
      toast('URL copiée !');
    }
  });

  // Update banner buttons
  updateBtn.addEventListener('click', () => {
    window.voicetyper.installUpdate();
  });

  updateDismiss.addEventListener('click', () => {
    updateBanner.classList.remove('visible');
  });
}

// ─── VoiceTyper API listeners ─────────────────────────────────────────────────
function setupVoicetyperListeners() {
  window.voicetyper.onTranscript((data) => {
    handleTranscript(data);
  });

  window.voicetyper.onStatus((data) => {
    handleStatus(data);
  });

  window.voicetyper.onQRCode((data) => {
    handleQRCode(data);
  });

  window.voicetyper.onEngineStatus((data) => {
    setEngineConnected(data.connected);
  });

  window.voicetyper.onEngineError((data) => {
    toast(`⚠️ ${data.message || 'Erreur moteur'}`, 4000);
  });

  window.voicetyper.onModelDownload((data) => {
    handleModelDownload(data);
  });

  window.voicetyper.onShowQR(() => {
    qrSection.classList.add('visible');
    state.qrVisible = true;
    qrSection.scrollIntoView({ behavior: 'smooth' });
  });

  // Update listeners
  window.voicetyper.onUpdateAvailable((data) => {
    updateBannerTxt.textContent = `Mise à jour disponible — v${data.version}`;
    updateBtn.textContent = 'Téléchargement…';
    updateBtn.disabled = true;
    updateBanner.classList.remove('ready', 'downloading');
    updateBanner.classList.add('visible', 'downloading');
  });

  window.voicetyper.onUpdateDownloadProgress((data) => {
    if (data.progress !== undefined) {
      updateBannerTxt.textContent = `Téléchargement mise à jour… ${data.progress}%`;
    }
  });

  window.voicetyper.onUpdateReady((data) => {
    updateBannerTxt.textContent = `Mise à jour v${data.version} prête — Redémarrez pour appliquer`;
    updateBtn.textContent = 'Installer';
    updateBtn.disabled = false;
    updateBanner.classList.remove('downloading');
    updateBanner.classList.add('visible', 'ready');
    toast('Mise à jour téléchargée — cliquez sur Installer', 5000);
  });

  window.voicetyper.onEngineUpdated((data) => {
    toast(`Moteur mis à jour — v${data.version}`, 3000);
  });
}

// ─── Dictation toggle ─────────────────────────────────────────────────────────
function toggleDictation() {
  if (state.isDictating) {
    window.voicetyper.stopDictation();
  } else {
    window.voicetyper.startDictation();
  }
}

// ─── Handle engine messages ───────────────────────────────────────────────────
function handleTranscript(data) {
  const { text, is_final } = data;

  if (is_final) {
    state.finalText += (state.finalText ? ' ' : '') + text;
    transcriptFinal.textContent = state.finalText;
    transcriptInter.textContent = '';
    addToHistory(text);
  } else {
    transcriptInter.textContent = ' ' + text;
  }

  // Auto scroll
  const box = transcriptFinal.parentElement;
  box.scrollTop = box.scrollHeight;
}

function handleStatus(data) {
  const { state: s } = data;

  state.isDictating = s === 'listening';

  // Update button
  btnDictate.classList.toggle('listening', s === 'listening');
  btnDictate.classList.toggle('processing', s === 'processing');

  const micIcon = btnDictate.querySelector('.mic-icon');
  const btnLabel = btnDictate.querySelector('.btn-label');

  if (s === 'listening') {
    micIcon.textContent = '🔴';
    btnLabel.textContent = 'STOP';
    waveform.classList.add('active');
  } else if (s === 'processing') {
    micIcon.textContent = '⏳';
    btnLabel.textContent = 'TRAITEMENT';
    waveform.classList.remove('active');
  } else {
    micIcon.textContent = '🎤';
    btnLabel.textContent = 'DICTER';
    waveform.classList.remove('active');
  }
}

function handleQRCode(data) {
  const { url, svg } = data;

  qrSection.classList.add('visible');

  if (svg) {
    qrImageWrap.innerHTML = svg;
  } else {
    qrImageWrap.innerHTML = `<span style="color:#ccc;font-size:10px;">QR indisponible</span>`;
  }

  qrUrl.textContent = url || '—';
}

function handleModelDownload(data) {
  const { model, progress, status, size } = data;

  if (status === 'downloading') {
    downloadSection.classList.add('visible');
    downloadLabel.textContent = `Téléchargement ${model} (${size || '?'})… ${Math.round(progress || 0)}%`;
    downloadBar.style.width = `${progress || 0}%`;
  } else if (status === 'extracting') {
    downloadLabel.textContent = `Extraction ${model}…`;
    downloadBar.style.width = '95%';
  } else if (status === 'done') {
    downloadLabel.textContent = `${model} prêt !`;
    downloadBar.style.width = '100%';
    setTimeout(() => downloadSection.classList.remove('visible'), 2000);
  } else if (status === 'error') {
    downloadLabel.textContent = `Erreur téléchargement ${model}`;
    downloadBar.style.background = '#ff3b30';
    setTimeout(() => downloadSection.classList.remove('visible'), 4000);
  }
}

function setEngineConnected(connected) {
  state.engineConnected = connected;
  engineStatusDot.className = 'dot ' + (connected ? 'connected' : 'error');
  engineStatusTxt.textContent = connected ? 'Prêt' : 'Déconnecté';
  engineDot.className = connected ? 'ok' : 'error';
  engineDotLabel.textContent = connected ? 'En ligne' : 'Hors ligne';
  btnDictate.disabled = !connected;
  if (!connected) btnDictate.style.opacity = '0.5';
  else btnDictate.style.opacity = '';
}

// ─── App version ──────────────────────────────────────────────────────────────
async function loadAppVersion() {
  try {
    const version = await window.voicetyper.getAppVersion();
    if (appVersionEl) appVersionEl.textContent = `v${version}`;
  } catch {}
}

// ─── Phone URL / QR request ───────────────────────────────────────────────────
async function requestPhoneUrl() {
  try {
    const url = await window.voicetyper.getPhoneUrl();
    qrUrl.textContent = url;
  } catch (e) {
    // Engine not ready yet, will receive via onQRCode event
  }
}

// ─── History ──────────────────────────────────────────────────────────────────
const HISTORY_KEY = 'voicetyper_history';
const MAX_HISTORY = 20;

function addToHistory(text) {
  if (!text.trim()) return;
  const entry = {
    text: text.trim(),
    time: new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }),
  };
  state.history.unshift(entry);
  if (state.history.length > MAX_HISTORY) state.history = state.history.slice(0, MAX_HISTORY);
  saveHistory();
  renderHistory();
}

function renderHistory() {
  if (state.history.length === 0) {
    historyList.innerHTML = '<div class="history-empty">Aucune dictée pour le moment</div>';
    return;
  }

  historyList.innerHTML = state.history
    .slice(0, 10)
    .map(entry => `
      <div class="history-item" data-text="${escapeHtml(entry.text)}">
        <span class="history-time">${entry.time}</span>
        <span class="history-text">${escapeHtml(entry.text)}</span>
      </div>
    `)
    .join('');

  // Click to copy
  historyList.querySelectorAll('.history-item').forEach(el => {
    el.addEventListener('click', () => {
      const text = el.dataset.text;
      navigator.clipboard.writeText(text).then(() => toast('Copié !')).catch(() => {});
    });
  });
}

function saveHistory() {
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(state.history)); } catch {}
}

function loadHistory() {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (raw) state.history = JSON.parse(raw);
  } catch {}
  renderHistory();
}

// ─── Preferences ─────────────────────────────────────────────────────────────
const PREFS_KEY = 'voicetyper_prefs';

function savePreferences() {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({
      lang: selectLang.value,
      engine: selectEngine.value,
    }));
  } catch {}
}

function loadPreferences() {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (raw) {
      const prefs = JSON.parse(raw);
      if (prefs.lang) selectLang.value = prefs.lang;
      if (prefs.engine) selectEngine.value = prefs.engine;
    }
  } catch {}

  // Apply loaded prefs to engine
  window.voicetyper.setLanguage(selectLang.value);
  window.voicetyper.setEngine(selectEngine.value);
}

// ─── Toast ────────────────────────────────────────────────────────────────────
function toast(msg, duration = 2200) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  toastContainer.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transition = 'opacity 0.3s';
    setTimeout(() => el.remove(), 350);
  }, duration);
}

// ─── Utils ────────────────────────────────────────────────────────────────────
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
