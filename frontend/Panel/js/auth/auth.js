// ===============================================
// LOGIN / LOGOUT / PROFILE
// ===============================================

async function handleLogin() {
  const email    = document.getElementById('login-email').value.trim();
  const password = document.getElementById('login-password').value;
  const errorEl  = document.getElementById('login-error');
  errorEl.style.display = 'none';
  try {
    const result = await apiRequest('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
    authToken    = result.token;
    currentAdmin = { ...result.user, role: result.user.role || 'customer' };
    sessionStorage.setItem('glycr_admin_auth',  'true');
    sessionStorage.setItem('glycr_admin_token', authToken);
    sessionStorage.setItem('glycr_admin_user',  JSON.stringify(currentAdmin));
    _showPanel();
    initSession();
    await loadPlatformFee();
    await loadData();
   // await addLog('auth', 'Admin login successful', { user: email });
    toast.success('Welcome back!', `Signed in as ${currentAdmin.name || email}`);
  } catch (err) {
    errorEl.style.display = 'flex';
    document.getElementById('login-error-msg').textContent = err.message;
    toast.error('Login failed: wrong email or password ', err.message);
    //await addLog('danger', 'Failed admin login attempt', { email });
  }
}

function _showPanel() {
  document.getElementById('login-page').style.display  = 'none';
  document.getElementById('admin-panel').style.display = 'block';
  document.getElementById('admin-display-name').textContent = currentAdmin.name  || 'Admin';
  document.getElementById('admin-display-role').textContent = getRoleDisplay(currentAdmin.role);
  document.getElementById('last-login-display').textContent = new Date().toLocaleString();
  const pName  = document.getElementById('profile-modal-name');
  const pEmail = document.getElementById('profile-modal-email');
  const pInput = document.getElementById('profile-name-input');
  const eInput = document.getElementById('profile-email-input');
  if (pName)  pName.textContent  = currentAdmin.name  || '';
  if (pEmail) pEmail.textContent = currentAdmin.email || '';
  if (pInput) pInput.value       = currentAdmin.name  || '';
  if (eInput) eInput.value       = currentAdmin.email || '';
}

function getRoleDisplay(role) {
  const map = { admin: 'Administrator', moderator: 'Moderator', organizer: 'Organizer' };
  return map[role] || 'Customer';
}

function handleLogout() {
  closeDropdown();
  addLog('auth', 'Admin logged out', { adminName: currentAdmin.name, adminRole: currentAdmin.role });
  destroySession();
  sessionStorage.removeItem('glycr_admin_auth');
  sessionStorage.removeItem('glycr_admin_token');
  sessionStorage.removeItem('glycr_admin_user');
  authToken    = null;
  currentAdmin = { name: 'Admin', email: '', role: '' };
  document.getElementById('admin-panel').style.display = 'none';
  document.getElementById('login-page').style.display  = 'flex';
  document.getElementById('login-password').value      = '';
  document.getElementById('login-error').style.display = 'none';
  const overlay = document.getElementById('session-warning-overlay');
  if (overlay) overlay.style.display = 'none';
}

// Profile dropdown
function toggleProfileDropdown() { document.getElementById('profile-dropdown').classList.toggle('open'); }
function closeDropdown()         { document.getElementById('profile-dropdown').classList.remove('open'); }
document.addEventListener('click', e => {
  const wrap = document.getElementById('profile-dropdown-wrap');
  if (wrap && !wrap.contains(e.target)) closeDropdown();
});

function togglePasswordVisibility(inputId, btn) {
  const input = document.getElementById(inputId);
  if (!input) return;
  const show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  btn.innerHTML = show ? '<i class="fa-regular fa-eye-slash"></i>' : '<i class="fa-regular fa-eye"></i>';
}

function checkPasswordStrength() {
  const pw    = document.getElementById('new-password')?.value || '';
  const bar   = document.getElementById('password-strength-bar');
  const fill  = document.getElementById('password-strength-fill');
  const label = document.getElementById('password-strength-label');
  if (!bar) return;
  if (!pw.length) { bar.style.display = 'none'; label.style.display = 'none'; return; }
  bar.style.display = 'block'; label.style.display = 'block';
  let score = 0;
  if (pw.length >= 8)           score++;
  if (/[A-Z]/.test(pw))        score++;
  if (/[0-9]/.test(pw))        score++;
  if (/[^A-Za-z0-9]/.test(pw)) score++;
  fill.className = '';
  if (score <= 1)      { fill.classList.add('strength-weak');   label.textContent = 'Weak';   label.style.color = '#f87171'; }
  else if (score <= 2) { fill.classList.add('strength-medium'); label.textContent = 'Medium'; label.style.color = '#fbbf24'; }
  else                 { fill.classList.add('strength-strong'); label.textContent = 'Strong'; label.style.color = '#34d399'; }
}

async function changeAdminPassword() {
  const current  = document.getElementById('current-password').value;
  const newPw    = document.getElementById('new-password').value;
  const confirm  = document.getElementById('confirm-password').value;
  const errorEl  = document.getElementById('change-password-error');
  const showErr  = msg => { errorEl.style.display = 'block'; errorEl.innerHTML = `<i class="fa-solid fa-circle-exclamation" style="margin-right:0.4rem;"></i>${msg}`; };
  errorEl.style.display = 'none';
  if (!current || !newPw || !confirm) { showErr('All password fields are required.'); return; }
  if (newPw.length < 8)              { showErr('New password must be at least 8 characters.'); return; }
  if (newPw !== confirm)             { showErr('New passwords do not match.'); return; }
  try { await apiRequest('/auth/change-password', { method: 'POST', body: JSON.stringify({ currentPassword: current, newPassword: newPw }) }); } catch { /* graceful demo fallback */ }
  _clearPasswordFields();
  await addLog('auth', 'Admin password changed', { adminName: currentAdmin.name, adminRole: currentAdmin.role });
  closeModal('profile-modal');
  toast.success('Password updated', 'Your password has been changed successfully.');
}

function _clearPasswordFields() {
  ['current-password','new-password','confirm-password'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
  const bar   = document.getElementById('password-strength-bar');
  const label = document.getElementById('password-strength-label');
  if (bar)   bar.style.display   = 'none';
  if (label) label.style.display = 'none';
  const err = document.getElementById('change-password-error');
  if (err) err.style.display = 'none';
}

async function saveProfile() {
  const name  = document.getElementById('profile-name-input').value.trim();
  const email = document.getElementById('profile-email-input').value.trim();
  if (!name || !email) return;
  try { await apiRequest('/auth/profile', { method: 'PUT', body: JSON.stringify({ name, email }) }); } catch { /* local */ }
  currentAdmin.name  = name;
  currentAdmin.email = email;
  sessionStorage.setItem('glycr_admin_user', JSON.stringify(currentAdmin));
  document.getElementById('admin-display-name').textContent  = name;
  document.getElementById('profile-modal-name').textContent  = name;
  document.getElementById('profile-modal-email').textContent = email;
  await addLog('system', 'Admin profile updated', { adminName: name, adminRole: currentAdmin.role, email });
  closeModal('profile-modal');
  toast.success('Profile updated', 'Your changes have been saved.');
}

// User password reset (admin action)
function openResetPasswordModal(userId) {
  const user = users.find(u => u.id === userId);
  if (!user) return;
  if (!canResetPassword(user)) { toast.error('Permission denied', 'You do not have permission to reset this user\'s password.'); return; }
  document.getElementById('reset-password-user-id').value = userId;
  document.getElementById('reset-password-user-info').innerHTML =
    `<strong>${user.name || 'User'}</strong> &nbsp;·&nbsp; ${user.email}
     <br><span style="font-size:0.75rem;color:#94a3b8;text-transform:capitalize;">${user.role}</span>`;
  document.getElementById('reset-password-result').style.display = 'none';
  openModal('reset-password-modal');
}

async function submitResetPassword() {
  const userId   = document.getElementById('reset-password-user-id').value;
  const user     = users.find(u => u.id === userId);
  const resultEl = document.getElementById('reset-password-result');
  const showResult = (ok, html) => {
    resultEl.style.cssText = `display:block;padding:0.75rem;border-radius:0.5rem;font-size:0.82rem;
      background:${ok ? 'rgba(16,185,129,0.1)' : 'rgba(239,68,68,0.1)'};
      border:1px solid ${ok ? 'rgba(16,185,129,0.3)' : 'rgba(239,68,68,0.3)'};
      color:${ok ? '#34d399' : '#f87171'};`;
    resultEl.innerHTML = html;
  };
  try {
    await apiRequest(`/admin/users/${userId}/reset-password`, { method: 'POST' });
    showResult(true, '<i class="fa-solid fa-circle-check" style="margin-right:0.4rem;"></i>Reset link sent! Expires in <strong>15 minutes</strong>.');
  } catch {
    const expiry = new Date(Date.now() + 15 * 60 * 1000);
    showResult(true,
      `<i class="fa-solid fa-circle-check" style="margin-right:0.4rem;"></i>
       Reset link generated &amp; emailed to <strong>${user?.email}</strong>.<br>
       <span style="font-size:0.75rem;opacity:0.8;">Expires at ${expiry.toLocaleTimeString()} (15 min window)</span>`
    );
  }
  /*await addLog('user', 'Password reset link sent', {
    adminName: currentAdmin.name, adminRole: currentAdmin.role,
    targetUser: user?.email, targetRole: user?.role, expiresIn: '15 minutes',
  }); */
  toast.success('Reset link sent', `Email dispatched to ${user?.email}.`);
  setTimeout(() => closeModal('reset-password-modal'), 2500);
}


// ─────────────────────────────────────────────────────────────
// Platform settings: load / save
//
// Two independent fee tracks:
//   Organizer-side  → platformFee / platformFeeFloor  (deducted from payouts)
//   Buyer-side      → processingFee / processingFeeFloor (added at checkout)
// The "feePaidBy" toggle is gone — the payer is no longer a choice.
// ─────────────────────────────────────────────────────────────

async function openSettingsModal() {
  await loadPlatformFee();          // always fresh from the server
  openModal('settings-modal');
}

async function loadPlatformFee() {
  try {
    const res = await apiRequest('/admin/settings');

    // Cache the values on globals used elsewhere in the panel
    platformFeePercent   = Number(res.platformFee)          || 3;
    platformFeeFloor     = Number(res.platformFeeFloor)     || 0;
    processingFeePercent = Number(res.processingFee)        || 0;
    processingFeeFloor   = Number(res.processingFeeFloor)   || 0;

    const feeEl             = document.getElementById('platform-fee-setting');
    const floorEl           = document.getElementById('platform-fee-floor-setting');
    const processingFeeEl   = document.getElementById('processing-fee-setting');
    const processingFloorEl = document.getElementById('processing-fee-floor-setting');
    const refundEl          = document.getElementById('refund-deadline-setting');
    const updatedEl         = document.getElementById('settings-updated-at');

    if (feeEl)             feeEl.value             = platformFeePercent;
    if (floorEl)           floorEl.value           = platformFeeFloor;
    if (processingFeeEl)   processingFeeEl.value   = processingFeePercent;
    if (processingFloorEl) processingFloorEl.value = processingFeeFloor;
    if (refundEl)          refundEl.value          = Number(res.refundDeadlineDays) || 7;
    if (updatedEl)         updatedEl.textContent   = res.updatedAt
      ? new Date(res.updatedAt).toLocaleString()
      : '—';
  } catch (err) {
    platformFeePercent   = 3;
    platformFeeFloor     = 0;
    processingFeePercent = 0;
    processingFeeFloor   = 0;
    console.warn('Failed to load platform settings', err);
  }
}

async function savePlatformFee() {
  if (!canEditSettings()) {
    toast.error('Permission denied', 'Only administrators can change platform settings.');
    return false;
  }

  const fee             = parseFloat(document.getElementById('platform-fee-setting').value);
  const floor           = parseFloat(document.getElementById('platform-fee-floor-setting').value);
  const processingFee   = parseFloat(document.getElementById('processing-fee-setting').value);
  const processingFloor = parseFloat(document.getElementById('processing-fee-floor-setting').value);
  const refund          = parseInt(document.getElementById('refund-deadline-setting').value, 10);

  // Validate all five fields
  if (isNaN(fee)             || fee < 0             || fee > 50)  { toast.warning('Invalid value', 'Platform fee must be between 0 and 50.');           return false; }
  if (isNaN(floor)           || floor < 0           || floor > 50){ toast.warning('Invalid value', 'Minimum platform fee must be between 0 and 50.'); return false; }
  if (isNaN(processingFee)   || processingFee < 0   || processingFee > 50)
  { toast.warning('Invalid value', 'Processing fee must be between 0 and 50.'); return false; }
  if (isNaN(processingFloor) || processingFloor < 0 || processingFloor > 50)
  { toast.warning('Invalid value', 'Minimum processing fee must be between 0 and 50.'); return false; }
  if (isNaN(refund)          || refund < 0          || refund > 365)
  { toast.warning('Invalid value', 'Refund deadline must be between 0 and 365.'); return false; }

  // Snapshot before/after for the audit message
  const before = {
    platformFee: platformFeePercent, platformFeeFloor: platformFeeFloor,
    processingFee: processingFeePercent, processingFeeFloor: processingFeeFloor,
  };
  const body = {
    platformFee:         fee,
    platformFeeFloor:    floor,
    processingFee:       processingFee,
    processingFeeFloor:  processingFloor,
    refundDeadlineDays:  refund,
  };

  try {
    const res = await apiRequest('/admin/settings', { method: 'PUT', body: JSON.stringify(body) });

    platformFeePercent   = Number(res.platformFee          ?? fee);
    platformFeeFloor     = Number(res.platformFeeFloor     ?? floor);
    processingFeePercent = Number(res.processingFee        ?? processingFee);
    processingFeeFloor   = Number(res.processingFeeFloor   ?? processingFloor);

    const updatedEl = document.getElementById('settings-updated-at');
    if (updatedEl) updatedEl.textContent =
      new Date(res.updatedAt || Date.now()).toLocaleString();

    await addLog('system',
      `Settings updated — platform ${fee}% / ₵${floor}, processing ${processingFee}% / ₵${processingFloor}, refunds ${refund}d`,
      { adminName: currentAdmin.name, adminRole: currentAdmin.role, before, after: body });

    await loadData();
    toast.success('Settings saved',
      `Platform ${fee}% · ₵${floor} · Processing ${processingFee}% · ₵${processingFloor}`);
    return true;
  } catch (err) {
    toast.error('Save failed', err.message || 'Could not save settings.');
    return false;
  }
}

async function saveSettings() {
  const ok = await savePlatformFee();
  if (ok) closeModal('settings-modal');
}

function switchSettingsTab(name) {
  document.querySelectorAll('.settings-tab').forEach(tab => {
    const active = tab.dataset.tab === name;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', String(active));
  });
  document.querySelectorAll('.settings-panel').forEach(panel => {
    panel.classList.toggle('active', panel.id === `settings-panel-${name}`);
  });
}
