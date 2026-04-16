// State management
let appState = {
  current: 'default',
  profiles: {},
  vmixStatus: {},
  vmixHealth: {},  // { roomKey: { latency, lastSeen, failures, tier } }
  currentPage: 'rooms',
  identity: null,
  syncEnabled: false,
  eventCode: '',
  auditLog: [],
  logFilters: { room: '', user: '', action: '' }
};

let statusRefreshInterval = null;
let showAutoTriggerInterval = null;
let recordingTimerInterval = null;
// Recording start times — persisted to localStorage to survive app restart
const recordingStartTimes = JSON.parse(localStorage.getItem('recordingStartTimes') || '{}');

function persistRecordingTimes() {
  localStorage.setItem('recordingStartTimes', JSON.stringify(recordingStartTimes));
}

// Shared icon markup — sourced from <template> blocks in index.html
const ICONS = {
  get gear() { const tpl = document.getElementById('icon-gear'); return tpl ? tpl.innerHTML.trim() : ''; },
  get play() { const tpl = document.getElementById('icon-play'); return tpl ? tpl.innerHTML.trim() : ''; },
  get stop() { const tpl = document.getElementById('icon-stop'); return tpl ? tpl.innerHTML.trim() : ''; }
};

// Scope keys by profile to prevent cross-conference collision
function scopedKey(roomKey) {
  return `${appState.current}:${roomKey}`;
}

// Format ms duration as H:MM:SS or MM:SS
function formatDuration(ms) {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

// Update all recording timer displays every second
function startRecordingTimers() {
  if (recordingTimerInterval) return;
  recordingTimerInterval = setInterval(() => {
    const prefix = appState.current + ':';
    for (const [key, startTime] of Object.entries(recordingStartTimes)) {
      if (!key.startsWith(prefix)) continue;
      const roomKey = key.slice(prefix.length);
      const el = document.getElementById(`rec-timer-${roomKey}`);
      if (el) {
        el.innerHTML = `<span class="rec-label">REC</span> ${formatDuration(Date.now() - startTime)}`;
        el.classList.add('active');
      }
    }
  }, 1000);
}

function stopRecordingTimers() {
  if (recordingTimerInterval) { clearInterval(recordingTimerInterval); recordingTimerInterval = null; }
}
let firebaseDb = null;
let firebaseRef = null;

// Initialize app
// ─── Proxy Status Bar ────────────────────────────────────────────────────────
function updateProxyStatusBar(status) {
  const dot   = document.getElementById('proxy-indicator');
  const label = document.getElementById('proxy-label');

  if (!dot) return;

  if (status.running) {
    dot.className = 'proxy-dot running';
    label.textContent = `vMix Proxy · Port ${status.port}`;
  } else if (status.error) {
    dot.className = 'proxy-dot failed';
    label.textContent = 'vMix Proxy · Error';
  } else {
    dot.className = 'proxy-dot pending';
    label.textContent = 'vMix Proxy · Starting…';
  }
}

// proxy listeners are set up in the Tunnel Status block below

// ─── Tunnel Status ────────────────────────────────────────────────────────────
let _currentTunnelUrl = '';

function renderTunnelQr(url) {
  const container = document.getElementById('tpage-qr-container');
  const urlLabel  = document.getElementById('tpage-qr-url');
  if (!container) return;

  const trackerUrl = `https://iamdjem.github.io/kubecon-tracker/?proxy=${encodeURIComponent(url)}`;
  container.innerHTML = '';
  new QRCode(container, {
    text: trackerUrl,
    width: 240,
    height: 240,
    colorDark: '#000000',
    colorLight: '#ffffff',
    correctLevel: QRCode.CorrectLevel.M
  });
  if (urlLabel) urlLabel.textContent = trackerUrl;
}

function updateTunnelPage(status) {
  _currentTunnelUrl = status.url || '';

  // Update tunnel page indicators
  const dot   = document.getElementById('tpage-tunnel-indicator');
  const label = document.getElementById('tpage-tunnel-label');
  const urlEl = document.getElementById('tpage-tunnel-url');
  const qrBox = document.getElementById('tpage-qr-container');

  if (!dot) return;

  if (status.running && status.url) {
    dot.className = 'proxy-dot running';
    label.textContent = 'Running';
    urlEl.textContent = status.url;
    renderTunnelQr(status.url);
  } else if (status.error) {
    dot.className = 'proxy-dot failed';
    label.textContent = 'Failed';
    urlEl.textContent = status.error;
    if (qrBox) qrBox.innerHTML = '<p style="color:var(--t3);font-size:14px;">Tunnel failed — click Restart</p>';
  } else {
    dot.className = 'proxy-dot pending';
    label.textContent = 'Starting…';
    urlEl.textContent = '';
    if (qrBox) qrBox.innerHTML = '<p style="color:var(--t3);font-size:14px;">Waiting for tunnel…</p>';
  }
}

function updateProxyPage(status) {
  const dot   = document.getElementById('tpage-proxy-indicator');
  const label = document.getElementById('tpage-proxy-label');
  const urlEl = document.getElementById('tpage-proxy-url');
  if (!dot) return;

  if (status.running) {
    dot.className = 'proxy-dot running';
    label.textContent = 'Running';
    urlEl.textContent = status.localIp ? `http://${status.localIp}:${status.port}` : `Port ${status.port}`;
  } else if (status.error) {
    dot.className = 'proxy-dot failed';
    label.textContent = 'Failed';
    urlEl.textContent = status.error || '';
  } else {
    dot.className = 'proxy-dot pending';
    label.textContent = 'Starting…';
    urlEl.textContent = '';
  }
}

if (window.tunnel) {
  window.tunnel.onStatus(updateTunnelPage);
  window.tunnel.getStatus().then(updateTunnelPage);
}

if (window.proxy) {
  window.proxy.onStatus((s) => { updateProxyStatusBar(s); updateProxyPage(s); });
  window.proxy.getStatus().then((s) => { updateProxyStatusBar(s); updateProxyPage(s); });
}

// Restart tunnel button (on tunnel page)
document.addEventListener('DOMContentLoaded', () => {
  const restartBtn = document.getElementById('btn-restart-tunnel');
  if (restartBtn) {
    restartBtn.addEventListener('click', () => {
      if (window.tunnel) {
        updateTunnelPage({ running: false, url: '', error: '' });
        window.tunnel.restart();
      }
    });
  }

  // QR modal close (legacy modal kept for possible future use)
  const closeBtn = document.getElementById('qr-modal-close');
  const modal    = document.getElementById('qr-modal');
  if (closeBtn) closeBtn.addEventListener('click', () => { closeModalOverlay(modal); });
  if (modal) modal.addEventListener('click', (e) => { if (e.target === modal) closeModalOverlay(modal); });
});
// ─── End Tunnel Status ────────────────────────────────────────────────────────

// ─── End Proxy Status Bar ────────────────────────────────────────────────────

async function init() {
  // Load identity first - required before anything else
  await loadIdentity();

  // Show onboarding if no identity
  if (!appState.identity) {
    showIdentityOnboarding();
    return; // Don't proceed until identity is set
  }

  // Continue normal initialization
  await loadProfiles();
  await loadAuditLog();
  updateIdentityBadge();
  setupNavigation();
  setupEventListeners();
  applyRoleRestrictions();
  switchPage('rooms');

  // Load always-on-top preference
  const alwaysOnTop = await window.windowControls.isAlwaysOnTop();
  document.getElementById('chk-always-on-top').checked = alwaysOnTop;

  // Load sync settings from profile
  const profile = getCurrentProfile();
  if (profile.syncEnabled) {
    appState.syncEnabled = profile.syncEnabled;
    appState.eventCode = profile.eventCode || '';
    document.getElementById('chk-sync-enabled').checked = true;
    document.getElementById('sync-event-code').value = appState.eventCode;
    if (appState.eventCode) {
      connectToFirebase();
    }
  }

  // Start auto-trigger checker for run-of-show
  startShowAutoTrigger();
}

// Load profiles from main process
async function loadProfiles() {
  const data = await window.profiles.get();
  appState.current = data.current;
  appState.profiles = data.profiles;
  updateProfileBadge();
}

// Save profiles to main process
async function saveProfiles() {
  const result = await window.profiles.save({
    current: appState.current,
    profiles: appState.profiles
  });
  if (result.ok) {
    showToast('Saved');
    // Push to Firebase if sync enabled
    await pushToFirebase();
  } else {
    showToast('Save failed: ' + result.error);
  }
}

// Get current profile
function getCurrentProfile() {
  return appState.profiles[appState.current] || { name: 'Unknown', rooms: [] };
}

// Conference tabs
function updateProfileBadge() {
  renderConferenceTabs();
}

function renderConferenceTabs() {
  const list = document.getElementById('conference-tab-list');
  if (!list) return;
  list.innerHTML = '';

  Object.keys(appState.profiles).forEach(key => {
    const profile = appState.profiles[key];
    const tab = document.createElement('button');
    tab.className = 'conference-tab' + (key === appState.current ? ' active' : '');
    tab.textContent = profile.name;
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', key === appState.current ? 'true' : 'false');
    tab.onclick = () => {
      if (key !== appState.current) {
        switchProfile(key);
      }
    };
    list.appendChild(tab);
  });
}

// Navigation
function setupNavigation() {
  document.querySelectorAll('.nav-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const page = tab.dataset.page;
      switchPage(page);
    });
  });
}

