'use strict';

const { app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain, nativeImage, shell, dialog } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const os = require('os');
const fs = require('fs');
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const { clipboard } = require('electron');

// ─── Crash & Bug Reporter ─────────────────────────────────────────────────────
const REPORT_URL = 'http://72.60.215.20:8766/report';

function sendBugReport(type, data) {
  try {
    const payload = JSON.stringify({
      type,
      version: app.isReady() ? app.getVersion() : '1.0.0',
      platform: process.platform,
      arch: process.arch,
      timestamp: new Date().toISOString(),
      hostname: os.hostname(),
      ...data,
    });
    const req = http.request(REPORT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      timeout: 5000,
    });
    req.on('error', () => {});
    req.write(payload);
    req.end();
  } catch (_) {}
}

process.on('uncaughtException', (err) => {
  sendBugReport('crash', { error: err.message, stack: err.stack });
  console.error('[CRASH]', err);
});

process.on('unhandledRejection', (reason) => {
  sendBugReport('unhandled_rejection', { error: String(reason), stack: String(reason && reason.stack) });
  console.error('[UNHANDLED]', reason);
});

// ─── Constants ────────────────────────────────────────────────────────────────
const ENGINE_PORT = 7523;
const ENGINE_HTTP_URL = `http://127.0.0.1:${ENGINE_PORT}`;

const UPDATE_SERVER_URL = 'http://72.60.215.20:8766';
const UPDATE_CHECK_DELAY_MS = 10000;

// Platform key mapping for update server
const PLATFORM_KEYS = {
  win32: 'win',
  darwin: 'mac',
  linux: 'linux',
};

// ─── State ────────────────────────────────────────────────────────────────────
let mainWindow = null;
let tray = null;
let pythonProcess = null;
let engineReady = false;
let isQuitting = false;
let isDictating = false;
let pendingUpdatePath = null;
let pendingUpdateVersion = null;
let alwaysOnMode = false;
let alwaysOnPaused = false;
let engineStartAttempts = 0;
const MAX_ENGINE_RESTARTS = 5;

// Error dedup: avoid spamming the UI with repeated errors
let lastErrorMessage = '';
let lastErrorTime = 0;
const ERROR_DEDUP_MS = 5000;

// ─── Single instance lock ─────────────────────────────────────────────────────
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

// ─── App lifecycle ─────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  createMainWindow();
  createTray();
  registerShortcuts();
  await startPythonEngine();
  startPolling();
  setTimeout(() => checkForUpdates(), UPDATE_CHECK_DELAY_MS);

  // Load always-on preference
  const configPath = path.join(app.getPath('userData'), 'voicetyper-config.json');
  try {
    if (fs.existsSync(configPath)) {
      const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (cfg.alwaysOn) {
        alwaysOnMode = true;
        console.log('[AlwaysOn] Mode enabled from config — will auto-start dictation');
        // Wait for engine to be ready, then start dictation
        const waitForEngine = setInterval(() => {
          if (engineReady) {
            clearInterval(waitForEngine);
            console.log('[AlwaysOn] Engine ready — starting dictation automatically');
            sendToEngine({ type: 'start_dictation' });
            sendToWindow('always-on-status', { active: true, paused: false });
          }
        }, 1000);
        // Give up after 60 seconds
        setTimeout(() => clearInterval(waitForEngine), 60000);
      }
    }
  } catch (e) {
    console.error('[AlwaysOn] Config load error:', e.message);
  }
});

app.on('window-all-closed', (e) => {
  // Keep running in tray
});

app.on('before-quit', () => {
  isQuitting = true;
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  stopPythonEngine();
});

app.on('activate', () => {
  if (mainWindow === null) createMainWindow();
  else mainWindow.show();
});

// ─── Main Window ──────────────────────────────────────────────────────────────
function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 420,
    height: 640,
    minWidth: 380,
    minHeight: 500,
    frame: false,
    transparent: false,
    backgroundColor: '#0f0f0f',
    resizable: true,
    show: false,
    titleBarStyle: 'hidden',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
    icon: getAppIcon(),
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'ui', 'index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) {
      e.preventDefault();
    }
  });

  mainWindow.webContents.setWindowOpenHandler(() => {
    return { action: 'deny' };
  });
}

