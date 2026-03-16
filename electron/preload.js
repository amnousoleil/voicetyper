'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// ─── Exposed API ──────────────────────────────────────────────────────────────
contextBridge.exposeInMainWorld('voicetyper', {

  // ── Commands ──────────────────────────────────────────────────────────────
  startDictation() {
    ipcRenderer.send('start-dictation');
  },

  stopDictation() {
    ipcRenderer.send('stop-dictation');
  },

  setLanguage(lang) {
    ipcRenderer.send('set-language', lang);
  },

  setEngine(engine) {
    ipcRenderer.send('set-engine', engine);
  },

  retryEngine() {
    ipcRenderer.send('retry-engine');
  },

  // ── Queries ───────────────────────────────────────────────────────────────
  async getPhoneUrl() {
    return ipcRenderer.invoke('get-phone-url');
  },

  async getStatus() {
    return ipcRenderer.invoke('get-status');
  },

  // ── Window controls ───────────────────────────────────────────────────────
  closeWindow() {
    ipcRenderer.send('window-close');
  },

  minimizeWindow() {
    ipcRenderer.send('window-minimize');
  },

  // ── Event listeners ───────────────────────────────────────────────────────
  onTranscript(callback) {
    const handler = (_, data) => callback(data);
    ipcRenderer.on('transcript', handler);
    return () => ipcRenderer.removeListener('transcript', handler);
  },

  onStatus(callback) {
    const handler = (_, data) => callback(data);
    ipcRenderer.on('status', handler);
    return () => ipcRenderer.removeListener('status', handler);
  },

  onQRCode(callback) {
    const handler = (_, data) => callback(data);
    ipcRenderer.on('qr-code', handler);
    return () => ipcRenderer.removeListener('qr-code', handler);
  },

  onEngineStatus(callback) {
    const handler = (_, data) => callback(data);
    ipcRenderer.on('engine-status', handler);
    return () => ipcRenderer.removeListener('engine-status', handler);
  },

  onEngineError(callback) {
    const handler = (_, data) => callback(data);
    ipcRenderer.on('engine-error', handler);
    return () => ipcRenderer.removeListener('engine-error', handler);
  },

  onEngineFatal(callback) {
    const handler = (_, data) => callback(data);
    ipcRenderer.on('engine-fatal', handler);
    return () => ipcRenderer.removeListener('engine-fatal', handler);
  },

  onModelDownload(callback) {
    const handler = (_, data) => callback(data);
    ipcRenderer.on('model-download', handler);
    return () => ipcRenderer.removeListener('model-download', handler);
  },

  onShowQR(callback) {
    const handler = () => callback();
    ipcRenderer.on('show-qr', handler);
    return () => ipcRenderer.removeListener('show-qr', handler);
  },

  // ── Auto-update ───────────────────────────────────────────────────────────
  onUpdateAvailable(callback) {
    const handler = (_, data) => callback(data);
    ipcRenderer.on('update-available', handler);
    return () => ipcRenderer.removeListener('update-available', handler);
  },

  onUpdateDownloadProgress(callback) {
    const handler = (_, data) => callback(data);
    ipcRenderer.on('update-download-progress', handler);
    return () => ipcRenderer.removeListener('update-download-progress', handler);
  },

  onUpdateReady(callback) {
    const handler = (_, data) => callback(data);
    ipcRenderer.on('update-ready', handler);
    return () => ipcRenderer.removeListener('update-ready', handler);
  },

  onEngineUpdated(callback) {
    const handler = (_, data) => callback(data);
    ipcRenderer.on('engine-updated', handler);
    return () => ipcRenderer.removeListener('engine-updated', handler);
  },

  installUpdate() {
    ipcRenderer.send('install-update');
  },

  async getAppVersion() {
    return ipcRenderer.invoke('get-app-version');
  },
});
