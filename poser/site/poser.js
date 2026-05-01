/* ═══════════════════════════════════════════
   POSER — Shared Identity & Auth System
   ═══════════════════════════════════════════ */

const PILLAR_COLORS = new Proxy({}, {
  get(_, key) {
    return getComputedStyle(document.documentElement).getPropertyValue('--' + key).trim() || '#888';
  }
});

const PILLAR_META = [
  { id: 'cinema',  name: 'Cinema',     icon: '🎬' },
  { id: 'music',   name: 'Music',      icon: '🎵' },
  { id: 'fashion', name: 'Fashion',    icon: '👗' },
  { id: 'lit',     name: 'Literature', icon: '📖' },
];

function getRingBg(pillars) {
  if (!pillars || pillars.length === 0) return 'background:#444';
  const cols = pillars.map(p => PILLAR_COLORS[p]);
  if (cols.length === 1) return 'background:' + cols[0];
  const seg = 360 / cols.length;
  const stops = cols.map((c, i) => c + ' ' + (i * seg) + 'deg ' + ((i + 1) * seg) + 'deg').join(',');
  return 'background:conic-gradient(' + stops + ')';
}

function getInitials(username) {
  if (!username) return '?';
  const parts = username.replace(/[._]/g, ' ').trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  return username.slice(0, 2).toUpperCase();
}

function validateUsername(val) {
  if (!val) return null;
  if (val.length < 3)  return 'Must be at least 3 characters';
  if (val.length > 20) return 'Must be 20 characters or less';
  if (!/^[a-zA-Z0-9._]+$/.test(val)) return 'Only letters, numbers, dots, underscores';
  if (/^[._]|[._]$/.test(val)) return "Can't start or end with . or _";
  return '';
}

function setRing(ringEl, avatarEl, pillars, photoDataUrl, username, avatarSize) {
  ringEl.style.cssText = getRingBg(pillars) + ';display:inline-flex;';
  if (avatarSize) { avatarEl.style.width = avatarSize + 'px'; avatarEl.style.height = avatarSize + 'px'; }
  if (photoDataUrl) {
    avatarEl.innerHTML = '<img src="' + photoDataUrl + '" style="width:100%;height:100%;object-fit:cover;border-radius:50%;" />';
  } else {
    avatarEl.textContent = getInitials(username);
  }
}

/* ── Auth State ── */
let S = {};
function resetS() {
  S = { mode: 'signup', oauthProvider: null, email: '', password: '',
        username: '', bio: '', pillars: [], photoDataUrl: null };
}
resetS();

let currentUser = null;
try { const d = localStorage.getItem('poser_user'); if (d) currentUser = JSON.parse(d); } catch(e) {}

function saveUser() { localStorage.setItem('poser_user', JSON.stringify(currentUser)); }

/* ── Step navigation ── */
function showStep(id) {
  document.querySelectorAll('.auth-step').forEach(s => s.classList.remove('active'));
  const el = document.getElementById(id);
  if (el) el.classList.add('active');
  const card = document.querySelector('.auth-card');
  if (card) card.classList.toggle('landing', id === 'step-landing');
}

/* ── Modal open/close ── */
function openAuthModal() {
  if (currentUser) { openProfile(); return; }
  resetS();
  showStep('step-landing');
  document.getElementById('auth-overlay').classList.add('open');
  document.body.style.overflow = 'hidden';
}

function closeAuthModal() {
  document.getElementById('auth-overlay').classList.remove('open');
  document.body.style.overflow = '';
}

document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape') {
    closeAuthModal();
    closeProfile();
    closeEditModal();
    const co = document.getElementById('compose-overlay');
    if (co) co.classList.remove('open');
    const rd = document.getElementById('review-overlay');
    if (rd) rd.classList.remove('open');
    document.body.style.overflow = '';
  }
});

/* ── Signup flow ── */
function startSignup() { S.mode = 'signup'; showStep('step-method'); }

function startLogin() {
  S.mode = 'login';
  document.getElementById('email-step-num').textContent = '01 — Sign In';
  document.getElementById('email-heading').innerHTML = 'Welcome<br/>back.';
  document.getElementById('email-back-btn').onclick = function() {
    document.getElementById('email-step-num').textContent = '02 — Email';
    document.getElementById('email-heading').innerHTML = 'Enter your<br/>email.';
    document.getElementById('email-back-btn').onclick = emailBack;
    showStep('step-landing');
  };
  clearEmailStep();
  showStep('step-email');
}

