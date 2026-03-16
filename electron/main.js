'use strict';

const { app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain, nativeImage, shell, dialog } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const os = require('os');
const fs = require('fs');
const https = require('https');
const http = require('http');

// ─── Constants ────────────────────────────────────────────────────────────────
const ENGINE_PORT = 7523;
const ENGINE_HTTP_URL = `http://127.0.0.1:${ENGINE_PORT}`;

const UPDATE_SERVER_URL = 'http://72.60.215.20:8766';
const UPDATE_CHECK_DELAY_MS = 5000; // Check 5s after startup

// ─── State ────────────────────────────────────────────────────────────────────
let mainWindow = null;
let tray = null;
let pythonProcess = null;
let engineReady = false;
let isQuitting = false;
let isDictating = false;
let pendingUpdatePath = null; // Path to downloaded update file

// ─── App lifecycle ─────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  createMainWindow();
  createTray();
  registerShortcuts();
  await startPythonEngine();
  startPolling();
  // Check for updates after a short delay (let UI settle first)
  setTimeout(() => checkForUpdates(), UPDATE_CHECK_DELAY_MS);
});

app.on('window-all-closed', (e) => {
  // Keep running in tray
  e.preventDefault();
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
      sandbox: false,
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
}

function getAppIcon() {
  const platform = process.platform;
  const iconsDir = path.join(__dirname, '..', 'build', 'icons');
  if (platform === 'win32') return path.join(iconsDir, 'icon.ico');
  if (platform === 'darwin') return path.join(iconsDir, 'icon.icns');
  return path.join(iconsDir, 'icon.png');
}

// ─── Tray ─────────────────────────────────────────────────────────────────────
function createTray() {
  // Create a simple 16x16 tray icon programmatically (white mic shape)
  const iconData = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAABHNCSVQICAgIfAhkiAAAAAlwSFlz' +
    'AAALEgAACxIB0t1+/AAAABx0RVh0U29mdHdhcmUAQWRvYmUgRmlyZXdvcmtzIENTNXG14zYAAAAW' +
    'SURBVDiNY2AYBaNgFAx3AAAAAABJRU5ErkJggg==',
    'base64'
  );

  let trayIcon;
  try {
    trayIcon = nativeImage.createFromBuffer(iconData);
    if (trayIcon.isEmpty()) throw new Error('empty');
  } catch {
    // Fallback: create a minimal valid PNG (8x8 red square)
    trayIcon = nativeImage.createEmpty();
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
  const contextMenu = Menu.buildFromTemplate([
    {
      label: isDictating ? '⏹  Stop Dictation' : '🎙  Start Dictation (Ctrl+Alt+Space)',
      click: () => toggleDictation(),
    },
    { type: 'separator' },
    {
      label: '🖥  Show VoiceTyper',
      click: () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } },
    },
    {
      label: '📱  Phone QR Code',
      click: () => {
        if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
        mainWindow && mainWindow.webContents.send('show-qr');
      },
    },
    { type: 'separator' },
    {
      label: '❌  Quit',
      click: () => { isQuitting = true; app.quit(); },
    },
  ]);
  tray.setContextMenu(contextMenu);
}

// ─── Global Shortcut ──────────────────────────────────────────────────────────
function registerShortcuts() {
  const registered = globalShortcut.register('CommandOrControl+Alt+Space', () => {
    toggleDictation();
  });
  if (!registered) {
    console.error('[Shortcuts] Failed to register Ctrl+Alt+Space');
  }
}

function toggleDictation() {
  if (isDictating) {
    sendToEngine({ type: 'stop_dictation' });
  } else {
    sendToEngine({ type: 'start_dictation' });
  }
}