function switchPage(page) {
  appState.currentPage = page;

  // Update page visibility
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  const pageEl = document.getElementById(`page-${page}`);
  pageEl.classList.add('active');

  // Update header title from page data attribute
  const headerTitle = document.getElementById('header-page-title');
  if (headerTitle && pageEl.dataset.title) {
    headerTitle.textContent = pageEl.dataset.title;
  }

  // Update nav tabs
  document.querySelectorAll('.nav-tab').forEach(t => {
    t.classList.remove('active');
    t.removeAttribute('aria-current');
  });
  const targetTab = document.querySelector(`.nav-tab[data-page="${page}"]`);
  if (targetTab) {
    targetTab.classList.add('active');
    targetTab.setAttribute('aria-current', 'page');
  }

  // Page-specific actions
  if (page === 'rooms') {
    renderRooms();
    startStatusRefresh();
  } else {
    stopStatusRefresh();
  }

  if (page === 'events') {
    renderProfiles();
  }

  if (page === 'show') {
    renderShowTimeline();
  }

  if (page === 'log') {
    renderAuditLog();
  }

  if (page === 'settings') {
    renderSettings();
    updateIdentityDisplay();
  }
}

// Event listeners
function setupEventListeners() {
  // New profile button
  document.getElementById('btn-new-profile').addEventListener('click', () => {
    showModal('New Profile', '', (name) => {
      if (!name) return;
      const key = 'profile_' + Date.now();
      appState.profiles[key] = {
        name,
        rooms: [
          { key: 'room1', name: 'Room 1', ip: '' },
          { key: 'room2', name: 'Room 2', ip: '' },
          { key: 'room3', name: 'Room 3', ip: '' }
        ]
      };
      appState.current = key;
      saveProfiles();
      renderProfiles();
      updateProfileBadge();
      showToast('Profile created');
    });
  });

  // Rename profile button
  document.getElementById('btn-rename-profile').addEventListener('click', () => {
    const profile = getCurrentProfile();
    showModal('Rename Profile', profile.name, (name) => {
      if (!name) return;
      profile.name = name;
      saveProfiles();
      renderSettings();
      updateProfileBadge();
    });
  });

  // Add room button
  document.getElementById('btn-add-room').addEventListener('click', () => {
    const profile = getCurrentProfile();
    const key = 'room_' + Date.now();
    profile.rooms.push({ key, name: 'New Room', ip: '' });
    saveProfiles();
    renderSettings();
    if (appState.currentPage === 'rooms') renderRooms();
    showToast('Room added');
  });

  // Always on top checkbox
  document.getElementById('chk-always-on-top').addEventListener('change', async (e) => {
    await window.windowControls.toggleAlwaysOnTop(e.target.checked);
  });

  // Export profiles button
  document.getElementById('btn-export-profiles').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    setButtonLoading(btn, true, 'Exporting…');
    try {
      const result = await window.dialog.saveJson(appState.profiles);
      if (result.ok) {
        showToast('Profiles exported');
      } else if (!result.canceled) {
        showToast('Export failed: ' + result.error);
      }
    } finally {
      setButtonLoading(btn, false);
    }
  });

  // Import profiles button
  document.getElementById('btn-import-profiles').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    setButtonLoading(btn, true, 'Importing…');
    try {
      const result = await window.dialog.openJson();
      if (result.ok) {
        const imported = result.data;
        let count = 0;

        // Merge profiles (skip duplicates by key)
        Object.keys(imported).forEach(key => {
          if (!appState.profiles[key]) {
            appState.profiles[key] = imported[key];
            count++;
          }
        });

        if (count > 0) {
          await saveProfiles();
          renderProfiles();
          showToast(`Imported ${count} profile${count === 1 ? '' : 's'}`);
        } else {
          showToast('No new profiles to import');
        }
      } else if (!result.canceled) {
        showToast('Import failed: ' + result.error);
      }
    } finally {
      setButtonLoading(btn, false);
    }
  });

  // Change identity button
  document.getElementById('btn-change-identity').addEventListener('click', () => {
    showChangeIdentityModal();
  });

  // Cloud sync checkbox
  document.getElementById('chk-sync-enabled').addEventListener('change', async (e) => {
    appState.syncEnabled = e.target.checked;
    const profile = getCurrentProfile();
    profile.syncEnabled = appState.syncEnabled;

    if (appState.syncEnabled) {
      const eventCode = document.getElementById('sync-event-code').value.trim();
      if (eventCode) {
        appState.eventCode = eventCode;
        profile.eventCode = eventCode;
        await saveProfiles();
        await connectToFirebase();
      } else {
        showToast('Please enter an event code');
        e.target.checked = false;
      }
    } else {
      disconnectFromFirebase();
      profile.eventCode = '';
      await saveProfiles();
    }
  });

  // Event code input
  document.getElementById('sync-event-code').addEventListener('change', async (e) => {
    const eventCode = e.target.value.trim();
    if (eventCode && appState.syncEnabled) {
      appState.eventCode = eventCode;
      const profile = getCurrentProfile();
      profile.eventCode = eventCode;
      await saveProfiles();
      await connectToFirebase();
    }
  });

  // Audit log filters
  document.getElementById('log-filter-room').addEventListener('input', (e) => {
    appState.logFilters.room = e.target.value;
    renderAuditLog();
  });

  document.getElementById('log-filter-user').addEventListener('input', (e) => {
    appState.logFilters.user = e.target.value;
    renderAuditLog();
  });

  document.getElementById('log-filter-action').addEventListener('change', (e) => {
    appState.logFilters.action = e.target.value;
    renderAuditLog();
  });

  // Export log button
  document.getElementById('btn-export-log').addEventListener('click', () => {
    exportAuditLogCsv();
  });

  // Clear log button
  document.getElementById('btn-clear-log').addEventListener('click', () => {
    clearAuditLog();
  });

  // Add show item button
  document.getElementById('btn-add-show-item').addEventListener('click', () => {
    showAddShowItemModal();
  });

  // Conference tabs
  document.getElementById('conference-add').addEventListener('click', () => {
    showModal('New Conference', '', (name) => {
      if (!name) return;
      const key = 'profile_' + Date.now();
      appState.profiles[key] = {
        name,
        rooms: [
          { key: 'room1', name: 'Room 1', ip: '' },
          { key: 'room2', name: 'Room 2', ip: '' },
          { key: 'room3', name: 'Room 3', ip: '' }
        ]
      };
      appState.current = key;
      saveProfiles();
      updateProfileBadge();
      if (appState.currentPage === 'rooms') renderRooms();
      if (appState.currentPage === 'events') renderProfiles();
      if (appState.currentPage === 'settings') renderSettings();
      showToast('Conference created');
    });
  });
}

// Render rooms page
function renderRooms() {
  const profile = getCurrentProfile();
  const container = document.getElementById('rooms-container');
  container.innerHTML = '';

  let roomsToShow = profile.rooms;

  // Apply Operator filter: show only assigned room
  if (appState.identity && appState.identity.role === 'Operator' && appState.identity.assignedRoom) {
    roomsToShow = profile.rooms.filter(r => r.key === appState.identity.assignedRoom);
  }

  if (roomsToShow.length === 0) {
    container.innerHTML = '<div class="empty-state">No rooms configured. Tap the settings icon to add rooms.</div>';
    return;
  }

  roomsToShow.forEach(room => {
    const card = createRoomCard(room);
    container.appendChild(card);
  });

  // Fetch initial status
  refreshAllStatus();
}

