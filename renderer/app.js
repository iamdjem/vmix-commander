// Stable per-install identifier — used by presence heartbeat + error telemetry
// so the tracker can tell Commander instances apart when multiple connect to
// the same event.
const COMMANDER_ID = (() => {
  try {
    let id = localStorage.getItem('vmc:commanderId');
    if (!id) {
      id = (crypto && crypto.randomUUID) ? crypto.randomUUID()
        : 'cmd-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
      localStorage.setItem('vmc:commanderId', id);
    }
    return id;
  } catch (_) {
    return 'cmd-' + Date.now().toString(36);
  }
})();

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
  trackerAuditLog: [],   // mirror of the event's Firebase audit tree (most recent 500)
  trackerErrors: [],     // mirror of the event's Firebase errors tree (most recent 100)
  showTrackerAudit: true,
  logFilters: { room: '', user: '', action: '' }
};

// Read-only mode flag — flipped when the user chose "Go read-only" on the
// concurrent-operator prompt. When true, no vMix-action call should fire and
// the sync toggle is disabled.
let _readOnlyMode = false;

// Global error telemetry — wired up before any heavy init so we catch even
// early boot failures. The pushErrorToTracker helper itself is defined lower
// down; the listeners tolerate it being undefined for a few ms during boot.
window.addEventListener('error', (ev) => {
  try {
    if (typeof pushErrorToTracker === 'function') {
      pushErrorToTracker({
        message: ev.message || 'window error',
        stack: (ev.error && ev.error.stack) || '',
        context: 'window.onerror'
      });
    }
  } catch (_) { /* never re-throw */ }
});

window.addEventListener('unhandledrejection', (ev) => {
  try {
    if (typeof pushErrorToTracker === 'function') {
      const reason = ev.reason;
      pushErrorToTracker({
        message: reason && reason.message ? reason.message : String(reason),
        stack: (reason && reason.stack) || '',
        context: 'unhandledrejection'
      });
    }
  } catch (_) { /* never re-throw */ }
});

let statusRefreshInterval = null;
let showAutoTriggerInterval = null;
let recordingTimerInterval = null;
// Recording start times — persisted to localStorage to survive app restart
const recordingStartTimes = JSON.parse(localStorage.getItem('recordingStartTimes') || '{}');

function persistRecordingTimes() {
  localStorage.setItem('recordingStartTimes', JSON.stringify(recordingStartTimes));
}

// Safety lock — when locked, all room controls are disabled
let controlsLocked = localStorage.getItem('controlsLocked') === '1';

function setControlsLocked(locked) {
  const next = !!locked;
  if (controlsLocked === next) return;  // no-op (also short-circuits Firebase echo loops)
  controlsLocked = next;
  localStorage.setItem('controlsLocked', next ? '1' : '0');
  document.body.classList.toggle('controls-locked', next);
  showToast(next ? '🔒 All Rooms locked' : '🔓 All Rooms unlocked');
  if (typeof pushVmixStatusToTracker === 'function') pushVmixStatusToTracker();
  if (typeof pushSafetyLockToTracker === 'function') pushSafetyLockToTracker();
}

function applyControlsLock() {
  document.body.classList.toggle('controls-locked', controlsLocked);
}

// Shared icon markup — sourced from <template> blocks in index.html
const ICONS = {
  get gear() { const tpl = document.getElementById('icon-gear'); return tpl ? tpl.innerHTML.trim() : ''; },
  get play() { const tpl = document.getElementById('icon-play'); return tpl ? tpl.innerHTML.trim() : ''; },
  get stop() { const tpl = document.getElementById('icon-stop'); return tpl ? tpl.innerHTML.trim() : ''; },
  get lock() { const tpl = document.getElementById('icon-lock'); return tpl ? tpl.innerHTML.trim() : ''; },
  get unlock() { const tpl = document.getElementById('icon-unlock'); return tpl ? tpl.innerHTML.trim() : ''; }
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
  const prevUrl = _currentTunnelUrl;
  _currentTunnelUrl = status.url || '';
  if (_currentTunnelUrl !== prevUrl && typeof pushProxyUrlToTracker === 'function') {
    pushProxyUrlToTracker();
  }

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
  applyControlsLock();

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
    document.getElementById('chk-sync-enabled').checked = true;
    connectToFirebase();
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
    renderErrorsPanel();
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

  // Re-match rooms — re-resolves assignedRooms from the current tracker
  // crew roster and persists. Only relevant when bound to a crew member.
  const btnRematch = document.getElementById('btn-rematch-rooms');
  if (btnRematch) {
    btnRematch.addEventListener('click', () => { rematchAssignedRooms(); });
  }

  // Cloud sync checkbox
  document.getElementById('chk-sync-enabled').addEventListener('change', async (e) => {
    appState.syncEnabled = e.target.checked;
    const profile = getCurrentProfile();
    profile.syncEnabled = appState.syncEnabled;

    if (appState.syncEnabled) {
      await saveProfiles();
      await connectToFirebase();
    } else {
      disconnectFromFirebase();
      await saveProfiles();
    }
  });

  // Event select dropdown — link this conference profile to a tracker event
  document.getElementById('sync-event-select').addEventListener('change', async (e) => {
    const eventId = e.target.value;
    const profile = getCurrentProfile();
    profile.trackerEventId = eventId || null;
    await saveProfiles();
    if (appState.syncEnabled) {
      // Rebuild event-scoped subscriptions / presence / initial pushes.
      stopPresenceHeartbeat();
      unsubscribeFromTrackerAudit();
      unsubscribeFromTrackerErrors();
      unsubscribeFromTrackerCrew();
      unsubscribeFromTrackerSafetyLock();
      if (eventId) {
        await pushRoomsToTrackerEvent();
        await pushProxyUrlToTracker();
        await pushVmixStatusToTracker();
        await checkConcurrentOperator();
        if (!_readOnlyMode) startPresenceHeartbeat();
        subscribeToTrackerAudit();
        subscribeToTrackerErrors();
        subscribeToTrackerCrew();
        subscribeToTrackerSafetyLock();
        pushRunOfShowToTracker();
        pushRoomLocksToTracker();
        pushSafetyLockToTracker();
        showToast('Linked to ' + (trackerEvents[eventId]?.name || 'event'));
      } else {
        showToast('Unlinked from event');
      }
    }
  });

  // Log page — "Show Tracker entries" toggle
  const logToggleTracker = document.getElementById('chk-log-show-tracker');
  if (logToggleTracker) {
    logToggleTracker.checked = appState.showTrackerAudit;
    logToggleTracker.addEventListener('change', (e) => {
      appState.showTrackerAudit = !!e.target.checked;
      renderAuditLog();
    });
  }

  // Read-only banner — "Take over" button
  const bannerTakeover = document.getElementById('readonly-banner-takeover');
  if (bannerTakeover) {
    bannerTakeover.addEventListener('click', () => {
      setReadOnlyMode(false);
      startPresenceHeartbeat();
      showToast('Took over as operator');
    });
  }

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

  // Apply Operator filter: show only assigned room(s). Resolved live from
  // the tracker's crew roster when identity.crewId is set, so a rename
  // anywhere takes effect on the next render. Falls back to stored values
  // for custom identities.
  if (appState.identity && appState.identity.role === 'Operator') {
    const keys = effectiveAssignedRooms(appState.identity);
    if (keys.length) {
      roomsToShow = profile.rooms.filter(r => keys.includes(r.key));
    }
  }

  if (roomsToShow.length === 0) {
    container.innerHTML = '<div class="empty-state">No rooms configured. Tap the settings icon to add rooms.</div>';
    return;
  }

  // Show an All Rooms master card only for Directors when there are 2+
  // rooms. Operators are scoped to their own room; Observers are
  // read-only and have no use for the master controls.
  const isDirector = appState.identity && appState.identity.role === 'Director';
  if (roomsToShow.length >= 2 && isDirector) {
    container.appendChild(createAllRoomsCard(roomsToShow));
  }

  roomsToShow.forEach(room => {
    const card = createRoomCard(room);
    container.appendChild(card);
  });

  // Fetch initial status
  refreshAllStatus();
}