// ─── Python Engine ────────────────────────────────────────────────────────────
async function startPythonEngine() {
  const enginePath = getEnginePath();
  console.log('[Engine] Starting Python engine:', enginePath);

  const args = [`--port=${ENGINE_PORT}`];

  // Resolve models path: packaged AppImage puts models in resources/models/
  const modelsPath = fs.existsSync(path.join(process.resourcesPath || '', 'models'))
    ? path.join(process.resourcesPath, 'models')
    : path.join(__dirname, '..', 'models');

  const engineEnv = {
    ...process.env,
    VOICETYPER_MODELS_PATH: modelsPath,
  };

  try {
    if (enginePath.endsWith('.py')) {
      pythonProcess = spawn('python3', [enginePath, ...args], {
        cwd: path.dirname(enginePath),
        env: engineEnv,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } else {
      // Compiled binary
      pythonProcess = spawn(enginePath, args, {
        cwd: path.dirname(enginePath),
        env: engineEnv,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    }

    pythonProcess.stdout.on('data', (data) => {
      const lines = data.toString().split('\n').filter(Boolean);
      lines.forEach(line => console.log('[Python]', line));
    });

    pythonProcess.stderr.on('data', (data) => {
      const lines = data.toString().split('\n').filter(Boolean);
      lines.forEach(line => console.error('[Python ERR]', line));
    });

    pythonProcess.on('exit', (code, signal) => {
      console.log(`[Engine] Python exited — code=${code}, signal=${signal}`);
      pythonProcess = null;
      if (!isQuitting) {
        // Restart after a delay
        setTimeout(() => startPythonEngine(), 3000);
      }
    });

    pythonProcess.on('error', (err) => {
      console.error('[Engine] Spawn error:', err.message);
    });

    // Give engine time to start
    await wait(1500);
  } catch (err) {
    console.error('[Engine] Failed to start:', err);
  }
}

function getEnginePath() {
  // Check for compiled binary first (packaged app)
  const binaryName = process.platform === 'win32' ? 'dictee_engine.exe' : 'dictee_engine';
  const binaryPath = path.join(process.resourcesPath || '', 'engine', binaryName);

  if (fs.existsSync(binaryPath)) return binaryPath;

  // Development: use Python script
  const scriptPath = path.join(__dirname, '..', 'engine', 'dictee_engine.py');
  return scriptPath;
}

function stopPythonEngine() {
  stopPolling();
  if (pythonProcess) {
    console.log('[Engine] Sending SIGTERM to Python process');
    pythonProcess.kill('SIGTERM');
    setTimeout(() => {
      if (pythonProcess) pythonProcess.kill('SIGKILL');
    }, 3000);
  }
}

// ─── HTTP Polling (remplace WebSocket) ────────────────────────────────────────
let pollTimer = null;
let lastEventId = 0;

function startPolling() {
  if (pollTimer) return;
  console.log('[Poll] Starting HTTP polling on', ENGINE_HTTP_URL);
  pollTimer = setInterval(pollEngine, 200);
}

function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

function pollEngine() {
  if (isQuitting) return;
  http.get(`${ENGINE_HTTP_URL}/poll?since=${lastEventId}`, (res) => {
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
          sendToWindow('engine-status', { connected: true });
          console.log('[Poll] Engine connected');
        }
      } catch {}
    });
  }).on('error', () => {
    if (engineReady) {
      engineReady = false;
      sendToWindow('engine-status', { connected: false });
      console.warn('[Poll] Engine unreachable');
    }
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
  };
  const req = http.request(options, (res) => { res.resume(); });
  req.on('error', (err) => console.warn('[HTTP] Command error:', err.message));
  req.write(body);
  req.end();
}

function handleEngineMessage(msg) {
  switch (msg.type) {
    case 'transcript':
      sendToWindow('transcript', msg);
      break;

    case 'status':
      isDictating = msg.state === 'listening';
      updateTrayMenu();
      sendToWindow('status', msg);
      break;

    case 'qr_code':
      sendToWindow('qr-code', msg);
      break;

    case 'error':
      console.error('[Engine] Error:', msg.message);
      sendToWindow('engine-error', msg);
      break;

    case 'model_download':
      sendToWindow('model-download', msg);
      break;

    default:
      console.log('[Engine] Unknown message type:', msg.type);
  }
}

function sendToWindow(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, data);
  }
}

// ─── Auto-update (custom, no electron-updater required) ───────────────────────
function httpGet(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    client.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ statusCode: res.statusCode, body: data }));
    }).on('error', reject);
  });
}

function compareVersions(a, b) {
  // Returns >0 if b > a, 0 if equal, <0 if a > b
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

    const platform = process.platform; // 'linux', 'win32', 'darwin'
    const platformInfo = latest.platforms && latest.platforms[platform];
    if (!platformInfo) {
      console.log('[Updater] No update for platform:', platform);
      return;
    }

    // Notify renderer that update is available
    sendToWindow('update-available', {
      version: latestVersion,
      releaseNotes: latest.releaseNotes || '',
      platform: platformInfo,
    });

    // Start background download
    console.log('[Updater] Downloading update from', platformInfo.url);
    downloadUpdate(platformInfo, latestVersion);
  } catch (err) {
    console.error('[Updater] Check failed:', err.message);
  }
}

