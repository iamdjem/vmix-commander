// State management
let appState = {
  current: 'default',
  profiles: {},
  vmixStatus: {},
  currentPage: 'rooms',
  identity: null,
  syncEnabled: false,
  eventCode: '',
  auditLog: [],
  logFilters: { room: '', user: '', action: '' }
};

let statusRefreshInterval = null;
let showAutoTriggerInterval = null;
let firebaseDb = null;
let firebaseRef = null;

// Initialize app
// ─── Proxy Status Bar ────────────────────────────────────────────────────────
function updateProxyStatusBar(status) {
  const dot   = document.getElementById('proxy-indicator');
  const label = document.getElementById('proxy-label');
  const url   = document.getElementById('proxy-url');

  if (!dot) return;

  if (status.running) {
    dot.className = 'proxy-dot running';
    label.textContent = `Proxy running on port ${status.port}`;
    url.textContent = status.localIp ? `http://${status.localIp}:${status.port}` : '';
  } else if (status.error) {
    dot.className = 'proxy-dot failed';
    label.textContent = `Proxy failed: ${status.error}`;
    url.textContent = '';
  } else {
    dot.className = 'proxy-dot pending';
    label.textContent = 'Proxy starting…';
    url.textContent = '';
  }
}

// Listen for proxy status pushed from main process
if (window.proxy) {
  window.proxy.onStatus(updateProxyStatusBar);
  // Also fetch current status on load (in case event already fired)
  window.proxy.getStatus().then(updateProxyStatusBar);
}
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

