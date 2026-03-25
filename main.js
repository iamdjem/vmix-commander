const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

// ─── Proxy State ────────────────────────────────────────────────────────────
const PROXY_PORT = 8080;
let proxyState = { running: false, port: PROXY_PORT, localIp: '' };

function getLocalIp() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        return net.address;
      }
    }
  }
  return '127.0.0.1';
}

function startProxyServer() {
  proxyState.localIp = getLocalIp();

  const proxy = http.createServer((req, res) => {
    const parsedUrl = new URL(req.url, `http://localhost:${PROXY_PORT}`);

    // Only handle /vmix-proxy
    if (parsedUrl.pathname !== '/vmix-proxy') {
      res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: 'Not found. Use /vmix-proxy?ip=<ip>&fn=<function>' }));
      return;
    }

    const ip = parsedUrl.searchParams.get('ip');
    const fn = parsedUrl.searchParams.get('fn') || '';

    if (!ip) {
      res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: 'Missing required parameter: ip' }));
      return;
    }

    const targetUrl = fn
      ? `http://${ip}:8088/api/?Function=${encodeURIComponent(fn)}`
      : `http://${ip}:8088/api`;

    const vmixReq = http.get(targetUrl, { timeout: 4000 }, (vmixRes) => {
      let body = '';
      vmixRes.on('data', (chunk) => { body += chunk; });
      vmixRes.on('end', () => {
        res.writeHead(vmixRes.statusCode || 200, {
          'Content-Type': vmixRes.headers['content-type'] || 'text/xml',
          'Access-Control-Allow-Origin': '*'
        });
        res.end(body);
      });
    });

    vmixReq.on('error', (err) => {
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });

    vmixReq.on('timeout', () => {
      vmixReq.destroy();
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ error: 'Timeout connecting to vMix' }));
      }
    });
  });

  proxy.listen(PROXY_PORT, () => {
    proxyState.running = true;
    console.log(`[Proxy] Running on port ${PROXY_PORT} — local IP: ${proxyState.localIp}`);
    // Notify renderer if window is ready
    if (mainWindow) {
      mainWindow.webContents.send('proxy:status', proxyState);
    }
  });

  proxy.on('error', (err) => {
    proxyState.running = false;
    console.error(`[Proxy] Failed to start: ${err.message}`);
    if (mainWindow) {
      mainWindow.webContents.send('proxy:status', { ...proxyState, error: err.message });
    }
  });
}
// ─── End Proxy ───────────────────────────────────────────────────────────────

let mainWindow;

// Store userData path for profiles
const userDataPath = app.getPath('userData');
const profilesPath = path.join(userDataPath, 'profiles.json');
const auditLogPath = path.join(userDataPath, 'audit-log.json');
const identityPath = path.join(userDataPath, 'identity.json');

// Load profiles from disk
function loadProfiles() {
  try {
    if (fs.existsSync(profilesPath)) {
      return JSON.parse(fs.readFileSync(profilesPath, 'utf8'));
    }
  } catch (e) {
    console.error('Failed to load profiles:', e);
  }
  // Default profile
  return {
    current: 'default',
    profiles: {
      default: {
        name: 'Default Event',
        rooms: [
          { key: 'room1', name: 'Auditorium', ip: '' },
          { key: 'room2', name: 'Hall A', ip: '' },
          { key: 'room3', name: 'Hall B', ip: '' }
        ]
      }
    }
  };
}

// Save profiles to disk
function saveProfiles(data) {
  try {
    fs.writeFileSync(profilesPath, JSON.stringify(data, null, 2), 'utf8');
    return { ok: true };
  } catch (e) {
    console.error('Failed to save profiles:', e);
    return { ok: false, error: e.message };
  }
}

// Audit Log functions
function loadAuditLog() {
  try {
    if (fs.existsSync(auditLogPath)) {
      return JSON.parse(fs.readFileSync(auditLogPath, 'utf8'));
    }
  } catch (e) {
    console.error('Failed to load audit log:', e);
  }
  return [];
}

function saveAuditLog(entries) {
  try {
    fs.writeFileSync(auditLogPath, JSON.stringify(entries, null, 2), 'utf8');
    return { ok: true };
  } catch (e) {
    console.error('Failed to save audit log:', e);
    return { ok: false, error: e.message };
  }
}

function appendAuditLogEntry(entry) {
  try {
    const entries = loadAuditLog();
    entries.push(entry);
    fs.writeFileSync(auditLogPath, JSON.stringify(entries, null, 2), 'utf8');
    return { ok: true };
  } catch (e) {
    console.error('Failed to append audit log entry:', e);
    return { ok: false, error: e.message };
  }
}

// Identity functions
function loadIdentity() {
  try {
    if (fs.existsSync(identityPath)) {
      return JSON.parse(fs.readFileSync(identityPath, 'utf8'));
    }
  } catch (e) {
    console.error('Failed to load identity:', e);
  }
  return null;
}

