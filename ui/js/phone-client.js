'use strict';

// ─── Config from URL ──────────────────────────────────────────────────────────
const params = new URLSearchParams(window.location.search);
const serverHost = params.get('host') || window.location.hostname;
const serverPort = params.get('port') || window.location.port || '7523';
const WS_URL = `ws://${serverHost}:${serverPort}/ws/phone`;

// ─── DOM refs ─────────────────────────────────────────────────────────────────
const appEl         = document.getElementById('app');
const errorScreen   = document.getElementById('error-screen');
const unsupportedEl = document.getElementById('unsupported-screen');
const btnRecord     = document.getElementById('btn-record');
const selectLang    = document.getElementById('select-lang');
const statusDot     = document.getElementById('status-dot');
const statusText    = document.getElementById('status-text');
const transcriptArea= document.getElementById('transcript-area');
const confirmToast  = document.getElementById('confirm-toast');

// ─── Check Web Speech API ─────────────────────────────────────────────────────
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

if (!SpeechRecognition) {
  appEl.style.display = 'none';
  unsupportedEl.classList.add('visible');
  throw new Error('SpeechRecognition not supported');
}

// ─── State ────────────────────────────────────────────────────────────────────
let ws = null;
let recognition = null;
let isRecording = false;
let reconnectTimer = null;
let reconnectCount = 0;
const MAX_RECONNECT = 30;

// ─── WebSocket ────────────────────────────────────────────────────────────────
function connect() {
  if (ws && ws.readyState === WebSocket.OPEN) return;

  ws = new WebSocket(WS_URL);

  ws.addEventListener('open', () => {
    console.log('[WS] Connected');
    reconnectCount = 0;
    clearTimeout(reconnectTimer);
    setStatus('connected', 'Connecté');
    btnRecord.disabled = false;
    errorScreen.style.display = 'none';
    appEl.style.display = 'flex';
  });

  ws.addEventListener('close', (e) => {
    console.log('[WS] Closed', e.code);
    setStatus('error', 'Déconnecté');
    btnRecord.disabled = true;
    if (isRecording) stopRecognition();
    scheduleReconnect();
  });

  ws.addEventListener('error', () => {
    setStatus('error', 'Erreur réseau');
  });

  ws.addEventListener('message', (evt) => {
    try {
      const msg = JSON.parse(evt.data);
      handleServerMessage(msg);
    } catch {}
  });
}

function scheduleReconnect() {
  if (reconnectCount >= MAX_RECONNECT) {
    appEl.style.display = 'none';
    errorScreen.classList.add('visible');
    return;
  }
  reconnectCount++;
  const delay = Math.min(1000 * reconnectCount, 10000);
  reconnectTimer = setTimeout(connect, delay);
}

function sendWS(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

function handleServerMessage(msg) {
  if (msg.type === 'injected') {
    showConfirm();
  }
}

// ─── Speech Recognition ───────────────────────────────────────────────────────
function createRecognition() {
  const r = new SpeechRecognition();
  r.continuous = true;
  r.interimResults = true;
  r.maxAlternatives = 1;
  r.lang = selectLang.value;

  r.onstart = () => {
    isRecording = true;
    btnRecord.classList.add('recording');
    btnRecord.querySelector('.lbl').textContent = 'STOP';
    setStatus('recording', 'Écoute…');
    transcriptArea.innerHTML = '<span class="placeholder">Parlez…</span>';
  };

  r.onresult = (event) => {
    let interim = '';
    let final = '';

    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i];
      const transcript = result[0].transcript;
      if (result.isFinal) {
        final += transcript;
      } else {
        interim += transcript;
      }
    }

    // Render
    let html = '';
    if (final) html += `<span class="final">${escapeHtml(final)}</span>`;
    if (interim) html += `<span class="interim"> ${escapeHtml(interim)}</span>`;
    if (!html) html = '<span class="placeholder">Parlez…</span>';
    transcriptArea.innerHTML = html;

    // Send final results to desktop
    if (final.trim()) {
      sendWS({
        type: 'transcript',
        text: final.trim(),
        lang: selectLang.value,
        is_final: true,
      });
    }
  };

  r.onerror = (event) => {
    console.error('[STT] Error:', event.error);
    if (event.error === 'not-allowed') {
      transcriptArea.innerHTML = `<span class="placeholder" style="color:#ff3b30">Microphone refusé — autorisez l'accès au micro</span>`;
    } else if (event.error === 'no-speech') {
      // Restart silently
    } else if (event.error === 'network') {
      transcriptArea.innerHTML = `<span class="placeholder" style="color:#ff3b30">Erreur réseau STT</span>`;
    }
  };

  r.onend = () => {
    // Restart if still supposed to be recording
    if (isRecording) {
      try { r.start(); } catch {}
    } else {
      onStopRecognition();
    }
  };

  return r;
}

function startRecognition() {
  if (recognition) {
    try { recognition.abort(); } catch {}
  }
  recognition = createRecognition();
  try {
    recognition.start();
  } catch (e) {
    console.error('[STT] Start failed:', e);
  }
}

function stopRecognition() {
  isRecording = false;
  if (recognition) {
    try { recognition.stop(); } catch {}
  }
}

function onStopRecognition() {
  isRecording = false;
  btnRecord.classList.remove('recording');
  btnRecord.querySelector('.lbl').textContent = 'DICTER';
  setStatus('connected', 'Connecté');
  transcriptArea.innerHTML = '<span class="placeholder">Appuyez sur le bouton pour dicter…</span>';
}

// ─── Button ───────────────────────────────────────────────────────────────────
btnRecord.addEventListener('click', () => {
  if (isRecording) {
    stopRecognition();
  } else {
    startRecognition();
  }
});

// ─── Language change ──────────────────────────────────────────────────────────
selectLang.addEventListener('change', () => {
  if (isRecording) {
    stopRecognition();
    setTimeout(startRecognition, 300);
  }
});

// ─── Status helpers ───────────────────────────────────────────────────────────
function setStatus(cls, text) {
  statusDot.className = cls;
  statusText.textContent = text;
}

// ─── Confirm toast ────────────────────────────────────────────────────────────
function showConfirm() {
  confirmToast.classList.add('show');
  setTimeout(() => confirmToast.classList.remove('show'), 1800);
}

// ─── Utils ────────────────────────────────────────────────────────────────────
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── Start ────────────────────────────────────────────────────────────────────
setStatus('', 'Connexion…');
connect();