function oauthSignup(provider) {
  S.oauthProvider = provider;
  S.mode = 'signup';
  clearUsernameStep();
  showStep('step-username');
}

function emailBack() { showStep('step-method'); }
function startEmailSignup() { clearEmailStep(); showStep('step-email'); }

function clearEmailStep() {
  document.getElementById('email-input').value = '';
  document.getElementById('email-input').className = 'auth-field-input';
  document.getElementById('email-hint').textContent = '';
  document.getElementById('email-hint').className = 'auth-field-hint';
  document.getElementById('email-submit-btn').disabled = true;
}

function validateEmailField() {
  const val   = document.getElementById('email-input').value.trim();
  const btn   = document.getElementById('email-submit-btn');
  const hint  = document.getElementById('email-hint');
  const input = document.getElementById('email-input');
  if (!val) { input.className = 'auth-field-input'; hint.textContent = ''; btn.disabled = true; return; }
  const ok = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val);
  if (ok) {
    input.className = 'auth-field-input ok'; hint.textContent = ''; hint.className = 'auth-field-hint'; btn.disabled = false;
  } else {
    input.className = 'auth-field-input err'; hint.textContent = 'Enter a valid email address'; hint.className = 'auth-field-hint err'; btn.disabled = true;
  }
}

function submitEmail() {
  const val = document.getElementById('email-input').value.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val)) return;
  S.email = val;
  if (S.mode === 'login') {
    try {
      const stored = localStorage.getItem('poser_user');
      if (stored) {
        const u = JSON.parse(stored);
        if (u.email === val) {
          document.getElementById('pw-step-num').textContent = '02 — Sign In';
          document.getElementById('pw-heading').innerHTML = 'Enter your<br/>password.';
          document.getElementById('pw-back-btn').onclick = function() {
            document.getElementById('pw-step-num').textContent = '04 — Security';
            document.getElementById('pw-heading').innerHTML = 'Create a<br/>password.';
            document.getElementById('pw-back-btn').onclick = pwBack;
            showStep('step-email');
          };
          clearPwStep(); showStep('step-password'); return;
        }
      }
    } catch(e) {}
    const hint = document.getElementById('email-hint');
    hint.textContent = 'No account found with this email.';
    hint.className = 'auth-field-hint err';
    document.getElementById('email-input').className = 'auth-field-input err';
    return;
  }
  document.getElementById('verify-email-display').textContent = 'We sent a 6-digit code to ' + val;
  for (let i = 0; i < 6; i++) document.getElementById('vd' + i).value = '';
  document.getElementById('verify-hint').textContent = '';
  document.getElementById('verify-hint').className = 'auth-field-hint';
  document.getElementById('verify-btn').disabled = true;
  showStep('step-verify');
  setTimeout(autoFillCode, 1800);
}

function verifyInput(idx) {
  const el = document.getElementById('vd' + idx);
  el.value = el.value.replace(/\D/g, '').slice(-1);
  if (el.value && idx < 5) document.getElementById('vd' + (idx + 1)).focus();
  checkVerifyComplete();
}

function verifyKey(e, idx) {
  if (e.key === 'Backspace' && !document.getElementById('vd' + idx).value && idx > 0)
    document.getElementById('vd' + (idx - 1)).focus();
}

function checkVerifyComplete() {
  const code = Array.from({length: 6}, (_, i) => document.getElementById('vd' + i).value).join('');
  document.getElementById('verify-btn').disabled = code.length < 6;
}