// All-rooms master card — fires actions across every room
function createAllRoomsCard(rooms) {
  const card = document.createElement('div');
  card.className = 'room-card all-rooms-card';

  const header = document.createElement('div');
  header.className = 'room-header';

  const nameWrap = document.createElement('div');
  nameWrap.className = 'room-name-wrap';

  const name = document.createElement('div');
  name.className = 'room-name';
  name.innerHTML = 'All Rooms <span class="master-badge">MASTER</span>';

  const count = document.createElement('span');
  count.className = 'room-health offline';
  count.innerHTML = `<span class="room-health-label">${rooms.length} rooms</span>`;

  nameWrap.appendChild(name);
  nameWrap.appendChild(count);
  header.appendChild(nameWrap);

  // Safety lock toggle (top right) — gates ONLY the All Rooms master
  // buttons. Individual room cards stay live so the operator can keep
  // running per-room actions while the global "all rooms" controls are
  // safely disabled mid-event.
  const lockWrap = document.createElement('label');
  lockWrap.className = 'safety-lock' + (controlsLocked ? ' locked' : '');
  lockWrap.title = 'Lock the START / STOP ALL ROOMS buttons. Per-room cards stay live.';
  lockWrap.innerHTML = `
    <span class="safety-lock-label">${controlsLocked ? 'LOCKED' : 'LIVE'}</span>
    <span class="safety-lock-switch">
      <input type="checkbox" ${controlsLocked ? 'checked' : ''}>
      <span class="safety-lock-slider"></span>
    </span>
  `;
  const lockInput = lockWrap.querySelector('input');
  lockInput.onchange = (e) => {
    setControlsLocked(e.target.checked);
    renderRooms();
  };
  header.appendChild(lockWrap);

  const masterControls = document.createElement('div');
  masterControls.className = 'master-controls';

  const startAllBtn = document.createElement('button');
  startAllBtn.className = 'btn btn-start-all';
  startAllBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor"><polygon points="2,0 12,6 2,12"/></svg><span>START ALL ROOMS</span>';
  startAllBtn.onclick = () => allRoomsAction(rooms, 'start');

  const stopAllBtn = document.createElement('button');
  stopAllBtn.className = 'btn btn-stop-all';
  stopAllBtn.innerHTML = '<svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor"><rect x="0" y="0" width="10" height="10" rx="1.5"/></svg><span>STOP ALL ROOMS</span>';
  stopAllBtn.onclick = () => allRoomsAction(rooms, 'stop');

  masterControls.appendChild(startAllBtn);
  masterControls.appendChild(stopAllBtn);

  card.appendChild(header);
  card.appendChild(masterControls);
  return card;
}

async function allRoomsAction(rooms, action) {
  if (_readOnlyMode) {
    showToast('Read-only mode — vMix actions disabled');
    return;
  }
  if (controlsLocked) {
    showToast('All Rooms is locked — toggle LIVE to enable');
    return;
  }

  const withIp = rooms.filter(r => r.ip);
  if (withIp.length === 0) {
    showToast('No rooms have an IP configured');
    return;
  }

  // Both START and STOP All Rooms require confirmation — these affect every
  // room simultaneously and an accidental tap mid-event has real cost.
  if (action === 'stop') {
    showConfirm({
      title: 'Stop all rooms?',
      message: `This will stop recording, streaming, and MultiCorder on all ${withIp.length} rooms. Continue?`,
      confirmLabel: 'Stop all rooms',
      danger: true,
      onConfirm: () => runAllRoomsAction(withIp, 'stop')
    });
    return;
  }

  if (action === 'start') {
    showConfirm({
      title: 'Start all rooms?',
      message: `This will start recording, streaming, and MultiCorder on all ${withIp.length} rooms. Continue?`,
      confirmLabel: 'Start all rooms',
      danger: false,
      onConfirm: () => runAllRoomsAction(withIp, 'start')
    });
    return;
  }

  runAllRoomsAction(withIp, action);
}

async function runAllRoomsAction(withIp, action) {
  showToast(`${action === 'start' ? 'Starting' : 'Stopping'} ${withIp.length} rooms…`);

  const fns = action === 'start'
    ? ['StartRecording', 'StartStreaming', 'StartMultiCorder']
    : ['StopRecording', 'StopStreaming', 'StopMultiCorder'];

  const results = await Promise.all(
    withIp.flatMap(room => fns.map(fn =>
      window.vmix.call(room.ip, fn)
        .then(res => ({ ...res, room: room.name }))
        .catch(err => ({ ok: false, error: err.message, room: room.name }))
    ))
  );

  const okCount = results.filter(r => r.ok).length;
  const totalCount = results.length;
  const actionLabel = action === 'start' ? 'START ALL' : 'STOP ALL';

  // One audit entry per room
  for (const room of withIp) {
    const roomResults = results.filter(r => r.room === room.name);
    const allOk = roomResults.every(r => r.ok);
    await appendAuditLog(room.name, actionLabel + ' (all rooms)', allOk ? 'ok' : 'fail');
  }

  showToast(okCount === totalCount ? `✓ All rooms done` : `✗ ${okCount}/${totalCount} OK`);

  // Refresh status for all rooms after a short delay
  setTimeout(() => refreshAllStatus(), 1200);
}

// Per-room lock helpers — persists in profile.roomLocks and, when sync is on,
// mirrors to Firebase via pushRoomLocksToTracker + pushVmixStatusToTracker.
function isRoomLocked(roomKey) {
  const profile = getCurrentProfile();
  return !!(profile.roomLocks && profile.roomLocks[roomKey]);
}

async function setRoomLocked(roomKey, locked) {
  const profile = getCurrentProfile();
  if (!profile.roomLocks) profile.roomLocks = {};
  if (locked) profile.roomLocks[roomKey] = true;
  else delete profile.roomLocks[roomKey];
  await saveProfiles();
  pushRoomLocksToTracker();
  pushVmixStatusToTracker();
  const roomName = (profile.rooms.find(r => r.key === roomKey) || {}).name || roomKey;
  showToast(locked ? `🔒 Locked: ${roomName}` : `🔓 Unlocked: ${roomName}`);
  if (appState.currentPage === 'rooms') renderRooms();
}