// Create room card
function createRoomCard(room) {
  const card = document.createElement('div');
  card.className = 'room-card';
  card.id = `room-card-${room.key}`;
  card.draggable = true;
  card.dataset.roomKey = room.key;

  const status = appState.vmixStatus[scopedKey(room.key)] || { ok: false, recording: false, streaming: false, multicorder: false };
  const connected = room.ip && status.ok;
  const error = room.ip && !status.ok;

  // Drag event handlers
  card.ondragstart = (e) => {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', room.key);
    card.style.opacity = '0.5';
  };

  card.ondragend = (e) => {
    card.style.opacity = '1';
    document.querySelectorAll('.room-card').forEach(c => c.classList.remove('drag-over'));
  };

  card.ondragover = (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    card.classList.add('drag-over');
  };

  card.ondragleave = (e) => {
    card.classList.remove('drag-over');
  };

  card.ondrop = (e) => {
    e.preventDefault();
    card.classList.remove('drag-over');

    const draggedKey = e.dataTransfer.getData('text/plain');
    if (draggedKey !== room.key) {
      reorderRooms(draggedKey, room.key);
    }
  };

  // Header
  const header = document.createElement('div');
  header.className = 'room-header';

  // Add drag handle
  const dragHandle = document.createElement('div');
  dragHandle.className = 'drag-handle';
  dragHandle.innerHTML = '⠿';
  dragHandle.title = 'Drag to reorder';

  const nameWrap = document.createElement('div');
  nameWrap.className = 'room-name-wrap';

  const name = document.createElement('div');
  name.className = 'room-name';
  name.textContent = room.name;
  name.title = room.name;

  // Health info
  const health = appState.vmixHealth[scopedKey(room.key)] || { latency: 0, lastSeen: null, failures: 0, tier: 'offline' };
  const healthEl = document.createElement('div');
  healthEl.className = `room-health ${health.tier}`;
  healthEl.id = 'room-health-' + room.key;

  const healthDot = document.createElement('span');
  healthDot.className = 'room-health-dot';

  const healthLabel = document.createElement('span');
  healthLabel.className = 'room-health-label';
  healthLabel.id = 'room-health-label-' + room.key;

  if (!room.ip) {
    healthEl.className = 'room-health offline';
    healthLabel.textContent = 'No IP';
  } else if (health.tier === 'healthy') {
    healthLabel.textContent = `Ping ${health.latency}ms`;
  } else if (health.tier === 'degraded') {
    healthLabel.textContent = health.failures > 0 ? 'Reconnecting…' : `Ping ${health.latency}ms`;
  } else if (health.tier === 'unreachable') {
    const ago = health.lastSeen ? Math.round((Date.now() - health.lastSeen) / 1000) : 0;
    healthLabel.textContent = ago > 0 ? `Offline ${ago}s` : 'Offline';
  } else {
    healthLabel.textContent = 'Connecting…';
  }

  healthEl.appendChild(healthDot);
  healthEl.appendChild(healthLabel);

  // Recording timer
  const timerEl = document.createElement('div');
  timerEl.className = 'room-rec-timer';
  timerEl.id = `rec-timer-${room.key}`;
  if (recordingStartTimes[scopedKey(room.key)]) {
    timerEl.classList.add('active');
    timerEl.innerHTML = `<span class="rec-label">REC</span> ${formatDuration(Date.now() - recordingStartTimes[scopedKey(room.key)])}`;
  }

  nameWrap.appendChild(name);
  nameWrap.appendChild(timerEl);
  nameWrap.appendChild(healthEl);

  const settingsBtn = document.createElement('button');
  settingsBtn.className = 'room-settings-btn';
  settingsBtn.innerHTML = ICONS.gear;
  settingsBtn.title = 'Room settings';
  settingsBtn.onclick = () => openRoomSettings(room.key);

  header.appendChild(dragHandle);
  header.appendChild(nameWrap);
  header.appendChild(settingsBtn);

  // Function controls
  const controls = document.createElement('div');
  controls.className = 'room-controls';

  const functions = [
    { label: 'Record', startFn: 'StartRecording', stopFn: 'StopRecording', on: status.recording },
    { label: 'Stream', startFn: 'StartStreaming', stopFn: 'StopStreaming', on: status.streaming },
    { label: 'MultiCorder', startFn: 'StartMultiCorder', stopFn: 'StopMultiCorder', on: status.multicorder }
  ];

  functions.forEach(fn => {
    const fnControl = document.createElement('div');
    fnControl.className = 'fn-control';

    const toggleBtn = document.createElement('button');
    toggleBtn.className = `fn-toggle ${error ? 'error' : fn.on ? 'active' : 'inactive'}`;
    toggleBtn.id = 'fn-' + room.key + '-' + fn.label;
    toggleBtn.dataset.fnLabel = fn.label;
    toggleBtn.dataset.roomKey = room.key;

    const toggleLabel = document.createElement('span');
    toggleLabel.className = 'fn-toggle-label';
    toggleLabel.textContent = fn.label;

    const toggleState = document.createElement('span');
    toggleState.className = 'fn-toggle-state';
    toggleState.id = 'fn-state-' + room.key + '-' + fn.label;

    if (error) {
      toggleBtn.disabled = true;
      toggleState.textContent = 'ERR';
    } else if (fn.on) {
      toggleState.innerHTML = '<span class="fn-toggle-dot"></span>LIVE';
      toggleBtn.onclick = async () => {
        toggleBtn.disabled = true;
        toggleBtn.classList.add('pending');
        toggleState.textContent = 'Stopping…';
        await callVmix(room.key, fn.stopFn);
        setTimeout(() => refreshStatus(room.key), 1000);
      };
    } else {
      toggleState.textContent = 'OFF';
      toggleBtn.onclick = async () => {
        toggleBtn.disabled = true;
        toggleBtn.classList.add('pending');
        toggleState.textContent = 'Starting…';
        await callVmix(room.key, fn.startFn);
        setTimeout(() => refreshStatus(room.key), 1000);
      };
    }

    toggleBtn.appendChild(toggleLabel);
    toggleBtn.appendChild(toggleState);
    fnControl.appendChild(toggleBtn);
    controls.appendChild(fnControl);
  });

  // Master controls
  const masterControls = document.createElement('div');
  masterControls.className = 'master-controls';

  const startAllBtn = document.createElement('button');
  startAllBtn.className = 'btn btn-start-all';
  startAllBtn.innerHTML = ICONS.play + '<span>START ALL</span>';
  startAllBtn.onclick = () => roomAction(room.key, 'start');

  const stopAllBtn = document.createElement('button');
  stopAllBtn.className = 'btn btn-stop-all';
  stopAllBtn.innerHTML = ICONS.stop + '<span>STOP ALL</span>';
  stopAllBtn.onclick = () => roomAction(room.key, 'stop');

  masterControls.appendChild(startAllBtn);
  masterControls.appendChild(stopAllBtn);

  card.appendChild(header);
  card.appendChild(controls);
  card.appendChild(masterControls);

  return card;
}

// Open settings page scrolled to a specific room
function openRoomSettings(roomKey) {
  switchPage('settings');
  renderSettings();
  const target = document.querySelector(`.settings-room-item[data-room-key="${roomKey}"]`);
  if (target) {
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    target.classList.add('highlight');
    setTimeout(() => target.classList.remove('highlight'), 1500);
  }
}

// Reorder rooms via drag and drop
function reorderRooms(draggedKey, targetKey) {
  const profile = getCurrentProfile();
  const draggedIndex = profile.rooms.findIndex(r => r.key === draggedKey);
  const targetIndex = profile.rooms.findIndex(r => r.key === targetKey);

  if (draggedIndex === -1 || targetIndex === -1) return;

  // Remove dragged room and insert before target
  const [draggedRoom] = profile.rooms.splice(draggedIndex, 1);
  profile.rooms.splice(targetIndex, 0, draggedRoom);

  saveProfiles();
  renderRooms();
}

