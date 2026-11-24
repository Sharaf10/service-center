// Connects the logbook page to Firebase (Google sign-in + Cloud Firestore).
// The page talks to `window.claude.use(name)`; this file provides those
// services (db, user, assets, downloads) on top of Firebase.
import { firebaseConfig } from './firebase-config.js';
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect, getRedirectResult, signOut, onAuthStateChanged,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import {
  initializeFirestore, collection, doc, onSnapshot, setDoc, updateDoc, deleteDoc, getDoc, writeBatch,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

const $ = s => document.querySelector(s);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const gate = $('#gate');
const MARK = `<span class="brand-mark"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.7 6.3a4 4 0 0 0-5.4 5.2L3 17.8V21h3.2l6.3-6.3a4 4 0 0 0 5.2-5.4l-2.6 2.6-2.5-.6-.6-2.5z"/></svg></span>`;

let resolveReady;
const ready = new Promise(r => { resolveReady = r; });
window.claude = { use: name => ready.then(ctx => (ctx && Object.prototype.hasOwnProperty.call(ctx, name)) ? ctx[name] : null) };

/* ---------- sign-in screen ---------- */
function showGate(html, wire) {
  gate.hidden = false;
  gate.querySelector('.gate-card').innerHTML = `<div class="gate-brand">${MARK}<span>Vehicle Service Logbook</span></div>${html}`;
  if (wire) wire(gate.querySelector('.gate-card'));
}
const hideGate = () => { gate.hidden = true; };

const configured = firebaseConfig && typeof firebaseConfig.apiKey === 'string' && firebaseConfig.apiKey && !/PASTE|YOUR_/i.test(firebaseConfig.apiKey);
if (!configured) {
  showGate(`<h1>Finish setting up</h1>
    <p>This copy of the logbook isn’t connected to a database yet. Put your Firebase project’s settings in <code>firebase-config.js</code>, then reload this page.</p>
    <p class="muted small">The README file in the repository walks through every step.</p>`);
  throw new Error('Firebase is not configured');
}

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const fs = initializeFirestore(app, { ignoreUndefinedProperties: true });

/* ---------- error mapping (Firestore codes -> the page's codes) ---------- */
const mapCode = c => ({
  'permission-denied': 'invalid_argument', 'resource-exhausted': 'quota_exceeded',
  'unavailable': 'unavailable', 'deadline-exceeded': 'unavailable', 'unauthenticated': 'revoked',
}[c] || 'other');
const toErr = e => ({ code: mapCode(e && e.code), message: (e && e.message) || String(e) });
const wrap = p => p.catch(e => { throw toErr(e); });

/* ---------- db ---------- */
const docSnap = s => ({ id: s.id, exists: s.exists(), data: () => s.data(), metadata: { fromCache: s.metadata.fromCache, hasPendingWrites: s.metadata.hasPendingWrites } });
function docRefApi(ref) {
  return {
    id: ref.id, path: ref.path,
    get: () => wrap(getDoc(ref)).then(docSnap),
    set: data => wrap(setDoc(ref, data)),
    update: data => wrap(updateDoc(ref, data)),
    delete: () => wrap(deleteDoc(ref)),
    onSnapshot: (next, err) => onSnapshot(ref, s => next(docSnap(s)), e => err && err(toErr(e))),
  };
}
const db = {
  doc: path => docRefApi(doc(fs, path)),
  collection: path => {
    const ref = collection(fs, path);
    return {
      path,
      doc: id => docRefApi(id ? doc(ref, id) : doc(ref)),
      onSnapshot: (next, err) => onSnapshot(ref, snap => next({
        docs: snap.docs.map(docSnap), size: snap.size, empty: snap.empty,
        metadata: { fromCache: snap.metadata.fromCache, hasPendingWrites: snap.metadata.hasPendingWrites },
      }), e => err && err(toErr(e))),
    };
  },
};

/* ---------- photos (stored as compressed JPEGs in Firestore, no billing needed) ---------- */
const photoCache = new Map();
async function fitImage(blob) {
  let bmp;
  try { bmp = await createImageBitmap(blob); } catch (_) { throw { code: 'unsupported_type' }; }
  for (const [max, q] of [[1280, 0.72], [1024, 0.62], [800, 0.55]]) {
    const sc = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * sc); c.height = Math.round(bmp.height * sc);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    const url = c.toDataURL('image/jpeg', q);
    if (url.length < 750000) return url;
  }
  throw { code: 'too_large' };
}
let uid = null;
const assets = {
  async upload(blob) {
    const url = await fitImage(blob);
    const id = 'ph' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    await wrap(setDoc(doc(fs, 'photos', id), { data: url, createdAt: new Date().toISOString(), createdBy: uid }));
    photoCache.set(id, Promise.resolve(url));
    return { id, url, sizeBytes: url.length, contentType: 'image/jpeg' };
  },
  async delete(id) {
    await wrap(deleteDoc(doc(fs, 'photos', id)));
    photoCache.delete(id);
    return { deleted: true };
  },
  async list() { return { assets: [], usage: {} }; },
  __resolve(id) {
    if (!photoCache.has(id)) {
      const p = getDoc(doc(fs, 'photos', id)).then(s => {
        const u = s.exists() ? s.data().data : null;
        if (typeof u !== 'string' || !u.startsWith('data:image/')) throw new Error('missing');
        return u;
      });
      p.catch(() => photoCache.delete(id));
      photoCache.set(id, p);
    }
    return photoCache.get(id);
  },
};

