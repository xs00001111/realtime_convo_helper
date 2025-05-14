const { contextBridge, ipcRenderer } = require('electron');

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('auth', {
  // Authentication methods
  completeLogin: (data) => {
    console.log('[AUTH-PRELOAD] Invoking complete-login with data:', data);
    return ipcRenderer.invoke('complete-login', data);
  },
  
  // Event listeners
  onAuthError: (callback) => ipcRenderer.on('auth-error', (_, data) => {
    console.log('[AUTH-PRELOAD] Received auth-error event:', data);
    callback(data);
  }),
  onAuthSuccess: (callback) => ipcRenderer.on('auth-success', (_, data) => {
    console.log('[AUTH-PRELOAD] Received auth-success event:', data);
    callback(data);
  }),
  // Session status listener
  onSessionStatus: (callback) => ipcRenderer.on('session-status', (_, isValid) => {
    console.log('[AUTH-PRELOAD] Received session-status event:', isValid);
    callback(isValid);
  }),
  // Subscription error listener
  onSubscriptionError: (callback) => ipcRenderer.on('subscription-error', (_, data) => {
    console.log('[AUTH-PRELOAD] Received subscription-error event:', data);
    callback(data);
  })
});