async function autoFillCode() {
  const hint = document.getElementById('verify-hint');
  hint.textContent = 'Fetching code…';
  hint.className = 'auth-field-hint';
  try {
    const apiBase = (window.POSER_API_URL || 'http://localhost:3001/api/v1');
    const res = await fetch(apiBase + '/dev/otp?email=' + encodeURIComponent(S.email) + '&purpose=signup');
    if (res.ok) {
      const d = await res.json();
      d.code.split('').forEach(function(c, i) {
        const el = document.getElementById('vd' + i);
        if (el) el.value = c;
      });
      document.getElementById('verify-btn').disabled = false;
      hint.textContent = '✓ Code auto-filled — click Verify to continue';
      hint.className = 'auth-field-hint ok';
    } else {
      hint.textContent = 'Check your terminal for the code';
      hint.className = 'auth-field-hint';
    }
  } catch (e) {
    hint.textContent = 'Check your terminal for the code';
    hint.className = 'auth-field-hint';
  }
}

function submitVerify() {
  const code = Array.from({length: 6}, (_, i) => document.getElementById('vd' + i).value).join('');
  if (code.length < 6) return;
  clearPwStep(); showStep('step-password');
}

function pwBack() { showStep('step-username'); }

function clearPwStep() {
  document.getElementById('pw-input').value = '';
  document.getElementById('pw-input').className = 'auth-field-input';
  document.getElementById('pw-hint').textContent = '';
  document.getElementById('pw-submit-btn').disabled = true;
}

function validatePwField() {
  const val   = document.getElementById('pw-input').value;
  const btn   = document.getElementById('pw-submit-btn');
  const hint  = document.getElementById('pw-hint');
  const input = document.getElementById('pw-input');
  if (!val) { input.className = 'auth-field-input'; hint.textContent = ''; btn.disabled = true; return; }
  const hasLength  = val.length >= 8;
  const hasLetter  = /[a-zA-Z]/.test(val);
  const hasNumber  = /[0-9]/.test(val);
  if (hasLength && hasLetter && hasNumber) {
    input.className = 'auth-field-input ok'; hint.textContent = ''; btn.disabled = false;
  } else {
    const msg = !hasLength ? 'At least 8 characters required'
              : !hasLetter ? 'Must include at least one letter'
              : 'Must include at least one number';
    input.className = 'auth-field-input err'; hint.textContent = msg; hint.className = 'auth-field-hint err'; btn.disabled = true;
  }
}

function submitPassword() {
  const val = document.getElementById('pw-input').value;
  if (val.length < 8) return;
  S.password = val;
  if (S.mode === 'login') {
    try {
      const stored = localStorage.getItem('poser_user');
      if (stored) {
        const u = JSON.parse(stored);
        if (u.email === S.email && u.password === val) {
          currentUser = u;
          closeAuthModal();
          updateNavForUser();
          openProfile();
          return;
        }
      }
    } catch(e) {}
    document.getElementById('pw-input').className = 'auth-field-input err';
    document.getElementById('pw-hint').textContent = 'Incorrect password';
    document.getElementById('pw-hint').className = 'auth-field-hint err';
    return;
  }
  clearUsernameStep(); showStep('step-username');
}

function clearUsernameStep() {
  document.getElementById('username-input').value = '';
  document.getElementById('username-input').className = 'auth-field-input';
  document.getElementById('username-hint').textContent = '';
  document.getElementById('username-btn').disabled = true;
}

function validateUsernameField() {
  const val   = document.getElementById('username-input').value.trim();
  const btn   = document.getElementById('username-btn');
  const hint  = document.getElementById('username-hint');
  const input = document.getElementById('username-input');
  if (!val) { input.className = 'auth-field-input'; hint.textContent = ''; hint.className = 'auth-field-hint'; btn.disabled = true; return; }
  const err = validateUsername(val);
  if (err === '') {
    input.className = 'auth-field-input ok'; hint.textContent = '@' + val + ' is available'; hint.className = 'auth-field-hint ok'; btn.disabled = false;
  } else {
    input.className = 'auth-field-input err'; hint.textContent = err; hint.className = 'auth-field-hint err'; btn.disabled = true;
  }
}

function submitUsername() {
  const val = document.getElementById('username-input').value.trim();
  if (validateUsername(val) !== '') return;
  S.username = val;
  const pa = document.getElementById('photo-avatar');
  pa.textContent = getInitials(val);
  pa.style.fontSize = '0.85rem';
  clearPwStep();
  showStep('step-password');
}