// Update profile badge in header
function updateProfileBadge() {
  const profile = getCurrentProfile();
  document.getElementById('profile-name').textContent = profile.name;
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
  document.getElementById(`page-${page}`).classList.add('active');

  // Update nav tabs
  document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
  const targetTab = document.querySelector(`.nav-tab[data-page="${page}"]`);
  if (targetTab) targetTab.classList.add('active');

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
  document.getElementById('btn-export-profiles').addEventListener('click', async () => {
    const result = await window.dialog.saveJson(appState.profiles);
    if (result.ok) {
      showToast('Profiles exported');
    } else if (!result.canceled) {
      showToast('Export failed: ' + result.error);
    }
  });

  // Import profiles button
  document.getElementById('btn-import-profiles').addEventListener('click', async () => {
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

  const status = appState.vmixStatus[room.key] || { ok: false, recording: false, streaming: false, multicorder: false };
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
  name.onclick = () => editRoomNameInline(room.key, name);

  const badges = document.createElement('div');
  badges.className = 'room-badges';

  const activeFns = [
    { on: status.recording, label: 'REC', color: '#ff5555' },
    { on: status.streaming, label: 'STREAM', color: '#ffaa00' },
    { on: status.multicorder, label: 'MULTI', color: '#55aaff' }
  ];

  let anyActive = false;
  activeFns.forEach(fn => {
    if (fn.on) {
      anyActive = true;
      const badge = document.createElement('span');
      badge.className = 'status-badge active';
      badge.textContent = '● ' + fn.label;
      badge.style.color = fn.color;
      badges.appendChild(badge);
    }
  });

  if (!anyActive && connected) {
    const badge = document.createElement('span');
    badge.className = 'status-badge idle';
    badge.textContent = 'IDLE';
    badges.appendChild(badge);
  }

  if (error) {
    const badge = document.createElement('span');
    badge.className = 'status-badge error';
    badge.textContent = 'ERROR';
    badges.appendChild(badge);
  }

  nameWrap.appendChild(name);
  nameWrap.appendChild(badges);

  const ipToggle = document.createElement('button');
  ipToggle.className = 'ip-toggle';
  ipToggle.textContent = room.ip ? '⚙' : '+ IP';
  ipToggle.title = room.ip || 'Set IP';
  ipToggle.onclick = () => toggleIpRow(room.key);

  header.appendChild(dragHandle);
  header.appendChild(nameWrap);
  header.appendChild(ipToggle);

  // IP row
  const ipRow = document.createElement('div');
  ipRow.className = 'ip-row';
  ipRow.id = `ip-row-${room.key}`;
  ipRow.style.display = 'none';

  const ipInput = document.createElement('input');
  ipInput.type = 'text';
  ipInput.className = 'ip-input';
  ipInput.placeholder = '10.x.x.x';
  ipInput.value = room.ip;

  const saveIpBtn = document.createElement('button');
  saveIpBtn.className = 'btn-save-ip';
  saveIpBtn.textContent = 'Save';
  saveIpBtn.onclick = () => saveIp(room.key, ipInput.value);

  ipRow.appendChild(ipInput);
  ipRow.appendChild(saveIpBtn);

  // Function controls
  const controls = document.createElement('div');
  controls.className = 'room-controls';

  const functions = [
    { label: 'REC', startFn: 'StartRecording', stopFn: 'StopRecording', on: status.recording },
    { label: 'STREAM', startFn: 'StartStreaming', stopFn: 'StopStreaming', on: status.streaming },
    { label: 'MULTI', startFn: 'StartMultiCorder', stopFn: 'StopMultiCorder', on: status.multicorder }
  ];

  functions.forEach(fn => {
    const fnControl = document.createElement('div');
    fnControl.className = 'fn-control';

    const fnHeader = document.createElement('div');
    fnHeader.className = 'fn-header';

    const fnLabel = document.createElement('div');
    fnLabel.className = 'fn-label';
    fnLabel.textContent = fn.label;

    const fnStatus = document.createElement('div');
    fnStatus.className = 'fn-status';

    const pill = document.createElement('span');
    pill.className = `status-pill ${error ? 'error' : fn.on ? 'active' : 'inactive'}`;

    const pillText = document.createElement('span');
    pillText.textContent = error ? 'ERR' : fn.on ? 'LIVE' : 'OFF';

    fnStatus.appendChild(pill);
    fnStatus.appendChild(pillText);

    fnHeader.appendChild(fnLabel);
    fnHeader.appendChild(fnStatus);

    const fnButtons = document.createElement('div');
    fnButtons.className = 'fn-buttons';

    const startBtn = document.createElement('button');
    startBtn.className = 'btn-start';
    startBtn.textContent = '▶';
    startBtn.title = 'Start ' + fn.label;
    startBtn.onclick = async () => {
      startBtn.disabled = true;
      startBtn.textContent = '…';
      await callVmix(room.key, fn.startFn);
      setTimeout(() => refreshStatus(room.key), 1000);
    };

    const stopBtn = document.createElement('button');
    stopBtn.className = 'btn-stop';
    stopBtn.textContent = '■';
    stopBtn.title = 'Stop ' + fn.label;
    stopBtn.onclick = async () => {
      stopBtn.disabled = true;
      stopBtn.textContent = '…';
      await callVmix(room.key, fn.stopFn);
      setTimeout(() => refreshStatus(room.key), 1000);
    };

    fnButtons.appendChild(startBtn);
    fnButtons.appendChild(stopBtn);

    fnControl.appendChild(fnHeader);
    fnControl.appendChild(fnButtons);

    controls.appendChild(fnControl);
  });

  // Master controls
  const masterControls = document.createElement('div');
  masterControls.className = 'master-controls';

  const startAllBtn = document.createElement('button');
  startAllBtn.className = 'btn-start-all';
  startAllBtn.textContent = '▶  START ALL';
  startAllBtn.onclick = () => roomAction(room.key, 'start');

  const stopAllBtn = document.createElement('button');
  stopAllBtn.className = 'btn-stop-all';
  stopAllBtn.textContent = '■  STOP ALL';
  stopAllBtn.onclick = () => roomAction(room.key, 'stop');

  masterControls.appendChild(startAllBtn);
  masterControls.appendChild(stopAllBtn);

  card.appendChild(header);
  card.appendChild(ipRow);
  card.appendChild(controls);
  card.appendChild(masterControls);

  return card;
}

// Toggle IP row visibility
function toggleIpRow(roomKey) {
  const ipRow = document.getElementById(`ip-row-${roomKey}`);
  ipRow.style.display = ipRow.style.display === 'none' ? 'flex' : 'none';
}

// Save IP address
function saveIp(roomKey, ip) {
  const profile = getCurrentProfile();
  const room = profile.rooms.find(r => r.key === roomKey);
  if (!room) return;

  room.ip = ip.trim();
  saveProfiles();
  toggleIpRow(roomKey);
  showToast('IP saved');
  refreshStatus(roomKey);
}

// Edit room name inline
function editRoomNameInline(roomKey, nameElement) {
  const profile = getCurrentProfile();
  const room = profile.rooms.find(r => r.key === roomKey);
  if (!room) return;

  const originalText = nameElement.textContent;
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'room-name-edit-input';
  input.value = originalText;

  // Replace text with input
  nameElement.textContent = '';
  nameElement.appendChild(input);
  input.focus();
  input.select();

  const save = () => {
    const newName = input.value.trim();
    if (newName && newName !== originalText) {
      room.name = newName;
      saveProfiles();
      renderRooms();
    } else {
      nameElement.textContent = originalText;
    }
  };

  const cancel = () => {
    nameElement.textContent = originalText;
  };

  input.onblur = save;
  input.onkeydown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      save();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancel();
    }
  };
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
    return;
  }

  const result = await window.vmix.call(room.ip, functionName);

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

  const results = await Promise.all(
    functions.map(fn => window.vmix.call(room.ip, fn))
  );

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

  const status = await window.vmix.status(room.ip);
  appState.vmixStatus[roomKey] = status;

  // Re-render just this card
  const oldCard = document.getElementById(`room-card-${roomKey}`);
  if (oldCard) {
    const newCard = createRoomCard(room);
    oldCard.replaceWith(newCard);
  }
}

// Refresh status for all rooms
async function refreshAllStatus() {
  const profile = getCurrentProfile();
  await Promise.all(profile.rooms.map(room => refreshStatus(room.key)));
}

// Start auto-refresh
function startStatusRefresh() {
  stopStatusRefresh();
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
}