function getAppIcon() {
  const iconsDir = path.join(__dirname, '..', 'build', 'icons');
  if (process.platform === 'win32') return path.join(iconsDir, 'icon.ico');
  if (process.platform === 'darwin') return path.join(iconsDir, 'icon.icns');
  return path.join(iconsDir, 'icon.png');
}

// ─── Tray ─────────────────────────────────────────────────────────────────────
function createTray() {
  let trayIcon;

  const trayIconPath = path.join(__dirname, '..', 'build', 'icons', '16x16.png');
  try {
    if (fs.existsSync(trayIconPath)) {
      trayIcon = nativeImage.createFromPath(trayIconPath);
    }
  } catch {}

  if (!trayIcon || trayIcon.isEmpty()) {
    const iconData = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAABHNCSVQICAgIfAhkiAAAAAlwSFlz' +
      'AAALEgAACxIB0t1+/AAAABx0RVh0U29mdHdhcmUAQWRvYmUgRmlyZXdvcmtzIENTNXG14zYAAAAW' +
      'SURBVDiNY2AYBaNgFAx3AAAAAABJRU5ErkJggg==',
      'base64'
    );
    try {
      trayIcon = nativeImage.createFromBuffer(iconData, { width: 16, height: 16 });
    } catch {
      trayIcon = nativeImage.createEmpty();
    }
  }

  tray = new Tray(trayIcon);
  tray.setToolTip('VoiceTyper — Ctrl+Alt+Space to dictate');
  updateTrayMenu();

  tray.on('click', () => {
    if (mainWindow) {
      if (mainWindow.isVisible()) mainWindow.hide();
      else { mainWindow.show(); mainWindow.focus(); }
    }
  });
}

function updateTrayMenu() {
  if (!tray) return;
  const menuItems = [
    {
      label: isDictating ? 'Stop Dictation' : 'Start Dictation (Ctrl+Alt+Space)',
      click: () => toggleDictation(),
    },
    {
      label: alwaysOnMode ? (alwaysOnPaused ? 'Always-On: EN PAUSE' : 'Always-On: ACTIF') : 'Activer Always-On',
      type: 'checkbox',
      checked: alwaysOnMode,
      click: () => {
        const newState = !alwaysOnMode;
        alwaysOnMode = newState;
        alwaysOnPaused = false;
        saveAlwaysOnConfig(newState);
        if (newState && !isDictating && engineReady) {
          sendToEngine({ type: 'start_dictation' });
        } else if (!newState && isDictating) {
          sendToEngine({ type: 'stop_dictation' });
        }
        sendToWindow('always-on-status', { active: newState, paused: false });
        updateTrayMenu();
      },
    },
    { type: 'separator' },
    {
      label: 'Show VoiceTyper',
      click: () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } },
    },
    {
      label: 'Phone QR Code',
      click: () => {
        if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
        mainWindow && mainWindow.webContents.send('show-qr');
      },
    },
  ];

  // Show pending update in tray menu
  if (pendingUpdatePath && pendingUpdateVersion) {
    menuItems.push({ type: 'separator' });
    menuItems.push({
      label: `Installer mise a jour v${pendingUpdateVersion}`,
      click: () => installPendingUpdate(),
    });
  }

  menuItems.push({ type: 'separator' });
  menuItems.push({
    label: 'Quit',
    click: () => { isQuitting = true; app.quit(); },
  });

  tray.setContextMenu(Menu.buildFromTemplate(menuItems));
}

// ─── Global Shortcut ──────────────────────────────────────────────────────────
function registerShortcuts() {
  try {
    const registered = globalShortcut.register('CommandOrControl+Alt+Space', () => {
      toggleDictation();
    });
    if (!registered) {
      console.error('[Shortcuts] Failed to register Ctrl+Alt+Space — another app may have claimed it');
    }
  } catch (err) {
    console.error('[Shortcuts] Registration error:', err.message);
  }
}

