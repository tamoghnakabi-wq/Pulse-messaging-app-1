/**
 * Idempotent seed for CI smoke tests (alice / bob).
 * Usage: node scripts/ci-seed-users.js
 *
 * Password1 is rejected by the common-password list — use a strong smoke password.
 * Override with SMOKE_PASSWORD. LEGACY Password1 is tried only for older local DBs.
 */
const API = process.env.API_URL || 'http://127.0.0.1:5050';
/** Meets letter + number; not on common list */
const SMOKE_PASSWORD = process.env.SMOKE_PASSWORD || 'PulseCi_Test9x';
const LEGACY_PASSWORD = 'Password1';

async function api(path, opts = {}) {
  const res = await fetch(`${API}/api${path}`, {
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    ...opts,
  });
  const json = await res.json().catch(() => ({}));
  return { res, json };
}

async function tryLogin(username, password) {
  return api('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ emailOrUsername: username, password }),
  });
}

async function ensureUser(username, email, displayName) {
  for (const password of [SMOKE_PASSWORD, LEGACY_PASSWORD]) {
    const login = await tryLogin(username, password);
    if (login.res.ok && login.json.success) {
      console.log(`ok login ${username} (${password === SMOKE_PASSWORD ? 'smoke' : 'legacy'})`);
      return;
    }
  }

  const reg = await api('/auth/register', {
    method: 'POST',
    body: JSON.stringify({
      username,
      email,
      password: SMOKE_PASSWORD,
      displayName,
    }),
  });
  if (reg.res.ok && reg.json.success) {
    console.log(`ok register ${username}`);
    return;
  }

  // Race: already exists under smoke password
  const again = await tryLogin(username, SMOKE_PASSWORD);
  if (again.res.ok && again.json.success) {
    console.log(`ok login ${username} (after register race)`);
    return;
  }
  console.error(`fail seed ${username}`, reg.json, again.json);
  process.exit(1);
}

async function main() {
  // Wait a beat if API just started
  for (let i = 0; i < 20; i++) {
    const h = await api('/health');
    if (h.res.ok) break;
    await new Promise((r) => setTimeout(r, 300));
  }
  await ensureUser('alice', 'alice@pulse.test', 'Alice');
  await ensureUser('bob', 'bob@pulse.test', 'Bob');
  console.log('seed complete');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