// Render profiles page
function renderProfiles() {
  const list = document.getElementById('profiles-list');
  list.innerHTML = '';

  Object.keys(appState.profiles).forEach(key => {
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
      switchBtn.className = 'btn-switch';
      switchBtn.textContent = 'Switch';
      switchBtn.onclick = () => switchProfile(key);
      actions.appendChild(switchBtn);
    }

    const copyBtn = document.createElement('button');
    copyBtn.className = 'btn-copy';
    copyBtn.textContent = '📋';
    copyBtn.title = 'Copy profile';
    copyBtn.onclick = () => copyProfile(key);
    actions.appendChild(copyBtn);

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'btn-delete';
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
  renderProfiles();
  updateProfileBadge();
  if (appState.currentPage === 'rooms') {
    renderRooms();
  }
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
  if (!confirm(`Delete profile "${profile.name}"?`)) return;

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

// Render settings page
function renderSettings() {
  const profile = getCurrentProfile();

  document.getElementById('settings-profile-name').textContent = profile.name;

  const roomsList = document.getElementById('settings-rooms-list');
  roomsList.innerHTML = '';

  profile.rooms.forEach((room, index) => {
    const item = document.createElement('div');
    item.className = 'settings-room-item';

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
    deleteBtn.className = 'btn-delete-room';
    deleteBtn.textContent = '✕';
    deleteBtn.title = 'Remove room';
    deleteBtn.onclick = () => {
      if (profile.rooms.length === 1) {
        showToast('Need at least one room');
        return;
      }
      profile.rooms.splice(index, 1);
      saveProfiles();
      renderSettings();
      if (appState.currentPage === 'rooms') renderRooms();
      showToast('Room removed');
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
  overlay.style.display = 'flex';
  input.focus();
  input.select();

  const confirm = () => {
    const value = input.value.trim();
    if (value) {
      onConfirm(value);
      hideModal();
    }
  };

  const cancel = () => {
    hideModal();
  };

  document.getElementById('modal-confirm').onclick = confirm;
  document.getElementById('modal-cancel').onclick = cancel;
  document.getElementById('modal-close').onclick = cancel;

  input.onkeydown = (e) => {
    if (e.key === 'Enter') confirm();
    if (e.key === 'Escape') cancel();
  };

  overlay.onclick = (e) => {
    if (e.target === overlay) cancel();
  };
}

function hideModal() {
  document.getElementById('modal-overlay').style.display = 'none';
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
  if (!appState.identity) return;
  const badge = document.getElementById('identity-badge');
  const roleColors = {
    Director: '#5dcc5d',
    Operator: '#55aaff',
    Observer: '#ffaa00'
  };
  badge.textContent = `${appState.identity.name} · ${appState.identity.role}`;
  badge.style.borderColor = roleColors[appState.identity.role] || '#888';
  badge.style.color = roleColors[appState.identity.role] || '#888';
}

function showIdentityOnboarding() {
  const modal = document.getElementById('identity-modal');
  modal.style.display = 'flex';

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
    modal.style.display = 'none';

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

  modal.style.display = 'flex';

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
    modal.style.display = 'none';
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
    ip: '', // IP could be added here if needed
    action: action,
    result: result
  };

  await window.audit.append(entry);
  appState.auditLog.push(entry);
}

function renderAuditLog() {
  const container = document.getElementById('log-container');
  container.innerHTML = '';

  // Apply filters
  let filteredLog = [...appState.auditLog];

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
  if (!confirm('Clear all audit log entries?')) return;

  await window.audit.clear();
  appState.auditLog = [];
  renderAuditLog();
  showToast('Log cleared');
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
  if (!appState.eventCode) {
    updateSyncStatus('🔴 No event code', false);
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

  } catch (error) {
    console.error('Firebase connection error:', error);
    updateSyncStatus('🔴 Connection failed', false);
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
          <button class="btn-show-go" data-id="${item.id}">Go</button>
          <button class="btn-show-skip" data-id="${item.id}">Skip</button>
        ` : ''}
        ${isDirector ? `
          <button class="btn-show-edit" data-id="${item.id}">✏</button>
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

  modal.style.display = 'flex';

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
    modal.style.display = 'none';
    renderShowTimeline();
    showToast('Item added');
  };

  document.getElementById('show-item-cancel').onclick = () => {
    modal.style.display = 'none';
  };

  document.getElementById('show-item-modal-close').onclick = () => {
    modal.style.display = 'none';
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

  modal.style.display = 'flex';

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
    modal.style.display = 'none';
    renderShowTimeline();
    showToast('Item updated');
  };

  document.getElementById('show-item-delete').onclick = () => {
    if (!confirm('Delete this timeline item?')) return;

    const index = runOfShow.findIndex(i => i.id === itemId);
    if (index !== -1) {
      runOfShow.splice(index, 1);
      saveRunOfShow(runOfShow);
      modal.style.display = 'none';
      renderShowTimeline();
      showToast('Item deleted');
    }
  };

  document.getElementById('show-item-cancel').onclick = () => {
    modal.style.display = 'none';
  };

  document.getElementById('show-item-modal-close').onclick = () => {
    modal.style.display = 'none';
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