function handlePhotoUpload(event) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = function(e) {
    S.photoDataUrl = e.target.result;
    document.getElementById('photo-avatar').innerHTML =
      '<img src="' + e.target.result + '" style="width:100%;height:100%;object-fit:cover;border-radius:50%;" />';
    document.getElementById('photo-drop-text').textContent = '✓ Photo uploaded';
  };
  reader.readAsDataURL(file);
}

function skipPhoto() { S.photoDataUrl = null; showStep('step-bio'); }

function updateBioCounter() {
  document.getElementById('bio-counter').textContent = document.getElementById('bio-input').value.length;
}

function submitBio() {
  S.bio = document.getElementById('bio-input').value;
  S.pillars = [];
  document.querySelectorAll('.pillar-opt[id^="popt-"]').forEach(b => b.classList.remove('sel'));
  document.getElementById('pillars-btn').disabled = true;
  updatePillarsPreview();
  showStep('step-pillars');
}

function updatePillarsPreview() {
  const ring   = document.getElementById('pillars-ring');
  const avatar = document.getElementById('pillars-avatar');
  ring.style.cssText = getRingBg(S.pillars) + ';display:inline-flex;';
  if (S.photoDataUrl) {
    avatar.innerHTML = '<img src="' + S.photoDataUrl + '" style="width:100%;height:100%;object-fit:cover;border-radius:50%;" />';
  } else {
    avatar.textContent = getInitials(S.username);
  }
}

function togglePillar(pid) {
  const idx = S.pillars.indexOf(pid);
  if (idx === -1) S.pillars.push(pid); else S.pillars.splice(idx, 1);
  document.querySelectorAll('.pillar-opt[id^="popt-"]').forEach(btn => {
    const id = btn.id.replace('popt-', '');
    btn.classList.toggle('sel', S.pillars.includes(id));
  });
  updatePillarsPreview();
  document.getElementById('pillars-btn').disabled = S.pillars.length === 0;
}

function submitPillars() {
  if (S.pillars.length === 0) return;
  currentUser = {
    email: S.email, password: S.password,
    username: S.username, bio: S.bio,
    pillars: [...S.pillars], photoDataUrl: S.photoDataUrl,
    createdAt: new Date().toISOString(),
  };
  saveUser();
  const doneRing   = document.getElementById('done-ring');
  const doneAvatar = document.getElementById('done-avatar');
  setRing(doneRing, doneAvatar, currentUser.pillars, currentUser.photoDataUrl, currentUser.username, 80);
  document.getElementById('done-heading').textContent = 'Welcome, @' + currentUser.username + '.';
  document.getElementById('done-sub').textContent = "Your ring is set. You're in.";
  showStep('step-done');
}

function enterPlatform() {
  closeAuthModal();
  updateNavForUser();
  openProfile();
}

/* ── Nav ── */
function updateNavForUser() {
  const userBtn  = document.getElementById('nav-user-btn');
  const ringEl   = document.getElementById('nav-ring');
  const avatarEl = document.getElementById('nav-avatar');
  const composeEl = document.getElementById('nav-compose-btn');
  if (!currentUser) {
    if (userBtn)  userBtn.style.display = 'none';
    if (ringEl)   ringEl.style.display = 'none';
    if (composeEl) composeEl.classList.remove('visible');
    return;
  }
  if (userBtn) userBtn.style.display = 'flex';
  if (ringEl) {
    ringEl.style.display = '';
    ringEl.style.cssText = getRingBg(currentUser.pillars) + ';display:inline-flex;padding:3px;border-radius:50%;';
  }
  if (avatarEl) {
    if (currentUser.photoDataUrl) {
      avatarEl.innerHTML = '<img src="' + currentUser.photoDataUrl + '" style="width:100%;height:100%;object-fit:cover;border-radius:50%;" />';
    } else {
      avatarEl.textContent = getInitials(currentUser.username);
    }
  }
  if (composeEl) composeEl.classList.add('visible');
}

