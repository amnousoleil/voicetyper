(function() {
  'use strict';

  // ── State ──────────────────────────────────────────────────────────────
  var isDictating = false;
  var alwaysOn = false;
  var history = [];
  var lastTranscript = '';

  // ── DOM refs ───────────────────────────────────────────────────────────
  var micRing     = document.getElementById('mic-ring');
  var micBtn      = document.getElementById('mic-btn');
  var micLabel    = document.getElementById('mic-label');
  var waveform    = document.getElementById('waveform');
  var transcriptEl = document.getElementById('transcript-text');
  var statusDot   = document.getElementById('status-dot');
  var statusText  = document.getElementById('status-text');
  var engineBar   = document.getElementById('engine-bar');
  var engineMsg   = document.getElementById('engine-msg');
  var retryBtn    = document.getElementById('retry-btn');
  var historyList = document.getElementById('history-list');
  var alwaysOnToggle = document.getElementById('always-on-toggle');
  var updateBanner = document.getElementById('update-banner');
  var updateText  = document.getElementById('update-text');
  var updateBtn   = document.getElementById('update-btn');
  var langSelect  = document.getElementById('lang-select');
  var deviceSelect = document.getElementById('device-select');

  // ── Button event listeners (fixes click issues — no more inline onclick) ──
  document.getElementById('btn-diag').addEventListener('click', function(e) {
    e.stopPropagation();
    toggleDebug();
  });
  document.getElementById('btn-min').addEventListener('click', function(e) {
    e.stopPropagation();
    voicetyper.minimizeWindow();
  });
  document.getElementById('btn-close').addEventListener('click', function(e) {
    e.stopPropagation();
    voicetyper.closeWindow();
  });

  micBtn.addEventListener('click', function(e) {
    e.stopPropagation();
    toggleDictation();
  });

  document.getElementById('copy-btn').addEventListener('click', function(e) {
    e.stopPropagation();
    copyTranscript();
  });

  langSelect.addEventListener('change', function() {
    voicetyper.setLanguage(this.value);
  });

  deviceSelect.addEventListener('change', function() {
    voicetyper.setDevice(this.value);
  });

  alwaysOnToggle.addEventListener('click', function(e) {
    e.stopPropagation();
    alwaysOn = !alwaysOn;
    voicetyper.toggleAlwaysOn(alwaysOn);
    updateAlwaysOnUI({ enabled: alwaysOn });
  });

  retryBtn.addEventListener('click', function(e) {
    e.stopPropagation();
    voicetyper.retryEngine();
  });

  document.getElementById('clear-history-btn').addEventListener('click', function(e) {
    e.stopPropagation();
    history = [];
    renderHistory();
  });

  document.getElementById('send-logs-btn').addEventListener('click', function(e) {
    e.stopPropagation();
    sendLogs();
  });
  document.getElementById('show-log-btn').addEventListener('click', function(e) {
    e.stopPropagation();
    showFullLog();
  });

  updateBtn.addEventListener('click', function(e) {
    e.stopPropagation();
    voicetyper.installUpdate();
  });

  document.getElementById('fatal-retry-btn').addEventListener('click', function(e) {
    e.stopPropagation();
    voicetyper.retryEngine();
    document.getElementById('fatal-overlay').classList.remove('visible');
  });
  document.getElementById('fatal-diag-btn').addEventListener('click', function(e) {
    e.stopPropagation();
    document.getElementById('fatal-overlay').classList.remove('visible');
    toggleDebug();
  });

  // ── Init ───────────────────────────────────────────────────────────────
  voicetyper.listDevices();

  setTimeout(function() {
    voicetyper.sendLogs().then(function(r) {
      if (r && r.ok) addDebugLine('Logs', 'envoyes auto', true);
    }).catch(function() {});
  }, 8000);

  voicetyper.getAlwaysOnStatus().then(function(s) {
    if (s) updateAlwaysOnUI(s);
  });
  voicetyper.getStatus().then(function(s) {
    if (s && s.engine_ready) setEngineReady();
  });

  // ── Toggle dictation ──────────────────────────────────────────────────
  function toggleDictation() {
    if (isDictating) {
      voicetyper.stopDictation();
      setIdle();
    } else {
      voicetyper.startDictation();
      setDictating();
    }
  }

  function setDictating() {
    isDictating = true;
    micRing.classList.add('active');
    waveform.classList.add('active');
    micLabel.innerHTML = '<strong>En \u00e9coute...</strong>';
    micBtn.querySelector('.mic-icon').textContent = '\u23F9';
  }

  function setIdle() {
    isDictating = false;
    micRing.classList.remove('active');
    waveform.classList.remove('active');
    micLabel.innerHTML = '<strong>Appuyer pour dicter</strong>';
    micBtn.querySelector('.mic-icon').textContent = '\uD83C\uDFA4';
  }

  function setEngineReady() {
    engineBar.classList.remove('error');
    engineMsg.textContent = 'Moteur pr\u00eat \u2713';
    retryBtn.style.display = 'none';
    statusDot.classList.add('connected');
    statusDot.classList.remove('error');
    statusText.textContent = 'Connect\u00e9';
  }

  // ── Always-On ─────────────────────────────────────────────────────────
  function updateAlwaysOnUI(s) {
    alwaysOn = s.enabled || s.active || false;
    alwaysOnToggle.classList.toggle('on', alwaysOn);
    if (alwaysOn && !s.paused) {
      micRing.classList.add('active');
      waveform.classList.add('active');
      micLabel.innerHTML = '<strong>Mode continu actif</strong>';
    }
  }

  // ── Copy ──────────────────────────────────────────────────────────────
  function copyTranscript() {
    if (!lastTranscript) return;
    navigator.clipboard.writeText(lastTranscript).then(function() {
      showToast('Copi\u00e9 dans le presse-papier !');
    });
  }

  // ── History ───────────────────────────────────────────────────────────
  function addToHistory(text) {
    var now = new Date();
    var time = now.getHours().toString().padStart(2, '0') + ':' + now.getMinutes().toString().padStart(2, '0');
    history.unshift({ text: text, time: time });
    if (history.length > 50) history.pop();
    renderHistory();
  }

  function renderHistory() {
    if (history.length === 0) {
      historyList.innerHTML = '<div class="history-empty">Aucune dict\u00e9e pour le moment</div>';
      return;
    }
    historyList.innerHTML = '';
    history.forEach(function(h) {
      var item = document.createElement('div');
      item.className = 'history-item';
      var timeSpan = document.createElement('span');
      timeSpan.className = 'history-time';
      timeSpan.textContent = h.time;
      var textSpan = document.createElement('span');
      textSpan.className = 'history-text';
      textSpan.textContent = h.text;
      item.appendChild(timeSpan);
      item.appendChild(textSpan);
      item.addEventListener('click', function() {
        navigator.clipboard.writeText(h.text).then(function() {
          showToast('Copi\u00e9 !');
        });
      });
      historyList.appendChild(item);
    });
  }

  function escHtml(s) {
    var d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  // ── Events from main process ──────────────────────────────────────────
  voicetyper.onTranscript(function(data) {
    var text = data.text || '';
    if (!text.trim()) return;
    lastTranscript = text;
    transcriptEl.textContent = text;
    transcriptEl.classList.remove('empty');
    addToHistory(text);
    transcriptEl.style.color = 'var(--gold)';
    setTimeout(function() { transcriptEl.style.color = ''; }, 1000);
  });

  voicetyper.onEngineStatus(function(data) {
    if (data.connected) {
      setEngineReady();
    } else {
      statusDot.classList.remove('connected');
      statusDot.classList.add('error');
      statusText.textContent = 'D\u00e9connect\u00e9';
      engineMsg.textContent = 'Moteur d\u00e9connect\u00e9 \u2014 relance...';
    }
  });

  voicetyper.onEngineError(function(data) {
    engineBar.classList.add('error');
    engineMsg.textContent = data.message || 'Erreur moteur';
    retryBtn.style.display = '';
    statusDot.classList.remove('connected');
    statusDot.classList.add('error');
    statusText.textContent = 'Erreur';
    addDebugLine('ERREUR', data.message || JSON.stringify(data), false);
    document.getElementById('debug-panel').style.display = 'block';
  });

  voicetyper.onEngineFatal(function(data) {
    document.getElementById('fatal-msg').textContent = data.message || 'Moteur indisponible';
    document.getElementById('fatal-overlay').classList.add('visible');
    setIdle();
    statusDot.classList.remove('connected');
    statusDot.classList.add('error');
    statusText.textContent = 'Hors ligne';
    addDebugLine('FATAL', data.message || JSON.stringify(data), false);
    document.getElementById('debug-panel').style.display = 'block';
  });

  voicetyper.onDevicesList(function(data) {
    deviceSelect.innerHTML = '<option value="">Micro par d\u00e9faut</option>';
    (data.devices || []).forEach(function(d) {
      var opt = document.createElement('option');
      opt.value = String(d.id);
      opt.textContent = d.name + (d.is_default ? ' \u2713' : '');
      deviceSelect.appendChild(opt);
    });
    if (data.selected_id != null) deviceSelect.value = String(data.selected_id);
  });

  voicetyper.onUpdateAvailable(function(data) {
    updateText.textContent = '\u2B07 Mise \u00e0 jour v' + data.version + ' en cours...';
    updateBanner.classList.add('visible');
    updateBanner.classList.remove('ready');
  });

  voicetyper.onUpdateDownloadProgress(function(data) {
    updateText.textContent = '\u2B07 T\u00e9l\u00e9chargement : ' + (data.progress || 0) + '%';
  });

  voicetyper.onUpdateReady(function(data) {
    updateText.textContent = '\u2728 Mise \u00e0 jour v' + data.version + ' pr\u00eate !';
    updateBanner.classList.add('visible', 'ready');
    showToast('Mise \u00e0 jour disponible');
  });

  voicetyper.onAlwaysOnStatus(function(data) { updateAlwaysOnUI(data); });

  voicetyper.onVoiceCommand(function(data) {
    if (data.message) showToast(data.message);
  });

  // ── Toast ─────────────────────────────────────────────────────────────
  function showToast(msg) {
    var c = document.getElementById('toast-container');
    var t = document.createElement('div');
    t.className = 'toast';
    t.textContent = msg;
    c.appendChild(t);
    setTimeout(function() {
      t.style.opacity = '0';
      t.style.transform = 'translateY(8px)';
      t.style.transition = 'all 0.3s';
      setTimeout(function() { t.remove(); }, 300);
    }, 3000);
  }

  // ── Debug Panel ───────────────────────────────────────────────────────
  var debugLines = [];
  function toggleDebug() {
    var p = document.getElementById('debug-panel');
    p.style.display = p.style.display === 'none' ? 'block' : 'none';
  }
  window.toggleDebug = toggleDebug;

  function addDebugLine(label, value, ok) {
    var color = ok === true ? '#10B981' : ok === false ? '#EF4444' : 'rgba(255,255,255,0.4)';
    debugLines.push('<div style="color:' + color + ';padding:1px 0"><b>' + escHtml(label) + '</b>: ' + escHtml(String(value)) + '</div>');
    document.getElementById('debug-lines').innerHTML = debugLines.join('');
  }

  function sendLogs() {
    var btn = document.getElementById('send-logs-btn');
    if (btn) { btn.textContent = 'Envoi...'; btn.disabled = true; }
    voicetyper.sendLogs().then(function(r) {
      if (r && r.ok) {
        showToast('Logs envoy\u00e9s !');
        if (btn) { btn.textContent = 'Envoy\u00e9 \u2713'; }
      } else {
        showToast('Erreur: ' + (r && r.error || 'inconnu'));
        if (btn) { btn.textContent = 'Envoyer'; btn.disabled = false; }
      }
    }).catch(function() {
      showToast('Erreur envoi logs');
      if (btn) { btn.textContent = 'Envoyer'; btn.disabled = false; }
    });
  }

  function showFullLog() {
    voicetyper.getLogContent().then(function(r) {
      if (!r || !r.ok) { showToast('Log introuvable'); return; }
      var overlay = document.createElement('div');
      overlay.style.cssText = 'position:fixed;inset:0;background:rgba(5,5,8,.95);backdrop-filter:blur(20px);z-index:9999;display:flex;flex-direction:column;padding:20px;gap:10px';

      var header = document.createElement('div');
      header.style.cssText = 'display:flex;justify-content:space-between;align-items:center;flex-shrink:0';

      var pathLabel = document.createElement('span');
      pathLabel.style.cssText = 'color:#FFD700;font-weight:700;font-size:12px;letter-spacing:0.05em';
      pathLabel.textContent = r.path || 'Log';
      header.appendChild(pathLabel);

      var closeBtn = document.createElement('button');
      closeBtn.textContent = 'Fermer';
      closeBtn.style.cssText = 'background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);color:#fff;padding:6px 14px;border-radius:8px;cursor:pointer;font-size:12px';
      closeBtn.addEventListener('click', function() { overlay.remove(); });
      header.appendChild(closeBtn);

      var pre = document.createElement('pre');
      pre.style.cssText = 'flex:1;overflow:auto;background:rgba(0,0,0,0.4);border:1px solid rgba(255,255,255,0.06);border-radius:12px;padding:14px;color:rgba(255,255,255,0.6);font-size:10px;line-height:1.6;margin:0;font-family:monospace';
      pre.textContent = r.content || '(vide)';

      overlay.appendChild(header);
      overlay.appendChild(pre);
      document.body.appendChild(overlay);
      pre.scrollTop = pre.scrollHeight;
    });
  }

  // Initial status fetch for debug
  voicetyper.getStatus().then(function(s) {
    s = s || {};
    addDebugLine('Version', s.version || '?', null);
    addDebugLine('Plateforme', s.platform || navigator.platform, null);
    addDebugLine('Moteur pr\u00eat', s.engine_ready ? 'OUI \u2713' : 'NON', s.engine_ready);
    addDebugLine('Engine path', s.engine_path || '?', s.engine_path ? !s.engine_path.includes('not found') : false);
    addDebugLine('Python path', s.python_path || '?', !!s.python_path);
    addDebugLine('Models path', s.models_path || '?', null);
  });

})();