// Call vMix function
async function callVmix(roomKey, functionName) {
  const profile = getCurrentProfile();
  const room = profile.rooms.find(r => r.key === roomKey);
  if (!room || !room.ip) {
    showToast('No IP set for ' + room.name);
    return { ok: false, error: 'no ip' };
  }

  let result;
  try {
    result = await window.vmix.call(room.ip, functionName);
  } catch (err) {
    console.error('vMix call failed:', err);
    result = { ok: false, error: err.message || 'Network error' };
  }

  // Log to audit
  let actionName = functionName;
  if (functionName === 'StartRecording') actionName = 'START REC';
  else if (functionName === 'StopRecording') actionName = 'STOP REC';
  else if (functionName === 'StartStreaming') actionName = 'START STREAM';
  else if (functionName === 'StopStreaming') actionName = 'STOP STREAM';
  else if (functionName === 'StartMultiCorder') actionName = 'START MULTI';
  else if (functionName === 'StopMultiCorder') actionName = 'STOP MULTI';

  await appendAuditLog(room.name, actionName, result.ok ? 'ok' : 'fail');

  if (result.ok) {
    showToast('✓ ' + functionName);
  } else {
    showToast('✗ Failed: ' + (result.error || 'unknown'));
  }

  return result;
}

// Room action (start/stop all)
async function roomAction(roomKey, action) {
  const profile = getCurrentProfile();
  const room = profile.rooms.find(r => r.key === roomKey);
  if (!room || !room.ip) {
    showToast('No IP set for ' + room.name);
    return;
  }

  showToast((action === 'start' ? 'Starting' : 'Stopping') + ' ' + room.name + '…');

  const functions = action === 'start'
    ? ['StartRecording', 'StartStreaming', 'StartMultiCorder']
    : ['StopRecording', 'StopStreaming', 'StopMultiCorder'];

  let results;
  try {
    results = await Promise.all(
      functions.map(fn => window.vmix.call(room.ip, fn).catch(err => ({ ok: false, error: err.message })))
    );
  } catch (err) {
    console.error('Room action failed:', err);
    showToast('✗ Room action failed');
    return;
  }

  // Log to audit
  const actionName = action === 'start' ? 'START ALL' : 'STOP ALL';
  const allOk = results.every(r => r.ok);
  await appendAuditLog(room.name, actionName, allOk ? 'ok' : 'fail');

  const ok = results.filter(r => r.ok).length;
  showToast(ok === 3 ? '✓ ' + room.name + ' done' : `✗ ${ok}/3 OK`);

  setTimeout(() => refreshStatus(roomKey), 1200);
}

// Refresh status for one room
async function refreshStatus(roomKey) {
  const profile = getCurrentProfile();
  const room = profile.rooms.find(r => r.key === roomKey);
  if (!room) return;

  let status;
  try {
    status = await window.vmix.status(room.ip);
  } catch (err) {
    console.error('vMix status failed:', err);
    status = { ok: false, error: err.message || 'Network error' };
  }
  const sk = scopedKey(roomKey);
  appState.vmixStatus[sk] = status;

  // Update health tracking
  const prev = appState.vmixHealth[sk] || { latency: 0, lastSeen: null, failures: 0, tier: 'offline' };
  if (status.ok) {
    appState.vmixHealth[sk] = {
      latency: status.latency || 0,
      lastSeen: Date.now(),
      failures: 0,
      tier: (status.latency || 0) > 1000 ? 'degraded' : 'healthy'
    };
    if (prev.tier === 'unreachable') {
      showToast(`${room.name} is back online`);
    }
  } else {
    const failures = prev.failures + 1;
    const tier = failures >= 3 ? 'unreachable' : failures >= 1 ? 'degraded' : 'healthy';
    appState.vmixHealth[sk] = {
      latency: prev.latency,
      lastSeen: prev.lastSeen,
      failures,
      tier
    };
    if (tier === 'unreachable' && prev.tier !== 'unreachable') {
      showToast(`${room.name} is unreachable`);
    }
  }

  // Track recording start time (persisted to localStorage)
  if (status.ok && status.recording) {
    if (!recordingStartTimes[sk]) {
      recordingStartTimes[sk] = Date.now();
      persistRecordingTimes();
    }
  } else if (recordingStartTimes[sk]) {
    delete recordingStartTimes[sk];
    persistRecordingTimes();
  }

  updateRoomCard(roomKey);
}

// Targeted DOM updates — avoids full card replacement, preserves focus/animations
function updateRoomCard(roomKey) {
  const profile = getCurrentProfile();
  const room = profile.rooms.find(r => r.key === roomKey);
  if (!room) return;

  const card = document.getElementById('room-card-' + roomKey);
  if (!card) return;

  const status = appState.vmixStatus[scopedKey(roomKey)] || { ok: false, recording: false, streaming: false, multicorder: false };
  const health = appState.vmixHealth[scopedKey(roomKey)] || { latency: 0, lastSeen: null, failures: 0, tier: 'offline' };
  const error = room.ip && !status.ok;

  const healthEl = document.getElementById('room-health-' + roomKey);
  const healthLabel = document.getElementById('room-health-label-' + roomKey);
  if (healthEl && healthLabel) {
    if (!room.ip) {
      healthEl.className = 'room-health offline';
      healthLabel.textContent = 'No IP';
    } else {
      healthEl.className = 'room-health ' + health.tier;
      if (health.tier === 'healthy') {
        healthLabel.textContent = `Ping ${health.latency}ms`;
      } else if (health.tier === 'degraded') {
        healthLabel.textContent = health.failures > 0 ? 'Reconnecting…' : `Ping ${health.latency}ms`;
      } else if (health.tier === 'unreachable') {
        const ago = health.lastSeen ? Math.round((Date.now() - health.lastSeen) / 1000) : 0;
        healthLabel.textContent = ago > 0 ? `Offline ${ago}s` : 'Offline';
      } else {
        healthLabel.textContent = 'Connecting…';
      }
    }
  }

  const timerEl = document.getElementById('rec-timer-' + roomKey);
  if (timerEl) {
    const sk = scopedKey(roomKey);
    if (recordingStartTimes[sk]) {
      timerEl.classList.add('active');
      timerEl.innerHTML = `<span class="rec-label">REC</span> ${formatDuration(Date.now() - recordingStartTimes[sk])}`;
    } else {
      timerEl.classList.remove('active');
      timerEl.innerHTML = '';
    }
  }

  const fnMap = [
    { label: 'Record', startFn: 'StartRecording', stopFn: 'StopRecording', on: status.recording },
    { label: 'Stream', startFn: 'StartStreaming', stopFn: 'StopStreaming', on: status.streaming },
    { label: 'MultiCorder', startFn: 'StartMultiCorder', stopFn: 'StopMultiCorder', on: status.multicorder }
  ];

  fnMap.forEach(fn => {
    const btn = document.getElementById('fn-' + roomKey + '-' + fn.label);
    const stateEl = document.getElementById('fn-state-' + roomKey + '-' + fn.label);
    if (!btn || !stateEl) return;

    btn.classList.remove('pending');
    btn.disabled = false;

    if (error) {
      btn.className = 'fn-toggle error';
      btn.disabled = true;
      stateEl.textContent = 'ERR';
      btn.onclick = null;
    } else if (fn.on) {
      btn.className = 'fn-toggle active';
      stateEl.innerHTML = '<span class="fn-toggle-dot"></span>LIVE';
      btn.onclick = async () => {
        btn.disabled = true;
        btn.classList.add('pending');
        stateEl.textContent = 'Stopping…';
        await callVmix(room.key, fn.stopFn);
        setTimeout(() => refreshStatus(room.key), 1000);
      };
    } else {
      btn.className = 'fn-toggle inactive';
      stateEl.textContent = 'OFF';
      btn.onclick = async () => {
        btn.disabled = true;
        btn.classList.add('pending');
        stateEl.textContent = 'Starting…';
        await callVmix(room.key, fn.startFn);
        setTimeout(() => refreshStatus(room.key), 1000);
      };
    }
  });
}

// Refresh status for all rooms
async function refreshAllStatus() {
  const profile = getCurrentProfile();
  await Promise.all(profile.rooms.map(room => refreshStatus(room.key)));
}