// Create room card
function createRoomCard(room) {
  const card = document.createElement('div');
  card.className = 'room-card';
  if (isRoomLocked(room.key)) card.classList.add('room-locked');
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

  // Per-room lock toggle — sits between name and settings-gear.
  const locked = isRoomLocked(room.key);
  const lockBtn = document.createElement('button');
  lockBtn.className = 'room-lock-btn' + (locked ? ' locked' : '');
  lockBtn.title = locked ? 'Room locked — click to unlock' : 'Lock this room';
  lockBtn.setAttribute('aria-label', locked ? 'Unlock room' : 'Lock room');
  lockBtn.innerHTML = locked ? ICONS.lock : ICONS.unlock;
  lockBtn.onclick = (e) => {
    e.stopPropagation();
    setRoomLocked(room.key, !isRoomLocked(room.key));
  };

  const settingsBtn = document.createElement('button');
  settingsBtn.className = 'room-settings-btn';
  settingsBtn.innerHTML = ICONS.gear;
  settingsBtn.title = 'Room settings';
  settingsBtn.onclick = () => openRoomSettings(room.key);

  header.appendChild(dragHandle);
  header.appendChild(nameWrap);
  header.appendChild(lockBtn);
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
  if (_readOnlyMode) {
    showToast('Read-only mode — vMix actions disabled');
    return { ok: false, error: 'read-only' };
  }
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
  if (_readOnlyMode) {
    showToast('Read-only mode — vMix actions disabled');
    return;
  }
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
  schedulePushVmixStatus();
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
  // Poll vMix on every tick regardless of which Commander tab is active.
  // The status push to Firebase is what keeps the tracker's "Commander
  // online" indicator fresh — gating polling on the Rooms tab caused the
  // tracker to falsely show "Commander offline" any time the operator
  // switched to Settings, Log, or Show.
  statusRefreshInterval = setInterval(() => {
    refreshAllStatus();
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
  if (typeof pushVmixStatusToTracker === 'function') pushVmixStatusToTracker();
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
  document.getElementById('chk-sync-enabled').checked = !!profile.syncEnabled;
  renderEventSelect();

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
  // Back-compat migration: older identities stored a single `assignedRoom`
  // string. New code reads `assignedRooms` (string[] of room keys) as the
  // source of truth. Keep `assignedRoom` around so any not-yet-migrated code
  // paths continue to work.
  if (appState.identity && appState.identity.assignedRoom && !appState.identity.assignedRooms) {
    appState.identity.assignedRooms = [appState.identity.assignedRoom];
  }
}

async function saveIdentity(identity) {
  appState.identity = identity;
  await window.identity.save(identity);
  if (typeof pushVmixStatusToTracker === 'function') pushVmixStatusToTracker();
  // Refresh presence so the tracker sees the new operator name/role.
  if (appState.syncEnabled && !_readOnlyMode && typeof startPresenceHeartbeat === 'function') {
    startPresenceHeartbeat();
  }
}

function updateIdentityBadge() {
  // Identity is shown on Settings page, no longer in header
}

// Re-render the crew-member dropdown inside the identity modal. Called on
// modal open AND whenever the tracker crew list updates while the modal is
// open. Preserves the current selection if it still matches a crew id;
// falls back to "__custom__" otherwise.
function renderTrackerCrewDropdown() {
  const select = document.getElementById('identity-crew');
  const helper = document.getElementById('identity-crew-helper');
  if (!select) return;

  const previousValue = select.value || '__custom__';

  const staticOptions = [
    '<option value="__custom__">— Custom identity —</option>',
    '<option value="__director__">Director — All rooms</option>'
  ];

  const crewOptions = (trackerCrewList || [])
    .filter(c => c && c.id && c.name)
    .map(c => {
      const roomLabels = Array.isArray(c.rooms) && c.rooms.length
        ? ' (' + c.rooms.map(r => (r && r.name) || '').filter(Boolean).join(', ') + ')'
        : '';
      const safeName = String(c.name).replace(/</g, '&lt;');
      const safeRooms = roomLabels.replace(/</g, '&lt;');
      return `<option value="${c.id}">${safeName}${safeRooms}</option>`;
    });

  select.innerHTML = staticOptions.concat(crewOptions).join('');

  // Restore previous selection if still valid.
  const stillValid = Array.from(select.options).some(o => o.value === previousValue);
  select.value = stillValid ? previousValue : '__custom__';

  if (helper) {
    helper.style.display = crewOptions.length === 0 ? 'block' : 'none';
  }
}

// Shared wiring for the identity modal. `onSave(identity)` fires after a
// valid identity is assembled and saved.
function wireIdentityModal({ onSave }) {
  const modal = document.getElementById('identity-modal');
  const nameInput = document.getElementById('identity-name');
  const roleSelect = document.getElementById('identity-role');
  const crewSelect = document.getElementById('identity-crew');
  const crewHint = document.getElementById('identity-crew-hint');
  const roomSelector = document.getElementById('identity-room-selector');
  const assignedRoomSelect = document.getElementById('identity-assigned-room');

  // Show the assigned-room picker whenever the role is "Operator" AND the
  // user is not locked into a crew-driven selection.
  const updateRoomSelector = () => {
    const crewLocked = crewSelect.value !== '__custom__' && crewSelect.value !== '__director__';
    if (roleSelect.value === 'Operator' && !crewLocked) {
      roomSelector.style.display = 'block';
      const profile = getCurrentProfile();
      const current = assignedRoomSelect.value;
      assignedRoomSelect.innerHTML = profile.rooms.map(r =>
        `<option value="${r.key}"${r.key === current ? ' selected' : ''}>${r.name}</option>`
      ).join('');
    } else {
      roomSelector.style.display = 'none';
    }
  };

  // Apply the currently-selected crew option to the Name/Role inputs.
  const applyCrewSelection = () => {
    const value = crewSelect.value;
    if (value === '__custom__') {
      nameInput.disabled = false;
      roleSelect.disabled = false;
      if (crewHint) crewHint.style.display = 'none';
      updateRoomSelector();
      return;
    }
    if (value === '__director__') {
      // Director shortcut — only fill name if blank.
      if (!nameInput.value.trim() && appState.identity && appState.identity.name) {
        nameInput.value = appState.identity.name;
      }
      roleSelect.value = 'Director';
      nameInput.disabled = false;
      roleSelect.disabled = false;
      if (crewHint) crewHint.style.display = 'none';
      updateRoomSelector();
      return;
    }
    // Crew-member selection — auto-fill and lock Name/Role.
    const crew = (trackerCrewList || []).find(c => c && c.id === value);
    if (crew) {
      nameInput.value = crew.name || '';
      roleSelect.value = 'Operator';
    }
    nameInput.disabled = true;
    roleSelect.disabled = true;
    if (crewHint) crewHint.style.display = 'block';
    // Crew members hide the single-room picker — assignedRooms is derived
    // from the crew's room list instead.
    roomSelector.style.display = 'none';
  };

  renderTrackerCrewDropdown();
  crewSelect.onchange = applyCrewSelection;
  roleSelect.onchange = updateRoomSelector;

  // Initial pass so the room picker is in the right state on open.
  applyCrewSelection();

  document.getElementById('identity-save').onclick = async () => {
    const name = nameInput.value.trim();
    const role = roleSelect.value;
    const crewValue = crewSelect.value;

    if (!name) {
      showToast('Please enter your name');
      return;
    }

    const identity = { name, role };

    if (crewValue !== '__custom__' && crewValue !== '__director__') {
      // Crew-member selection — derive assignedRooms from crew.rooms by name.
      const crew = (trackerCrewList || []).find(c => c && c.id === crewValue);
      if (crew) {
        identity.crewId = crew.id;
        const roomNames = Array.isArray(crew.rooms) ? crew.rooms.map(r => r && r.name).filter(Boolean) : [];
        const keys = roomNames.map(findRoomKeyByName).filter(Boolean);
        identity.assignedRooms = keys;
        // Also mirror the first key into the legacy `assignedRoom` field so
        // any code still reading it keeps working.
        if (keys.length) identity.assignedRoom = keys[0];

        if (keys.length === 0) {
          showToast(`Crew member "${crew.name}" has no matching rooms in this profile — check that vMix room names match the tracker's crew assignments.`);
        }
      }
    } else if (role === 'Operator') {
      // Custom identity with Operator role — keep the single-room picker behavior.
      const key = assignedRoomSelect.value;
      if (key) {
        identity.assignedRoom = key;
        identity.assignedRooms = [key];
      }
    }
    // Director / Custom-non-operator: no assignedRooms / crewId.

    await saveIdentity(identity);
    closeModalOverlay(document.getElementById('identity-modal'));

    if (typeof onSave === 'function') await onSave(identity);
  };
}

function showIdentityOnboarding() {
  const modal = document.getElementById('identity-modal');
  openModalOverlay(modal);
  enableModalClose(modal, () => { closeModalOverlay(modal); });

  wireIdentityModal({
    onSave: async () => {
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
    }
  });
}

function showChangeIdentityModal() {
  const modal = document.getElementById('identity-modal');
  const nameInput = document.getElementById('identity-name');
  const roleSelect = document.getElementById('identity-role');
  const crewSelect = document.getElementById('identity-crew');
  const assignedRoomSelect = document.getElementById('identity-assigned-room');

  // Pre-fill current identity before wiring so wireIdentityModal's initial
  // pass sees the right values.
  nameInput.value = appState.identity.name || '';
  roleSelect.value = appState.identity.role || 'Director';

  // Pre-select the crew dropdown if the active identity references one.
  // Otherwise default to "Custom identity" so the name/role inputs stay free.
  const currentCrewId = appState.identity.crewId || '__custom__';
  // Populate the room selector with current selection for back-compat.
  if (appState.identity.role === 'Operator') {
    const profile = getCurrentProfile();
    const currentKey = (appState.identity.assignedRooms && appState.identity.assignedRooms[0])
      || appState.identity.assignedRoom
      || '';
    assignedRoomSelect.innerHTML = profile.rooms.map(r =>
      `<option value="${r.key}"${r.key === currentKey ? ' selected' : ''}>${r.name}</option>`
    ).join('');
  }

  openModalOverlay(modal);
  enableModalClose(modal, () => { closeModalOverlay(modal); });

  wireIdentityModal({
    onSave: async () => {
      updateIdentityBadge();
      updateIdentityDisplay();
      applyRoleRestrictions();

      // Re-render current page to apply restrictions
      if (appState.currentPage === 'rooms') renderRooms();

      showToast('Identity updated');
    }
  });

  // Apply the pre-selected crew id *after* wireIdentityModal has rendered
  // the options — fires the change handler so Name/Role lock correctly.
  if (Array.from(crewSelect.options).some(o => o.value === currentCrewId)) {
    crewSelect.value = currentCrewId;
    crewSelect.dispatchEvent(new Event('change'));
  }
}

function updateIdentityDisplay() {
  const display = document.getElementById('identity-display');
  if (!appState.identity) return;

  let html = `<div style="margin-bottom: 8px;"><strong>Name:</strong> ${appState.identity.name}</div>`;
  html += `<div style="margin-bottom: 8px;"><strong>Role:</strong> ${appState.identity.role}</div>`;

  if (appState.identity.role === 'Operator') {
    const profile = getCurrentProfile();
    // Use the live-resolved assignedRooms so renames in the tracker crew
    // config show up here without requiring a re-pick.
    const keys = effectiveAssignedRooms(appState.identity);
    if (keys.length) {
      const names = keys
        .map(k => profile.rooms.find(r => r.key === k))
        .map(r => r ? r.name : 'Unknown')
        .join(', ');
      const label = keys.length === 1 ? 'Assigned Room' : 'Assigned Rooms';
      html += `<div><strong>${label}:</strong> ${names}</div>`;
    }
    if (appState.identity.crewId) {
      const crew = (trackerCrewList || []).find(c => c && c.id === appState.identity.crewId);
      const crewLabel = crew ? crew.name : '(crew not found)';
      html += `<div style="margin-top: 4px; color: var(--t3); font-size: var(--fs-sm);"><strong>Bound to crew:</strong> ${crewLabel}</div>`;
    }
  }

  display.innerHTML = html;

  // Show "Re-match rooms" button only when identity is bound to a crew member.
  const btnRematch = document.getElementById('btn-rematch-rooms');
  if (btnRematch) {
    btnRematch.style.display = appState.identity.crewId ? '' : 'none';
  }
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

  // Mirror to Firebase — local log remains primary. Errors are swallowed
  // inside pushAuditToTracker.
  pushAuditToTracker(room, action, result);
}

function renderAuditLog() {
  const container = document.getElementById('log-container');
  container.innerHTML = '';

  // Local entries — scoped to the current conference profile
  const local = appState.auditLog
    .filter(e => !e.profileKey || e.profileKey === appState.current)
    .map(e => ({
      ts: e.ts,
      tsMs: new Date(e.ts).getTime(),
      user: e.user,
      room: e.room,
      action: e.action,
      result: e.result,
      viaTracker: false
    }));

  // Tracker-originated entries — only included when the toggle is on and we
  // have a linked event. Tracker entries only exist scoped to this event so
  // they're safe to include unconditionally once fetched.
  let merged = local.slice();
  if (appState.showTrackerAudit && Array.isArray(appState.trackerAuditLog)) {
    const trackerOnly = appState.trackerAuditLog
      .filter(e => e && e.source === 'tracker')
      .map(e => ({
        ts: new Date(e.timestamp || Date.now()).toISOString(),
        tsMs: e.timestamp || 0,
        user: (e.identity && e.identity.name) || 'tracker',
        room: e.room || '',
        action: e.action || '',
        result: e.result || 'ok',
        viaTracker: true
      }));
    merged = merged.concat(trackerOnly);
  }

  // Apply filters (room/user/action)
  let filteredLog = merged;
  if (appState.logFilters.room) {
    filteredLog = filteredLog.filter(e =>
      (e.room || '').toLowerCase().includes(appState.logFilters.room.toLowerCase())
    );
  }
  if (appState.logFilters.user) {
    filteredLog = filteredLog.filter(e =>
      (e.user || '').toLowerCase().includes(appState.logFilters.user.toLowerCase())
    );
  }
  if (appState.logFilters.action) {
    filteredLog = filteredLog.filter(e => e.action === appState.logFilters.action);
  }

  // Sort newest first, cap to 500
  filteredLog.sort((a, b) => (b.tsMs || 0) - (a.tsMs || 0));
  filteredLog = filteredLog.slice(0, 500);

  if (filteredLog.length === 0) {
    container.innerHTML = '<div class="log-empty">No log entries</div>';
    return;
  }

  filteredLog.forEach(entry => {
    const row = document.createElement('div');
    row.className = 'log-entry' + (entry.viaTracker ? ' log-entry-tracker' : '');

    const time = new Date(entry.ts).toLocaleString();
    const resultIcon = entry.result === 'ok' ? '✓' : entry.result === 'denied' ? '∅' : '✗';
    const resultClass = entry.result === 'ok' ? 'log-result-ok' : 'log-result-fail';
    const badge = entry.viaTracker ? '<span class="log-via-tracker">via Tracker</span>' : '';

    row.innerHTML = `
      <div class="log-time">${time}</div>
      <div class="log-user">${entry.user}${badge}</div>
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

// Tracker Firebase config (shared with kubecon-tracker)
const TRACKER_FB_CONFIG = {
  apiKey: 'AIzaSyAo1IeN6TnsKC48_ZJG6BWxke_T1l8Ke2g',
  authDomain: 'kubecon-tracker.firebaseapp.com',
  databaseURL: 'https://kubecon-tracker-default-rtdb.europe-west1.firebasedatabase.app',
  projectId: 'kubecon-tracker'
};
const TRACKER_FB_ROOT = 'e3-kc26-x7k9m';
const TRACKER_USER_EMAIL = 'user@e3tracker.local';
const TRACKER_USER_PASSWORD = 'e3crew';

let trackerAuth = null;
let trackerEvents = {};  // { eventId: eventObject } cached from tracker
let trackerEventsRef = null;

function loadFirebaseScripts() {
  return new Promise((resolve, reject) => {
    if (window.firebase && firebase.auth) {
      resolve();
      return;
    }

    const scripts = [
      'https://www.gstatic.com/firebasejs/9.22.0/firebase-app-compat.js',
      'https://www.gstatic.com/firebasejs/9.22.0/firebase-auth-compat.js',
      'https://www.gstatic.com/firebasejs/9.22.0/firebase-database-compat.js'
    ];

    let loaded = 0;
    scripts.forEach(src => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = () => { if (++loaded === scripts.length) resolve(); };
      s.onerror = () => reject(new Error('Failed to load ' + src));
      document.head.appendChild(s);
    });
  });
}

async function initTrackerFirebase() {
  if (firebaseDb && trackerAuth && trackerAuth.currentUser) return;

  await loadFirebaseScripts();

  if (!firebase.apps.length) {
    firebase.initializeApp(TRACKER_FB_CONFIG);
  }
  firebaseDb = firebase.database();
  trackerAuth = firebase.auth();

  // Sign in as user role (crew, not admin — we only read events and write rooms)
  if (!trackerAuth.currentUser) {
    await trackerAuth.signInWithEmailAndPassword(TRACKER_USER_EMAIL, TRACKER_USER_PASSWORD);
  }
}

async function connectToFirebase() {
  const syncCheckbox = document.getElementById('chk-sync-enabled');
  if (syncCheckbox) syncCheckbox.disabled = true;

  updateSyncStatus('🟡 Connecting…', false);

  try {
    await initTrackerFirebase();

    // Listen to the tracker's events collection
    if (!trackerEventsRef) {
      trackerEventsRef = firebaseDb.ref(`${TRACKER_FB_ROOT}/events`);
      trackerEventsRef.on('value', (snap) => {
        trackerEvents = snap.val() || {};
        renderEventSelect();
        updateSyncStatus('🟢 Connected', true);
      });
    }

    // Initial push of rooms + proxy URL + vmix status after connecting.
    // Previously this ran on every snapshot, which created a feedback loop
    // (writing updatedAt re-triggered the snapshot listener) and caused the
    // event dropdown to close itself mid-click.
    await pushRoomsToTrackerEvent();
    await pushProxyUrlToTracker();
    await pushVmixStatusToTracker();

    // Presence + concurrent-operator + audit mirror + run-of-show + room locks
    await checkConcurrentOperator();
    if (!_readOnlyMode) startPresenceHeartbeat();
    subscribeToTrackerAudit();
    subscribeToTrackerErrors();
    subscribeToTrackerCrew();
    subscribeToTrackerSafetyLock();
    pushRunOfShowToTracker();
    pushRoomLocksToTracker();
    pushSafetyLockToTracker();

    if (syncCheckbox) syncCheckbox.disabled = _readOnlyMode;
  } catch (error) {
    console.error('Firebase connection error:', error);
    updateSyncStatus('🔴 ' + (error.message || 'Connection failed'), false);
    if (syncCheckbox) syncCheckbox.disabled = false;
    if (typeof pushErrorToTracker === 'function') {
      pushErrorToTracker({ message: 'connectToFirebase: ' + (error && error.message || error), stack: error && error.stack || '', context: 'connectToFirebase' });
    }
  }
}

function disconnectFromFirebase() {
  if (trackerEventsRef) {
    trackerEventsRef.off();
    trackerEventsRef = null;
  }
  stopPresenceHeartbeat();
  unsubscribeFromTrackerAudit();
  unsubscribeFromTrackerErrors();
  unsubscribeFromTrackerCrew();
  unsubscribeFromTrackerSafetyLock();
  setReadOnlyMode(false);
  trackerEvents = {};
  renderEventSelect();
  updateSyncStatus('🔴 Disconnected', false);
}

function updateSyncStatus(message, connected) {
  const statusEl = document.getElementById('sync-status');
  if (!statusEl) return;
  statusEl.textContent = message;
  statusEl.className = 'sync-status ' + (connected ? 'sync-connected' : 'sync-disconnected');
}

// Populate the event dropdown with live events from the tracker.
// Skip rebuild when the option set hasn't changed — re-assigning innerHTML
// closes an open dropdown and drops focus, which was making selection
// impossible while snapshots were arriving.
let _lastEventSelectSig = '';
function renderEventSelect() {
  const select = document.getElementById('sync-event-select');
  if (!select) return;

  const profile = getCurrentProfile();
  const currentLinkedId = profile.trackerEventId || '';

  // Sort: live first (non-archived), newest updatedAt first
  const events = Object.values(trackerEvents)
    .sort((a, b) => {
      if (a.archived !== b.archived) return a.archived ? 1 : -1;
      return (b.updatedAt || 0) - (a.updatedAt || 0);
    });

  const sig = currentLinkedId + '|' + events.map(ev => `${ev.id}:${ev.name || ''}:${ev.archived ? 1 : 0}`).join(',');
  if (sig === _lastEventSelectSig) return;
  _lastEventSelectSig = sig;

  select.innerHTML = '<option value="">— Not linked —</option>' +
    events.map(ev => {
      const label = (ev.name || 'Untitled') + (ev.archived ? ' (archived)' : '');
      const sel = ev.id === currentLinkedId ? ' selected' : '';
      return `<option value="${ev.id}"${sel}>${label}</option>`;
    }).join('');
}

// Push active profile's rooms to the linked tracker event
async function pushRoomsToTrackerEvent() {
  const profile = getCurrentProfile();
  if (!profile.trackerEventId || !firebaseDb || !trackerAuth || !trackerAuth.currentUser) return;

  try {
    const path = `${TRACKER_FB_ROOT}/events/${profile.trackerEventId}/config/vmixRooms`;
    const rooms = profile.rooms.map(r => ({ key: r.key, name: r.name, ip: r.ip || '' }));
    await firebaseDb.ref(path).set(rooms);
    // Also bump updatedAt so the tracker re-syncs
    await firebaseDb.ref(`${TRACKER_FB_ROOT}/events/${profile.trackerEventId}/updatedAt`).set(Date.now());
  } catch (error) {
    console.error('Failed to push rooms to tracker event:', error);
    if (typeof pushErrorToTracker === 'function') {
      pushErrorToTracker({ message: 'pushRoomsToTrackerEvent: ' + (error && error.message || error), stack: error && error.stack || '', context: 'pushRoomsToTrackerEvent' });
    }
  }
}

async function pushToFirebase() {
  if (!appState.syncEnabled) return;
  await pushRoomsToTrackerEvent();
}

// Publish the Cloudflare tunnel URL so the tracker (served over HTTPS) can
// reach vMix (HTTP) via the commander's /vmix-proxy bridge. Without this,
// the tracker falls back to direct HTTP and gets blocked by mixed-content,
// showing every room's REC/STREAM/MULTI as OFF.
// Writes both the legacy global node (for older tracker versions) and the
// per-event config node so a tracker can prefer event-scoped URL when present.
let _lastPushedProxyUrl = '';
let _lastPushedProxyEventId = '';
async function pushProxyUrlToTracker() {
  if (!appState.syncEnabled) return;
  if (!firebaseDb || !trackerAuth || !trackerAuth.currentUser) return;
  const url = _currentTunnelUrl || '';
  const profile = getCurrentProfile();
  const eventId = profile.trackerEventId || '';

  // Legacy global write — always kept in sync for back-compat.
  if (url !== _lastPushedProxyUrl) {
    try {
      await firebaseDb.ref(`${TRACKER_FB_ROOT}/vmix_proxy_url`).set(url || null);
      _lastPushedProxyUrl = url;
    } catch (error) {
      console.error('Failed to push proxy URL to tracker (global):', error);
      if (typeof pushErrorToTracker === 'function') {
        pushErrorToTracker({ message: 'pushProxyUrlToTracker global: ' + (error && error.message || error), stack: error && error.stack || '', context: 'pushProxyUrlToTracker' });
      }
    }
  }

  // Per-event write — newer shared contract.
  if (eventId && (url !== _lastPushedProxyUrl || eventId !== _lastPushedProxyEventId)) {
    try {
      await firebaseDb.ref(`${TRACKER_FB_ROOT}/events/${eventId}/config/vmixProxyUrl`).set(url || null);
      _lastPushedProxyEventId = eventId;
    } catch (error) {
      console.error('Failed to push proxy URL to tracker (event):', error);
      if (typeof pushErrorToTracker === 'function') {
        pushErrorToTracker({ message: 'pushProxyUrlToTracker event: ' + (error && error.message || error), stack: error && error.stack || '', context: 'pushProxyUrlToTracker' });
      }
    }
  }
}

// Publish rich per-room status + operator identity + safety-lock state to
// the tracker, as a single blob per event. The tracker uses this as the
// source of truth for its Recording page so crew see the same data the
// operator sees (recording timer, ping, tier, lock state).
//
// Written outside the events/ tree so Commander's own events listener
// doesn't re-fire on every status push.
let _pushVmixStatusTimer = null;
function schedulePushVmixStatus() {
  if (_pushVmixStatusTimer) return;
  _pushVmixStatusTimer = setTimeout(() => {
    _pushVmixStatusTimer = null;
    pushVmixStatusToTracker();
  }, 400);
}

// Shared shape for the `operator` blob written to both
// `events/<id>/controller.operator` (presence) and `vmixStatus/<id>.operator`.
// Only includes crewId / assignedRooms when they're populated so older
// readers that don't know about them see the same shape they always have.
function buildOperatorPayload(identity) {
  const payload = {
    name: identity.name || '',
    role: identity.role || ''
  };
  if (identity.crewId) payload.crewId = identity.crewId;
  // Send the LIVE assignedRooms (re-resolved from the current crew roster
  // when bound) so the tracker's "Controlled by" banner and presence node
  // reflect what the operator actually sees, not what was cached at save.
  const live = effectiveAssignedRooms(identity);
  if (live.length) payload.assignedRooms = live;
  return payload;
}

// Always returns an object with `name` + `role` children so that Firebase
// security rules (which require identity.hasChildren()) never reject a
// write just because identity hasn't loaded yet — e.g. errors that fire
// during early boot, or audit entries logged before onboarding completes.
function identityOrPlaceholder() {
  return appState.identity
    ? buildOperatorPayload(appState.identity)
    : { name: 'unknown', role: 'Observer' };
}

async function pushVmixStatusToTracker() {
  if (!appState.syncEnabled) return;
  const profile = getCurrentProfile();
  if (!profile.trackerEventId) return;
  if (!firebaseDb || !trackerAuth || !trackerAuth.currentUser) return;

  const rooms = {};
  profile.rooms.forEach(r => {
    const sk = scopedKey(r.key);
    const s = appState.vmixStatus[sk] || {};
    const h = appState.vmixHealth[sk] || {};
    rooms[r.key] = {
      ok: !!s.ok,
      recording: !!s.recording,
      streaming: !!s.streaming,
      multicorder: !!s.multicorder,
      latency: h.latency || 0,
      tier: h.tier || 'offline',
      recordingStartTime: recordingStartTimes[sk] || null
    };
  });

  try {
    await firebaseDb.ref(`${TRACKER_FB_ROOT}/vmixStatus/${profile.trackerEventId}`).set({
      updatedAt: Date.now(),
      operator: appState.identity ? buildOperatorPayload(appState.identity) : null,
      safetyLocked: !!controlsLocked,
      rooms,
      roomLocks: profile.roomLocks || {}
    });
  } catch (error) {
    console.error('Failed to push vmix status to tracker:', error);
    if (typeof pushErrorToTracker === 'function') {
      pushErrorToTracker({ message: 'pushVmixStatusToTracker: ' + (error && error.message || error), stack: error && error.stack || '', context: 'pushVmixStatusToTracker' });
    }
  }
}

// ────────────────────────────────────────────────────────────────────────
// Presence heartbeat + concurrent-operator detection
// ────────────────────────────────────────────────────────────────────────
let _presenceInterval = null;
let _presenceRef = null;

function startPresenceHeartbeat() {
  stopPresenceHeartbeat();
  const profile = getCurrentProfile();
  if (!appState.syncEnabled || !profile.trackerEventId) return;
  if (!firebaseDb || !trackerAuth || !trackerAuth.currentUser) return;

  _presenceRef = firebaseDb.ref(`${TRACKER_FB_ROOT}/events/${profile.trackerEventId}/controller`);
  try { _presenceRef.onDisconnect().remove(); } catch (_) { /* ignore */ }

  const writePresence = () => {
    if (!_presenceRef) return;
    const payload = {
      commanderId: COMMANDER_ID,
      operator: identityOrPlaceholder(),
      lastHeartbeat: Date.now(),
      safetyLocked: !!controlsLocked
    };
    _presenceRef.set(payload).catch((error) => {
      console.error('Presence heartbeat write failed:', error);
      if (typeof pushErrorToTracker === 'function') {
        pushErrorToTracker({ message: 'presenceHeartbeat: ' + (error && error.message || error), stack: error && error.stack || '', context: 'presenceHeartbeat' });
      }
    });
  };

  writePresence();
  _presenceInterval = setInterval(writePresence, 5000);
}

function stopPresenceHeartbeat() {
  if (_presenceInterval) {
    clearInterval(_presenceInterval);
    _presenceInterval = null;
  }
  if (_presenceRef) {
    try { _presenceRef.onDisconnect().cancel(); } catch (_) { /* ignore */ }
    try { _presenceRef.remove(); } catch (_) { /* ignore */ }
    _presenceRef = null;
  }
}

// Read the current controller once on connect. If someone else is heartbeating
// within the last 10s and they're not us, prompt the user.
async function checkConcurrentOperator() {
  const profile = getCurrentProfile();
  if (!profile.trackerEventId) return;
  if (!firebaseDb || !trackerAuth || !trackerAuth.currentUser) return;

  try {
    const snap = await firebaseDb
      .ref(`${TRACKER_FB_ROOT}/events/${profile.trackerEventId}/controller`)
      .once('value');
    const current = snap.val();
    if (!current) return;

    const recent = current.lastHeartbeat && (Date.now() - current.lastHeartbeat) < 10000;
    const different = current.commanderId && current.commanderId !== COMMANDER_ID;
    if (recent && different) {
      showConcurrentOperatorModal(current);
    }
  } catch (error) {
    console.error('Concurrent-operator check failed:', error);
    if (typeof pushErrorToTracker === 'function') {
      pushErrorToTracker({ message: 'checkConcurrentOperator: ' + (error && error.message || error), stack: error && error.stack || '', context: 'checkConcurrentOperator' });
    }
  }
}

function showConcurrentOperatorModal(current) {
  const modal = document.getElementById('concurrent-modal');
  if (!modal) return;
  const msgEl = document.getElementById('concurrent-modal-message');
  const opName = (current.operator && current.operator.name) || 'An operator';
  const opRole = (current.operator && current.operator.role) || '';
  if (msgEl) {
    msgEl.textContent = `${opName}${opRole ? ' (' + opRole + ')' : ''} is currently controlling this event. Their last heartbeat was just now.`;
  }

  openModalOverlay(modal);
  enableModalClose(modal, () => { closeModalOverlay(modal); });

  const takeoverBtn = document.getElementById('concurrent-takeover');
  const readonlyBtn = document.getElementById('concurrent-readonly');

  const takeover = () => {
    closeModalOverlay(modal);
    setReadOnlyMode(false);
    startPresenceHeartbeat();
    showToast('Took over as operator');
  };

  const goReadOnly = () => {
    closeModalOverlay(modal);
    setReadOnlyMode(true);
    showToast('Read-only mode enabled');
  };

  if (takeoverBtn) takeoverBtn.onclick = takeover;
  if (readonlyBtn) readonlyBtn.onclick = goReadOnly;
}

function setReadOnlyMode(enabled) {
  _readOnlyMode = !!enabled;
  document.body.classList.toggle('readonly-mode', _readOnlyMode);
  const banner = document.getElementById('readonly-banner');
  if (banner) banner.style.display = _readOnlyMode ? 'flex' : 'none';

  const syncCheckbox = document.getElementById('chk-sync-enabled');
  if (syncCheckbox) syncCheckbox.disabled = _readOnlyMode;

  if (_readOnlyMode) {
    // Stop heartbeating — we are not the active controller.
    stopPresenceHeartbeat();
  }
  // Re-render so fn-toggles reflect the gating
  if (appState.currentPage === 'rooms') renderRooms();
}

// ────────────────────────────────────────────────────────────────────────
// Audit mirror + live tracker audit subscription
// ────────────────────────────────────────────────────────────────────────
let _trackerAuditRef = null;

async function pushAuditToTracker(room, action, result) {
  if (!appState.syncEnabled) return;
  const profile = getCurrentProfile();
  if (!profile.trackerEventId) return;
  if (!firebaseDb || !trackerAuth || !trackerAuth.currentUser) return;

  try {
    const ref = firebaseDb.ref(`${TRACKER_FB_ROOT}/events/${profile.trackerEventId}/audit`);
    const entry = {
      timestamp: Date.now(),
      source: 'commander',
      identity: identityOrPlaceholder(),
      action,
      room,
      result
    };
    await ref.push().set(entry);
  } catch (error) {
    console.error('Failed to mirror audit entry to tracker:', error);
    if (typeof pushErrorToTracker === 'function') {
      pushErrorToTracker({ message: 'pushAuditToTracker: ' + (error && error.message || error), stack: error && error.stack || '', context: 'pushAuditToTracker' });
    }
  }
}

function subscribeToTrackerAudit() {
  unsubscribeFromTrackerAudit();
  const profile = getCurrentProfile();
  if (!profile.trackerEventId) return;
  if (!firebaseDb || !trackerAuth || !trackerAuth.currentUser) return;

  _trackerAuditRef = firebaseDb
    .ref(`${TRACKER_FB_ROOT}/events/${profile.trackerEventId}/audit`)
    .limitToLast(500);

  _trackerAuditRef.on('value', (snap) => {
    const val = snap.val() || {};
    appState.trackerAuditLog = Object.keys(val).map(id => ({ id, ...val[id] }));
    if (appState.currentPage === 'log') renderAuditLog();
  }, (error) => {
    console.error('Tracker audit subscription error:', error);
  });
}

function unsubscribeFromTrackerAudit() {
  if (_trackerAuditRef) {
    try { _trackerAuditRef.off(); } catch (_) { /* ignore */ }
    _trackerAuditRef = null;
  }
  appState.trackerAuditLog = [];
}

// ────────────────────────────────────────────────────────────────────────
// Tracker errors subscription
// ────────────────────────────────────────────────────────────────────────
// Error telemetry is written to events/<eventId>/errors/<pushId> by the
// global handlers at the top of this file. The Log page surfaces these
// in a collapsible "Errors" section so the operator can spot crashes
// without opening the Firebase console.
let _trackerErrorsRef = null;

function subscribeToTrackerErrors() {
  unsubscribeFromTrackerErrors();
  const profile = getCurrentProfile();
  if (!profile.trackerEventId) return;
  if (!firebaseDb || !trackerAuth || !trackerAuth.currentUser) return;

  _trackerErrorsRef = firebaseDb
    .ref(`${TRACKER_FB_ROOT}/events/${profile.trackerEventId}/errors`)
    .limitToLast(100);

  _trackerErrorsRef.on('value', (snap) => {
    const val = snap.val() || {};
    appState.trackerErrors = Object.keys(val).map(id => ({ id, ...val[id] }));
    if (appState.currentPage === 'log') renderErrorsPanel();
  }, (error) => {
    console.error('Tracker errors subscription error:', error);
  });
}

function unsubscribeFromTrackerErrors() {
  if (_trackerErrorsRef) {
    try { _trackerErrorsRef.off(); } catch (_) { /* ignore */ }
    _trackerErrorsRef = null;
  }
  appState.trackerErrors = [];
}

function renderErrorsPanel() {
  const panel = document.getElementById('errors-panel');
  const container = document.getElementById('errors-container');
  const countEl = document.getElementById('errors-count');
  if (!panel || !container || !countEl) return;

  const errors = (appState.trackerErrors || []).slice().sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

  if (errors.length === 0) {
    panel.style.display = 'none';
    return;
  }

  panel.style.display = '';
  countEl.textContent = errors.length;

  container.innerHTML = '';
  errors.forEach(err => {
    const row = document.createElement('div');
    row.className = 'error-entry';

    const header = document.createElement('div');
    header.className = 'error-entry-header';
    const when = new Date(err.timestamp || 0).toLocaleString();
    const commanderIdShort = (err.commanderId || '').slice(0, 8);
    const identityName = err.identity && err.identity.name ? err.identity.name : 'unknown';
    const ctx = err.context ? `<span class="error-entry-context">${escapeForHtml(err.context)}</span>` : '';
    header.innerHTML = `<span>${escapeForHtml(when)}</span>${ctx ? ' · ' + ctx : ''} · <span>${escapeForHtml(identityName)}</span>` + (commanderIdShort ? ` · <span>${escapeForHtml(commanderIdShort)}</span>` : '');

    const msg = document.createElement('div');
    msg.className = 'error-entry-message';
    msg.textContent = err.message || '(no message)';

    row.appendChild(header);
    row.appendChild(msg);

    if (err.stack) {
      const stack = document.createElement('details');
      const summary = document.createElement('summary');
      summary.style.cssText = 'color: var(--t3); cursor: pointer; font-size: var(--fs-xs); margin-top: var(--sp-1);';
      summary.textContent = 'Stack trace';
      const pre = document.createElement('pre');
      pre.className = 'error-entry-stack';
      pre.textContent = err.stack;
      stack.appendChild(summary);
      stack.appendChild(pre);
      row.appendChild(stack);
    }

    container.appendChild(row);
  });
}

function escapeForHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ────────────────────────────────────────────────────────────────────────
// Tracker crew subscription
// ────────────────────────────────────────────────────────────────────────
// The Crew Tracker's Setup page maintains a crew list at
//   events/<eventId>/config/crew = [ { id, name, rooms: [{ id, name }] } ]
// Commander subscribes when sync is connected + an event is linked so the
// identity modal can surface a "Sign in as <crew member>" shortcut. Matching
// of a crew member's rooms to the Commander profile is by *name*
// (case-sensitive exact match) — the Director is expected to keep names
// aligned between the two apps.
let trackerCrewList = [];
let _trackerCrewRef = null;

function subscribeToTrackerCrew() {
  unsubscribeFromTrackerCrew();
  const profile = getCurrentProfile();
  if (!profile.trackerEventId) return;
  if (!firebaseDb || !trackerAuth || !trackerAuth.currentUser) return;

  _trackerCrewRef = firebaseDb.ref(`${TRACKER_FB_ROOT}/events/${profile.trackerEventId}/config/crew`);
  _trackerCrewRef.on('value', (snap) => {
    const val = snap.val();
    // Tracker stores crew as an array; tolerate object-shape writes too.
    if (Array.isArray(val)) {
      trackerCrewList = val.filter(Boolean);
    } else if (val && typeof val === 'object') {
      trackerCrewList = Object.values(val).filter(Boolean);
    } else {
      trackerCrewList = [];
    }
    // If the identity modal is open, re-render only its crew dropdown —
    // avoid blowing away a name the user is mid-typing.
    const modal = document.getElementById('identity-modal');
    if (modal && modal.classList.contains('is-open') && typeof renderTrackerCrewDropdown === 'function') {
      renderTrackerCrewDropdown();
    }
    // assignedRooms is now resolved live from this list, so a crew-config
    // change (renamed room, added member) should re-render dependent views.
    if (appState.currentPage === 'rooms') renderRooms();
    if (appState.currentPage === 'settings') updateIdentityDisplay();
  }, (error) => {
    console.error('Tracker crew subscription error:', error);
    if (typeof pushErrorToTracker === 'function') {
      pushErrorToTracker({ message: 'subscribeToTrackerCrew: ' + (error && error.message || error), stack: error && error.stack || '', context: 'subscribeToTrackerCrew' });
    }
  });
}

function unsubscribeFromTrackerCrew() {
  if (_trackerCrewRef) {
    try { _trackerCrewRef.off(); } catch (_) { /* ignore */ }
    _trackerCrewRef = null;
  }
  trackerCrewList = [];
}

// Look up a Commander profile room key by display name (case-sensitive exact
// match). Used when resolving a tracker crew member's room list into the
// internal room-key array stored on `identity.assignedRooms`.
function findRoomKeyByName(name) {
  if (!name) return null;
  const norm = String(name).trim().toLowerCase();
  if (!norm) return null;
  const profile = getCurrentProfile();
  const match = (profile.rooms || []).find(r => String(r.name || '').trim().toLowerCase() === norm);
  return match ? match.key : null;
}

// Live room resolution. When an identity is bound to a tracker crew member
// (identity.crewId is set), re-derive assignedRooms from the current crew
// roster on every read — so renaming a vMix room or fixing a typo in the
// crew config takes effect immediately, no re-pick required. For custom
// identities (no crewId), use the stored assignedRooms / assignedRoom.
function effectiveAssignedRooms(identity) {
  if (!identity) return [];
  if (identity.crewId && Array.isArray(trackerCrewList) && trackerCrewList.length) {
    const crew = trackerCrewList.find(c => c && c.id === identity.crewId);
    if (crew && Array.isArray(crew.rooms)) {
      const live = crew.rooms
        .map(r => r && r.name)
        .filter(Boolean)
        .map(findRoomKeyByName)
        .filter(Boolean);
      // Use live result if any matches; otherwise fall back to stored
      // assignedRooms (avoids snapping to "no rooms" mid-session if the
      // crew list temporarily disappears or the names momentarily mismatch).
      if (live.length) return live;
    }
  }
  if (Array.isArray(identity.assignedRooms) && identity.assignedRooms.length) {
    return identity.assignedRooms.slice();
  }
  if (identity.assignedRoom) return [identity.assignedRoom];
  return [];
}

// Manual re-trigger: re-resolves assignedRooms from the current crew roster
// and persists the result. Useful when a Director just fixed a room name
// in either app and wants to see the effect immediately on a saved identity.
async function rematchAssignedRooms() {
  const id = appState.identity;
  if (!id) { showToast('No identity set'); return; }
  if (!id.crewId) { showToast('Not bound to a crew member — pick one in Change Identity first'); return; }
  const crew = (trackerCrewList || []).find(c => c && c.id === id.crewId);
  if (!crew) { showToast('Crew member not found in tracker — sync to an event first'); return; }
  const crewRoomNames = (Array.isArray(crew.rooms) ? crew.rooms : [])
    .map(r => r && r.name).filter(Boolean);
  const matchedKeys = crewRoomNames.map(findRoomKeyByName).filter(Boolean);
  id.assignedRooms = matchedKeys;
  await saveIdentity(id);
  if (appState.currentPage === 'rooms') renderRooms();
  if (appState.currentPage === 'settings') renderSettings();
  showToast(`Re-matched: ${matchedKeys.length} of ${crewRoomNames.length} crew rooms`);
}

// ────────────────────────────────────────────────────────────────────────
// Run-of-show sync (debounced)
// ────────────────────────────────────────────────────────────────────────
let _runOfShowPushTimer = null;
function schedulePushRunOfShow() {
  if (!appState.syncEnabled) return;
  const profile = getCurrentProfile();
  if (!profile.trackerEventId) return;
  if (_runOfShowPushTimer) clearTimeout(_runOfShowPushTimer);
  _runOfShowPushTimer = setTimeout(() => {
    _runOfShowPushTimer = null;
    pushRunOfShowToTracker();
  }, 400);
}

async function pushRunOfShowToTracker() {
  if (!appState.syncEnabled) return;
  const profile = getCurrentProfile();
  if (!profile.trackerEventId) return;
  if (!firebaseDb || !trackerAuth || !trackerAuth.currentUser) return;

  try {
    const payload = Array.isArray(profile.runOfShow) ? profile.runOfShow : [];
    await firebaseDb
      .ref(`${TRACKER_FB_ROOT}/events/${profile.trackerEventId}/runOfShow`)
      .set(payload);
  } catch (error) {
    console.error('Failed to push run-of-show to tracker:', error);
    if (typeof pushErrorToTracker === 'function') {
      pushErrorToTracker({ message: 'pushRunOfShowToTracker: ' + (error && error.message || error), stack: error && error.stack || '', context: 'pushRunOfShowToTracker' });
    }
  }
}

// ────────────────────────────────────────────────────────────────────────
// Safety-lock sync
// ────────────────────────────────────────────────────────────────────────
// Shared global lock state lives at events/<id>/safetyLocked. Both apps
// write/read it. Echo-loop prevention is handled by setControlsLocked()'s
// no-op short-circuit when the value already matches local state.
let _trackerSafetyLockRef = null;

function subscribeToTrackerSafetyLock() {
  unsubscribeFromTrackerSafetyLock();
  const profile = getCurrentProfile();
  if (!profile.trackerEventId) return;
  if (!firebaseDb || !trackerAuth || !trackerAuth.currentUser) return;

  _trackerSafetyLockRef = firebaseDb.ref(`${TRACKER_FB_ROOT}/events/${profile.trackerEventId}/safetyLocked`);
  _trackerSafetyLockRef.on('value', (snap) => {
    const remote = snap.val();
    if (typeof remote !== 'boolean') return;  // initial empty state — ignore
    setControlsLocked(remote);  // no-op short-circuits if already matching
    if (appState.currentPage === 'rooms') renderRooms();
  }, (error) => {
    console.error('Tracker safetyLock subscription error:', error);
  });
}

function unsubscribeFromTrackerSafetyLock() {
  if (_trackerSafetyLockRef) {
    try { _trackerSafetyLockRef.off(); } catch (_) { /* ignore */ }
    _trackerSafetyLockRef = null;
  }
}

async function pushSafetyLockToTracker() {
  if (!appState.syncEnabled) return;
  const profile = getCurrentProfile();
  if (!profile.trackerEventId) return;
  if (!firebaseDb || !trackerAuth || !trackerAuth.currentUser) return;
  try {
    await firebaseDb
      .ref(`${TRACKER_FB_ROOT}/events/${profile.trackerEventId}/safetyLocked`)
      .set(!!controlsLocked);
  } catch (error) {
    console.error('Failed to push safetyLock to tracker:', error);
    if (typeof pushErrorToTracker === 'function') {
      pushErrorToTracker({ message: 'pushSafetyLockToTracker: ' + (error && error.message || error), stack: error && error.stack || '', context: 'pushSafetyLockToTracker' });
    }
  }
}

// ────────────────────────────────────────────────────────────────────────
// Room-lock sync
// ────────────────────────────────────────────────────────────────────────
async function pushRoomLocksToTracker() {
  if (!appState.syncEnabled) return;
  const profile = getCurrentProfile();
  if (!profile.trackerEventId) return;
  if (!firebaseDb || !trackerAuth || !trackerAuth.currentUser) return;

  try {
    await firebaseDb
      .ref(`${TRACKER_FB_ROOT}/events/${profile.trackerEventId}/roomLocks`)
      .set(profile.roomLocks || {});
  } catch (error) {
    console.error('Failed to push roomLocks to tracker:', error);
    if (typeof pushErrorToTracker === 'function') {
      pushErrorToTracker({ message: 'pushRoomLocksToTracker: ' + (error && error.message || error), stack: error && error.stack || '', context: 'pushRoomLocksToTracker' });
    }
  }
}

// ────────────────────────────────────────────────────────────────────────
// Error telemetry
// ────────────────────────────────────────────────────────────────────────
let _lastErrorPushAt = 0;
const _ERROR_MAX_LEN = 8000;

function pushErrorToTracker(payload) {
  try {
    if (!appState || !appState.syncEnabled) return;
    const profile = getCurrentProfile();
    if (!profile || !profile.trackerEventId) return;
    if (!firebaseDb || !trackerAuth || !trackerAuth.currentUser) return;

    // Rate-limit: max 1 error write per 500ms
    const now = Date.now();
    if (now - _lastErrorPushAt < 500) return;
    _lastErrorPushAt = now;

    const msg = String(payload && payload.message || '').slice(0, _ERROR_MAX_LEN);
    const stack = String(payload && payload.stack || '').slice(0, _ERROR_MAX_LEN);
    const context = String(payload && payload.context || '').slice(0, 500);

    const entry = {
      timestamp: now,
      source: 'commander',
      commanderId: COMMANDER_ID,
      identity: identityOrPlaceholder(),
      message: msg,
      stack,
      context
    };

    firebaseDb
      .ref(`${TRACKER_FB_ROOT}/events/${profile.trackerEventId}/errors`)
      .push()
      .set(entry)
      .catch((err) => { console.error('pushErrorToTracker write failed:', err); });
  } catch (err) {
    // Must never re-throw
    console.error('pushErrorToTracker threw:', err);
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
  schedulePushRunOfShow();
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