/* ── Profile page ── */
function openProfile() {
  if (!currentUser) return;
  const ring   = document.getElementById('prof-ring');
  const avatar = document.getElementById('prof-avatar');
  setRing(ring, avatar, currentUser.pillars, currentUser.photoDataUrl, currentUser.username, 80);
  document.getElementById('prof-username').textContent = '@' + currentUser.username;
  document.getElementById('prof-bio').textContent = currentUser.bio || '';
  document.getElementById('prof-pillars-row').innerHTML = '';
  document.querySelectorAll('.prof-tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.prof-tab-content').forEach(t => t.classList.remove('active'));
  document.querySelector('.prof-tab').classList.add('active');
  document.getElementById('tab-reviews').classList.add('active');
  document.getElementById('profile-page').classList.add('open');
  document.body.style.overflow = 'hidden';
}

function closeProfile() {
  document.getElementById('profile-page').classList.remove('open');
  document.body.style.overflow = '';
}

function switchTab(name, btn) {
  document.querySelectorAll('.prof-tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.prof-tab-content').forEach(t => t.classList.remove('active'));
  btn.classList.add('active');
  document.getElementById('tab-' + name).classList.add('active');
}

function signOut() {
  currentUser = null;
  localStorage.removeItem('poser_user');
  updateNavForUser();
  closeProfile();
}

/* ── Edit profile ── */
let editPillars = [];
let editPhotoDataUrl = null;

function openEditModal() {
  if (!currentUser) return;
  editPillars      = [...currentUser.pillars];
  editPhotoDataUrl = currentUser.photoDataUrl;
  document.getElementById('edit-username').value = currentUser.username;
  document.getElementById('edit-bio').value      = currentUser.bio || '';
  document.getElementById('edit-bio-counter').textContent = (currentUser.bio || '').length;
  document.getElementById('edit-username-hint').textContent = '';
  document.getElementById('edit-username').className = 'auth-field-input';
  PILLAR_META.forEach(function(m) {
    document.getElementById('edit-popt-' + m.id).classList.toggle('sel', editPillars.includes(m.id));
  });
  refreshEditRing();
  document.getElementById('edit-overlay').classList.add('open');
}

function closeEditModal() { document.getElementById('edit-overlay').classList.remove('open'); }

function handleEditPhoto(event) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = function(e) { editPhotoDataUrl = e.target.result; refreshEditRing(); };
  reader.readAsDataURL(file);
}

function refreshEditRing() {
  const ring   = document.getElementById('edit-ring');
  const avatar = document.getElementById('edit-avatar');
  const uname  = document.getElementById('edit-username').value || (currentUser && currentUser.username) || '';
  setRing(ring, avatar, editPillars, editPhotoDataUrl, uname, 64);
}

function toggleEditPillar(pid) {
  const idx = editPillars.indexOf(pid);
  if (idx === -1) editPillars.push(pid);
  else if (editPillars.length > 1) editPillars.splice(idx, 1);
  PILLAR_META.forEach(function(m) {
    document.getElementById('edit-popt-' + m.id).classList.toggle('sel', editPillars.includes(m.id));
  });
  refreshEditRing();
}

function validateEditUsername() {
  const val   = document.getElementById('edit-username').value.trim();
  const hint  = document.getElementById('edit-username-hint');
  const input = document.getElementById('edit-username');
  if (!val) { input.className = 'auth-field-input'; hint.textContent = ''; hint.className = 'auth-field-hint'; return; }
  const err = validateUsername(val);
  if (err === '') {
    input.className = 'auth-field-input ok'; hint.textContent = ''; hint.className = 'auth-field-hint';
  } else {
    input.className = 'auth-field-input err'; hint.textContent = err; hint.className = 'auth-field-hint err';
  }
  refreshEditRing();
}

function updateEditBioCounter() {
  document.getElementById('edit-bio-counter').textContent = document.getElementById('edit-bio').value.length;
}

function saveEditProfile() {
  const newUsername = document.getElementById('edit-username').value.trim();
  if (validateUsername(newUsername) !== '') return;
  currentUser.username     = newUsername;
  currentUser.bio          = document.getElementById('edit-bio').value;
  currentUser.pillars      = [...editPillars];
  currentUser.photoDataUrl = editPhotoDataUrl;
  saveUser();
  closeEditModal();
  updateNavForUser();
  openProfile();
}

/* ── Mobile nav ── */
function toggleMobileMenu() {
  const menu = document.getElementById('mobile-menu');
  if (menu) menu.classList.toggle('open');
}

/* ── Init ── */
(function init() {
  if (currentUser) updateNavForUser();
})();