// Start auto-refresh
function startStatusRefresh() {
  stopStatusRefresh();
  startRecordingTimers();
  statusRefreshInterval = setInterval(() => {
    if (appState.currentPage === 'rooms') {
      refreshAllStatus();
    }
  }, 8000);
}

// Stop auto-refresh
function stopStatusRefresh() {
  if (statusRefreshInterval) {
    clearInterval(statusRefreshInterval);
    statusRefreshInterval = null;
  }
  stopRecordingTimers();
}

// Render profiles page
function renderProfiles() {
  const list = document.getElementById('profiles-list');
  list.innerHTML = '';

  const profileKeys = Object.keys(appState.profiles);
  if (profileKeys.length === 0) {
    list.innerHTML = '<div class="empty-state">No profiles yet. Create one to get started.</div>';
    return;
  }

  profileKeys.forEach(key => {
    const profile = appState.profiles[key];
    const item = document.createElement('div');
    item.className = 'profile-item' + (key === appState.current ? ' active' : '');

    const info = document.createElement('div');
    info.className = 'profile-info';

    const name = document.createElement('div');
    name.className = 'profile-name';
    name.textContent = profile.name;
    name.title = 'Click to rename';
    name.style.cursor = 'pointer';
    name.onclick = (e) => {
      e.stopPropagation();
      showModal('Rename Profile', profile.name, (newName) => {
        if (!newName.trim()) return;
        profile.name = newName.trim();
        saveProfiles();
        renderProfiles();
        updateProfileBadge();
      });
    };

    const count = document.createElement('div');
    count.className = 'profile-count';
    count.textContent = `${profile.rooms.length} room${profile.rooms.length === 1 ? '' : 's'}`;

    info.appendChild(name);
    info.appendChild(count);

    const actions = document.createElement('div');
    actions.className = 'profile-actions';

    if (key !== appState.current) {
      const switchBtn = document.createElement('button');
      switchBtn.className = 'btn btn-primary';
      switchBtn.textContent = 'Switch';
      switchBtn.onclick = () => switchProfile(key);
      actions.appendChild(switchBtn);
    }

    const copyBtn = document.createElement('button');
    copyBtn.className = 'btn btn-ghost';
    copyBtn.textContent = '📋';
    copyBtn.title = 'Copy profile';
    copyBtn.onclick = () => copyProfile(key);
    actions.appendChild(copyBtn);

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'btn btn-danger';
    deleteBtn.textContent = '✕';
    deleteBtn.title = 'Delete profile';
    deleteBtn.onclick = () => deleteProfile(key);
    actions.appendChild(deleteBtn);

    item.appendChild(info);
    item.appendChild(actions);

    list.appendChild(item);
  });
}

// Switch to a different profile
function switchProfile(key) {
  appState.current = key;
  saveProfiles();
  updateProfileBadge();

  // Re-render current page with new conference data
  if (appState.currentPage === 'rooms') renderRooms();
  else if (appState.currentPage === 'events') renderProfiles();
  else if (appState.currentPage === 'show') renderShowTimeline();
  else if (appState.currentPage === 'log') renderAuditLog();
  else if (appState.currentPage === 'settings') renderSettings();

  showToast('Switched to ' + appState.profiles[key].name);
}

// Copy a profile
function copyProfile(key) {
  const original = appState.profiles[key];
  if (!original) return;

  const newKey = 'profile_' + Date.now();
  const newName = original.name + ' (copy)';

  // Deep copy the profile
  appState.profiles[newKey] = {
    name: newName,
    rooms: original.rooms.map(room => ({
      key: 'room_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9),
      name: room.name,
      ip: room.ip
    }))
  };

  // Switch to the new profile
  appState.current = newKey;
  saveProfiles();
  renderProfiles();
  updateProfileBadge();
  if (appState.currentPage === 'rooms') {
    renderRooms();
  }
  showToast('Copied to ' + newName);
}

// Delete a profile
function deleteProfile(key) {
  if (Object.keys(appState.profiles).length === 1) {
    showToast('Cannot delete the only profile');
    return;
  }

  const profile = appState.profiles[key];
  showConfirm({
    message: `Delete profile "${profile.name}"?`,
    onConfirm: () => {
      delete appState.profiles[key];

      // Switch to another profile if deleting current
      if (appState.current === key) {
        appState.current = Object.keys(appState.profiles)[0];
      }

      saveProfiles();
      renderProfiles();
      updateProfileBadge();
      showToast('Profile deleted');
    }
  });
}

// Render settings page
function renderSettings() {
  const profile = getCurrentProfile();

  document.getElementById('settings-profile-name').textContent = profile.name;

  const roomsList = document.getElementById('settings-rooms-list');
  roomsList.innerHTML = '';

  profile.rooms.forEach((room, index) => {
    const item = document.createElement('div');
    item.className = 'settings-room-item';
    item.dataset.roomKey = room.key;

    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'room-name-input';
    nameInput.value = room.name;
    nameInput.onchange = () => {
      room.name = nameInput.value.trim() || room.name;
      saveProfiles();
      if (appState.currentPage === 'rooms') renderRooms();
    };

    const ipInput = document.createElement('input');
    ipInput.type = 'text';
    ipInput.className = 'room-ip-input';
    ipInput.placeholder = '10.x.x.x';
    ipInput.value = room.ip;
    ipInput.onchange = () => {
      room.ip = ipInput.value.trim();
      saveProfiles();
    };

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'btn btn-danger btn-sm';
    deleteBtn.textContent = '✕';
    deleteBtn.title = 'Remove room';
    deleteBtn.onclick = () => {
      if (profile.rooms.length === 1) {
        showToast('Need at least one room');
        return;
      }
      showConfirm({
        message: `Remove room "${room.name}"?`,
        onConfirm: () => {
          profile.rooms.splice(index, 1);
          saveProfiles();
          renderSettings();
          if (appState.currentPage === 'rooms') renderRooms();
          showToast('Room removed');
        }
      });
    };

    item.appendChild(nameInput);
    item.appendChild(ipInput);
    item.appendChild(deleteBtn);

    roomsList.appendChild(item);
  });
}

// Modal helpers
function showModal(title, initialValue, onConfirm) {
  const overlay = document.getElementById('modal-overlay');
  const input = document.getElementById('modal-input');
  const titleEl = document.getElementById('modal-title');

  titleEl.textContent = title;
  input.value = initialValue;
  openModalOverlay(overlay);
  input.focus();
  input.select();

  const confirmFn = () => {
    const value = input.value.trim();
    if (value) {
      onConfirm(value);
      hideModal();
    }
  };
  const cancel = () => hideModal();

  document.getElementById('modal-confirm').onclick = confirmFn;
  document.getElementById('modal-cancel').onclick = cancel;
  document.getElementById('modal-close').onclick = cancel;

  input.onkeydown = (e) => {
    if (e.key === 'Enter') confirmFn();
    if (e.key === 'Escape') cancel();
  };

  bindOverlayDismiss(overlay, cancel);
}

function hideModal() { closeModalOverlay(document.getElementById('modal-overlay')); }

// Shared modal close behavior — ESC key + backdrop click
function enableModalClose(modalEl, onClose) {
  bindOverlayDismiss(modalEl, onClose);
}

// ─── Modal manager — prevents listener leaks and enforces body lock ─────────
const _modalEscHandlers = new WeakMap();

function openModalOverlay(overlayEl) {
  overlayEl.classList.add('is-open');
  overlayEl.style.display = 'flex';
  document.body.classList.add('modal-open');
}

function closeModalOverlay(overlayEl) {
  overlayEl.classList.remove('is-open');
  overlayEl.style.display = 'none';
  const handler = _modalEscHandlers.get(overlayEl);
  if (handler) {
    document.removeEventListener('keydown', handler);
    _modalEscHandlers.delete(overlayEl);
  }
  const anyOpen = document.querySelector('.modal-overlay.is-open');
  if (!anyOpen) document.body.classList.remove('modal-open');
}

function bindOverlayDismiss(overlayEl, onClose) {
  const prev = _modalEscHandlers.get(overlayEl);
  if (prev) document.removeEventListener('keydown', prev);
  const escHandler = (e) => { if (e.key === 'Escape') onClose(); };
  document.addEventListener('keydown', escHandler);
  _modalEscHandlers.set(overlayEl, escHandler);
  overlayEl.onclick = (e) => { if (e.target === overlayEl) onClose(); };
}

