'use strict';

// ─── Config from URL ──────────────────────────────────────────────────────────
// FIX: the phone page is served by the Python engine which injects host/port
// as query params on the <script> tag URL, not the page URL. We need to read
// from both the page URL params AND try document.currentScript.
const pageParams = new URLSearchParams(window.location.search);
let serverHost = pageParams.get('host') || window.location.hostname;
let serverPort = pageParams.get('port') || window.location.port || '7523';

// Also try to extract from the script tag's src URL (set by dictee_engine.py)
try {
  const scriptSrc = document.currentScript && document.currentScript.src;
  if (scriptSrc) {
    const scriptUrl = new URL(scriptSrc);
    const scriptParams = new URLSearchParams(scriptUrl.search);
    if (scriptParams.get('host')) serverHost = scriptParams.get('host');
    if (scriptParams.get('port')) serverPort = scriptParams.get('port');
  }
} catch (e) {
  // Ignore — will use defaults
}

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

  try {
    ws = new WebSocket(WS_URL);
  } catch (e) {
    console.error('[WS] Failed to create WebSocket:', e);
    scheduleReconnect();
    return;
  }

  ws.addEventListener('open', () => {
    console.log('[WS] Connected to', WS_URL);
    reconnectCount = 0;
    clearTimeout(reconnectTimer);
    setStatus('connected', 'Connecte');
    btnRecord.disabled = false;
    errorScreen.style.display = 'none';
    appEl.style.display = 'flex';
  });

  ws.addEventListener('close', (e) => {
    console.log('[WS] Closed', e.code);
    setStatus('error', 'Deconnecte');
    btnRecord.disabled = true;
    if (isRecording) stopRecognition();
    scheduleReconnect();
  });

  ws.addEventListener('error', () => {
    setStatus('error', 'Erreur reseau');
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
    setStatus('recording', 'Ecoute...');
    transcriptArea.innerHTML = '<span class="placeholder">Parlez...</span>';
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

    let html = '';
    if (final) html += '<span class="final">' + escapeHtml(final) + '</span>';
    if (interim) html += '<span class="interim"> ' + escapeHtml(interim) + '</span>';
    if (!html) html = '<span class="placeholder">Parlez...</span>';
    transcriptArea.innerHTML = html;

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
      transcriptArea.innerHTML = '<span class="placeholder" style="color:#ff3b30">Microphone refuse — autorisez l\'acces au micro</span>';
      // FIX: stop recording if permission denied
      isRecording = false;
      onStopRecognition();
    } else if (event.error === 'no-speech') {
      // Restart silently — handled by onend
    } else if (event.error === 'network') {
      transcriptArea.innerHTML = '<span class="placeholder" style="color:#ff3b30">Erreur reseau STT</span>';
    } else if (event.error === 'aborted') {
      // User stopped, normal flow
    }
  };

  r.onend = () => {
    if (isRecording) {
      // FIX: add small delay before restart to avoid rapid restart loops
      setTimeout(() => {
        if (isRecording) {
          try { r.start(); } catch {}
        }
      }, 100);
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
    isRecording = false;
    onStopRecognition();
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
  setStatus('connected', 'Connecte');
  transcriptArea.innerHTML = '<span class="placeholder">Appuyez sur le bouton pour dicter...</span>';
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
setStatus('', 'Connexion...');
connect();
