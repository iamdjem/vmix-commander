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

const {
  buildReachableRoomScope,
  commanderScopesOverlap,
  mergeMissingRoomsByName,
  roomClaimKey,
  claimBelongsToEvent
} = window.CommanderRoutingHelpers;

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

function buildTrackerShareUrl(proxyUrl) {
  return `https://iamdjem.github.io/kubecon-tracker/?proxy=${encodeURIComponent(proxyUrl)}`;
}

function renderTunnelQr(url) {
  const container = document.getElementById('share-qr-container');
  const urlLabel  = document.getElementById('share-qr-url');
  if (!container) return;

  const trackerUrl = buildTrackerShareUrl(url);
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

  const dot   = document.getElementById('share-tunnel-indicator');
  const label = document.getElementById('share-tunnel-label');
  const urlEl = document.getElementById('share-tunnel-url');
  const qrBox = document.getElementById('share-qr-container');

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
  const dot   = document.getElementById('share-proxy-indicator');
  const label = document.getElementById('share-proxy-label');
  const urlEl = document.getElementById('share-proxy-url');
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

  const restartBtn = document.getElementById('btn-share-restart-tunnel');
  if (restartBtn) {
    restartBtn.addEventListener('click', () => {
      if (window.tunnel) {
        updateTunnelPage({ running: false, url: '', error: '' });
        window.tunnel.restart();
      }
    });
  }

  const copyBtn = document.getElementById('btn-share-copy-url');
  if (copyBtn) {
    copyBtn.addEventListener('click', async () => {
      if (!_currentTunnelUrl) {
        showToast('No tunnel yet');
        return;
      }
      try {
        await navigator.clipboard.writeText(buildTrackerShareUrl(_currentTunnelUrl));
        showToast('Tracker link copied');
      } catch (_) {
        showToast('Copy failed');
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

  // Always set up the app shell first so the sign-in gate has functioning
  // buttons + subscriptions once the user signs in.
  await loadProfiles();
  await loadAuditLog();
  updateIdentityBadge();
  setupNavigation();
  setupEventListeners();
  setupSignInGateListeners();
  applyRoleRestrictions();

  // Load always-on-top preference
  const alwaysOnTop = await window.windowControls.isAlwaysOnTop();
  document.getElementById('chk-always-on-top').checked = alwaysOnTop;

  // Gate the app behind sign-in. If we have a previously-stored role + an
  // identity, resume silently. Otherwise show the sign-in screen.
  const storedRole = getStoredRole();
  if (storedRole && appState.identity) {
    // Resume previous session — the existing sync-enabled flow will
    // reauthenticate via initTrackerFirebase on connect.
    applyRoleToBody(storedRole);
    currentRole = storedRole;
    switchPage('rooms');
    const profile = getCurrentProfile();
    if (profile.syncEnabled) {
      appState.syncEnabled = true;
      document.getElementById('chk-sync-enabled').checked = true;
      connectToFirebase();
    }
  } else {
    // First-time or signed-out — force the sign-in gate. We still call
    // switchPage to keep page elements initialized in the background.
    switchPage('rooms');
    showSignInGate();
  }

  updateHeaderIdentityChip();

  // Start auto-trigger checker for run-of-show
  startShowAutoTrigger();
}

// Wire up the sign-in gate buttons once at init. All handlers are on a
// single gate, so this runs before any sign-in attempt.
function setupSignInGateListeners() {
  // Role cards (step 1)
  document.querySelectorAll('.signin-role-card').forEach(btn => {
    btn.addEventListener('click', () => signInSelectRole(btn.dataset.role));
  });
  // Password step
  const pwNext = document.getElementById('signin-pw-next');
  const pwBack = document.getElementById('signin-pw-back');
  const pwInput = document.getElementById('signin-pw-input');
  if (pwNext) pwNext.addEventListener('click', () => signInVerifyPassword());
  if (pwBack) pwBack.addEventListener('click', () => signInShowStep('role'));
  if (pwInput) pwInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') signInVerifyPassword(); });
  // Admin identity step
  const admDone = document.getElementById('signin-admin-done');
  const admBack = document.getElementById('signin-admin-back');
  const admInput = document.getElementById('signin-admin-name');
  if (admDone) admDone.addEventListener('click', () => signInFinishAdmin());
  if (admBack) admBack.addEventListener('click', () => {
    if (signInLiveEvents().length > 1) { signInRenderEventList(); signInShowStep('event'); }
    else if (appState.identity) hideSignInGate();
    else signInShowStep('password');
  });
  if (admInput) admInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') signInFinishAdmin(); });
  // Crew identity step
  const crewDone = document.getElementById('signin-crew-done');
  const crewBack = document.getElementById('signin-crew-back');
  if (crewDone) crewDone.addEventListener('click', () => signInFinishCrew());
  if (crewBack) crewBack.addEventListener('click', () => {
    if (signInLiveEvents().length > 1) { signInRenderEventList(); signInShowStep('event'); }
    else if (appState.identity) hideSignInGate();
    else signInShowStep('password');
  });
  // Event picker step
  const evtBack = document.getElementById('signin-event-back');
  if (evtBack) evtBack.addEventListener('click', () => {
    if (appState.identity) hideSignInGate();
    else signInShowStep('password');
  });

  // Header identity chip — click toggles menu
  const chipBtn = document.getElementById('header-identity-btn');
  const chipMenu = document.getElementById('header-identity-menu');
  if (chipBtn && chipMenu) {
    chipBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const open = chipMenu.style.display === 'block';
      chipMenu.style.display = open ? 'none' : 'block';
      chipBtn.setAttribute('aria-expanded', open ? 'false' : 'true');
    });
    // Click outside closes the menu
    document.addEventListener('click', (e) => {
      if (!chipBtn.contains(e.target) && !chipMenu.contains(e.target)) {
        chipMenu.style.display = 'none';
        chipBtn.setAttribute('aria-expanded', 'false');
      }
    });
    chipMenu.querySelectorAll('.header-identity-menu-item').forEach(item => {
      item.addEventListener('click', () => {
        chipMenu.style.display = 'none';
        chipBtn.setAttribute('aria-expanded', 'false');
        const action = item.dataset.action;
        if (action === 'change-identity') signInReopenForChangeIdentity();
        else if (action === 'sign-out') fullSignOut();
      });
    });
  }
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

  // Admin: render a tab per live tracker event — mirrors the tracker UI
  // so an admin overseeing multiple venues can jump between them the same
  // way. Clicking a tab switches to (or lazily creates) the local profile
  // linked to that event.
  // Crew: only ever show the currently-linked event as a single, inert
  // tab. Crew work one event at a time, and exposing switches mid-show
  // invites accidental taps on the wrong room.
  if (typeof isAdmin === 'function' && isAdmin()) {
    const events = (typeof signInLiveEvents === 'function') ? signInLiveEvents() : [];
    if (events.length) {
      const currentEventId = (getCurrentProfile() || {}).trackerEventId || null;
      const eventIds = new Set(events.map(ev => ev.id));
      events.forEach(ev => {
        const tab = document.createElement('button');
        tab.className = 'conference-tab' + (ev.id === currentEventId ? ' active' : '');
        tab.textContent = ev.name || 'Untitled event';
        tab.setAttribute('role', 'tab');
        tab.setAttribute('aria-selected', ev.id === currentEventId ? 'true' : 'false');
        tab.onclick = () => {
          if (ev.id !== currentEventId) switchToTrackerEvent(ev.id);
        };
        list.appendChild(tab);
      });
      // Orphan profiles — local profiles not linked to any live tracker
      // event. Appended so admin doesn't lose access to offline/legacy
      // workspaces. Labeled with a · prefix to distinguish them visually
      // from tracker-backed tabs.
      Object.keys(appState.profiles).forEach(key => {
        const profile = appState.profiles[key];
        if (!profile || profile.archived) return;
        if (profile.trackerEventId && eventIds.has(profile.trackerEventId)) return;
        const tab = document.createElement('button');
        tab.className = 'conference-tab' + (key === appState.current ? ' active' : '');
        tab.textContent = '· ' + profile.name;
        tab.setAttribute('role', 'tab');
        tab.setAttribute('aria-selected', key === appState.current ? 'true' : 'false');
        tab.title = 'Local profile (not linked to a live tracker event)';
        tab.onclick = () => { if (key !== appState.current) switchProfile(key); };
        list.appendChild(tab);
      });
      return;
    }
    // Fallback: no tracker events visible yet (offline, not connected,
    // or initial snapshot pending) — render local profile tabs so admin
    // isn't stuck staring at an empty strip.
    renderLocalProfileTabs(list);
    return;
  }

  // Crew path — single inert tab naming the bound event/profile.
  const profile = getCurrentProfile();
  if (!profile) return;
  const tab = document.createElement('button');
  tab.className = 'conference-tab active';
  tab.textContent = profile.name;
  tab.setAttribute('role', 'tab');
  tab.setAttribute('aria-selected', 'true');
  tab.disabled = true;
  list.appendChild(tab);
}

function renderLocalProfileTabs(list) {
  // Archived profiles are hidden — they live in the Archived section on
  // the Events page and can be restored from there.
  Object.keys(appState.profiles).forEach(key => {
    const profile = appState.profiles[key];
    if (profile.archived) return;
    const tab = document.createElement('button');
    tab.className = 'conference-tab' + (key === appState.current ? ' active' : '');
    tab.textContent = profile.name;
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', key === appState.current ? 'true' : 'false');
    tab.onclick = () => {
      if (key !== appState.current) switchProfile(key);
    };
    list.appendChild(tab);
  });
}

// Find an existing non-archived profile linked to the given tracker event.
// Returns null when no match — callers typically create a fresh profile.
function findProfileKeyForEvent(eventId) {
  if (!eventId) return null;
  return Object.keys(appState.profiles).find(k => {
    const p = appState.profiles[k];
    return p && !p.archived && p.trackerEventId === eventId;
  }) || null;
}

// Admin tab-click handler. Jumps to the profile linked to the chosen
// tracker event, creating one on the fly when none exists yet. When sync
// is live, tears down the outgoing event's Firebase subs and rebuilds
// them against the new event so audit/crew/rooms/presence all re-scope.
async function switchToTrackerEvent(eventId) {
  if (!eventId) return;
  let targetKey = findProfileKeyForEvent(eventId);
  if (!targetKey) {
    targetKey = 'profile_' + Date.now();
    const ev = trackerEvents[eventId];
    appState.profiles[targetKey] = {
      name: (ev && ev.name && String(ev.name).trim()) || 'Untitled event',
      trackerEventId: eventId,
      rooms: []  // reconcileRoomsOnConnect will adopt the event's rooms
    };
  }

  if (targetKey === appState.current) {
    renderConferenceTabs();
    return;
  }

  const hadLiveSubs = appState.syncEnabled && !!firebaseDb && !!(trackerAuth && trackerAuth.currentUser);
  if (hadLiveSubs) {
    await cleanupRoomProxyClaimsForEvent((getCurrentProfile() || {}).trackerEventId);
    stopPresenceHeartbeat();
    unsubscribeFromTrackerAudit();
    unsubscribeFromTrackerErrors();
    unsubscribeFromTrackerCrew();
    unsubscribeFromTrackerSafetyLock();
    unsubscribeFromTrackerVmixRooms();
  }

  appState.current = targetKey;
  await saveProfiles();
  updateProfileBadge();

  if (hadLiveSubs) {
    const profile = getCurrentProfile();
    if (profile && profile.trackerEventId) {
      try {
        await reconcileRoomsOnConnect();
        await pushProxyUrlToTracker();
        await pushVmixStatusToTracker();
        await checkConcurrentOperator();
        if (!_readOnlyMode) startPresenceHeartbeat();
        subscribeToTrackerAudit();
        subscribeToTrackerErrors();
        subscribeToTrackerCrew();
        subscribeToTrackerSafetyLock();
        subscribeToTrackerVmixRooms();
        pushRunOfShowToTracker();
        pushRoomLocksToTracker();
        pushSafetyLockToTracker();
      } catch (err) {
        console.error('switchToTrackerEvent: resubscribe failed:', err);
        if (typeof pushErrorToTracker === 'function') {
          pushErrorToTracker({ message: 'switchToTrackerEvent: ' + (err && err.message || err), stack: err && err.stack || '', context: 'switchToTrackerEvent' });
        }
      }
    }
  }

  if (appState.currentPage === 'rooms') renderRooms();
  else if (appState.currentPage === 'events') renderProfiles();
  else if (appState.currentPage === 'show') renderShowTimeline();
  else if (appState.currentPage === 'log') renderAuditLog();
  else if (appState.currentPage === 'settings') renderSettings();

  const ev = trackerEvents[eventId];
  showToast('Switched to ' + ((ev && ev.name) || 'event'));
  if (typeof pushVmixStatusToTracker === 'function') pushVmixStatusToTracker();
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
  // Events + Tunnel tabs were folded into Settings. Any residual call to
  // switchPage('events') or switchPage('tunnel') — old localStorage, a
  // stale data-page, a bookmark — must redirect BEFORE we try to find the
  // (no-longer-existing) page element, or we throw and take down the whole
  // shell including the sign-in gate wiring.
  if (page === 'events' || page === 'tunnel') { page = 'settings'; }

  appState.currentPage = page;

  // Update page visibility
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  const pageEl = document.getElementById(`page-${page}`);
  if (!pageEl) {
    console.warn('switchPage: unknown page', page);
    return;
  }
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

  if (page === 'show') {
    renderShowTimeline();
  }

  if (page === 'share') {
    // Re-render with the latest status so opening the tab never shows stale
    // "starting…" placeholders if the tunnel came up before this tab was
    // ever visited.
    if (window.proxy) window.proxy.getStatus().then(updateProxyPage);
    if (window.tunnel) window.tunnel.getStatus().then(updateTunnelPage);
  }

  if (page === 'log') {
    renderAuditLog();
    renderErrorsPanel();
  }

  if (page === 'settings') {
    // Render the Events list (formerly its own tab) inside the Settings
    // Events section every time the page opens.
    renderProfiles();
    renderSettings();
    updateIdentityDisplay();
    updateAccountDisplay();
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
        rooms: []  // rooms come from the linked tracker event, not seeds
      };
      appState.current = key;
      saveProfiles();
      renderProfiles();
      updateProfileBadge();
      showToast('Profile created');
    });
  });

  // Add room button
  const btnAddRoom = document.getElementById('btn-add-room');
  if (btnAddRoom) btnAddRoom.addEventListener('click', () => {
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

  // Legacy export/import flows — folded out of the UI but kept as
  // hidden-button-safe no-ops below. They predated tracker sync; everything
  // is synced to Firebase now. Left here so existing code paths that might
  // reference the elements don't crash.
  const legacyExport = document.getElementById('btn-export-profiles');
  if (legacyExport) legacyExport.addEventListener('click', async (e) => {
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

  const legacyImport = document.getElementById('btn-import-profiles');
  if (legacyImport) legacyImport.addEventListener('click', async (e) => {
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

  // Change identity — reuse the sign-in gate's identity picker step, no
  // password re-entry. Mirrors the header chip's menu item.
  const btnChangeIdentity = document.getElementById('btn-settings-change-identity');
  if (btnChangeIdentity) btnChangeIdentity.addEventListener('click', () => signInReopenForChangeIdentity());

  // Sign out from the Settings row — same action as the chip menu.
  const btnSettingsSignout = document.getElementById('btn-settings-signout');
  if (btnSettingsSignout) btnSettingsSignout.addEventListener('click', () => fullSignOut());

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
      await disconnectFromFirebase();
      await saveProfiles();
    }
  });

  // Event select dropdown — link this conference profile to a tracker event
  document.getElementById('sync-event-select').addEventListener('change', async (e) => {
    const eventId = e.target.value;
    const profile = getCurrentProfile();
    const previousEventId = profile.trackerEventId || null;
    profile.trackerEventId = eventId || null;
    // Rename the profile tab to match the bound event so the top tab and
    // the Settings dropdown can't drift apart.
    syncProfileNameToLinkedEvent(profile);
    await saveProfiles();
    updateProfileBadge();
    if (appState.syncEnabled) {
      // Rebuild event-scoped subscriptions / presence / initial pushes.
      await cleanupRoomProxyClaimsForEvent(previousEventId);
      stopPresenceHeartbeat();
      unsubscribeFromTrackerAudit();
      unsubscribeFromTrackerErrors();
      unsubscribeFromTrackerCrew();
      unsubscribeFromTrackerSafetyLock();
      unsubscribeFromTrackerVmixRooms();
      if (eventId) {
        // Reconcile (don't overwrite) rooms so a template-duplicated event
        // keeps its rooms instead of being clobbered by Commander's local list.
        await reconcileRoomsOnConnect();
        await pushProxyUrlToTracker();
        await pushVmixStatusToTracker();
        await checkConcurrentOperator();
        if (!_readOnlyMode) startPresenceHeartbeat();
        subscribeToTrackerAudit();
        subscribeToTrackerErrors();
        subscribeToTrackerCrew();
        subscribeToTrackerSafetyLock();
        subscribeToTrackerVmixRooms();
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
        rooms: []  // rooms come from the linked tracker event, not seeds
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

  // If the active profile is archived (e.g. the linked tracker event was
  // archived and no other live profile existed to switch to), don't show
  // stale room cards — they're misleading. Surface an empty state with a
  // clear next step.
  if (profile && profile.archived) {
    const liveCount = Object.values(appState.profiles || {}).filter(p => !p.archived).length;
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.innerHTML = liveCount > 0
      ? `<strong>This profile is archived.</strong><br>Pick a live profile from the tabs above, or restore <em>${profile.name}</em> from the Events page.`
      : `<strong>All profiles are archived.</strong><br>Restore one from the Events page or create a new profile to get started.`;
    container.appendChild(empty);
    return;
  }

  let roomsToShow = profile.rooms;

  // Apply Operator filter: show only assigned room(s). Resolved live from
  // the tracker's crew roster when identity.crewId is set, so a rename
  // anywhere takes effect on the next render. Falls back to stored values
  // for custom identities.
  if (appState.identity && appState.identity.role === 'Operator') {
    const keys = effectiveAssignedRooms(appState.identity);
    if (keys.length) {
      roomsToShow = profile.rooms.filter(r => keys.includes(r.key));
    } else if (appState.identity.crewId) {
      // Crew-bound Operator whose assigned rooms don't (yet) exist in this
      // profile. Show an empty state like the tracker does — previously we
      // fell through to "all rooms" which leaked other people's rooms to
      // an unassigned operator.
      const crew = (trackerCrewList || []).find(c => c && c.id === appState.identity.crewId);
      const crewRoomNames = crew && Array.isArray(crew.rooms)
        ? crew.rooms.map(r => r && r.name).filter(Boolean)
        : [];
      const roomsHint = crewRoomNames.length
        ? `Your assigned rooms aren't configured in vMix: ${crewRoomNames.map(n => `'${n}'`).join(', ')}. Ask a Director to add them, or change identity.`
        : `You have no rooms assigned yet. Ask a Director to update the crew list, or change identity.`;
      container.innerHTML =
        '<div class="empty-state">' +
        '<strong>No rooms assigned</strong><br>' +
        roomsHint +
        '</div>';
      return;
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

  const liveKeys = profileKeys.filter(k => !appState.profiles[k].archived);
  const archivedKeys = profileKeys
    .filter(k => appState.profiles[k].archived)
    .sort((a, b) => (appState.profiles[b].archivedAt || 0) - (appState.profiles[a].archivedAt || 0));

  const buildRow = (key) => {
    const profile = appState.profiles[key];
    const item = document.createElement('div');
    item.className = 'profile-item' + (key === appState.current ? ' active' : '') + (profile.archived ? ' archived' : '');

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
    count.textContent = `${profile.rooms.length} room${profile.rooms.length === 1 ? '' : 's'}` +
      (profile.archived && profile.archivedAt ? ` · archived ${new Date(profile.archivedAt).toLocaleDateString()}` : '');

    info.appendChild(name);
    info.appendChild(count);

    const actions = document.createElement('div');
    actions.className = 'profile-actions';

    if (!profile.archived && key !== appState.current) {
      const switchBtn = document.createElement('button');
      switchBtn.className = 'btn btn-primary';
      switchBtn.textContent = 'Switch';
      switchBtn.onclick = () => switchProfile(key);
      actions.appendChild(switchBtn);
    }

    if (!profile.archived) {
      const copyBtn = document.createElement('button');
      copyBtn.className = 'btn btn-ghost';
      copyBtn.textContent = '📋';
      copyBtn.title = 'Copy profile';
      copyBtn.onclick = () => copyProfile(key);
      actions.appendChild(copyBtn);
    }

    const archiveBtn = document.createElement('button');
    archiveBtn.className = 'btn btn-ghost admin-only admin-only-inline-flex';
    archiveBtn.textContent = profile.archived ? 'Restore' : 'Archive';
    archiveBtn.title = profile.archived
      ? 'Restore — also unarchives the linked tracker event'
      : 'Archive — also archives the linked tracker event';
    archiveBtn.onclick = () => setProfileArchived(key, !profile.archived);
    actions.appendChild(archiveBtn);

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'btn btn-danger admin-only admin-only-inline-flex';
    deleteBtn.textContent = '✕';
    deleteBtn.title = 'Delete profile';
    deleteBtn.onclick = () => deleteProfile(key);
    actions.appendChild(deleteBtn);

    item.appendChild(info);
    item.appendChild(actions);
    return item;
  };

  if (liveKeys.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'No live profiles. Restore one from the archive below or create a new one.';
    list.appendChild(empty);
  } else {
    liveKeys.forEach(k => list.appendChild(buildRow(k)));
  }

  if (archivedKeys.length) {
    const details = document.createElement('details');
    details.className = 'archived-profiles';
    const summary = document.createElement('summary');
    summary.innerHTML = `<span>Archived</span> <span class="archived-profiles-count">${archivedKeys.length}</span>`;
    details.appendChild(summary);
    const archList = document.createElement('div');
    archList.className = 'archived-profiles-list';
    archivedKeys.forEach(k => archList.appendChild(buildRow(k)));
    details.appendChild(archList);
    list.appendChild(details);
  }
}

// Switch to a different profile
function switchProfile(key) {
  const previousEventId = (getCurrentProfile() || {}).trackerEventId || null;
  cleanupRoomProxyClaimsForEvent(previousEventId);
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

  // Legacy "Event Profile Configuration" section was removed — the profile
  // name now lives inline on each row of the Events section. Keep the
  // field assignment guarded so it's a no-op when the element is gone.
  const profileNameEl = document.getElementById('settings-profile-name');
  if (profileNameEl) profileNameEl.textContent = profile.name;
  document.getElementById('chk-sync-enabled').checked = !!profile.syncEnabled;
  renderEventSelect();

  const roomsList = document.getElementById('settings-rooms-list');
  roomsList.innerHTML = '';

  // Mirror the Recording page's visibility rule: an Operator (e3crew)
  // only sees + configures their own assigned rooms here; Director
  // (e3admin) and Observer see the full list. Index is resolved against
  // the real profile.rooms so delete/splice stays correct.
  let roomsForSettings = profile.rooms;
  if (appState.identity && appState.identity.role === 'Operator') {
    const _keys = (typeof effectiveAssignedRooms === 'function')
      ? effectiveAssignedRooms(appState.identity) : [];
    roomsForSettings = _keys.length
      ? profile.rooms.filter(r => _keys.includes(r.key))
      : [];
  }

  roomsForSettings.forEach((room) => {
    const index = profile.rooms.indexOf(room);
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
    ipInput.onchange = async () => {
      room.ip = ipInput.value.trim();
      await saveProfiles();
      // Surgical per-room IP write so we never clobber other rooms' IPs
      // that a mobile tracker user or another Commander just set. The
      // subscribeToTrackerVmixRooms echo guard handles the round-trip.
      if (appState.syncEnabled && typeof pushRoomIpToTrackerEvent === 'function') {
        try { await pushRoomIpToTrackerEvent(room.key, room.ip); } catch (_) { /* non-fatal — retries on next sync */ }
      }
    };

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'btn btn-danger btn-sm';
    deleteBtn.textContent = '✕';
    deleteBtn.title = 'Remove room';
    deleteBtn.onclick = () => {
      // No floor on room count — an empty profile is a valid state (Rooms
      // page already shows a "No rooms configured" empty state). Lets
      // operators bulk-clear rooms when recovering from a polluted event.
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
  // Keep the header chip + Settings account row in sync on every identity
  // change (including sign-out where identity === null).
  if (typeof updateHeaderIdentityChip === 'function') updateHeaderIdentityChip();
  if (typeof updateAccountDisplay === 'function') updateAccountDisplay();
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

function updateAccountDisplay() {
  const row = document.querySelector('.auth-row');
  const info = document.getElementById('settings-account-info');
  const signoutBtn = document.getElementById('btn-settings-signout');
  const changeBtn = document.getElementById('btn-settings-change-identity');
  if (!info) return;
  if (row) { row.classList.remove('role-admin', 'role-crew'); if (currentRole) row.classList.add(currentRole === 'admin' ? 'role-admin' : 'role-crew'); }
  if (currentRole === 'admin' || currentRole === 'user') {
    const roleLbl = currentRole === 'admin' ? 'ADMIN' : 'CREW';
    const name = appState.identity && appState.identity.name ? ' · ' + escapeHtmlForSignin(appState.identity.name) : '';
    info.innerHTML = 'Signed in as <span class="auth-row-role">' + roleLbl + '</span>' + name;
    if (signoutBtn) signoutBtn.style.display = '';
    if (changeBtn) changeBtn.style.display = '';
  } else {
    info.innerHTML = '<span style="color:var(--t3);">Not signed in</span>';
    if (signoutBtn) signoutBtn.style.display = 'none';
    if (changeBtn) changeBtn.style.display = 'none';
  }
}

function updateIdentityDisplay() {
  // Legacy identity section was removed from Settings — the header chip
  // + Account row now cover the display. Show the "Re-match rooms"
  // button (only when bound to a crew member) and bail early.
  const btnRematch = document.getElementById('btn-rematch-rooms');
  if (btnRematch) btnRematch.style.display = appState.identity && appState.identity.crewId ? '' : 'none';
  const display = document.getElementById('identity-display');
  if (!display || !appState.identity) return;

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

// Tracker Firebase config (shared with kubecon-tracker). databaseURL and
// event root come from tracker-config.js (loaded before app.js). Fall back
// to baked-in values if that script fails to load for any reason —
// Firebase init with databaseURL=undefined would take the whole app down.
const TRACKER_FB_CONFIG = {
  apiKey: 'AIzaSyAo1IeN6TnsKC48_ZJG6BWxke_T1l8Ke2g',
  authDomain: 'kubecon-tracker.firebaseapp.com',
  databaseURL: window.TRACKER_FB_DATABASE_URL || 'https://kubecon-tracker-default-rtdb.europe-west1.firebasedatabase.app',
  projectId: 'kubecon-tracker'
};
// TRACKER_FB_ROOT is declared by tracker-config.js (loaded first); classic
// <script> tags share the global lexical scope so it's already in scope here.
// Redeclaring with const threw SyntaxError and broke the renderer (0.6.23/24).
// Auth credentials shared with the Crew Tracker. Two accounts:
//   admin@ → can do everything (archive events, edit config)
//   user@  → standard crew, no admin-gated UI
// Mirrors the tracker's AUTH_* constants — keep these in sync.
const TRACKER_AUTH_ADMIN_EMAIL = 'admin@e3tracker.local';
const TRACKER_AUTH_USER_EMAIL  = 'user@e3tracker.local';
const TRACKER_AUTH_ADMIN_PASSWORD = 'e3admin';
const TRACKER_AUTH_USER_PASSWORD  = 'e3crew';
// Persisted role choice — restored on next launch so reconnect picks up
// where the operator left off without prompting again.
const TRACKER_ROLE_KEY = 'vmc:trackerRole';

let trackerAuth = null;
let trackerEvents = {};  // { eventId: eventObject } cached from tracker
let trackerEventsRef = null;
// 'admin' | 'user' | null. Mirrors the tracker's currentRole concept so
// admin-only UI gating works the same way across both apps.
let currentRole = null;
function isAdmin() { return currentRole === 'admin'; }
function getStoredRole() {
  try { return localStorage.getItem(TRACKER_ROLE_KEY); } catch (_) { return null; }
}
function setStoredRole(role) {
  try {
    if (role) localStorage.setItem(TRACKER_ROLE_KEY, role);
    else localStorage.removeItem(TRACKER_ROLE_KEY);
  } catch (_) { /* ignore */ }
}
function applyRoleToBody(role) {
  document.body.classList.toggle('role-admin', role === 'admin');
  document.body.classList.toggle('role-user',  role === 'user');
  // Tab strip composition depends on role (admin: per-event tabs, crew:
  // single inert tab), so refresh it whenever the role toggles.
  if (typeof renderConferenceTabs === 'function') renderConferenceTabs();
}

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

  // Sign in with the persisted role choice (defaults to 'user' for crew).
  // Admin gives access to destructive operations (archive, delete profile,
  // edit conference config) — gated client-side via .admin-only CSS class.
  if (!trackerAuth.currentUser) {
    const desired = getStoredRole() === 'admin' ? 'admin' : 'user';
    await signInTrackerAs(desired);
  } else {
    // Already signed in (re-init after page refresh): figure out role from
    // the auth user's email and propagate to body class.
    const email = trackerAuth.currentUser.email || '';
    currentRole = email === TRACKER_AUTH_ADMIN_EMAIL ? 'admin' : 'user';
    applyRoleToBody(currentRole);
  }
}

// Sign in to Firebase using the chosen role's credentials. Updates
// currentRole + persists the choice + propagates the body class for
// CSS-driven admin-only gating. Caller decides whether to also kick off
// subscriptions; this function just handles auth state.
async function signInTrackerAs(role) {
  if (!trackerAuth) return;
  const desired = role === 'admin' ? 'admin' : 'user';
  const email = desired === 'admin' ? TRACKER_AUTH_ADMIN_EMAIL : TRACKER_AUTH_USER_EMAIL;
  const pass  = desired === 'admin' ? TRACKER_AUTH_ADMIN_PASSWORD : TRACKER_AUTH_USER_PASSWORD;
  // If already signed in as someone else, sign out first so the next call
  // picks up the new credentials cleanly.
  if (trackerAuth.currentUser && trackerAuth.currentUser.email !== email) {
    try { await trackerAuth.signOut(); } catch (_) { /* ignore */ }
  }
  if (!trackerAuth.currentUser) {
    await trackerAuth.signInWithEmailAndPassword(email, pass);
  }
  currentRole = desired;
  setStoredRole(desired);
  applyRoleToBody(desired);
}

// ────────────────────────────────────────────────────────────────────────
// Sign-in gate — unified sign-in + identity flow. Replaces the separate
// "sign in as admin/crew" buttons + "change identity" modal with a single
// launch-time prompt that maps the auth role (ADMIN/CREW) to the right
// identity shape (Director name vs. crew roster pick) in one interaction.
// ────────────────────────────────────────────────────────────────────────
let _signinChosenRole = null;   // 'admin' | 'user'
let _signinChosenCrew = null;   // crew.id (or null for Observer/Director)

function showSignInGate() {
  const gate = document.getElementById('signin-gate');
  if (!gate) return;
  gate.style.display = 'flex';
  gate.setAttribute('aria-hidden', 'false');
  signInShowStep('role');
  // Clear inputs
  const pw = document.getElementById('signin-pw-input'); if (pw) pw.value = '';
  const err = document.getElementById('signin-pw-error'); if (err) err.style.display = 'none';
  const nm = document.getElementById('signin-admin-name'); if (nm) nm.value = appState.identity?.name || '';
  _signinChosenRole = null;
  _signinChosenCrew = null;
}

function hideSignInGate() {
  const gate = document.getElementById('signin-gate');
  if (!gate) return;
  gate.style.display = 'none';
  gate.setAttribute('aria-hidden', 'true');
}

function signInShowStep(stepName) {
  const steps = {
    role:          document.getElementById('signin-step-role'),
    password:      document.getElementById('signin-step-password'),
    event:         document.getElementById('signin-step-event'),
    adminIdentity: document.getElementById('signin-step-admin-identity'),
    crewIdentity:  document.getElementById('signin-step-crew-identity')
  };
  Object.entries(steps).forEach(([name, el]) => { if (el) el.style.display = name === stepName ? '' : 'none'; });
  // Focus the relevant input for the step
  setTimeout(() => {
    if (stepName === 'password') document.getElementById('signin-pw-input')?.focus();
    else if (stepName === 'adminIdentity') document.getElementById('signin-admin-name')?.focus();
  }, 30);
}

// Enumerate live (non-archived, non-template) events, newest-first. Mirrors
// the tracker-side helper so the event picker matches.
function signInLiveEvents() {
  return Object.values(trackerEvents || {})
    .filter(ev => ev && ev.id && !ev.archived && !isTemplateTrackerEvent(ev))
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

function signInRenderEventList() {
  const list = document.getElementById('signin-event-list');
  if (!list) return;
  list.innerHTML = '';
  const events = signInLiveEvents();
  if (!events.length) {
    const empty = document.createElement('div');
    empty.className = 'signin-step-hint';
    empty.style.padding = '8px 0';
    empty.textContent = 'No live events yet. Ask an admin to create one.';
    list.appendChild(empty);
    return;
  }
  const profile = getCurrentProfile();
  const currentLinkedId = profile && profile.trackerEventId;
  events.forEach(ev => {
    const opt = document.createElement('button');
    opt.type = 'button';
    opt.className = 'signin-crew-option' + (ev.id === currentLinkedId ? ' selected' : '');
    opt.dataset.eventId = ev.id;
    const sub = [ev.location, ev.dateLabel].filter(Boolean).join(' · ');
    opt.innerHTML =
      '<span class="signin-crew-option-name">' + escapeHtmlForSignin(ev.name || 'Untitled event') + '</span>' +
      (sub ? '<span class="signin-crew-option-rooms">' + escapeHtmlForSignin(sub) + '</span>' : '');
    opt.onclick = () => signInPickEvent(ev.id);
    list.appendChild(opt);
  });
}

// Link the current profile to the chosen event, refresh event-scoped
// subscriptions + reconcile rooms, then advance to the right identity step.
async function signInPickEvent(eventId) {
  if (!eventId) return;
  const profile = getCurrentProfile();
  if (!profile) return;
  if (profile.trackerEventId !== eventId) {
    profile.trackerEventId = eventId;
    syncProfileNameToLinkedEvent(profile);
    await saveProfiles();
    updateProfileBadge();
    if (typeof unsubscribeFromTrackerCrew === 'function') unsubscribeFromTrackerCrew();
    if (typeof unsubscribeFromTrackerVmixRooms === 'function') unsubscribeFromTrackerVmixRooms();
    if (typeof unsubscribeFromTrackerAudit === 'function') unsubscribeFromTrackerAudit();
    if (typeof unsubscribeFromTrackerErrors === 'function') unsubscribeFromTrackerErrors();
    if (typeof unsubscribeFromTrackerSafetyLock === 'function') unsubscribeFromTrackerSafetyLock();
    if (typeof reconcileRoomsOnConnect === 'function') {
      try { await reconcileRoomsOnConnect(); } catch (_) { /* non-fatal */ }
    }
    if (typeof subscribeToTrackerCrew === 'function') subscribeToTrackerCrew();
    if (typeof subscribeToTrackerVmixRooms === 'function') subscribeToTrackerVmixRooms();
    if (typeof subscribeToTrackerAudit === 'function') subscribeToTrackerAudit();
    if (typeof subscribeToTrackerErrors === 'function') subscribeToTrackerErrors();
    if (typeof subscribeToTrackerSafetyLock === 'function') subscribeToTrackerSafetyLock();
    if (typeof renderEventSelect === 'function') renderEventSelect();
  }
  // Wait briefly for the new event's crew list to arrive (crew path only).
  if (_signinChosenRole === 'user') {
    const waitStart = Date.now();
    while (!trackerCrewList.length && Date.now() - waitStart < 1500) {
      await new Promise(r => setTimeout(r, 100));
    }
  }
  if (_signinChosenRole === 'admin') {
    const nm = document.getElementById('signin-admin-name');
    if (nm && !nm.value) nm.value = appState.identity?.name || '';
    signInShowStep('adminIdentity');
  } else {
    renderSignInCrewList();
    signInShowStep('crewIdentity');
  }
}

function signInSelectRole(role) {
  _signinChosenRole = role === 'admin' ? 'admin' : 'user';
  const title = document.getElementById('signin-pw-title');
  if (title) title.textContent = _signinChosenRole === 'admin' ? 'Admin password' : 'Crew password';
  signInShowStep('password');
}

async function signInVerifyPassword() {
  const input = document.getElementById('signin-pw-input');
  const err = document.getElementById('signin-pw-error');
  const btn = document.getElementById('signin-pw-next');
  if (!input || !err) return;
  const pass = input.value;
  const expected = _signinChosenRole === 'admin' ? TRACKER_AUTH_ADMIN_PASSWORD : TRACKER_AUTH_USER_PASSWORD;
  if (pass !== expected) {
    err.textContent = 'Incorrect password.';
    err.style.display = '';
    return;
  }
  err.style.display = 'none';

  // Authenticate to Firebase and pull the active event's crew + rooms BEFORE
  // showing the picker. Previously the crew step ran with an empty crew
  // list because connect happened inside signInFinishCrew — so users only
  // ever saw the "observer" fallback. Enabling sync + connecting here also
  // auto-links the current profile to the first live event (matches the
  // tracker's default behavior).
  if (btn) { btn.disabled = true; btn.textContent = 'Connecting…'; }
  try {
    // Persist the role choice before connectToFirebase so initTrackerFirebase
    // signs in with the right credentials.
    setStoredRole(_signinChosenRole);
    appState.syncEnabled = true;
    const profile = getCurrentProfile();
    profile.syncEnabled = true;
    const chk = document.getElementById('chk-sync-enabled');
    if (chk) chk.checked = true;
    await saveProfiles();
    await connectToFirebase();

    // For crew sign-in, the roster subscription fires once the event link
    // is in place. Wait up to 1.5s for the first snapshot so the picker
    // isn't empty on slow networks.
    if (_signinChosenRole === 'user') {
      const waitStart = Date.now();
      while (!trackerCrewList.length && Date.now() - waitStart < 1500) {
        await new Promise(r => setTimeout(r, 100));
      }
    }
  } catch (error) {
    console.error('Sign-in connect failed:', error);
    err.textContent = 'Connection failed: ' + (error.message || String(error));
    err.style.display = '';
    if (btn) { btn.disabled = false; btn.textContent = 'Continue'; }
    return;
  }
  if (btn) { btn.disabled = false; btn.textContent = 'Continue'; }

  // Route through event picker when 2+ live events exist. connectToFirebase
  // auto-linked first-live; the picker lets the user correct that.
  if (signInLiveEvents().length > 1) {
    signInRenderEventList();
    signInShowStep('event');
    return;
  }
  if (_signinChosenRole === 'admin') {
    signInShowStep('adminIdentity');
  } else {
    renderSignInCrewList();
    signInShowStep('crewIdentity');
  }
}

function renderSignInCrewList() {
  const list = document.getElementById('signin-crew-list');
  const doneBtn = document.getElementById('signin-crew-done');
  const hint = document.getElementById('signin-crew-hint');
  if (!list) return;
  list.innerHTML = '';
  const crew = Array.isArray(trackerCrewList) ? trackerCrewList.filter(c => c && c.name) : [];
  if (!crew.length) {
    if (hint) hint.textContent = 'No crew list available yet (no event linked, or admin has not added crew members). You can continue as an Observer and pick a crew member later from the identity menu.';
  } else {
    if (hint) hint.textContent = 'Pick yourself from this event\u2019s crew list. Your rooms will be scoped automatically.';
  }
  crew.forEach(c => {
    const opt = document.createElement('button');
    opt.type = 'button';
    opt.className = 'signin-crew-option';
    opt.dataset.crewId = c.id;
    const roomsLabel = (c.rooms && c.rooms.length) ? c.rooms.map(r => r && r.name).filter(Boolean).join(', ') : '(no rooms assigned)';
    opt.innerHTML = '<span class="signin-crew-option-name">' + escapeHtmlForSignin(c.name) + '</span>' +
                    '<span class="signin-crew-option-rooms">' + escapeHtmlForSignin(roomsLabel) + '</span>';
    opt.onclick = () => signInPickCrew(c.id, opt);
    list.appendChild(opt);
  });
  // Observer fallback, always last
  const obs = document.createElement('button');
  obs.type = 'button';
  obs.className = 'signin-crew-option signin-crew-option-observer';
  obs.dataset.crewId = '__observer__';
  obs.innerHTML = '<span class="signin-crew-option-name">I\u2019m not listed \u2014 observer only</span>' +
                  '<span class="signin-crew-option-rooms">Read-only access. No start/stop controls.</span>';
  obs.onclick = () => signInPickCrew('__observer__', obs);
  list.appendChild(obs);
  if (doneBtn) doneBtn.disabled = true;
  _signinChosenCrew = null;
}

function signInPickCrew(crewId, el) {
  _signinChosenCrew = crewId;
  const list = document.getElementById('signin-crew-list');
  if (list) list.querySelectorAll('.signin-crew-option.selected').forEach(n => n.classList.remove('selected'));
  if (el) el.classList.add('selected');
  const doneBtn = document.getElementById('signin-crew-done');
  if (doneBtn) doneBtn.disabled = false;
}

async function signInFinishAdmin() {
  const nameInput = document.getElementById('signin-admin-name');
  const name = (nameInput?.value || '').trim();
  if (!name) { nameInput?.focus(); return; }
  await saveIdentity({ name, role: 'Director' });
  // Admin sees ALL rooms — adopt the full crew-room union from the tracker
  // (the source of truth). Without this, admin only ever saw whatever was
  // in config.vmixRooms, which drifts; crew sign-in already reconciles.
  if (typeof reconcileAllCrewRoomsIntoProfile === 'function') {
    try { await reconcileAllCrewRoomsIntoProfile(); } catch (_) { /* non-fatal */ }
  }
  hideSignInGate();
  updateHeaderIdentityChip();
  applyRoleRestrictions();
  if (appState.currentPage === 'rooms') renderRooms();
  if (appState.currentPage === 'settings') { renderSettings(); updateIdentityDisplay(); updateAccountDisplay(); }
}

// Ensure the given crew member's rooms exist in the current profile. Crew
// rooms come from the tracker's config.crew[].rooms (checklist per member);
// profile.rooms mirrors config.vmixRooms (the vMix-authoritative list).
// Those don't always line up — this helper upserts by case-insensitive name,
// creates missing rooms (empty IP), and returns the matching profile keys.
// Writes back to profile storage + pushes to tracker's config.vmixRooms when
// sync is enabled so everyone converges on the same room list.
async function reconcileCrewRoomsIntoProfile(crew) {
  if (!crew || !Array.isArray(crew.rooms)) return [];
  const profile = getCurrentProfile();
  if (!profile) return [];
  if (!Array.isArray(profile.rooms)) profile.rooms = [];
  const crewRooms = crew.rooms.filter(r => r && r.name && String(r.name).trim());
  const next = mergeMissingRoomsByName(profile.rooms, crewRooms, makeRoomKey);
  const profileMutated = JSON.stringify(profile.rooms) !== JSON.stringify(next);
  profile.rooms = next;
  if (profileMutated) {
    await saveProfiles();
    if (appState.syncEnabled && typeof upsertRoomsToTrackerEvent === 'function') {
      try {
        const roomsToEnsure = crewRooms.map((room) => {
          const wantedName = String(room.name).trim().toLowerCase();
          return profile.rooms.find((candidate) =>
            String(candidate.name || '').trim().toLowerCase() === wantedName
          );
        }).filter(Boolean);
        const remoteRooms = await upsertRoomsToTrackerEvent(roomsToEnsure);
        if (Array.isArray(remoteRooms) && remoteRooms.length) {
          profile.rooms = remoteRooms;
          await saveProfiles();
        }
      } catch (_) { /* non-fatal */ }
    }
  }
  return crewRooms
    .map((room) => findRoomKeyByName(room.name))
    .filter(Boolean);
}

// Re-reconcile the current Operator's rooms against the live crew roster.
// Called on crew-list snapshots so a resumed session (Operator signed in on
// a previous version, or crew config changed remotely) picks up room
// additions without requiring a re-pick from the gate.
async function reconcileCurrentOperatorRooms() {
  const id = appState.identity;
  if (!id || id.role !== 'Operator' || !id.crewId) return;
  if (!Array.isArray(trackerCrewList) || !trackerCrewList.length) return;
  const crew = trackerCrewList.find(c => c && c.id === id.crewId);
  if (!crew) return;
  const keys = await reconcileCrewRoomsIntoProfile(crew);
  const existing = Array.isArray(id.assignedRooms) ? id.assignedRooms : [];
  const changed = keys.length !== existing.length || keys.some(k => !existing.includes(k));
  if (changed) {
    id.assignedRooms = keys;
    await saveIdentity(id);
  }
  if (appState.currentPage === 'rooms') renderRooms();
}

// Admin/Director equivalent of reconcileCrewRoomsIntoProfile: rebuild
// profile.rooms to exactly the union of ALL crew members' rooms (the
// tracker Setup page's config.crew[].rooms — the real source of truth
// for NAMES). Prunes rooms not assigned to any crew member so admin
// sees the same set crew collectively sees.
//
// Identity (key) and IP are resolved from the SHARED remote
// config.vmixRooms first, then the local profile, then generated. This
// is what makes every admin converge: names come from the same crew
// list, keys+IPs come from the same shared list, so two admins reconcile
// to byte-identical room arrays instead of each minting private keys
// (which would thrash via the vmixRooms subscription) or one admin's
// blank IPs clobbering another's. Returns the resulting room keys.
async function reconcileAllCrewRoomsIntoProfile() {
  const profile = getCurrentProfile();
  if (!profile) return [];
  if (!Array.isArray(trackerCrewList) || !trackerCrewList.length) return [];
  if (!Array.isArray(profile.rooms)) profile.rooms = [];

  const seen = new Set();
  const orderedNames = [];
  trackerCrewList.forEach(c => {
    (c && Array.isArray(c.rooms) ? c.rooms : []).forEach(r => {
      const n = (r && r.name) ? String(r.name).trim() : '';
      if (!n || seen.has(n.toLowerCase())) return;
      seen.add(n.toLowerCase());
      orderedNames.push(n);
    });
  });
  if (!orderedNames.length) return [];  // no crew rooms yet — don't wipe local

  // Shared identity source: the latest remote vmixRooms. Read once so all
  // admins resolve the same {key, ip} for a given room name.
  const byNameRemote = {};
  try {
    if (profile.trackerEventId && firebaseDb && trackerAuth && trackerAuth.currentUser) {
      const snap = await firebaseDb
        .ref(`${TRACKER_FB_ROOT}/events/${profile.trackerEventId}/config/vmixRooms`)
        .once('value');
      const remote = snap.val();
      if (Array.isArray(remote)) {
        remote.forEach(r => {
          if (r && r.name) byNameRemote[String(r.name).trim().toLowerCase()] = r;
        });
      }
    }
  } catch (_) { /* offline / denied — fall back to local-only resolution */ }

  const byNameLocal = {};
  profile.rooms.forEach(r => {
    if (r && r.name) byNameLocal[String(r.name).trim().toLowerCase()] = r;
  });

  const next = orderedNames.map(n => {
    const k = n.toLowerCase();
    const rem = byNameRemote[k];
    const loc = byNameLocal[k];
    // key: prefer the shared remote key so all admins agree on identity.
    const key = (rem && rem.key) || (loc && loc.key)
      || ('room_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6));
    // ip: prefer whichever is actually set (remote wins ties) so we never
    // blank out an IP another admin configured, nor lose a local-only one.
    const ip = (rem && rem.ip) || (loc && loc.ip) || '';
    return { key, name: n, ip };
  });

  const before = JSON.stringify(profile.rooms.map(r => ({ key: r.key, name: r.name, ip: r.ip || '' })));
  const after = JSON.stringify(next);
  if (before === after) return next.map(r => r.key);  // no change — skip churn

  profile.rooms = next;
  await saveProfiles();
  if (appState.syncEnabled && typeof pushRoomsToTrackerEvent === 'function') {
    try { await pushRoomsToTrackerEvent(); } catch (_) { /* non-fatal — retries on next sync */ }
  }
  if (appState.currentPage === 'rooms') renderRooms();
  if (appState.currentPage === 'settings') renderSettings();
  return next.map(r => r.key);
}

async function signInFinishCrew() {
  if (!_signinChosenCrew) return;
  let identity;
  if (_signinChosenCrew === '__observer__') {
    identity = { name: 'Observer', role: 'Observer' };
  } else {
    const crew = (trackerCrewList || []).find(c => c && c.id === _signinChosenCrew);
    if (crew) {
      const keys = await reconcileCrewRoomsIntoProfile(crew);
      identity = { name: crew.name, role: 'Operator', crewId: crew.id, assignedRooms: keys };
    } else {
      identity = { name: 'Observer', role: 'Observer' };
    }
  }
  await saveIdentity(identity);
  hideSignInGate();
  updateHeaderIdentityChip();
  applyRoleRestrictions();
  if (appState.currentPage === 'rooms') renderRooms();
  if (appState.currentPage === 'settings') { renderSettings(); updateIdentityDisplay(); updateAccountDisplay(); }
}

function signInReopenForChangeIdentity() {
  // Reopen the sign-in gate but skip straight past auth. If multiple live
  // events exist, present the event picker first so "Change identity" can
  // also scope to a different event in one gesture.
  if (!currentRole) { showSignInGate(); return; }
  const gate = document.getElementById('signin-gate');
  if (!gate) return;
  _signinChosenRole = currentRole;
  gate.style.display = 'flex';
  gate.setAttribute('aria-hidden', 'false');
  if (signInLiveEvents().length > 1) {
    signInRenderEventList();
    signInShowStep('event');
    return;
  }
  if (currentRole === 'admin') {
    const nm = document.getElementById('signin-admin-name');
    if (nm) nm.value = appState.identity?.name || '';
    signInShowStep('adminIdentity');
  } else {
    renderSignInCrewList();
    // If the current identity maps to a crew member, preselect it
    if (appState.identity?.crewId) {
      const match = document.querySelector('.signin-crew-option[data-crew-id="' + appState.identity.crewId + '"]');
      if (match) signInPickCrew(appState.identity.crewId, match);
    }
    signInShowStep('crewIdentity');
  }
}

async function fullSignOut() {
  try {
    if (trackerAuth && trackerAuth.currentUser) await trackerAuth.signOut();
  } catch (_) { /* ignore */ }
  currentRole = null;
  setStoredRole(null);
  applyRoleToBody(null);
  await saveIdentity(null);
  appState.identity = null;
  if (appState.syncEnabled) {
    appState.syncEnabled = false;
    const profile = getCurrentProfile();
    if (profile) profile.syncEnabled = false;
    const chk = document.getElementById('chk-sync-enabled');
    if (chk) chk.checked = false;
    await saveProfiles();
    await disconnectFromFirebase();
  }
  updateHeaderIdentityChip();
  showSignInGate();
}

function updateHeaderIdentityChip() {
  const host = document.getElementById('header-identity');
  const roleEl = document.getElementById('header-identity-role');
  const subEl = document.getElementById('header-identity-sub');
  if (!host || !roleEl || !subEl) return;
  if (!currentRole) { host.style.display = 'none'; return; }
  host.style.display = '';
  host.classList.remove('role-admin', 'role-crew', 'role-offline');
  if (currentRole === 'admin') { roleEl.textContent = 'ADMIN'; host.classList.add('role-admin'); }
  else if (currentRole === 'user') { roleEl.textContent = 'CREW'; host.classList.add('role-crew'); }
  else { roleEl.textContent = 'OFFLINE'; host.classList.add('role-offline'); }
  subEl.textContent = appState.identity?.name || '';
}

function escapeHtmlForSignin(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function(c) { return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; });
}

// Switch role mid-session. Tears down event subscriptions, signs out,
// signs back in with the chosen role, then re-establishes everything.
async function switchTrackerRole(role) {
  const desired = role === 'admin' ? 'admin' : 'user';
  if (currentRole === desired) return;
  if (!appState.syncEnabled) {
    // Sync disabled — just persist the choice; it'll be applied on reconnect.
    setStoredRole(desired);
    showToast(`Will sign in as ${desired === 'admin' ? 'Admin' : 'Crew'} on next connect`);
    return;
  }
  try {
    // Tear down subscriptions so they don't fire mid-reauth.
    await disconnectFromFirebase();
    setStoredRole(desired);
    await connectToFirebase();
    showToast(desired === 'admin' ? 'Signed in as Admin' : 'Signed in as Crew');
  } catch (error) {
    console.error('Failed to switch role:', error);
    showToast('Sign-in failed: ' + (error.message || error));
  }
}

async function connectToFirebase() {
  const syncCheckbox = document.getElementById('chk-sync-enabled');
  if (syncCheckbox) syncCheckbox.disabled = true;

  updateSyncStatus('🟡 Connecting…', false);

  try {
    await initTrackerFirebase();

    // Listen to the tracker's events collection. Await the first snapshot so
    // downstream auto-link + reconcile have real data, not the empty {} seed.
    if (!trackerEventsRef) {
      trackerEventsRef = firebaseDb.ref(`${TRACKER_FB_ROOT}/events`);
      await new Promise((resolve, reject) => {
        let settled = false;
        trackerEventsRef.on('value', (snap) => {
          trackerEvents = snap.val() || {};
          renderEventSelect();
          // Admin tab strip is driven by live tracker events — refresh it
          // whenever the event set or an event's name changes so tabs
          // appear/disappear/rename in lockstep with Firebase.
          renderConferenceTabs();
          // Mirror remote archive state into any locally-linked profiles so
          // the Events page + tab strip reflect tracker changes immediately.
          mirrorTrackerArchiveStateToProfiles();
          // On subsequent snapshots (event created/deleted elsewhere), keep
          // the current profile pointed at a live event.
          if (settled) autoLinkFirstLiveEventIfNeeded();
          // Repopulate the sign-in event picker if it's the visible step.
          const gate = document.getElementById('signin-gate');
          const evStep = document.getElementById('signin-step-event');
          if (gate && gate.style.display !== 'none' && evStep && evStep.style.display !== 'none') {
            signInRenderEventList();
          }
          updateSyncStatus('🟢 Connected', true);
          if (!settled) { settled = true; resolve(); }
        }, (error) => {
          if (!settled) { settled = true; reject(error); }
        });
      });
    }

    // Auto-link the current profile to the first live tracker event when
    // it has no link yet (or the linked event was archived/deleted). Mirrors
    // the tracker's "first live event" auto-pick so a fresh Commander
    // install inherits rooms + crew from the event without manual linking.
    await autoLinkFirstLiveEventIfNeeded();

    // Reconcile rooms on connect — adopt the event's rooms when present
    // (template duplicate etc.), only push up when the event has none yet.
    // Previously unconditional push clobbered template-inherited rooms.
    await reconcileRoomsOnConnect();
    await pushProxyUrlToTracker();
    await pushVmixStatusToTracker();

    // Presence + concurrent-operator + audit mirror + run-of-show + room locks
    await checkConcurrentOperator();
    if (!_readOnlyMode) startPresenceHeartbeat();
    subscribeToTrackerAudit();
    subscribeToTrackerErrors();
    subscribeToTrackerCrew();
    subscribeToTrackerSafetyLock();
    subscribeToTrackerVmixRooms();
    pushRunOfShowToTracker();
    pushRoomLocksToTracker();
    pushSafetyLockToTracker();

    if (syncCheckbox) syncCheckbox.disabled = _readOnlyMode;
    if (typeof updateAccountDisplay === 'function') updateAccountDisplay();
  } catch (error) {
    console.error('Firebase connection error:', error);
    updateSyncStatus('🔴 ' + (error.message || 'Connection failed'), false);
    if (syncCheckbox) syncCheckbox.disabled = false;
    if (typeof pushErrorToTracker === 'function') {
      pushErrorToTracker({ message: 'connectToFirebase: ' + (error && error.message || error), stack: error && error.stack || '', context: 'connectToFirebase' });
    }
  }
}

async function disconnectFromFirebase() {
  if (trackerEventsRef) {
    trackerEventsRef.off();
    trackerEventsRef = null;
  }
  stopPresenceHeartbeat();
  await cleanupAllRoomProxyClaims();
  unsubscribeFromTrackerAudit();
  unsubscribeFromTrackerErrors();
  unsubscribeFromTrackerCrew();
  unsubscribeFromTrackerSafetyLock();
  unsubscribeFromTrackerVmixRooms();
  setReadOnlyMode(false);
  // Sign out so the next connect re-evaluates the persisted role choice
  // cleanly. Keeps role-switch flows from getting stuck on stale auth.
  if (trackerAuth && trackerAuth.currentUser) {
    try { trackerAuth.signOut(); } catch (_) { /* ignore */ }
  }
  currentRole = null;
  applyRoleToBody(null);
  if (typeof updateAccountDisplay === 'function') updateAccountDisplay();
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

// Template events (e.g. "E3 Tracker Template") are stencils on the
// tracker — hide them from the link dropdown and from any auto-mirror
// flows. Match the tracker's isTemplateEvent() definition exactly.
const TRACKER_TEMPLATE_EVENT_NAME = 'E3 Tracker Template';
function isTemplateTrackerEvent(ev) {
  if (!ev) return false;
  if (ev.template === true) return true;
  return String(ev.name || '').trim().toLowerCase() === TRACKER_TEMPLATE_EVENT_NAME.toLowerCase();
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

  // Sort: live first (non-archived), newest updatedAt first.
  // Template events are excluded entirely — they're stencils, not bookable.
  const events = Object.values(trackerEvents)
    .filter(ev => !isTemplateTrackerEvent(ev))
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

function makeRoomKey() {
  return 'room_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
}

// Additive room merge used by Operator reconciliation. This deliberately
// avoids whole-array replacement so one crew member signing in cannot erase
// another Commander's rooms/IPs from the shared event config.
async function upsertRoomsToTrackerEvent(roomsToEnsure) {
  const profile = getCurrentProfile();
  if (!profile.trackerEventId || !firebaseDb || !trackerAuth || !trackerAuth.currentUser) return null;
  const clean = (roomsToEnsure || [])
    .filter((room) => room && room.key && room.name)
    .map((room) => ({ key: room.key, name: String(room.name).trim(), ip: room.ip || '' }));
  if (!clean.length) return null;

  try {
    const ref = firebaseDb.ref(`${TRACKER_FB_ROOT}/events/${profile.trackerEventId}/config/vmixRooms`);
    const tx = await ref.transaction((current) => {
      const base = Array.isArray(current)
        ? current.map((room) => ({ key: room && room.key || '', name: room && room.name || '', ip: room && room.ip || '' }))
        : [];
      clean.forEach((room) => {
        const wanted = room.name.trim().toLowerCase();
        const exists = base.some((candidate) => String(candidate.name || '').trim().toLowerCase() === wanted);
        if (!exists) base.push(room);
      });
      return base;
    });
    await firebaseDb.ref(`${TRACKER_FB_ROOT}/events/${profile.trackerEventId}/updatedAt`).set(Date.now());
    const remote = tx && tx.snapshot ? tx.snapshot.val() : null;
    return Array.isArray(remote)
      ? remote.map((room) => ({ key: room && room.key || '', name: room && room.name || '', ip: room && room.ip || '' })).filter((room) => room.key)
      : null;
  } catch (error) {
    console.error('Failed to upsert rooms to tracker event:', error);
    if (typeof pushErrorToTracker === 'function') {
      pushErrorToTracker({ message: 'upsertRoomsToTrackerEvent: ' + (error && error.message || error), stack: error && error.stack || '', context: 'upsertRoomsToTrackerEvent' });
    }
    return null;
  }
}

// Surgical single-room IP write. Unlike pushRoomsToTrackerEvent (which
// does a whole-array .set()), this touches ONLY this room's ip, located
// by key in the REMOTE array — so editing one room's IP can never
// clobber other rooms' IPs that a mobile tracker user or another
// Commander just set, and any row-order drift between devices is
// irrelevant. Falls back to a full push only when the room isn't in the
// remote list yet (nothing to clobber in that case).
async function pushRoomIpToTrackerEvent(key, ip) {
  const profile = getCurrentProfile();
  if (!profile.trackerEventId || !firebaseDb || !trackerAuth || !trackerAuth.currentUser) return;
  try {
    const base = `${TRACKER_FB_ROOT}/events/${profile.trackerEventId}`;
    const snap = await firebaseDb.ref(`${base}/config/vmixRooms`).once('value');
    const remote = snap.val();
    if (Array.isArray(remote)) {
      const idx = remote.findIndex(r => r && r.key === key);
      if (idx >= 0) {
        await firebaseDb.ref(`${base}/config/vmixRooms/${idx}/ip`).set(ip || '');
        await firebaseDb.ref(`${base}/updatedAt`).set(Date.now());
        return;
      }
    }
    await pushRoomsToTrackerEvent();  // room not in remote list yet — rare
  } catch (error) {
    console.error('Failed to push room IP to tracker event:', error);
    if (typeof pushErrorToTracker === 'function') {
      pushErrorToTracker({ message: 'pushRoomIpToTrackerEvent: ' + (error && error.message || error), stack: error && error.stack || '', context: 'pushRoomIpToTrackerEvent' });
    }
  }
}

async function pushToFirebase() {
  if (!appState.syncEnabled) return;
  await pushRoomsToTrackerEvent();
}

// Auto-link the current profile to the first live tracker event when it
// has no link (fresh install) or the previously-linked event is gone
// (archived/deleted). Matches the tracker's "first live event" auto-pick
// so operators don't have to manually link via Settings → Events before
// seeing crew + rooms.
// Keep profile.name aligned with the linked tracker event's name. Returns
// true when the local profile was mutated, so callers can avoid redundant
// saves. Called whenever the linked trackerEventId changes OR the remote
// event's name changes — matches the user's mental model that "the tab
// names the event it's bound to".
function syncProfileNameToLinkedEvent(profile) {
  if (!profile || !profile.trackerEventId) return false;
  const ev = trackerEvents[profile.trackerEventId];
  if (!ev) return false;
  const desired = (ev.name && String(ev.name).trim()) || 'Untitled event';
  if (profile.name === desired) return false;
  profile.name = desired;
  return true;
}

async function autoLinkFirstLiveEventIfNeeded() {
  const profile = getCurrentProfile();
  if (!profile) return;
  // Keep an existing link if it still points at a live, non-template event.
  if (profile.trackerEventId) {
    const existing = trackerEvents[profile.trackerEventId];
    if (existing && !existing.archived && !isTemplateTrackerEvent(existing)) {
      console.log('[auto-link] keeping existing link to event', profile.trackerEventId, existing.name);
      return;
    }
  }
  const liveEvent = Object.values(trackerEvents)
    .filter(ev => ev && !ev.archived && !isTemplateTrackerEvent(ev))
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0];
  const nextId = liveEvent && liveEvent.id ? liveEvent.id : null;
  if (profile.trackerEventId === nextId) return;
  console.log('[auto-link] switching profile link:', profile.trackerEventId, '→', nextId, liveEvent && liveEvent.name);
  profile.trackerEventId = nextId;
  // Auto-link switches the bound event — the profile's display name has to
  // follow, otherwise the conference tab shows the old event's name while
  // the Settings dropdown shows the new one (visible mismatch).
  syncProfileNameToLinkedEvent(profile);
  await saveProfiles();
  renderEventSelect();
  updateProfileBadge();
}

// Reconcile vmixRooms between this Commander and the linked tracker event
// on first connect. Previously pushRoomsToTrackerEvent() unconditionally
// overwrote the event's rooms with Commander's local list — which wiped
// out rooms inherited from template duplicates. Now the event's remote
// rooms win when they exist; Commander only pushes up when the event has
// no rooms yet (fresh event, no template). Called once per connect; the
// live subscription handles ongoing updates.
async function reconcileRoomsOnConnect() {
  const profile = getCurrentProfile();
  if (!profile.trackerEventId) return;
  if (!firebaseDb || !trackerAuth || !trackerAuth.currentUser) return;
  try {
    const snap = await firebaseDb
      .ref(`${TRACKER_FB_ROOT}/events/${profile.trackerEventId}/config/vmixRooms`)
      .once('value');
    const remote = snap.val();
    if (Array.isArray(remote) && remote.length) {
      // Remote already has rooms (e.g. inherited from a template duplicate,
      // or set by another Commander). Adopt them locally — don't clobber.
      const shape = remote
        .map(r => ({ key: (r && r.key) || '', name: (r && r.name) || '', ip: (r && r.ip) || '' }))
        .filter(r => r.key);
      profile.rooms = shape;
      window.profiles.save({ current: appState.current, profiles: appState.profiles });
      if (appState.currentPage === 'rooms') renderRooms();
      if (appState.currentPage === 'settings') renderSettings();
      return;
    }
    // Remote has nothing — push Commander's local rooms up so the tracker
    // has something to show on its Recording page.
    await pushRoomsToTrackerEvent();
  } catch (error) {
    console.error('reconcileRoomsOnConnect failed:', error);
    if (typeof pushErrorToTracker === 'function') {
      pushErrorToTracker({ message: 'reconcileRoomsOnConnect: ' + (error && error.message || error), stack: error && error.stack || '', context: 'reconcileRoomsOnConnect' });
    }
  }
}

// ────────────────────────────────────────────────────────────────────────
// Subscribe to remote vmixRooms — keeps profile.rooms aligned with the
// Firebase source of truth so changes from another Commander instance
// (or eventually the tracker) flow into this Commander automatically.
// Echo prevention: we only update local state when the remote shape
// differs from what we already have, so our own pushRoomsToTrackerEvent
// writes round-trip without causing a re-write.
// ────────────────────────────────────────────────────────────────────────
let _trackerVmixRoomsRef = null;

function subscribeToTrackerVmixRooms() {
  unsubscribeFromTrackerVmixRooms();
  const profile = getCurrentProfile();
  if (!profile.trackerEventId) return;
  if (!firebaseDb || !trackerAuth || !trackerAuth.currentUser) return;

  _trackerVmixRoomsRef = firebaseDb.ref(`${TRACKER_FB_ROOT}/events/${profile.trackerEventId}/config/vmixRooms`);
  _trackerVmixRoomsRef.on('value', (snap) => {
    const remote = snap.val();
    if (!Array.isArray(remote)) return;  // node missing or non-array — ignore

    const localShape = (profile.rooms || []).map(r => ({ key: r.key || '', name: r.name || '', ip: r.ip || '' }));
    const remoteShape = remote.map(r => ({ key: (r && r.key) || '', name: (r && r.name) || '', ip: (r && r.ip) || '' }));
    // Compare ordered shapes; if identical, the snapshot is just our own
    // write echoing back — no work to do.
    if (JSON.stringify(localShape) === JSON.stringify(remoteShape)) return;

    profile.rooms = remoteShape.filter(r => r.key);  // drop entries without a key — would corrupt vmixStatus
    // Persist locally; do NOT re-push (would create an echo loop).
    window.profiles.save({ current: appState.current, profiles: appState.profiles });
    if (appState.currentPage === 'rooms') renderRooms();
    if (appState.currentPage === 'settings') renderSettings();
  }, (error) => {
    console.error('Tracker vmixRooms subscription error:', error);
    if (typeof pushErrorToTracker === 'function') {
      pushErrorToTracker({ message: 'subscribeToTrackerVmixRooms: ' + (error && error.message || error), stack: error && error.stack || '', context: 'subscribeToTrackerVmixRooms' });
    }
  });
}

function unsubscribeFromTrackerVmixRooms() {
  if (_trackerVmixRoomsRef) {
    try { _trackerVmixRoomsRef.off(); } catch (_) { /* ignore */ }
    _trackerVmixRoomsRef = null;
  }
}

// ────────────────────────────────────────────────────────────────────────
// Profile <-> tracker event archive sync (bidirectional)
// ────────────────────────────────────────────────────────────────────────

// Mirror remote `archived` state into any local profile linked to that event.
// Called whenever the trackerEventsRef snapshot fires. Re-renders dependent
// views and switches off an archived current profile if needed.
function mirrorTrackerArchiveStateToProfiles() {
  let changed = false;
  let currentBecameArchived = false;
  Object.entries(appState.profiles || {}).forEach(([key, profile]) => {
    if (!profile || !profile.trackerEventId) return;
    const ev = trackerEvents[profile.trackerEventId];
    if (!ev) return;
    if (isTemplateTrackerEvent(ev)) return;  // ignore template stencils
    const remoteArchived = !!ev.archived;
    if (!!profile.archived !== remoteArchived) {
      profile.archived = remoteArchived;
      profile.archivedAt = remoteArchived ? (ev.archivedAt || Date.now()) : null;
      changed = true;
      if (remoteArchived && key === appState.current) currentBecameArchived = true;
    }
    // Mirror tracker-side renames so the conference tab always reflects
    // the bound event's current name.
    if (syncProfileNameToLinkedEvent(profile)) changed = true;
  });
  if (!changed) return;
  // If the live profile just got archived from elsewhere, jump to another
  // live one so the operator isn't left looking at an "archived" workspace.
  if (currentBecameArchived) {
    const nextKey = Object.keys(appState.profiles).find(k => !appState.profiles[k].archived);
    if (nextKey) {
      appState.current = nextKey;
      showToast('Linked event archived — switched to ' + appState.profiles[nextKey].name);
    }
  }
  // Persist locally without an extra Firebase round-trip (we just got the
  // truth from Firebase, no need to push it back).
  window.profiles.save({ current: appState.current, profiles: appState.profiles });
  updateProfileBadge();
  if (appState.currentPage === 'events') renderProfiles();
  if (appState.currentPage === 'rooms') renderRooms();
}

// Push a profile's archive flag to its linked tracker event. Uses update()
// so only the archived/archivedAt/updatedAt fields are touched — the rest
// of the event object (name, location, config) is owned by the tracker.
async function pushProfileArchiveToTracker(profile) {
  if (!profile || !profile.trackerEventId) return;
  if (!appState.syncEnabled) return;
  if (!firebaseDb || !trackerAuth || !trackerAuth.currentUser) return;
  try {
    await firebaseDb
      .ref(`${TRACKER_FB_ROOT}/events/${profile.trackerEventId}`)
      .update({
        archived: !!profile.archived,
        archivedAt: profile.archived ? (profile.archivedAt || Date.now()) : null,
        updatedAt: Date.now()
      });
  } catch (error) {
    console.error('Failed to push profile archive to tracker:', error);
    if (typeof pushErrorToTracker === 'function') {
      pushErrorToTracker({ message: 'pushProfileArchiveToTracker: ' + (error && error.message || error), stack: error && error.stack || '', context: 'pushProfileArchiveToTracker' });
    }
  }
}

// Toggle a profile's archive state. Local-only when the profile isn't
// linked to a tracker event; pushes to Firebase when linked. Always
// preserves at least one live profile.
async function setProfileArchived(key, archived) {
  const profile = appState.profiles[key];
  if (!profile) return;
  const next = !!archived;
  if (!!profile.archived === next) return;

  if (next) {
    // Don't allow archiving the last live profile.
    const liveCount = Object.values(appState.profiles).filter(p => !p.archived).length;
    if (liveCount <= 1) {
      showToast('Keep at least one live profile');
      return;
    }
    // If archiving the active profile, switch to another live one first.
    if (key === appState.current) {
      const nextKey = Object.keys(appState.profiles).find(k => k !== key && !appState.profiles[k].archived);
      if (nextKey) appState.current = nextKey;
    }
  }

  profile.archived = next;
  profile.archivedAt = next ? Date.now() : null;
  await saveProfiles();
  await pushProfileArchiveToTracker(profile);
  updateProfileBadge();
  if (appState.currentPage === 'events') renderProfiles();
  if (appState.currentPage === 'rooms') renderRooms();
  showToast(next ? `Archived '${profile.name}'` : `Restored '${profile.name}'`);
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
    // Scope status under THIS Commander's id. Previously every Commander
    // .set() the shared vmixStatus/<eventId> node, so N Commanders (one
    // per venue) clobbered each other every ~2s and rooms flickered
    // live↔unreachable on the tracker. Now each writes only its own
    // sub-node; the tracker merges them (any reachable Commander = live).
    // onDisconnect cleanup so a closed Commander's rooms drop out of the
    // merge instead of lingering stale.
    const ref = firebaseDb.ref(`${TRACKER_FB_ROOT}/vmixStatus/${profile.trackerEventId}/commanders/${COMMANDER_ID}`);
    try { ref.onDisconnect().remove(); } catch (_) { /* best-effort */ }
    await ref.set({
      commanderId: COMMANDER_ID,
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

  // Per-room proxy routing. Multiple Commanders can legitimately serve one
  // event from separate private networks, so each Commander publishes its own
  // event+room-scoped claim. Tracker prefers the freshest claim per room, then
  // falls back to the legacy single winner mirror for older clients.
  try {
    const proxyUrl = _currentTunnelUrl || '';
    const claimsBase = `${TRACKER_FB_ROOT}/events/${profile.trackerEventId}/roomProxyClaims`;
    const legacyBase = `${TRACKER_FB_ROOT}/events/${profile.trackerEventId}/roomProxies`;
    profile.rooms.forEach(r => {
      const reachable = !!rooms[r.key] && rooms[r.key].ok;
      const key = roomClaimKey(profile.trackerEventId, r.key, COMMANDER_ID);
      const claimRef = firebaseDb.ref(`${claimsBase}/${r.key}/${COMMANDER_ID}`);
      const legacyRef = firebaseDb.ref(`${legacyBase}/${r.key}`);
      if (reachable && proxyUrl) {
        if (!_roomProxyClaims[key]) {
          try { claimRef.onDisconnect().remove(); } catch (_) { /* best-effort */ }
          _roomProxyClaims[key] = {
            eventId: profile.trackerEventId,
            roomKey: r.key,
            claimRef,
            legacyRef
          };
        }
        const payload = { url: proxyUrl, commanderId: COMMANDER_ID, updatedAt: Date.now() };
        claimRef.set(payload).then(() => {
          console.log(`[room-proxy] claim ${profile.trackerEventId}/${r.key} -> ${proxyUrl}`);
        }).catch(() => {});
        legacyRef.set(payload).catch(() => {});
      } else if (_roomProxyClaims[key]) {
        removeRoomProxyClaim(key);
      }
    });
  } catch (_) { /* non-fatal — retries next status cycle */ }
}
let _roomProxyClaims = {};

function removeRoomProxyClaim(key) {
  const claim = _roomProxyClaims[key];
  if (!claim) return Promise.resolve();
  try { claim.claimRef.onDisconnect().cancel(); } catch (_) {}
  delete _roomProxyClaims[key];
  console.log(`[room-proxy] remove ${claim.eventId}/${claim.roomKey}`);
  return Promise.all([
    claim.claimRef.remove().catch(() => {}),
    claim.legacyRef.once('value').then((snap) => {
      const current = snap.val();
      if (current && current.commanderId === COMMANDER_ID) {
        return claim.legacyRef.remove().catch(() => {});
      }
      return null;
    }).catch(() => {})
  ]);
}

async function cleanupRoomProxyClaimsForEvent(eventId) {
  if (!eventId) return;
  const keys = Object.keys(_roomProxyClaims).filter((key) => claimBelongsToEvent(key, eventId));
  await Promise.all(keys.map((key) => removeRoomProxyClaim(key)));
}

function cleanupAllRoomProxyClaims() {
  return Promise.all(Object.keys(_roomProxyClaims).map((key) => removeRoomProxyClaim(key)));
}

function currentReachableRoomKeys() {
  const profile = getCurrentProfile();
  if (!profile || !Array.isArray(profile.rooms)) return [];
  const roomStatus = {};
  profile.rooms.forEach((room) => {
    roomStatus[room.key] = appState.vmixStatus[scopedKey(room.key)] || {};
  });
  return buildReachableRoomScope(roomStatus);
}

// ────────────────────────────────────────────────────────────────────────
// Presence heartbeat + concurrent-operator detection
// ────────────────────────────────────────────────────────────────────────
let _presenceInterval = null;
let _presenceRef = null;

let _presenceControllerRef = null;
function startPresenceHeartbeat() {
  stopPresenceHeartbeat();
  const profile = getCurrentProfile();
  if (!appState.syncEnabled || !profile.trackerEventId) return;
  if (!firebaseDb || !trackerAuth || !trackerAuth.currentUser) return;

  const base = `${TRACKER_FB_ROOT}/events/${profile.trackerEventId}`;
  // Per-Commander presence cell: each instance owns presence/<id>, so two
  // Commanders never overwrite each other, and a disconnect only removes
  // THIS Commander's cell — not the shared one. This is what stops the
  // active↔not-connected flicker when >1 Commander is connected.
  _presenceRef = firebaseDb.ref(`${base}/presence/${COMMANDER_ID}`);
  try { _presenceRef.onDisconnect().remove(); } catch (_) { /* ignore */ }

  // Legacy shared `controller` node kept for backward compat (the
  // concurrent-operator check + un-upgraded trackers still read it).
  // CRITICAL: no onDisconnect().remove() here — a blip must never wipe
  // the shared node (that was the flicker). Staleness via lastHeartbeat
  // already handles "this Commander is gone".
  _presenceControllerRef = firebaseDb.ref(`${base}/controller`);

  const writePresence = () => {
    const payload = {
      commanderId: COMMANDER_ID,
      operator: identityOrPlaceholder(),
      lastHeartbeat: Date.now(),
      safetyLocked: !!controlsLocked,
      reachableRooms: currentReachableRoomKeys()
    };
    if (_presenceRef) {
      _presenceRef.set(payload).catch((error) => {
        console.error('Presence heartbeat write failed:', error);
        if (typeof pushErrorToTracker === 'function') {
          pushErrorToTracker({ message: 'presenceHeartbeat: ' + (error && error.message || error), stack: error && error.stack || '', context: 'presenceHeartbeat' });
        }
      });
    }
    if (_presenceControllerRef) {
      _presenceControllerRef.set(payload).catch(() => { /* compat mirror — non-fatal */ });
    }
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
    try { _presenceRef.remove(); } catch (_) { /* ignore */ }  // only OUR cell
    _presenceRef = null;
  }
  // Deliberately do NOT remove the shared `controller` node here — another
  // Commander may be relying on it; let it go stale instead.
  _presenceControllerRef = null;
}

// Read live peers once on connect. Multiple Commanders are valid for one event;
// only warn when another live Commander overlaps the same reachable room scope.
async function checkConcurrentOperator() {
  const profile = getCurrentProfile();
  if (!profile.trackerEventId) return;
  if (!firebaseDb || !trackerAuth || !trackerAuth.currentUser) return;

  try {
    const now = Date.now();
    const myScope = currentReachableRoomKeys();
    const presenceSnap = await firebaseDb
      .ref(`${TRACKER_FB_ROOT}/events/${profile.trackerEventId}/presence`)
      .once('value');
    const presence = presenceSnap.val() || {};
    const peers = Object.values(presence).filter((entry) =>
      entry &&
      entry.commanderId &&
      entry.commanderId !== COMMANDER_ID &&
      entry.lastHeartbeat &&
      (now - entry.lastHeartbeat) < 10000
    );
    const overlappingPeer = peers.find((entry) =>
      commanderScopesOverlap(myScope, entry.reachableRooms || entry.operator && entry.operator.assignedRooms || [])
    );
    if (overlappingPeer) {
      showConcurrentOperatorModal(overlappingPeer);
      return;
    }

    // Backward compatibility for old Commanders that only publish the legacy
    // shared controller node. If the modern presence map has no live peers at
    // all, keep the old safeguard.
    if (!peers.length) {
      const snap = await firebaseDb
        .ref(`${TRACKER_FB_ROOT}/events/${profile.trackerEventId}/controller`)
        .once('value');
      const current = snap.val();
      const recent = current && current.lastHeartbeat && (now - current.lastHeartbeat) < 10000;
      const different = current && current.commanderId && current.commanderId !== COMMANDER_ID;
      if (recent && different) showConcurrentOperatorModal(current);
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
  if (!profile.trackerEventId) { console.log('[crew-sub] skipped — no event linked'); return; }
  if (!firebaseDb || !trackerAuth || !trackerAuth.currentUser) { console.log('[crew-sub] skipped — Firebase not ready'); return; }

  console.log('[crew-sub] subscribing to event', profile.trackerEventId);
  _trackerCrewRef = firebaseDb.ref(`${TRACKER_FB_ROOT}/events/${profile.trackerEventId}/config/crew`);
  _trackerCrewRef.on('value', (snap) => {
    const val = snap.val();
    console.log('[crew-sub] snapshot received:', val ? (Array.isArray(val) ? val.length : Object.keys(val).length) + ' entries' : 'null');
    // Tracker stores crew as an array; tolerate object-shape writes too.
    if (Array.isArray(val)) {
      trackerCrewList = val.filter(Boolean);
    } else if (val && typeof val === 'object') {
      trackerCrewList = Object.values(val).filter(Boolean);
    } else {
      trackerCrewList = [];
    }
    // If the legacy identity modal is open, re-render its crew dropdown.
    const modal = document.getElementById('identity-modal');
    if (modal && modal.classList.contains('is-open') && typeof renderTrackerCrewDropdown === 'function') {
      renderTrackerCrewDropdown();
    }
    // If the sign-in gate's crew picker is currently visible, re-render it
    // so a late-arriving roster populates without requiring a reopen.
    const gate = document.getElementById('signin-gate');
    const crewStep = document.getElementById('signin-step-crew-identity');
    if (gate && gate.style.display !== 'none' && crewStep && crewStep.style.display !== 'none') {
      const prevCrew = _signinChosenCrew;
      renderSignInCrewList();
      if (prevCrew) {
        const match = document.querySelector(`.signin-crew-option[data-crew-id="${prevCrew}"]`);
        if (match) signInPickCrew(prevCrew, match);
      }
    }
    // For resumed Operator sessions (signed in on a previous version, or
    // crew config changed remotely), reconcile the crew's rooms into
    // profile.rooms + refresh identity.assignedRooms so the filter has
    // real keys. Fire-and-forget — it re-renders on success.
    if (typeof reconcileCurrentOperatorRooms === 'function') {
      reconcileCurrentOperatorRooms().catch(function () { /* non-fatal */ });
    }
    // Admin/Director equivalent: keep profile.rooms aligned with the full
    // crew-room union whenever the roster arrives or changes. Without this,
    // an admin who signed in before the crew snapshot landed would never
    // reconcile (reconcileCurrentOperatorRooms is Operator-only).
    if (appState.identity && appState.identity.role === 'Director'
        && typeof reconcileAllCrewRoomsIntoProfile === 'function') {
      reconcileAllCrewRoomsIntoProfile().catch(function () { /* non-fatal */ });
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
    if (controlsLocked === remote) return;    // already in sync — no-op + no re-render
    // Adopt the remote state. setControlsLocked handles localStorage + body
    // class + downstream pushes; we always re-render so the All Rooms toggle
    // checkbox visibly flips even when the operator isn't on the Rooms tab
    // (the next visit would otherwise show the wrong toggle position).
    setControlsLocked(remote);
    renderRooms();
  }, (error) => {
    console.error('Tracker safetyLock subscription error:', error);
    if (typeof pushErrorToTracker === 'function') {
      pushErrorToTracker({ message: 'subscribeToTrackerSafetyLock: ' + (error && error.message || error), stack: error && error.stack || '', context: 'subscribeToTrackerSafetyLock' });
    }
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

// Initialize on load. Any throw here previously left the app as a blank
// screen — the default HTML has `page-rooms` active with an empty
// `rooms-container`, so an init crash just looks like "nothing happened".
// Surface the error on-screen so the user isn't stuck guessing.
init().catch((err) => {
  try {
    const el = document.getElementById('rooms-container');
    if (el) {
      el.innerHTML =
        '<div class="empty-state" style="color:var(--red);text-align:left;white-space:pre-wrap;">' +
        '<strong>Commander failed to start.</strong>\n\n' +
        'Error: ' + (err && err.message ? err.message : String(err)) + '\n\n' +
        (err && err.stack ? err.stack : '') +
        '</div>';
    }
  } catch (_) { /* never re-throw from the error path */ }
  console.error('init() failed:', err);
});