// Custom confirmation dialog — replaces native confirm() for consistent UX
function showConfirm({ title = 'Confirm', message, confirmLabel = 'Delete', cancelLabel = 'Cancel', danger = true, onConfirm }) {
  const overlay = document.getElementById('modal-overlay');
  const modal = overlay.querySelector('.modal');
  const titleEl = document.getElementById('modal-title');
  const body = modal.querySelector('.modal-body');
  const footer = modal.querySelector('.modal-footer');

  const originalBody = body.innerHTML;
  const originalFooter = footer.innerHTML;

  modal.classList.add('confirm-modal');
  titleEl.textContent = title;
  body.innerHTML = `<div>${message}</div>`;
  footer.innerHTML = `
    <button type="button" class="btn btn-ghost btn-cancel" id="confirm-cancel-btn">${cancelLabel}</button>
    <button type="button" class="btn ${danger ? 'btn-danger' : 'btn-primary'} btn-confirm" id="confirm-ok-btn">${confirmLabel}</button>
  `;

  openModalOverlay(overlay);

  const cleanup = () => {
    closeModalOverlay(overlay);
    modal.classList.remove('confirm-modal');
    body.innerHTML = originalBody;
    footer.innerHTML = originalFooter;
  };

  document.getElementById('confirm-ok-btn').onclick = () => { cleanup(); onConfirm(); };
  document.getElementById('confirm-cancel-btn').onclick = cleanup;
  document.getElementById('modal-close').onclick = cleanup;
  bindOverlayDismiss(overlay, cleanup);
}

// Toast notifications
function showToast(message) {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.classList.add('show');

  setTimeout(() => {
    toast.classList.remove('show');
  }, 2500);
}

function setButtonLoading(btn, loading, label) {
  if (!btn) return;
  if (loading) {
    btn.dataset.originalText = btn.dataset.originalText || btn.innerHTML;
    btn.innerHTML = `<span class="spinner"></span>${label || 'Working…'}`;
    btn.classList.add('is-loading');
    btn.disabled = true;
  } else {
    if (btn.dataset.originalText) btn.innerHTML = btn.dataset.originalText;
    btn.classList.remove('is-loading');
    btn.disabled = false;
    delete btn.dataset.originalText;
  }
}

// ========================================
// IDENTITY MANAGEMENT
// ========================================

async function loadIdentity() {
  appState.identity = await window.identity.get();
}

async function saveIdentity(identity) {
  appState.identity = identity;
  await window.identity.save(identity);
}

function updateIdentityBadge() {
  // Identity is shown on Settings page, no longer in header
}

function showIdentityOnboarding() {
  const modal = document.getElementById('identity-modal');
  openModalOverlay(modal);
  enableModalClose(modal, () => { closeModalOverlay(modal); });

  // Populate room selector for Operator role
  const roleSelect = document.getElementById('identity-role');
  const roomSelector = document.getElementById('identity-room-selector');
  const assignedRoomSelect = document.getElementById('identity-assigned-room');

  roleSelect.onchange = () => {
    if (roleSelect.value === 'Operator') {
      roomSelector.style.display = 'block';
      // Populate rooms (will use default profile rooms for now)
      const profile = getCurrentProfile();
      assignedRoomSelect.innerHTML = profile.rooms.map(r =>
        `<option value="${r.key}">${r.name}</option>`
      ).join('');
    } else {
      roomSelector.style.display = 'none';
    }
  };

  document.getElementById('identity-save').onclick = async () => {
    const name = document.getElementById('identity-name').value.trim();
    const role = document.getElementById('identity-role').value;

    if (!name) {
      showToast('Please enter your name');
      return;
    }

    const identity = { name, role };
    if (role === 'Operator') {
      identity.assignedRoom = document.getElementById('identity-assigned-room').value;
    }

    await saveIdentity(identity);
    closeModalOverlay(modal);

    // Now initialize the rest of the app
    await loadProfiles();
    await loadAuditLog();
    updateIdentityBadge();
    setupNavigation();
    setupEventListeners();
    applyRoleRestrictions();
    switchPage('rooms');

    const alwaysOnTop = await window.windowControls.isAlwaysOnTop();
    document.getElementById('chk-always-on-top').checked = alwaysOnTop;

    startShowAutoTrigger();
  };
}

function showChangeIdentityModal() {
  const modal = document.getElementById('identity-modal');
  const nameInput = document.getElementById('identity-name');
  const roleSelect = document.getElementById('identity-role');
  const roomSelector = document.getElementById('identity-room-selector');
  const assignedRoomSelect = document.getElementById('identity-assigned-room');

  // Pre-fill current identity
  nameInput.value = appState.identity.name;
  roleSelect.value = appState.identity.role;

  if (appState.identity.role === 'Operator') {
    roomSelector.style.display = 'block';
    const profile = getCurrentProfile();
    assignedRoomSelect.innerHTML = profile.rooms.map(r =>
      `<option value="${r.key}"${r.key === appState.identity.assignedRoom ? ' selected' : ''}>${r.name}</option>`
    ).join('');
  }

  openModalOverlay(modal);
  enableModalClose(modal, () => { closeModalOverlay(modal); });

  roleSelect.onchange = () => {
    if (roleSelect.value === 'Operator') {
      roomSelector.style.display = 'block';
      const profile = getCurrentProfile();
      assignedRoomSelect.innerHTML = profile.rooms.map(r =>
        `<option value="${r.key}">${r.name}</option>`
      ).join('');
    } else {
      roomSelector.style.display = 'none';
    }
  };

  document.getElementById('identity-save').onclick = async () => {
    const name = nameInput.value.trim();
    const role = roleSelect.value;

    if (!name) {
      showToast('Please enter your name');
      return;
    }

    const identity = { name, role };
    if (role === 'Operator') {
      identity.assignedRoom = assignedRoomSelect.value;
    }

    await saveIdentity(identity);
    closeModalOverlay(modal);
    updateIdentityBadge();
    updateIdentityDisplay();
    applyRoleRestrictions();

    // Re-render current page to apply restrictions
    if (appState.currentPage === 'rooms') renderRooms();

    showToast('Identity updated');
  };
}

function updateIdentityDisplay() {
  const display = document.getElementById('identity-display');
  if (!appState.identity) return;

  let html = `<div style="margin-bottom: 8px;"><strong>Name:</strong> ${appState.identity.name}</div>`;
  html += `<div style="margin-bottom: 8px;"><strong>Role:</strong> ${appState.identity.role}</div>`;

  if (appState.identity.role === 'Operator' && appState.identity.assignedRoom) {
    const profile = getCurrentProfile();
    const room = profile.rooms.find(r => r.key === appState.identity.assignedRoom);
    html += `<div><strong>Assigned Room:</strong> ${room ? room.name : 'Unknown'}</div>`;
  }

  display.innerHTML = html;
}

function applyRoleRestrictions() {
  if (!appState.identity) return;

  const role = appState.identity.role;

  // Hide Log tab for non-Directors
  const logTab = document.getElementById('nav-tab-log');
  if (role === 'Director') {
    logTab.style.display = 'flex';
  } else {
    logTab.style.display = 'none';
    // If currently on log page, switch away
    if (appState.currentPage === 'log') {
      switchPage('rooms');
    }
  }

  // Hide import/export buttons for non-Directors
  const hideForNonDirector = [
    'btn-export-profiles',
    'btn-import-profiles'
  ];
  hideForNonDirector.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = role === 'Director' ? 'inline-block' : 'none';
  });

  // Observers: hide all control buttons
  if (role === 'Observer') {
    document.body.classList.add('observer-mode');
  } else {
    document.body.classList.remove('observer-mode');
  }

  // Operators: filter rooms to show only assigned room
  // This will be applied in renderRooms()
}

// ========================================
// AUDIT LOG
// ========================================

async function loadAuditLog() {
  appState.auditLog = await window.audit.get();
}

async function appendAuditLog(room, action, result) {
  if (!appState.identity) return;

  const entry = {
    ts: new Date().toISOString(),
    user: appState.identity.name,
    room: room,
    ip: '',
    action: action,
    result: result,
    profileKey: appState.current
  };

  await window.audit.append(entry);
  appState.auditLog.push(entry);
}