function toggleDictation() {
  if (alwaysOnMode) {
    // In always-on mode, Ctrl+Alt+Space toggles pause
    alwaysOnPaused = !alwaysOnPaused;
    if (alwaysOnPaused) {
      console.log('[AlwaysOn] Paused by shortcut');
      sendToEngine({ type: 'stop_dictation' });
      sendToWindow('always-on-status', { active: true, paused: true });
    } else {
      console.log('[AlwaysOn] Resumed by shortcut');
      sendToEngine({ type: 'start_dictation' });
      sendToWindow('always-on-status', { active: true, paused: false });
    }
  } else {
    if (isDictating) {
      sendToEngine({ type: 'stop_dictation' });
    } else {
      sendToEngine({ type: 'start_dictation' });
    }
  }
}

// ─── Python Engine ────────────────────────────────────────────────────────────
async function startPythonEngine() {
  const enginePath = getEnginePath();
  console.log('[Engine] Starting Python engine:', enginePath);

  if (!fs.existsSync(enginePath)) {
    console.error('[Engine] Engine not found at:', enginePath);
    sendToWindow('engine-error', { message: `Moteur introuvable: ${enginePath}` });
    return;
  }

  const args = [`--port=${ENGINE_PORT}`];

  // Resolve models path — check multiple locations
  const resourcesPath = process.resourcesPath || '';
  const candidateModelsPaths = [
    path.join(resourcesPath, 'models'),
    path.join(resourcesPath, '..', 'models'),
    path.join(resourcesPath, 'engine', 'models'),
    path.join(__dirname, '..', 'models'),
  ];

  let modelsPath = candidateModelsPaths[0]; // default
  console.log('[Engine] Searching for models in candidates:');
  for (const candidate of candidateModelsPaths) {
    const exists = fs.existsSync(candidate);
    console.log('[Engine]   ', candidate, exists ? 'FOUND' : 'not found');
    if (exists && modelsPath === candidateModelsPaths[0]) {
      modelsPath = candidate;
    }
  }
  console.log('[Engine] Using models path:', modelsPath);

  const engineEnv = {
    ...process.env,
    VOICETYPER_MODELS_PATH: modelsPath,
    VOICETYPER_RESOURCES_PATH: resourcesPath,
    PYTHONIOENCODING: 'utf-8',
    PYTHONUTF8: '1',
  };

  try {
    if (enginePath.endsWith('.py')) {
      const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';
      pythonProcess = spawn(pythonCmd, [enginePath, ...args], {
        cwd: path.dirname(enginePath),
        env: engineEnv,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } else {
      pythonProcess = spawn(enginePath, args, {
        cwd: path.dirname(enginePath),
        env: engineEnv,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    }

    pythonProcess.stdout.on('data', (data) => {
      const lines = data.toString('utf8').split('\n').filter(Boolean);
      lines.forEach(line => console.log('[Python]', line));
    });

    pythonProcess.stderr.on('data', (data) => {
      const lines = data.toString('utf8').split('\n').filter(Boolean);
      lines.forEach(line => console.error('[Python ERR]', line));
    });

    pythonProcess.on('exit', (code, signal) => {
      console.log(`[Engine] Python exited — code=${code}, signal=${signal}`);
      pythonProcess = null;
      engineReady = false;
      sendToWindow('engine-status', { connected: false });

      if (!isQuitting) {
        engineStartAttempts++;
        if (engineStartAttempts >= MAX_ENGINE_RESTARTS) {
          console.error(`[Engine] Max restart attempts (${MAX_ENGINE_RESTARTS}) reached — giving up`);
          sendToWindow('engine-fatal', {
            message: 'Le moteur a plante trop de fois. Redemarrez VoiceTyper.',
          });
          return;
        }
        const delay = Math.min(3000 * engineStartAttempts, 15000);
        console.log(`[Engine] Restarting in ${delay}ms (attempt ${engineStartAttempts})`);
        setTimeout(() => startPythonEngine(), delay);
      }
    });

    pythonProcess.on('error', (err) => {
      console.error('[Engine] Spawn error:', err.message);
      pythonProcess = null;
      sendToWindow('engine-fatal', {
        message: `Impossible de lancer le moteur: ${err.message}`,
      });
    });

    await wait(2000);
    engineStartAttempts = 0;
  } catch (err) {
    console.error('[Engine] Failed to start:', err);
    sendToWindow('engine-fatal', { message: `Erreur demarrage: ${err.message}` });
  }
}

function getEnginePath() {
  const resourcesPath = process.resourcesPath || '';
  if (process.platform === 'win32') {
    const onedirPath = path.join(resourcesPath, 'engine', 'dictee_engine.exe');
    if (fs.existsSync(onedirPath)) return onedirPath;
  } else {
    const binaryPath = path.join(resourcesPath, 'engine', 'dictee_engine');
    if (fs.existsSync(binaryPath)) return binaryPath;
  }
  return path.join(__dirname, '..', 'engine', 'dictee_engine.py');
}

function stopPythonEngine() {
  stopPolling();
  if (pythonProcess) {
    console.log('[Engine] Stopping Python process');
    if (process.platform === 'win32') {
      try {
        spawn('taskkill', ['/pid', String(pythonProcess.pid), '/T', '/F'], {
          windowsHide: true,
        });
      } catch {}
    } else {
      pythonProcess.kill('SIGTERM');
      setTimeout(() => {
        if (pythonProcess) {
          try { pythonProcess.kill('SIGKILL'); } catch {}
        }
      }, 3000);
    }
  }
}

// ─── HTTP Polling ─────────────────────────────────────────────────────────────
let pollTimer = null;
let lastEventId = 0;
let pollErrorCount = 0;

function startPolling() {
  if (pollTimer) return;
  console.log('[Poll] Starting HTTP polling on', ENGINE_HTTP_URL);
  pollTimer = setInterval(pollEngine, 2000);
}

function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

function pollEngine() {
  if (isQuitting) return;

  const req = http.get(`${ENGINE_HTTP_URL}/poll?since=${lastEventId}`, {
    timeout: 2000,
  }, (res) => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
      try {
        const events = JSON.parse(data);
        if (!Array.isArray(events)) return;
        events.forEach(msg => {
          if (msg.id > lastEventId) lastEventId = msg.id;
          handleEngineMessage(msg);
        });
        if (!engineReady) {
          engineReady = true;
          pollErrorCount = 0;
          sendToWindow('engine-status', { connected: true });
          console.log('[Poll] Engine connected');
        }
      } catch (parseErr) {
        // Ignore parse errors on partial data
      }
    });
  });

  req.on('error', () => {
    pollErrorCount++;
    if (engineReady) {
      engineReady = false;
      sendToWindow('engine-status', { connected: false });
      console.warn('[Poll] Engine unreachable');
    }
  });

  req.on('timeout', () => {
    req.destroy();
  });
}

function sendToEngine(msg) {
  const body = JSON.stringify(msg);
  const options = {
    hostname: '127.0.0.1',
    port: ENGINE_PORT,
    path: '/command',
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    timeout: 5000,
  };
  const req = http.request(options, (res) => { res.resume(); });
  req.on('error', (err) => console.warn('[HTTP] Command error:', err.message));
  req.on('timeout', () => req.destroy());
  req.write(body);
  req.end();
}

function handleEngineMessage(msg) {
  switch (msg.type) {
    case 'transcript':
      sendToWindow('transcript', msg);
      // Always-On: auto-type final transcripts into active app
      if (alwaysOnMode && !alwaysOnPaused && msg.is_final && msg.text) {
        autoTypeText(msg.text);
      }
      break;

    case 'voice_command':
      sendToWindow('voice-command', msg);
      // Handle always-on voice commands
      if (alwaysOnMode && msg.command === 'stop') {
        alwaysOnPaused = true;
        sendToWindow('always-on-status', { active: true, paused: true });
      }
      break;

    case 'status':
      isDictating = msg.state === 'listening';
      updateTrayMenu();
      sendToWindow('status', msg);
      // Always-On: if dictation stopped unexpectedly and not paused, restart
      if (alwaysOnMode && !alwaysOnPaused && msg.state === 'idle' && engineReady) {
        console.log('[AlwaysOn] Dictation stopped unexpectedly — restarting in 500ms');
        setTimeout(() => {
          if (alwaysOnMode && !alwaysOnPaused && engineReady) {
            sendToEngine({ type: 'start_dictation' });
          }
        }, 500);
      }
      break;

    case 'qr_code':
      sendToWindow('qr-code', msg);
      break;

    case 'error':
      console.error('[Engine] Error:', msg.message);
      // Deduplicate errors to avoid UI spam
      sendDedupedError(msg.message);
      break;

    case 'model_download':
      sendToWindow('model-download', msg);
      break;

    case 'devices_list':
      sendToWindow('devices-list', msg);
      break;

    case 'device_set':
      sendToWindow('device-set', msg);
      break;

    default:
      break;
  }
}

/**
 * Send error to UI but deduplicate: same message within ERROR_DEDUP_MS is suppressed.
 */
function sendDedupedError(message) {
  const now = Date.now();
  if (message === lastErrorMessage && (now - lastErrorTime) < ERROR_DEDUP_MS) {
    return; // suppress duplicate
  }
  lastErrorMessage = message;
  lastErrorTime = now;
  sendToWindow('engine-error', { message });
}

function sendToWindow(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    try {
      mainWindow.webContents.send(channel, data);
    } catch {
      // Window may be in bad state during shutdown
    }
  }
}