function downloadUpdate(platformInfo, version) {
  const tmpDir = app.getPath('temp');
  const filename = platformInfo.filename || path.basename(platformInfo.url);
  const destPath = path.join(tmpDir, filename);

  const client = platformInfo.url.startsWith('https') ? https : http;

  const fileStream = fs.createWriteStream(destPath);

  const request = client.get(platformInfo.url, (res) => {
    if (res.statusCode !== 200) {
      console.error('[Updater] Download failed with status', res.statusCode);
      fileStream.close();
      return;
    }

    const totalSize = parseInt(res.headers['content-length'] || '0', 10);
    let downloaded = 0;

    res.on('data', (chunk) => {
      downloaded += chunk.length;
      fileStream.write(chunk);
      if (totalSize > 0) {
        const progress = Math.round((downloaded / totalSize) * 100);
        sendToWindow('update-download-progress', { progress, downloaded, total: totalSize });
      }
    });

    res.on('end', () => {
      fileStream.end();
      // Make executable on Linux/macOS
      if (process.platform !== 'win32') {
        try { fs.chmodSync(destPath, 0o755); } catch {}
      }
      pendingUpdatePath = destPath;
      console.log('[Updater] Download complete:', destPath);
      sendToWindow('update-ready', { version, path: destPath });
    });

    res.on('error', (err) => {
      fileStream.close();
      console.error('[Updater] Download stream error:', err.message);
    });
  });

  request.on('error', (err) => {
    fileStream.close();
    console.error('[Updater] Download request error:', err.message);
  });
}

// ─── Hot-reload engine sidecar ────────────────────────────────────────────────
async function checkEngineUpdate() {
  try {
    const result = await httpGet(`${UPDATE_SERVER_URL}/engine/latest.json`);
    if (result.statusCode !== 200) return;
    const latest = JSON.parse(result.body);

    // Read current engine version if stored
    const versionFile = path.join(app.getPath('userData'), 'engine_version.txt');
    let currentEngineVersion = '0.0.0';
    try { currentEngineVersion = fs.readFileSync(versionFile, 'utf8').trim(); } catch {}

    if (compareVersions(currentEngineVersion, latest.version) <= 0) return;

    const platform = process.platform;
    const engineUrl = latest[platform];
    if (!engineUrl) return;

    console.log('[EngineUpdater] Downloading new engine from', engineUrl);
    const tmpDir = app.getPath('temp');
    const engineBinary = path.join(tmpDir, 'dictee_engine_new');

    const client = engineUrl.startsWith('https') ? https : http;
    await new Promise((resolve, reject) => {
      const fileStream = fs.createWriteStream(engineBinary);
      client.get(engineUrl, (res) => {
        if (res.statusCode !== 200) { fileStream.close(); reject(new Error('HTTP ' + res.statusCode)); return; }
        res.pipe(fileStream);
        res.on('end', resolve);
        res.on('error', reject);
      }).on('error', reject);
    });

    // Make executable
    if (process.platform !== 'win32') {
      fs.chmodSync(engineBinary, 0o755);
    }

    // Stop current engine, replace binary, restart
    console.log('[EngineUpdater] Replacing engine binary and restarting sidecar');
    stopPythonEngine();
    await wait(1000);

    // Move new binary to resources path
    const targetPath = path.join(process.resourcesPath || path.join(__dirname, '..', 'dist'), 'engine', 'dictee_engine');
    try { fs.copyFileSync(engineBinary, targetPath); fs.chmodSync(targetPath, 0o755); } catch (e) {
      console.error('[EngineUpdater] Could not replace binary:', e.message);
    }

    // Save new version
    fs.writeFileSync(versionFile, latest.version, 'utf8');

    // Restart engine
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
  sendToEngine({ type: 'set_language', lang });
});

ipcMain.on('set-engine', (_, engine) => {
  sendToEngine({ type: 'set_engine', engine });
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
  if (!pendingUpdatePath) {
    console.warn('[Updater] install-update called but no pending update');
    return;
  }
  console.log('[Updater] Installing update:', pendingUpdatePath);
  if (process.platform === 'linux') {
    // On Linux: open the AppImage location in file manager, user runs it manually
    shell.showItemInFolder(pendingUpdatePath);
    dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: 'Mise à jour prête',
      message: `La nouvelle version a été téléchargée.\nFichier : ${pendingUpdatePath}\n\nFermez VoiceTyper et lancez le nouveau fichier pour mettre à jour.`,
      buttons: ['Quitter VoiceTyper', 'Plus tard'],
    }).then(({ response }) => {
      if (response === 0) {
        isQuitting = true;
        app.quit();
      }
    });
  } else {
    // Windows/Mac: launch the installer and quit
    shell.openPath(pendingUpdatePath).then(() => {
      isQuitting = true;
      app.quit();
    });
  }
});

ipcMain.handle('get-app-version', async () => {
  return app.getVersion();
});

ipcMain.on('check-engine-update', () => {
  checkEngineUpdate();
});

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