function renderAuditLog() {
  const container = document.getElementById('log-container');
  container.innerHTML = '';

  // Filter by current conference profile
  let filteredLog = appState.auditLog.filter(e => !e.profileKey || e.profileKey === appState.current);

  if (appState.logFilters.room) {
    filteredLog = filteredLog.filter(e =>
      e.room.toLowerCase().includes(appState.logFilters.room.toLowerCase())
    );
  }

  if (appState.logFilters.user) {
    filteredLog = filteredLog.filter(e =>
      e.user.toLowerCase().includes(appState.logFilters.user.toLowerCase())
    );
  }

  if (appState.logFilters.action) {
    filteredLog = filteredLog.filter(e => e.action === appState.logFilters.action);
  }

  // Reverse chronological
  filteredLog.reverse();

  if (filteredLog.length === 0) {
    container.innerHTML = '<div class="log-empty">No log entries</div>';
    return;
  }

  filteredLog.forEach(entry => {
    const row = document.createElement('div');
    row.className = 'log-entry';

    const time = new Date(entry.ts).toLocaleString();
    const resultIcon = entry.result === 'ok' ? '✓' : '✗';
    const resultClass = entry.result === 'ok' ? 'log-result-ok' : 'log-result-fail';

    row.innerHTML = `
      <div class="log-time">${time}</div>
      <div class="log-user">${entry.user}</div>
      <div class="log-room">${entry.room}</div>
      <div class="log-action">${entry.action}</div>
      <div class="log-result ${resultClass}">${resultIcon}</div>
    `;

    container.appendChild(row);
  });
}

async function exportAuditLogCsv() {
  const headers = ['Timestamp', 'User', 'Room', 'IP', 'Action', 'Result'];
  const rows = appState.auditLog.map(e => [
    e.ts,
    e.user,
    e.room,
    e.ip,
    e.action,
    e.result
  ]);

  const csv = [
    headers.join(','),
    ...rows.map(row => row.map(cell => `"${cell}"`).join(','))
  ].join('\n');

  const result = await window.dialog.saveCsv(csv);
  if (result.ok) {
    showToast('Log exported');
  } else if (!result.canceled) {
    showToast('Export failed');
  }
}

async function clearAuditLog() {
  showConfirm({
    message: 'Clear all audit log entries?',
    confirmLabel: 'Clear',
    onConfirm: async () => {
      await window.audit.clear();
      appState.auditLog = [];
      renderAuditLog();
      showToast('Log cleared');
    }
  });
}

// ========================================
// FIREBASE CLOUD SYNC
// ========================================

function loadFirebaseScripts() {
  return new Promise((resolve) => {
    if (window.firebase) {
      resolve();
      return;
    }

    const script1 = document.createElement('script');
    script1.src = 'https://www.gstatic.com/firebasejs/9.22.0/firebase-app-compat.js';
    document.head.appendChild(script1);

    script1.onload = () => {
      const script2 = document.createElement('script');
      script2.src = 'https://www.gstatic.com/firebasejs/9.22.0/firebase-database-compat.js';
      document.head.appendChild(script2);
      script2.onload = resolve;
    };
  });
}

async function connectToFirebase() {
  const syncCheckbox = document.getElementById('chk-sync-enabled');
  if (syncCheckbox) syncCheckbox.disabled = true;

  if (!appState.eventCode) {
    updateSyncStatus('🔴 No event code', false);
    if (syncCheckbox) syncCheckbox.disabled = false;
    return;
  }

  updateSyncStatus('🟡 Connecting...', false);

  try {
    await loadFirebaseScripts();

    if (!firebaseDb) {
      const firebaseConfig = {
        databaseURL: 'https://kubecon-tracker-default-rtdb.europe-west1.firebasedatabase.app'
      };

      if (!firebase.apps.length) {
        firebase.initializeApp(firebaseConfig);
      }
      firebaseDb = firebase.database();
    }

    // Listen to remote changes
    firebaseRef = firebaseDb.ref(`vmix-commander/${appState.eventCode}/profiles`);

    firebaseRef.on('value', (snapshot) => {
      const remoteProfiles = snapshot.val();
      if (remoteProfiles) {
        // Merge remote with local (remote wins)
        Object.keys(remoteProfiles).forEach(key => {
          appState.profiles[key] = remoteProfiles[key];
        });
        saveProfiles();
        if (appState.currentPage === 'rooms') renderRooms();
        if (appState.currentPage === 'events') renderProfiles();
      }
      updateSyncStatus('🟢 Connected', true);
    });

    // Push current profiles to Firebase
    await firebaseRef.set(appState.profiles);

    if (syncCheckbox) syncCheckbox.disabled = false;
  } catch (error) {
    console.error('Firebase connection error:', error);
    updateSyncStatus('🔴 Connection failed', false);
    if (syncCheckbox) syncCheckbox.disabled = false;
  }
}

function disconnectFromFirebase() {
  if (firebaseRef) {
    firebaseRef.off();
    firebaseRef = null;
  }
  updateSyncStatus('🔴 Disconnected', false);
}

function updateSyncStatus(message, connected) {
  const statusEl = document.getElementById('sync-status');
  statusEl.textContent = message;
  statusEl.className = 'sync-status ' + (connected ? 'sync-connected' : 'sync-disconnected');
}

async function pushToFirebase() {
  if (!appState.syncEnabled || !firebaseRef) return;

  try {
    await firebaseRef.set(appState.profiles);
  } catch (error) {
    console.error('Failed to push to Firebase:', error);
  }
}

// ========================================
// RUN-OF-SHOW TIMELINE
// ========================================

function getRunOfShow() {
  const profile = getCurrentProfile();
  return profile.runOfShow || [];
}

function saveRunOfShow(runOfShow) {
  const profile = getCurrentProfile();
  profile.runOfShow = runOfShow;
  saveProfiles();
}

function renderShowTimeline() {
  const container = document.getElementById('show-timeline');
  const runOfShow = getRunOfShow();

  if (runOfShow.length === 0) {
    container.innerHTML = '<div class="show-empty">No timeline items. Click "+ Add Item" to create one.</div>';
    return;
  }

  // Sort by time
  const sorted = [...runOfShow].sort((a, b) => a.time.localeCompare(b.time));

  // Get current time for active detection
  const now = new Date();
  const currentTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

  container.innerHTML = '';

  sorted.forEach(item => {
    const row = document.createElement('div');
    row.className = 'show-item';

    // Determine status class
    if (item.status === 'Done') {
      row.classList.add('show-item-done');
    } else if (item.status === 'Skipped') {
      row.classList.add('show-item-skipped');
    } else if (item.time <= currentTime && item.status === 'Pending') {
      row.classList.add('show-item-active');
    }

    const isDirector = appState.identity && appState.identity.role === 'Director';
    const isObserver = appState.identity && appState.identity.role === 'Observer';

    row.innerHTML = `
      <div class="show-item-time">${item.time}</div>
      <div class="show-item-content">
        <div class="show-item-title">${item.title}</div>
        <div class="show-item-meta">
          <span class="show-item-room">${item.room}</span>
          <span class="show-item-action">${item.action}</span>
          ${item.autoRun ? '<span class="show-item-auto">AUTO</span>' : ''}
        </div>
      </div>
      <div class="show-item-status">${item.status}</div>
      <div class="show-item-actions">
        ${!isObserver && item.status === 'Pending' ? `
          <button class="btn btn-success btn-sm btn-show-go" data-id="${item.id}">Go</button>
          <button class="btn btn-ghost btn-sm btn-show-skip" data-id="${item.id}">Skip</button>
        ` : ''}
        ${isDirector ? `
          <button class="btn btn-ghost btn-sm btn-show-edit" data-id="${item.id}">✏</button>
        ` : ''}
      </div>
    `;

    container.appendChild(row);
  });

  // Attach event listeners
  container.querySelectorAll('.btn-show-go').forEach(btn => {
    btn.onclick = () => executeShowItem(btn.dataset.id);
  });

  container.querySelectorAll('.btn-show-skip').forEach(btn => {
    btn.onclick = () => skipShowItem(btn.dataset.id);
  });

  container.querySelectorAll('.btn-show-edit').forEach(btn => {
    btn.onclick = () => editShowItem(btn.dataset.id);
  });
}