// ─── Auto-update ──────────────────────────────────────────────────────────────
function httpGet(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, { timeout: 15000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        httpGet(res.headers.location).then(resolve).catch(reject);
        return;
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ statusCode: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (pb[i] || 0) - (pa[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

async function checkForUpdates() {
  try {
    console.log('[Updater] Checking for updates at', UPDATE_SERVER_URL);
    const result = await httpGet(`${UPDATE_SERVER_URL}/updates/latest.json`);
    if (result.statusCode !== 200) {
      console.log('[Updater] Server returned', result.statusCode, '— skipping');
      return;
    }
    const latest = JSON.parse(result.body);
    const currentVersion = app.getVersion();
    const latestVersion = latest.version;

    console.log(`[Updater] Current: ${currentVersion}, Latest: ${latestVersion}`);

    if (compareVersions(currentVersion, latestVersion) <= 0) {
      console.log('[Updater] Already up to date');
      return;
    }

    // Map platform: win32 -> 'win', darwin -> 'mac', linux -> 'linux'
    const platformKey = PLATFORM_KEYS[process.platform] || process.platform;
    const platformInfo = latest.platforms && latest.platforms[platformKey];
    if (!platformInfo) {
      console.log('[Updater] No update for platform:', process.platform, '(key:', platformKey, ')');
      return;
    }

    // Build download URL from server base + file name
    const downloadFilename = platformInfo.file || platformInfo.filename;
    if (!downloadFilename) {
      console.log('[Updater] No file specified in platform info');
      return;
    }
    const downloadUrl = platformInfo.url || `${UPDATE_SERVER_URL}/releases/${encodeURIComponent(downloadFilename)}`;

    console.log(`[Updater] Update available: v${latestVersion}, file: ${downloadFilename}`);

    sendToWindow('update-available', {
      version: latestVersion,
      releaseNotes: latest.releaseNotes || '',
      size: platformInfo.size || 0,
    });

    console.log('[Updater] Downloading update from', downloadUrl);
    downloadUpdate({
      url: downloadUrl,
      filename: downloadFilename,
      sha256: platformInfo.sha256 || null,
      size: platformInfo.size || 0,
    }, latestVersion);
  } catch (err) {
    console.error('[Updater] Check failed:', err.message);
    sendBugReport('update_check_failed', { error: err.message });
  }
}

function downloadUpdate(info, version) {
  const tmpDir = app.getPath('temp');
  const destPath = path.join(tmpDir, info.filename);

  // If the file already exists with the right size, skip download
  try {
    if (fs.existsSync(destPath)) {
      const stat = fs.statSync(destPath);
      if (info.size > 0 && stat.size === info.size) {
        console.log('[Updater] File already downloaded:', destPath);
        pendingUpdatePath = destPath;
        pendingUpdateVersion = version;
        updateTrayMenu();
        sendToWindow('update-ready', { version, path: destPath });
        return;
      }
      // Wrong size, delete and re-download
      fs.unlinkSync(destPath);
    }
  } catch {}

  const client = info.url.startsWith('https') ? https : http;
  const fileStream = fs.createWriteStream(destPath);

  const request = client.get(info.url, { timeout: 120000 }, (res) => {
    if (res.statusCode === 302 || res.statusCode === 301) {
      fileStream.close();
      try { fs.unlinkSync(destPath); } catch {}
      // Follow redirect
      downloadUpdate({ ...info, url: res.headers.location }, version);
      return;
    }

    if (res.statusCode !== 200) {
      console.error('[Updater] Download failed with status', res.statusCode);
      fileStream.close();
      try { fs.unlinkSync(destPath); } catch {}
      sendToWindow('engine-error', { message: `Erreur telechargement mise a jour (HTTP ${res.statusCode})` });
      return;
    }

    const totalSize = parseInt(res.headers['content-length'] || '0', 10) || info.size;
    let downloaded = 0;
    const hashStream = info.sha256 ? crypto.createHash('sha256') : null;

    res.on('data', (chunk) => {
      downloaded += chunk.length;
      fileStream.write(chunk);
      if (hashStream) hashStream.update(chunk);
      if (totalSize > 0) {
        const progress = Math.round((downloaded / totalSize) * 100);
        sendToWindow('update-download-progress', { progress, downloaded, total: totalSize });
      }
    });

    res.on('end', () => {
      fileStream.end(() => {
        // Verify SHA256 if provided
        if (hashStream && info.sha256) {
          const actualHash = hashStream.digest('hex');
          if (actualHash.toLowerCase() !== info.sha256.toLowerCase()) {
            console.error(`[Updater] SHA256 mismatch! Expected: ${info.sha256}, Got: ${actualHash}`);
            try { fs.unlinkSync(destPath); } catch {}
            sendToWindow('engine-error', { message: 'Erreur: fichier de mise a jour corrompu (SHA256 invalide)' });
            return;
          }
          console.log('[Updater] SHA256 verified OK');
        }

        if (process.platform !== 'win32') {
          try { fs.chmodSync(destPath, 0o755); } catch {}
        }

        pendingUpdatePath = destPath;
        pendingUpdateVersion = version;
        updateTrayMenu();
        console.log('[Updater] Download complete:', destPath);
        sendToWindow('update-ready', { version, path: destPath });
      });
    });

    res.on('error', (err) => {
      fileStream.close();
      try { fs.unlinkSync(destPath); } catch {}
      console.error('[Updater] Download stream error:', err.message);
    });
  });

  request.on('error', (err) => {
    fileStream.close();
    try { fs.unlinkSync(destPath); } catch {}
    console.error('[Updater] Download request error:', err.message);
  });

  request.on('timeout', () => {
    request.destroy();
    fileStream.close();
    try { fs.unlinkSync(destPath); } catch {}
    console.error('[Updater] Download timed out');
  });
}

function installPendingUpdate() {
  if (!pendingUpdatePath) {
    console.warn('[Updater] install-update called but no pending update');
    return;
  }
  if (!fs.existsSync(pendingUpdatePath)) {
    console.error('[Updater] Update file disappeared:', pendingUpdatePath);
    sendToWindow('engine-error', { message: 'Fichier de mise a jour introuvable.' });
    pendingUpdatePath = null;
    pendingUpdateVersion = null;
    updateTrayMenu();
    return;
  }

  console.log('[Updater] Installing update:', pendingUpdatePath);

  if (process.platform === 'win32') {
    // NSIS silent install: /S flag runs silently, app restarts automatically
    const installerProcess = spawn(pendingUpdatePath, ['/S'], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    });
    installerProcess.unref();
    // Give the installer a moment to start, then quit
    setTimeout(() => {
      isQuitting = true;
      app.quit();
    }, 1500);
  } else if (process.platform === 'linux') {
    shell.showItemInFolder(pendingUpdatePath);
    dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: 'Mise a jour prete',
      message: `La nouvelle version a ete telechargee.\nFichier : ${pendingUpdatePath}\n\nFermez VoiceTyper et lancez le nouveau fichier.`,
      buttons: ['Quitter VoiceTyper', 'Plus tard'],
    }).then(({ response }) => {
      if (response === 0) {
        isQuitting = true;
        app.quit();
      }
    });
  } else {
    // macOS
    shell.openPath(pendingUpdatePath).then(() => {
      isQuitting = true;
      app.quit();
    });
  }
}

// ─── Hot-reload engine sidecar ────────────────────────────────────────────────
async function checkEngineUpdate() {
  try {
    const result = await httpGet(`${UPDATE_SERVER_URL}/engine/latest.json`);
    if (result.statusCode !== 200) return;
    const latest = JSON.parse(result.body);

    const versionFile = path.join(app.getPath('userData'), 'engine_version.txt');
    let currentEngineVersion = '0.0.0';
    try { currentEngineVersion = fs.readFileSync(versionFile, 'utf8').trim(); } catch {}

    if (compareVersions(currentEngineVersion, latest.version) <= 0) return;

    const platformKey = PLATFORM_KEYS[process.platform] || process.platform;
    const engineUrl = latest[platformKey];
    if (!engineUrl) return;

    console.log('[EngineUpdater] Downloading new engine from', engineUrl);
    const tmpDir = app.getPath('temp');
    const binaryName = process.platform === 'win32' ? 'dictee_engine_new.exe' : 'dictee_engine_new';
    const engineBinary = path.join(tmpDir, binaryName);

    const client = engineUrl.startsWith('https') ? https : http;
    await new Promise((resolve, reject) => {
      const fileStream = fs.createWriteStream(engineBinary);
      client.get(engineUrl, { timeout: 60000 }, (res) => {
        if (res.statusCode !== 200) {
          fileStream.close();
          reject(new Error('HTTP ' + res.statusCode));
          return;
        }
        res.pipe(fileStream);
        fileStream.on('finish', resolve);
        res.on('error', reject);
      }).on('error', reject);
    });

    if (process.platform !== 'win32') {
      fs.chmodSync(engineBinary, 0o755);
    }

    console.log('[EngineUpdater] Replacing engine binary and restarting sidecar');
    stopPythonEngine();
    await wait(1500);

    const targetDir = path.join(process.resourcesPath || path.join(__dirname, '..', 'dist'), 'engine');
    const targetName = process.platform === 'win32' ? 'dictee_engine.exe' : 'dictee_engine';
    const targetPath = path.join(targetDir, targetName);

    try {
      if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
      fs.copyFileSync(engineBinary, targetPath);
      if (process.platform !== 'win32') fs.chmodSync(targetPath, 0o755);
    } catch (e) {
      console.error('[EngineUpdater] Could not replace binary:', e.message);
    }

    fs.writeFileSync(versionFile, latest.version, 'utf8');

    await startPythonEngine();
    startPolling();
    sendToWindow('engine-updated', { version: latest.version });
    console.log('[EngineUpdater] Engine updated to', latest.version);
  } catch (err) {
    console.error('[EngineUpdater] Failed:', err.message);
  }
}

// ─── IPC Handlers ─────────────────────────────────────────────────────────────
ipcMain.on('start-dictation', () => {
  sendToEngine({ type: 'start_dictation' });
});

ipcMain.on('stop-dictation', () => {
  sendToEngine({ type: 'stop_dictation' });
});

ipcMain.on('set-language', (_, lang) => {
  const validLangs = ['fr', 'en', 'es', 'de', 'it', 'pt', 'ru', 'ar', 'zh', 'ja'];
  if (typeof lang === 'string' && validLangs.includes(lang)) {
    sendToEngine({ type: 'set_language', lang });
  }
});

ipcMain.on('set-engine', (_, engine) => {
  if (typeof engine === 'string' && (engine === 'vosk' || engine === 'whisper')) {
    sendToEngine({ type: 'set_engine', engine });
  }
});

ipcMain.handle('get-phone-url', async () => {
  const ip = getLocalIP();
  return `http://${ip}:${ENGINE_PORT}/phone`;
});

ipcMain.handle('get-status', async () => {
  return { connected: engineReady, dictating: isDictating };
});

ipcMain.on('window-close', () => {
  if (mainWindow) mainWindow.hide();
});

ipcMain.on('window-minimize', () => {
  if (mainWindow) mainWindow.minimize();
});

ipcMain.on('install-update', () => {
  installPendingUpdate();
});

ipcMain.handle('get-app-version', async () => {
  return app.getVersion();
});

ipcMain.on('check-engine-update', () => {
  checkEngineUpdate();
});

ipcMain.on('list-devices', () => {
  sendToEngine({ type: 'list_devices' });
});

ipcMain.on('set-device', (_, deviceId) => {
  sendToEngine({ type: 'set_device', device_id: deviceId });
});

ipcMain.on('toggle-always-on', (_, enabled) => {
  alwaysOnMode = !!enabled;
  alwaysOnPaused = false;
  saveAlwaysOnConfig(alwaysOnMode);
  console.log('[AlwaysOn] Mode', alwaysOnMode ? 'ENABLED' : 'DISABLED');
  
  if (alwaysOnMode) {
    // Start dictation immediately
    if (!isDictating && engineReady) {
      sendToEngine({ type: 'start_dictation' });
    }
    sendToWindow('always-on-status', { active: true, paused: false });
  } else {
    // Stop dictation if running
    if (isDictating) {
      sendToEngine({ type: 'stop_dictation' });
    }
    sendToWindow('always-on-status', { active: false, paused: false });
  }
  updateTrayMenu();
});

ipcMain.on('resume-always-on', () => {
  if (alwaysOnMode && alwaysOnPaused) {
    alwaysOnPaused = false;
    console.log('[AlwaysOn] Resumed by UI');
    sendToEngine({ type: 'start_dictation' });
    sendToWindow('always-on-status', { active: true, paused: false });
  }
});

ipcMain.handle('get-always-on-status', async () => {
  return { active: alwaysOnMode, paused: alwaysOnPaused };
});

ipcMain.on('retry-engine', () => {
  console.log('[IPC] Retry engine requested');
  engineStartAttempts = 0;
  stopPythonEngine();
  setTimeout(async () => {
    await startPythonEngine();
    startPolling();
  }, 1000);
});

// ─── Auto-Type (Always-On) ─────────────────────────────────────────────────────
function autoTypeText(text) {
  if (!text || !text.trim()) return;
  const textToType = text.trim() + ' ';
  
  // Use clipboard + simulated Ctrl+V
  clipboard.writeText(textToType);
  
  if (process.platform === 'win32') {
    // Use PowerShell to send Ctrl+V to active window
    const ps = spawn('powershell', [
      '-NoProfile', '-NonInteractive', '-Command',
      'Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait("^v")'
    ], { windowsHide: true, stdio: 'ignore' });
    ps.unref();
  } else if (process.platform === 'linux') {
    // Use xdotool
    const xdo = spawn('xdotool', ['key', 'ctrl+v'], { stdio: 'ignore' });
    xdo.unref();
  } else if (process.platform === 'darwin') {
    // Use osascript
    const osa = spawn('osascript', ['-e', 'tell application "System Events" to keystroke "v" using command down'], { stdio: 'ignore' });
    osa.unref();
  }
  
  console.log('[AutoType] Typed:', textToType.substring(0, 50));
}

function saveAlwaysOnConfig(enabled) {
  const configPath = path.join(app.getPath('userData'), 'voicetyper-config.json');
  let cfg = {};
  try {
    if (fs.existsSync(configPath)) {
      cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    }
  } catch {}
  cfg.alwaysOn = enabled;
  fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2), 'utf8');
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return '127.0.0.1';
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