/* ---------- downloads ---------- */
const MIME = { pdf: 'application/pdf', csv: 'text/csv;charset=utf-8' };
const downloads = {
  async save({ filename, data }) {
    const ext = String(filename).split('.').pop().toLowerCase();
    const blob = data instanceof Blob ? data : new Blob([data], { type: MIME[ext] || 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.style.display = 'none';
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    return { status: 'saved' };
  },
};

/* ---------- signed-in session ---------- */
let started = false;
async function start(u, role) {
  if (started) return;
  started = true;
  uid = u.uid;
  const email = (u.email || '').toLowerCase();
  const isAdmin = role === 'admin';
  setDoc(doc(fs, 'people', u.uid), { name: u.displayName || email, email, lastSeen: new Date().toISOString() }).catch(() => {});

  const people = new Map();
  onSnapshot(collection(fs, 'people'), snap => { snap.docs.forEach(d => people.set(d.id, d.data())); }, () => {});

  const user = {
    id: async () => u.uid,
    me: async () => ({ id: u.uid, name: u.displayName || email, email, avatarUrl: u.photoURL || '', color: '', isOwner: isAdmin, canEdit: isAdmin }),
    isOwner: async () => isAdmin,
    canEdit: async () => isAdmin,
    can: async () => true,
    name: async () => u.displayName || email,
    profiles: async ids => {
      const out = {};
      for (const id of [].concat(ids)) {
        let p = people.get(id);
        if (!p) { try { const s = await getDoc(doc(fs, 'people', id)); if (s.exists()) { p = s.data(); people.set(id, p); } } catch (_) {} }
        out[id] = { id, name: (p && p.name) || '', email: (p && p.email) || null, avatarUrl: '', color: '', isMe: id === u.uid, guest: false, roles: null };
      }
      return out;
    },
    search: async () => [],
  };

  addSignOut(email);
  mountStaff(email, isAdmin);
  hideGate();
  resolveReady({ db, user, assets, downloads });
}

function addSignOut(email) {
  const foot = document.querySelector('.side-foot');
  if (!foot || foot.querySelector('#btnSignOut')) return;
  const b = document.createElement('button');
  b.className = 'nav-item'; b.type = 'button'; b.id = 'btnSignOut';
  b.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/></svg><span class="t">Sign out</span>`;
  b.title = 'Signed in as ' + email;
  b.addEventListener('click', () => signOut(auth).then(() => location.reload()));
  foot.insertBefore(b, foot.querySelector('.who-am-i'));
}

/* ---------- staff access (Settings dialog) ---------- */
function mountStaff(myEmail, isAdmin) {
  const mount = $('#staffMount');
  if (!mount) return;
  if (!isAdmin) {
    mount.innerHTML = `<fieldset><legend>Staff access</legend><p class="muted small" style="margin:0">You’re signed in as ${esc(myEmail)} with staff access. Only administrators can change settings or add people.</p></fieldset>`;
    return;
  }
  mount.innerHTML = `<fieldset>
    <legend>Staff access</legend>
    <p class="muted small" style="margin:0">People on this list can sign in with their Google account and use the logbook. Administrators can also change settings and manage this list.</p>
    <div class="inner-table"><table><thead><tr><th>Google account email</th><th>Role</th><th><span class="sr">Remove</span></th></tr></thead><tbody id="staffRows"><tr><td colspan="3" class="muted">Loading…</td></tr></tbody></table></div>
    <div class="grid" style="align-items:end">
      <div class="field"><label for="sf_email">Email address</label><input id="sf_email" type="email" maxlength="120" placeholder="name@gmail.com" autocomplete="off"></div>
      <div class="field"><label for="sf_role">Role</label><select id="sf_role"><option value="staff">Staff</option><option value="admin">Administrator</option></select></div>
      <div class="field"><button class="btn" type="button" id="sf_add">Add person</button></div>
    </div>
    <span class="small" id="sf_msg" role="status"></span>
  </fieldset>`;
  const rows = $('#staffRows'), msg = $('#sf_msg');
  const say = (t, bad) => { msg.textContent = t; msg.style.color = bad ? 'var(--bad)' : 'var(--muted)'; };
  onSnapshot(collection(fs, 'staff'), snap => {
    const list = snap.docs.map(d => ({ email: d.id, ...d.data() })).sort((a, b) => a.email.localeCompare(b.email));
    rows.innerHTML = list.map(s => `<tr>
      <td>${esc(s.email)}${s.email === myEmail ? ' <span class="muted">(you)</span>' : ''}</td>
      <td>${s.email === myEmail ? (s.role === 'admin' ? 'Administrator' : 'Staff') : `<select class="status-sel" data-role-for="${esc(s.email)}" aria-label="Role for ${esc(s.email)}"><option value="staff" ${s.role !== 'admin' ? 'selected' : ''}>Staff</option><option value="admin" ${s.role === 'admin' ? 'selected' : ''}>Administrator</option></select>`}</td>
      <td class="r">${s.email === myEmail ? '' : `<button class="btn ghost sm danger" type="button" data-rm-staff="${esc(s.email)}">Remove</button>`}</td>
    </tr>`).join('') || `<tr><td colspan="3" class="muted">No one yet.</td></tr>`;
  }, () => { rows.innerHTML = `<tr><td colspan="3" class="muted">Couldn’t load the staff list.</td></tr>`; });

  const add = async () => {
    const email = $('#sf_email').value.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { say('Enter a valid email address.', true); return; }
    try {
      await setDoc(doc(fs, 'staff', email), { role: $('#sf_role').value, addedAt: new Date().toISOString(), addedBy: myEmail });
      $('#sf_email').value = '';
      say(`${email} can now sign in. Send them the link to this page.`);
    } catch (e) { say('Couldn’t add that person. Check your connection and try again.', true); }
  };
  $('#sf_add').addEventListener('click', add);
  $('#sf_email').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); add(); } });
  rows.addEventListener('change', async e => {
    const sel = e.target.closest('[data-role-for]'); if (!sel) return;
    try { await updateDoc(doc(fs, 'staff', sel.dataset.roleFor), { role: sel.value }); say('Role updated.'); }
    catch (_) { say('Couldn’t change the role.', true); }
  });
  rows.addEventListener('click', async e => {
    const b = e.target.closest('[data-rm-staff]'); if (!b) return;
    if (b.dataset.confirm !== '1') { b.dataset.confirm = '1'; b.textContent = 'Confirm remove'; return; }
    try { await deleteDoc(doc(fs, 'staff', b.dataset.rmStaff)); say(`${b.dataset.rmStaff} no longer has access.`); }
    catch (_) { say('Couldn’t remove that person.', true); }
  });
}

/* ---------- auth flow ---------- */
function signInScreen(errText) {
  showGate(`<h1>Sign in</h1>
    <p>Use the Google account your service center added to the staff list.</p>
    <div class="row"><button class="btn primary" type="button" id="gSignIn">Sign in with Google</button></div>
    ${errText ? `<p class="err">${esc(errText)}</p>` : ''}`, card => {
    card.querySelector('#gSignIn').addEventListener('click', async () => {
      const provider = new GoogleAuthProvider();
      provider.setCustomParameters({ prompt: 'select_account' });
      try { await signInWithPopup(auth, provider); }
      catch (e) {
        const c = e && e.code;
        if (c === 'auth/popup-blocked' || c === 'auth/operation-not-supported-in-environment') { signInWithRedirect(auth, provider); return; }
        if (c === 'auth/popup-closed-by-user' || c === 'auth/cancelled-popup-request') return;
        if (c === 'auth/unauthorized-domain') { signInScreen(`This web address isn’t allowed to sign in yet. In Firebase, open Authentication → Settings → Authorized domains and add ${location.hostname}.`); return; }
        signInScreen('Sign-in didn’t work. Check your connection and try again.');
      }
    });
  });
}

getRedirectResult(auth).catch(() => {});

onAuthStateChanged(auth, async u => {
  if (!u) { if (!started) signInScreen(); else location.reload(); return; }
  if (started) return;
  showGate(`<p class="muted">Checking your access…</p>`);
  const email = (u.email || '').toLowerCase();
  try {
    const me = await getDoc(doc(fs, 'staff', email));
    if (me.exists()) { start(u, me.data().role); return; }
    const setup = await getDoc(doc(fs, 'config', 'setup'));
    if (!setup.exists()) {
      showGate(`<h1>Set up this logbook</h1>
        <p>No one has set up this logbook yet. Continue to become its administrator as <b>${esc(email)}</b>. You can then add your staff by email under Settings.</p>
        <div class="row"><button class="btn primary" type="button" id="gClaim">Set up as administrator</button><button class="btn" type="button" id="gOut">Use another account</button></div>
        <p class="err" id="gErr"></p>`, card => {
        card.querySelector('#gOut').addEventListener('click', () => signOut(auth));
        card.querySelector('#gClaim').addEventListener('click', async ev => {
          ev.target.disabled = true;
          try {
            const now = new Date().toISOString();
            const b = writeBatch(fs);
            b.set(doc(fs, 'config', 'setup'), { by: u.uid, at: now });
            b.set(doc(fs, 'staff', email), { role: 'admin', addedAt: now, addedBy: email });
            await b.commit();
            start(u, 'admin');
          } catch (e) {
            ev.target.disabled = false;
            card.querySelector('#gErr').textContent = 'Setup didn’t complete. Make sure the Firestore rules from firestore.rules are published, then try again.';
          }
        });
      });
      return;
    }
    showGate(`<h1>No access yet</h1>
      <p>You’re signed in as <b>${esc(email)}</b>, but this account isn’t on the staff list. Ask an administrator to add this email under Settings → Staff access.</p>
      <div class="row"><button class="btn primary" type="button" id="gAgain">Check again</button><button class="btn" type="button" id="gOut">Use another account</button></div>`, card => {
      card.querySelector('#gAgain').addEventListener('click', () => location.reload());
      card.querySelector('#gOut').addEventListener('click', () => signOut(auth));
    });
  } catch (e) {
    showGate(`<h1>Can’t reach the database</h1>
      <p>${e && e.code === 'permission-denied' ? 'The database refused the request. Make sure the rules from firestore.rules are published in Firebase.' : 'Check your internet connection, then try again.'}</p>
      <div class="row"><button class="btn primary" type="button" id="gAgain">Try again</button><button class="btn" type="button" id="gOut">Sign out</button></div>`, card => {
      card.querySelector('#gAgain').addEventListener('click', () => location.reload());
      card.querySelector('#gOut').addEventListener('click', () => signOut(auth));
    });
  }
});