async function executeShowItem(itemId) {
  const runOfShow = getRunOfShow();
  const item = runOfShow.find(i => i.id === itemId);
  if (!item) return;

  showToast(`Executing: ${item.title}`);

  // Map action to vMix function(s)
  const profile = getCurrentProfile();
  let rooms = [];

  if (item.room === 'All Rooms') {
    rooms = profile.rooms;
  } else {
    rooms = profile.rooms.filter(r => r.key === item.room);
  }

  let allSuccess = true;

  for (const room of rooms) {
    let result;

    switch (item.action) {
      case 'Start Recording':
        result = await window.vmix.call(room.ip, 'StartRecording');
        await appendAuditLog(room.name, 'START REC', result.ok ? 'ok' : 'fail');
        break;
      case 'Stop Recording':
        result = await window.vmix.call(room.ip, 'StopRecording');
        await appendAuditLog(room.name, 'STOP REC', result.ok ? 'ok' : 'fail');
        break;
      case 'Start Streaming':
        result = await window.vmix.call(room.ip, 'StartStreaming');
        await appendAuditLog(room.name, 'START STREAM', result.ok ? 'ok' : 'fail');
        break;
      case 'Stop Streaming':
        result = await window.vmix.call(room.ip, 'StopStreaming');
        await appendAuditLog(room.name, 'STOP STREAM', result.ok ? 'ok' : 'fail');
        break;
      case 'Start MultiCorder':
        result = await window.vmix.call(room.ip, 'StartMultiCorder');
        await appendAuditLog(room.name, 'START MULTI', result.ok ? 'ok' : 'fail');
        break;
      case 'Stop MultiCorder':
        result = await window.vmix.call(room.ip, 'StopMultiCorder');
        await appendAuditLog(room.name, 'STOP MULTI', result.ok ? 'ok' : 'fail');
        break;
      case 'Start All':
        await window.vmix.call(room.ip, 'StartRecording');
        await window.vmix.call(room.ip, 'StartStreaming');
        result = await window.vmix.call(room.ip, 'StartMultiCorder');
        await appendAuditLog(room.name, 'START ALL', result.ok ? 'ok' : 'fail');
        break;
      case 'Stop All':
        await window.vmix.call(room.ip, 'StopRecording');
        await window.vmix.call(room.ip, 'StopStreaming');
        result = await window.vmix.call(room.ip, 'StopMultiCorder');
        await appendAuditLog(room.name, 'STOP ALL', result.ok ? 'ok' : 'fail');
        break;
    }

    if (!result || !result.ok) allSuccess = false;
  }

  // Mark as done
  item.status = 'Done';
  saveRunOfShow(runOfShow);
  renderShowTimeline();

  showToast(allSuccess ? '✓ Item completed' : '✗ Some actions failed');
}

function skipShowItem(itemId) {
  const runOfShow = getRunOfShow();
  const item = runOfShow.find(i => i.id === itemId);
  if (!item) return;

  item.status = 'Skipped';
  saveRunOfShow(runOfShow);
  renderShowTimeline();
  showToast('Item skipped');
}

function showAddShowItemModal() {
  const modal = document.getElementById('show-item-modal');
  const profile = getCurrentProfile();

  // Populate room dropdown
  const roomSelect = document.getElementById('show-item-room');
  roomSelect.innerHTML = '<option value="All Rooms">All Rooms</option>' +
    profile.rooms.map(r => `<option value="${r.key}">${r.name}</option>`).join('');

  // Reset form
  document.getElementById('show-item-modal-title').textContent = 'Add Timeline Item';
  document.getElementById('show-item-time').value = '';
  document.getElementById('show-item-title').value = '';
  document.getElementById('show-item-room').value = 'All Rooms';
  document.getElementById('show-item-action').value = 'Start Recording';
  document.getElementById('show-item-auto-run').checked = false;
  document.getElementById('show-item-delete').style.display = 'none';

  openModalOverlay(modal);
  enableModalClose(modal, () => { closeModalOverlay(modal); });

  document.getElementById('show-item-confirm').onclick = () => {
    const time = document.getElementById('show-item-time').value;
    const title = document.getElementById('show-item-title').value.trim();
    const room = document.getElementById('show-item-room').value;
    const action = document.getElementById('show-item-action').value;
    const autoRun = document.getElementById('show-item-auto-run').checked;

    if (!time || !title) {
      showToast('Please fill all fields');
      return;
    }

    const runOfShow = getRunOfShow();
    runOfShow.push({
      id: 'show_' + Date.now(),
      time,
      title,
      room,
      action,
      autoRun,
      status: 'Pending'
    });

    saveRunOfShow(runOfShow);
    closeModalOverlay(modal);
    renderShowTimeline();
    showToast('Item added');
  };

  document.getElementById('show-item-cancel').onclick = () => {
    closeModalOverlay(modal);
  };

  document.getElementById('show-item-modal-close').onclick = () => {
    closeModalOverlay(modal);
  };
}

function editShowItem(itemId) {
  const runOfShow = getRunOfShow();
  const item = runOfShow.find(i => i.id === itemId);
  if (!item) return;

  const modal = document.getElementById('show-item-modal');
  const profile = getCurrentProfile();

  // Populate room dropdown
  const roomSelect = document.getElementById('show-item-room');
  roomSelect.innerHTML = '<option value="All Rooms">All Rooms</option>' +
    profile.rooms.map(r => `<option value="${r.key}">${r.name}</option>`).join('');

  // Pre-fill form
  document.getElementById('show-item-modal-title').textContent = 'Edit Timeline Item';
  document.getElementById('show-item-time').value = item.time;
  document.getElementById('show-item-title').value = item.title;
  document.getElementById('show-item-room').value = item.room;
  document.getElementById('show-item-action').value = item.action;
  document.getElementById('show-item-auto-run').checked = item.autoRun;
  document.getElementById('show-item-delete').style.display = 'inline-block';

  openModalOverlay(modal);
  enableModalClose(modal, () => { closeModalOverlay(modal); });

  document.getElementById('show-item-confirm').onclick = () => {
    const time = document.getElementById('show-item-time').value;
    const title = document.getElementById('show-item-title').value.trim();
    const room = document.getElementById('show-item-room').value;
    const action = document.getElementById('show-item-action').value;
    const autoRun = document.getElementById('show-item-auto-run').checked;

    if (!time || !title) {
      showToast('Please fill all fields');
      return;
    }

    item.time = time;
    item.title = title;
    item.room = room;
    item.action = action;
    item.autoRun = autoRun;

    saveRunOfShow(runOfShow);
    closeModalOverlay(modal);
    renderShowTimeline();
    showToast('Item updated');
  };

  document.getElementById('show-item-delete').onclick = () => {
    showConfirm({
      message: 'Delete this timeline item?',
      onConfirm: () => {
        const index = runOfShow.findIndex(i => i.id === itemId);
        if (index !== -1) {
          runOfShow.splice(index, 1);
          saveRunOfShow(runOfShow);
          closeModalOverlay(modal);
          renderShowTimeline();
          showToast('Item deleted');
        }
      }
    });
  };

  document.getElementById('show-item-cancel').onclick = () => {
    closeModalOverlay(modal);
  };

  document.getElementById('show-item-modal-close').onclick = () => {
    closeModalOverlay(modal);
  };
}

function startShowAutoTrigger() {
  stopShowAutoTrigger();

  // Check every 30 seconds
  showAutoTriggerInterval = setInterval(() => {
    if (!appState.identity || appState.identity.role !== 'Director') return;
    if (appState.currentPage !== 'show') return;

    const runOfShow = getRunOfShow();
    const now = new Date();
    const currentTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

    runOfShow.forEach(item => {
      if (item.autoRun && item.status === 'Pending' && item.time === currentTime) {
        // Check if not already fired this session (simple check: if it's still pending and time matches)
        // More robust would be to track "firedThisSession" flag, but for now we rely on status change
        executeShowItem(item.id);
      }
    });
  }, 30000);
}

function stopShowAutoTrigger() {
  if (showAutoTriggerInterval) {
    clearInterval(showAutoTriggerInterval);
    showAutoTriggerInterval = null;
  }
}

// Initialize on load
init();