function saveIdentity(identity) {
  try {
    fs.writeFileSync(identityPath, JSON.stringify(identity, null, 2), 'utf8');
    return { ok: true };
  } catch (e) {
    console.error('Failed to save identity:', e);
    return { ok: false, error: e.message };
  }
}

// vMix HTTP call helper
function vmixHttpRequest(ip, functionName) {
  return new Promise((resolve) => {
    if (!ip) {
      resolve({ ok: false, error: 'No IP provided' });
      return;
    }

    const url = functionName
      ? `http://${ip}:8088/api/?Function=${encodeURIComponent(functionName)}`
      : `http://${ip}:8088/api`;

    const req = http.get(url, { timeout: 4000 }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        resolve({ ok: true, data });
      });
    });

    req.on('error', (err) => {
      resolve({ ok: false, error: err.message });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, error: 'Timeout' });
    });
  });
}

// Parse vMix status from XML
function parseVmixStatus(xml) {
  return {
    recording: /<recording[^>]*>True<\/recording>/i.test(xml),
    streaming: /<streaming[^>]*>True<\/streaming>/i.test(xml),
    multicorder: /<multiCorder[^>]*>True<\/multiCorder>/i.test(xml)
  };
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 320,
    minHeight: 400,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    },
    backgroundColor: '#111111',
    titleBarStyle: 'default',
    show: false
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  // Open DevTools in development
  // mainWindow.webContents.openDevTools();

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  startProxyServer();
  createWindow();

  // Send proxy status once the renderer is ready
  app.on('browser-window-created', (_, win) => {
    win.webContents.once('did-finish-load', () => {
      win.webContents.send('proxy:status', proxyState);
    });
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// IPC Handlers

// Get profiles
ipcMain.handle('profiles:get', () => {
  return loadProfiles();
});

// Save profiles
ipcMain.handle('profiles:save', (event, data) => {
  return saveProfiles(data);
});

// vMix: Get status
ipcMain.handle('vmix:status', async (event, ip) => {
  const result = await vmixHttpRequest(ip, null);
  if (!result.ok) {
    return { ok: false, error: result.error, recording: false, streaming: false, multicorder: false };
  }
  const status = parseVmixStatus(result.data);
  return { ok: true, ...status };
});

// vMix: Call function
ipcMain.handle('vmix:call', async (event, ip, functionName) => {
  const result = await vmixHttpRequest(ip, functionName);
  return result;
});

// Window: toggle always on top
ipcMain.handle('window:toggleAlwaysOnTop', (event, value) => {
  if (mainWindow) {
    mainWindow.setAlwaysOnTop(value);
    return { ok: true, value };
  }
  return { ok: false };
});

// Window: get always on top status
ipcMain.handle('window:isAlwaysOnTop', () => {
  if (mainWindow) {
    return mainWindow.isAlwaysOnTop();
  }
  return false;
});

// Dialog: Save JSON file
ipcMain.handle('dialog:save-json', async (event, data) => {
  if (!mainWindow) return { ok: false, error: 'No window' };

  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Export Profiles',
    defaultPath: 'vmix-profiles.json',
    filters: [
      { name: 'JSON Files', extensions: ['json'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  });

  if (result.canceled) {
    return { ok: false, canceled: true };
  }

  try {
    fs.writeFileSync(result.filePath, JSON.stringify(data, null, 2), 'utf8');
    return { ok: true, filePath: result.filePath };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// Dialog: Open JSON file
ipcMain.handle('dialog:open-json', async (event) => {
  if (!mainWindow) return { ok: false, error: 'No window' };

  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Import Profiles',
    filters: [
      { name: 'JSON Files', extensions: ['json'] },
      { name: 'All Files', extensions: ['*'] }
    ],
    properties: ['openFile']
  });

  if (result.canceled) {
    return { ok: false, canceled: true };
  }

  try {
    const data = fs.readFileSync(result.filePaths[0], 'utf8');
    const parsed = JSON.parse(data);
    return { ok: true, data: parsed };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// Dialog: Save CSV file
ipcMain.handle('dialog:save-csv', async (event, csvData) => {
  if (!mainWindow) return { ok: false, error: 'No window' };

  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Export Audit Log',
    defaultPath: 'audit-log.csv',
    filters: [
      { name: 'CSV Files', extensions: ['csv'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  });

  if (result.canceled) {
    return { ok: false, canceled: true };
  }

  try {
    fs.writeFileSync(result.filePath, csvData, 'utf8');
    return { ok: true, filePath: result.filePath };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// Audit Log handlers
ipcMain.handle('audit:get', () => {
  return loadAuditLog();
});

ipcMain.handle('audit:append', (event, entry) => {
  return appendAuditLogEntry(entry);
});

ipcMain.handle('audit:clear', () => {
  return saveAuditLog([]);
});

// Identity handlers
ipcMain.handle('identity:get', () => {
  return loadIdentity();
});

ipcMain.handle('identity:save', (event, identity) => {
  return saveIdentity(identity);
});

// Proxy status handler
ipcMain.handle('proxy:getStatus', () => {
  return proxyState;
});
