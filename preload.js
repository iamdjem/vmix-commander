const { contextBridge, ipcRenderer } = require('electron');

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('vmix', {
  // Get vMix status for a room
  status: (ip) => ipcRenderer.invoke('vmix:status', ip),

  // Call a vMix function
  call: (ip, functionName) => ipcRenderer.invoke('vmix:call', ip, functionName)
});

contextBridge.exposeInMainWorld('profiles', {
  // Get all profiles
  get: () => ipcRenderer.invoke('profiles:get'),

  // Save profiles
  save: (data) => ipcRenderer.invoke('profiles:save', data)
});

contextBridge.exposeInMainWorld('windowControls', {
  // Toggle always on top
  toggleAlwaysOnTop: (value) => ipcRenderer.invoke('window:toggleAlwaysOnTop', value),

  // Get always on top status
  isAlwaysOnTop: () => ipcRenderer.invoke('window:isAlwaysOnTop')
});

contextBridge.exposeInMainWorld('dialog', {
  // Save JSON file
  saveJson: (data) => ipcRenderer.invoke('dialog:save-json', data),

  // Open JSON file
  openJson: () => ipcRenderer.invoke('dialog:open-json'),

  // Save CSV file
  saveCsv: (csvData) => ipcRenderer.invoke('dialog:save-csv', csvData)
});

contextBridge.exposeInMainWorld('audit', {
  // Get audit log
  get: () => ipcRenderer.invoke('audit:get'),

  // Append entry to audit log
  append: (entry) => ipcRenderer.invoke('audit:append', entry),

  // Clear audit log
  clear: () => ipcRenderer.invoke('audit:clear')
});

contextBridge.exposeInMainWorld('identity', {
  // Get identity
  get: () => ipcRenderer.invoke('identity:get'),

  // Save identity
  save: (identity) => ipcRenderer.invoke('identity:save', identity)
});

contextBridge.exposeInMainWorld('proxy', {
  // Get proxy status: { running, port, localIp }
  getStatus: () => ipcRenderer.invoke('proxy:getStatus'),

  // Listen for proxy status updates pushed from main
  onStatus: (callback) => ipcRenderer.on('proxy:status', (_, status) => callback(status))
});

contextBridge.exposeInMainWorld('tunnel', {
  // Get tunnel status: { running, url, error }
  getStatus: () => ipcRenderer.invoke('tunnel:getStatus'),

  // Restart tunnel
  restart: () => ipcRenderer.invoke('tunnel:restart'),

  // Listen for tunnel status updates pushed from main
  onStatus: (callback) => ipcRenderer.on('tunnel:status', (_, status) => callback(status))
});
