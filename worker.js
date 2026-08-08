/* ============================================================================
   Venue dashboard - Worker shell (ships in the FC Member Dashboard Kit)

   You are the AI running this build. This file is YOURS to finish; the owner
   never sees it. The shell already does the hard plumbing:

     - serves the dashboard page
     - a metrics API with a fixed contract the page already understands
     - an OAuth2 begin/callback flow with token storage
     - automatic access-token refresh, INCLUDING rotating refresh tokens
       (Xero rotates the refresh token on every refresh - the store persists
       the new one every time; never cache tokens outside the store)
     - plain-English connection status for the Connections screen
     - the no-API rungs built in: POST /api/ingest (file/export data in),
       an email() handler stub for emailed reports, a scheduled() cron hook,
       and a KV day-store the export-fed adapters read from

   What you fill in: the three ADAPTERS (accounting / pos / rostering), each
   marked with  >>> ADAPTER ...  blocks. Wire them against the provider's
   CURRENT documentation, per capability-matrix.md and playbook.md.

   Rules that bind every adapter (kpi-spec.md is the law):
     - accounting supplies EVERY money figure, always ex GST/sales tax
     - pos supplies ONE number: completed transaction count (no voids/refunds)
     - rostering supplies rostered cost only (projected wage %)
     - read-only scopes/permissions everywhere
     - secrets ONLY via Worker secrets (wrangler secret put NAME) - never in
       this file, never in the repo, never echoed to the owner

   Bindings expected (wrangler.toml): TOKENS (KV). Secrets: see each adapter.
============================================================================ */

import dashboardHtml from './dashboard.html';

/* ----------------------------------------------------------------------------
   Provider adapters - THE PART YOU BUILD.
   Flip `configured: true` per source as you wire it. Until then the
   dashboard honestly shows "not configured" (never a fake zero).
---------------------------------------------------------------------------- */
/* OPTIONAL no-API hooks any adapter may add (the fallback-ladder rungs):
     mode: 'export'           - source is fed by exports, not a live API
     parseExport(env, h, raw) - raw = { text, contentType }: parse the tool's
                                exported CSV/report into day rows:
                                  pos:        [{ date:'YYYY-MM-DD', count }]
                                  accounting: [{ date, revenue, cogs, wagesSuper, overheads }]
                                  rostering:  [{ date, cost }]
                                Adding parseExport makes the dashboard's
                                Connections screen offer a file-upload panel
                                for this source (the guided-upload rung).
     scheduledPull(env, h)    - cron hook (uncomment [triggers] in
                                wrangler.toml): fetch the tool's own export
                                (its report scheduler's output, a saved export
                                URL) and h.saveIngestedRows(rows).
   In export mode, implement fetchRange/fetchMonthly via h.readIngested /
   h.monthlyIngested instead of provider calls. Emailed reports: complete the
   email() handler at the bottom (needs the owner's domain on their Cloudflare
   with Email Routing pointed at this Worker). Ingest auth: the INGEST_TOKEN
   secret; if the owner uploads by hand, that same value is their upload code. */
/* ---- Xero P&L report parser (maps a ProfitAndLoss report to the 4 figures) ----
   Revenue = trading Income section (Other Income excluded); COGS = Cost of Sales
   section; within Operating Expenses, wage/super accounts -> wagesSuper, the rest
   -> overheads. All ex-GST (Xero P&L accounts are GST-exclusive). */
const XERO_WAGE_RE = /payroll|wage|salar|kiwisaver|superannuat|\bsuper\b/i;
function xeroNum(v) {
  const n = parseFloat(String(v == null ? '' : v).replace(/,/g, ''));
  return isFinite(n) ? n : 0;
}
function xeroLastCell(cells) {
  if (!Array.isArray(cells) || !cells.length) return 0;
  return xeroNum(cells[cells.length - 1].Value);
}
function xeroAccountName(cells) {
  return (Array.isArray(cells) && cells[0] && cells[0].Value) || '';
}
function parseXeroPnl(report) {
  const rows = (report && report.Reports && report.Reports[0] && report.Reports[0].Rows) || [];
  let revenue = 0, cogs = 0, wagesSuper = 0, overheads = 0;
  for (const sec of rows) {
    if (sec.RowType !== 'Section') continue;
    const title = (sec.Title || '').toLowerCase();
    const isOther = title.indexOf('other income') >= 0;
    const isCogs = title.indexOf('cost of sales') >= 0 || title.indexOf('cost of goods') >= 0;
    const isIncome = !isOther && !isCogs &&
      (title.indexOf('income') >= 0 || title.indexOf('revenue') >= 0 ||
       title.indexOf('sales') >= 0 || title.indexOf('turnover') >= 0);
    const isOpex = !isCogs && !isIncome && !isOther &&
      (title.indexOf('expense') >= 0 || title.indexOf('overhead') >= 0 ||
       title.indexOf('administrative') >= 0);
    const secRows = sec.Rows || [];
    for (const r of secRows) {
      if (r.RowType !== 'Row') continue; /* skip SummaryRow to avoid double-count */
      const name = xeroAccountName(r.Cells);
      const val = xeroLastCell(r.Cells);
      if (isCogs) cogs += val;
      else if (isIncome) revenue += val;
      else if (isOpex) { if (XERO_WAGE_RE.test(name)) wagesSuper += val; else overheads += val; }
    }
  }
  return { revenue: revenue, cogs: cogs, wagesSuper: wagesSuper, overheads: overheads };
}

const ADAPTERS = {

  /* >>> ADAPTER 1: ACCOUNTING (connect this FIRST - it feeds most of the board)
     Contract:
       auth: 'oauth' with the oauth{} block filled, or 'token' for a pasted key
       status(env, h)        -> { connected, org, sandbox, lastSync }
       fetchRange(env, h, q) -> { revenue, cogs, wagesSuper, overheads }
                                 (numbers, ex GST/sales tax, for q.from..q.to
                                  inclusive, dates in the venue's books)
       fetchMonthly(env, h, q)-> { months:['YYYY-MM',...], revenue:[...],
                                   cogs:[...], wagesSuper:[...], overheads:[...] }
                                 (align arrays to months; null where no data)
     Map the owner's P&L faithfully: Revenue/Income section (trading income
     only - Other Income excluded), Cost of Sales section, wage + super
     accounts, Operating Expenses less wages/super. Do not re-categorise
     their books. See kpi-spec.md.
     Example (Xero): oauth with tokenAuth:'basic' (the token endpoint wants
     HTTP Basic client auth), scopes 'offline_access
     accounting.reports.profitandloss.read', P&L report endpoint, org name
     from the connections endpoint, sandbox = tenant name contains
     'Demo Company'. Secrets: ACCOUNTING_CLIENT_ID, ACCOUNTING_CLIENT_SECRET.
  */
  accounting: {
    configured: true,
    auth: 'oauth',
    oauth: {
      authorizeUrl: 'https://login.xero.com/identity/connect/authorize',
      tokenUrl: 'https://identity.xero.com/connect/token',
      scopes: 'offline_access accounting.reports.profitandloss.read',
      clientIdSecret: 'ACCOUNTING_CLIENT_ID',
      clientSecretSecret: 'ACCOUNTING_CLIENT_SECRET',
      tokenAuth: 'basic'   /* Xero's token endpoint wants HTTP Basic client auth */
    },
    /* Resolve (and cache in the token record) the Xero tenant id + org name. */
    async _tenant(env, h) {
      const tokens = await h.getTokens();
      if (tokens && tokens.tenantId) return tokens.tenantId;
      const conns = await h.fetchJson('https://api.xero.com/connections', {});
      const org = (Array.isArray(conns) ? conns : []).find(function (c) { return c.tenantType === 'ORGANISATION'; }) ||
                  (Array.isArray(conns) ? conns[0] : null);
      if (!org) { const e = new Error('no xero organisation on this login'); e.status = 401; throw e; }
      await h.saveTokens(Object.assign({}, tokens || {}, { tenantId: org.tenantId, org: org.tenantName }));
      return org.tenantId;
    },
    async _report(env, h, from, to) {
      const tenant = await this._tenant(env, h);
      const url = 'https://api.xero.com/api.xro/2.0/Reports/ProfitAndLoss?fromDate=' + from + '&toDate=' + to;
      return h.fetchJson(url, { headers: { 'Xero-tenant-id': tenant, 'Accept': 'application/json' } });
    },
    async status(env, h) {
      const tokens = await h.getTokens();
      if (!tokens || !tokens.access_token) return { connected: false };
      const conns = await h.fetchJson('https://api.xero.com/connections', {});
      const org = (Array.isArray(conns) ? conns : []).find(function (c) { return c.tenantType === 'ORGANISATION'; }) ||
                  (Array.isArray(conns) ? conns[0] : null);
      if (!org) return { connected: false };
      await h.saveTokens(Object.assign({}, tokens, { tenantId: org.tenantId, org: org.tenantName }));
      return {
        connected: true,
        org: org.tenantName,
        sandbox: /demo company/i.test(org.tenantName || ''),
        lastSync: null
      };
    },
    async fetchRange(env, h, q) {
      const rep = await this._report(env, h, q.from, q.to);
      return parseXeroPnl(rep);
    },
    async fetchMonthly(env, h, q) {
      const months = monthList(q.fromMonth, q.toMonth);
      const revenue = [], cogs = [], wagesSuper = [], overheads = [];
      for (const mo of months) {
        const parts = mo.split('-').map(Number);
        const y = parts[0], m = parts[1];
        const from = mo + '-01';
        const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
        const to = mo + '-' + String(last).padStart(2, '0');
        try {
          const v = parseXeroPnl(await this._report(env, h, from, to));
          revenue.push(v.revenue); cogs.push(v.cogs); wagesSuper.push(v.wagesSuper); overheads.push(v.overheads);
        } catch (e) {
          revenue.push(null); cogs.push(null); wagesSuper.push(null); overheads.push(null);
        }
      }
      return { months: months, revenue: revenue, cogs: cogs, wagesSuper: wagesSuper, overheads: overheads };
    }
  },

  /* >>> ADAPTER 2: POS
     Contract:
       status(env, h)        -> { connected, org, sandbox, lastSync }
       fetchRange(env, h, q) -> { count }   (completed transactions only;
                                  exclude voided/cancelled; refunds never
                                  reduce the count; q.rollover shifts the
                                  trading-day boundary by that many hours)
       fetchMonthly(env, h, q)-> { months:[...], count:[...] }
     NEVER return a dollar figure from the POS.
     Example (Square): pasted production personal access token (secret
     POS_API_TOKEN); sandbox sign = token only answers on
     connect.squareupsandbox.com.
  */
  pos: {
    /* Manual count rung: Dnero has no self-serve API, so the owner types one
       number per month (the count of completed transactions). Stored in KV as
       poscount:YYYY-MM. Money never comes from here - only the count. A period
       returns a count only when it is exactly whole calendar months that all
       have a saved figure; otherwise null (honest "not configured"). */
    configured: true,
    auth: 'manual',
    oauth: {},
    async status(env, h) {
      return { connected: true, org: null, manualCount: true, sandbox: false, lastSync: null };
    },
    async fetchRange(env, h, q) {
      const months = wholeMonthsInRange(q.from, q.to);
      if (!months) return { count: null };
      let total = 0;
      for (const mo of months) {
        const v = await env.TOKENS.get('poscount:' + mo);
        if (v == null || v === '') return { count: null };
        const n = parseInt(v, 10);
        if (!isFinite(n)) return { count: null };
        total += n;
      }
      return { count: total };
    },
    async fetchMonthly(env, h, q) {
      const months = monthList(q.fromMonth, q.toMonth);
      const count = [];
      for (const mo of months) {
        const v = await env.TOKENS.get('poscount:' + mo);
        const n = (v == null || v === '') ? NaN : parseInt(v, 10);
        count.push(isFinite(n) ? n : null);
      }
      return { months: months, count: count };
    }
  },

  /* >>> ADAPTER 3: ROSTERING (optional - only if the owner has one)
     Contract:
       status(env, h)        -> { connected, org, sandbox, lastSync }
       fetchRange(env, h, q) -> { cost }    (rostered labour cost for the
                                  period; powers the PROJECTED wage % only)
     If this source is gated or absent, leave configured:false - the actual
     Wage % from accounting already covers the board (fallback ladder).
     Example (Deputy): pasted permanent token (secret ROSTERING_API_TOKEN).
  */
  rostering: {
    configured: false,
    auth: null,
    oauth: {},
    async status(env, h) { return { connected: false }; },
    async fetchRange(env, h, q) { throw new NotConfigured('rostering'); },
    async fetchMonthly(env, h, q) { return { months: [], cost: [] }; }
  }
};

/* ============================================================================
   Everything below is the shell. You should rarely need to edit it.
============================================================================ */

class NotConfigured extends Error {
  constructor(source) { super('not configured: ' + source); this.source = source; }
}

const PLAIN_ERRORS = {
  401: 'This connection needs reconnecting. Click Reconnect and log in again.',
  403: 'This connection is missing a permission it needs. Your AI will sort out the access.',
  429: 'The tool is asking us to slow down. Wait a few minutes, then refresh.',
  500: 'The tool had a problem at its end. Try refresh in a little while.'
};
function plainError(status) {
  return PLAIN_ERRORS[status] || ('Something went wrong talking to this tool (code ' + status + '). Try refresh; if it persists, tell your AI.');
}

/* ---------------- Token store (KV) with refresh built in ---------------- */

async function getTokens(env, source) {
  const raw = await env.TOKENS.get('tokens:' + source);
  return raw ? JSON.parse(raw) : null;
}
async function saveTokens(env, source, tokens) {
  await env.TOKENS.put('tokens:' + source, JSON.stringify(tokens));
}
async function clearTokens(env, source) {
  await env.TOKENS.delete('tokens:' + source);
}
async function noteSync(env, source) {
  await env.TOKENS.put('lastSync:' + source, new Date().toISOString());
}
async function lastSync(env, source) {
  return await env.TOKENS.get('lastSync:' + source);
}

/* Build the POST to an OAuth token endpoint, honouring the adapter's client-auth
   method. tokenAuth:'basic' -> client id+secret in an HTTP Basic Authorization
   header, NOT in the body (Xero and most OpenID providers expect this); 'post'
   (or unset, for back-compat) -> client_id/client_secret in the form body. */
function tokenRequestInit(cfg, params, env) {
  const id = env[cfg.clientIdSecret] || '';
  const secret = env[cfg.clientSecretSecret] || '';
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
  const body = new URLSearchParams(params);
  if ((cfg.tokenAuth || 'post') === 'basic') {
    headers['Authorization'] = 'Basic ' + btoa(id + ':' + secret);
  } else {
    body.set('client_id', id);
    body.set('client_secret', secret);
  }
  return { method: 'POST', headers: headers, body: body.toString() };
}

/* Returns a valid access token for an OAuth source, refreshing (and
   persisting the ROTATED refresh token) when needed. */
async function getValidAccessToken(env, source) {
  const adapter = ADAPTERS[source];
  const tokens = await getTokens(env, source);
  if (!tokens || !tokens.access_token) { const e = new Error('no tokens'); e.status = 401; throw e; }
  const skewMs = 60 * 1000;
  if (!tokens.expires_at || Date.now() < tokens.expires_at - skewMs) return tokens.access_token;

  /* refresh */
  const cfg = adapter.oauth || {};
  if (!tokens.refresh_token || !cfg.tokenUrl) { const e = new Error('cannot refresh'); e.status = 401; throw e; }
  const res = await fetch(cfg.tokenUrl, tokenRequestInit(cfg, {
    grant_type: 'refresh_token',
    refresh_token: tokens.refresh_token
  }, env));
  if (!res.ok) {
    /* refresh failed: force a reconnect rather than silently serving stale data */
    const e = new Error('refresh failed'); e.status = 401; throw e;
  }
  const fresh = await res.json();
  const updated = {
    ...tokens,
    access_token: fresh.access_token,
    /* CRITICAL: many providers (Xero!) rotate the refresh token - always keep the new one */
    refresh_token: fresh.refresh_token || tokens.refresh_token,
    expires_at: Date.now() + ((fresh.expires_in || 1800) * 1000)
  };
  await saveTokens(env, source, updated);
  return updated.access_token;
}

/* Helpers handed to every adapter call */
function makeHelpers(env, source) {
  return {
    getValidAccessToken: () => getValidAccessToken(env, source),
    getTokens: () => getTokens(env, source),
    saveTokens: (t) => saveTokens(env, source, t),
    noteSync: () => noteSync(env, source),
    saveIngestedRows: (rows) => saveIngestedRows(env, source, rows),
    readIngested: (from, to) => readIngested(env, source, from, to),
    monthlyIngested: (fromMonth, toMonth) => monthlyIngested(env, source, fromMonth, toMonth),
    /* fetch JSON with one automatic refresh-and-retry on 401 (OAuth sources) */
    fetchJson: async (url, init, opts) => {
      const useAuth = !opts || opts.auth !== false;
      const doFetch = async () => {
        const headers = new Headers((init && init.headers) || {});
        if (useAuth && ADAPTERS[source].auth === 'oauth') {
          headers.set('Authorization', 'Bearer ' + await getValidAccessToken(env, source));
        }
        return fetch(url, { ...(init || {}), headers });
      };
      let res = await doFetch();
      if (res.status === 401 && useAuth && ADAPTERS[source].auth === 'oauth') {
        const t = await getTokens(env, source);
        if (t) { t.expires_at = 0; await saveTokens(env, source, t); } /* force refresh */
        res = await doFetch();
      }
      if (!res.ok) { const e = new Error('HTTP ' + res.status); e.status = res.status; throw e; }
      return res.json();
    }
  };
}

/* ---------------- OAuth begin + callback (generic, per-source) ---------- */

function randomState() {
  const a = new Uint8Array(16);
  crypto.getRandomValues(a);
  return Array.from(a).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/* ---------------- Owner login: one passcode + a signed session cookie ----
   The owner sets the dashboard password on the dashboard's own FIRST-RUN screen;
   it is stored PBKDF2-hashed in KV (sys:passcode_hash) - no Cloudflare Variables
   step. (env.DASHBOARD_PASSCODE still works as an override, e.g. when the
   one-click button collected it in its wizard.) The session-signing key is
   generated and stored in KV on first run (env.SESSION_SECRET overrides if set).
   Until a password exists the dashboard shows the SET-PASSWORD screen, never an
   open page; once set, the page and every data route require a valid session. */
const SESSION_TTL = 60 * 60 * 24 * 30;
/* A password exists if the owner set one (first-run -> KV) or the deploy provided
   one as an env override (the one-click button's wizard). */
async function passcodeSet(env) {
  if (env.DASHBOARD_PASSCODE) return true;
  if (env.TOKENS) return !!(await env.TOKENS.get('sys:passcode_hash'));
  return false;
}
/* PBKDF2-SHA256 of a passcode with a hex salt -> base64url (at-rest hashing). */
async function pbkdf2B64(passcode, saltHex) {
  const salt = Uint8Array.from((saltHex.match(/.{2}/g) || []).map((h) => parseInt(h, 16)));
  const km = await crypto.subtle.importKey('raw', new TextEncoder().encode(passcode), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: salt, iterations: 100000, hash: 'SHA-256' }, km, 256);
  return b64url(bits);
}
let _sessionKeyCache = null;
async function getSessionKey(env) {
  if (env.SESSION_SECRET) return env.SESSION_SECRET;
  if (_sessionKeyCache) return _sessionKeyCache;
  if (env.TOKENS) {
    let k = await env.TOKENS.get('sys:session_secret');
    if (!k) {
      const b = new Uint8Array(32);
      crypto.getRandomValues(b);
      k = Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join('');
      await env.TOKENS.put('sys:session_secret', k);
    }
    _sessionKeyCache = k;
    return k;
  }
  return env.DASHBOARD_PASSCODE || 'unset';
}
function b64url(buf) {
  return btoa(String.fromCharCode.apply(null, new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function hmacB64(secret, msg) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg)));
}
async function shaB64(s) {
  return b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
}
function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
function b64urlEnc(str) { return btoa(String(str)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function b64urlDec(str) { try { return atob(String(str).replace(/-/g, '+').replace(/_/g, '/')); } catch (e) { return ''; } }
async function makeSession(env, role, user) {
  const payload = 'v2.' + Math.floor(Date.now() / 1000) + '.' + (role || 'owner') + '.' + b64urlEnc(user || 'owner');
  return payload + '.' + await hmacB64(await getSessionKey(env), payload);
}
async function getSession(env, token) {
  if (!token) return null;
  const i = token.lastIndexOf('.');
  if (i < 0) return null;
  const payload = token.slice(0, i);
  if (!timingSafeEqual(token.slice(i + 1), await hmacB64(await getSessionKey(env), payload))) return null;
  const parts = payload.split('.');
  const issued = parseInt(parts[1], 10);
  if (!issued || (Date.now() / 1000 - issued) > SESSION_TTL) return null;
  if (parts[0] === 'v2') return { role: parts[2] || 'owner', user: b64urlDec(parts[3] || '') || 'owner' };
  return { role: 'owner', user: 'owner' };
}
async function validSession(env, token) { return !!(await getSession(env, token)); }
function getCookie(request, name) {
  const m = (request.headers.get('Cookie') || '').match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
  return m ? decodeURIComponent(m[1]) : null;
}
async function isLoggedIn(request, env) {
  return await validSession(env, getCookie(request, 'vd_session'));
}
async function sessionOf(request, env) { return await getSession(env, getCookie(request, 'vd_session')); }

/* ---------------- Staff users + role-based access ---------------- */
const ROLES = ['owner', 'manager', 'headchef', 'supervisor'];
function normId(x) { return String(x || '').trim().toLowerCase().replace(/[^a-z0-9._@-]/g, ''); }
async function getUser(env, id) { if (!env.TOKENS) return null; const raw = await env.TOKENS.get('user:' + id); return raw ? JSON.parse(raw) : null; }
async function listUsers(env) {
  const out = [];
  try { const l = await env.TOKENS.list({ prefix: 'user:' }); for (const k of l.keys) { const u = await getUser(env, k.name.slice(5)); if (u) out.push({ id: u.id, name: u.name, role: u.role }); } } catch (e) {}
  out.sort(function (a, b) { return a.id < b.id ? -1 : 1; });
  return out;
}
async function putUser(env, id, name, role, password) {
  const saltB = new Uint8Array(16); crypto.getRandomValues(saltB);
  const saltHex = Array.from(saltB).map(function (x) { return x.toString(16).padStart(2, '0'); }).join('');
  const hash = await pbkdf2B64(password, saltHex);
  await env.TOKENS.put('user:' + id, JSON.stringify({ id: id, name: name, role: role, saltHex: saltHex, hash: hash }));
}
async function apiUserSave(env, request) {
  let b; try { b = await request.json(); } catch (e) { return json({ ok: false }, 400); }
  const id = normId(b && b.id);
  const name = String((b && b.name) || '').slice(0, 60) || id;
  const role = String((b && b.role) || '');
  const password = String((b && b.password) || '');
  if (!id) return json({ ok: false, plain: 'Enter a username (letters and numbers, no spaces).' }, 400);
  if (id === 'owner') return json({ ok: false, plain: 'That username is reserved.' }, 400);
  if (['manager', 'headchef', 'supervisor', 'trainee'].indexOf(role) < 0) return json({ ok: false, plain: 'Pick a role.' }, 400);
  if (password.length < 6) return json({ ok: false, plain: 'Password must be at least 6 characters.' }, 400);
  await putUser(env, id, name, role, password);
  return json({ ok: true, id: id });
}
async function apiUserDelete(env, request) {
  let b; try { b = await request.json(); } catch (e) { return json({ ok: false }, 400); }
  const id = normId(b && b.id);
  if (id && env.TOKENS) await env.TOKENS.delete('user:' + id);
  return json({ ok: true });
}
const TRAINING_DEFAULT = { sections: [
  { id: 'onboarding', title: 'Onboarding / new starter', lessons: [] },
  { id: 'coffee', title: 'Coffee & barista', lessons: [] },
  { id: 'foh', title: 'Front of house / service', lessons: [] },
  { id: 'kitchen', title: 'Kitchen & food safety', lessons: [] }
] };
async function getTraining(env) {
  if (!env.TOKENS) return TRAINING_DEFAULT;
  const raw = await env.TOKENS.get('training:content');
  if (!raw) return TRAINING_DEFAULT;
  try { return JSON.parse(raw); } catch (e) { return TRAINING_DEFAULT; }
}
async function apiTrainingSave(env, request) {
  let b; try { b = await request.json(); } catch (e) { return json({ ok: false }, 400); }
  const content = b && b.content;
  if (!content || !Array.isArray(content.sections)) return json({ ok: false }, 400);
  const clean = { sections: content.sections.slice(0, 50).map(function (sec) {
    return {
      id: String(sec.id || ('s' + Date.now())).slice(0, 40),
      title: String(sec.title || '').slice(0, 120),
      lessons: Array.isArray(sec.lessons) ? sec.lessons.slice(0, 100).map(function (l) {
        return {
          id: String(l.id || ('l' + Date.now())).slice(0, 40),
          title: String(l.title || '').slice(0, 160),
          video: String(l.video || '').slice(0, 400),
          steps: String(l.steps || '').slice(0, 4000)
        };
      }) : []
    };
  }) };
  await env.TOKENS.put('training:content', JSON.stringify(clean));
  return json({ ok: true });
}
function roleMetrics(role) {
  if (role === 'owner') return ['revenue', 'transactions', 'acs', 'cogs', 'wage', 'overheads', 'profit'];
  if (role === 'trainee') return [];
  if (role === 'manager' || role === 'headchef') return ['revenue', 'transactions', 'acs', 'cogs', 'wage'];
  return ['revenue', 'transactions', 'acs'];
}
function roleAccFields(role) {
  if (role === 'owner') return ['revenue', 'cogs', 'wagesSuper', 'overheads'];
  if (role === 'trainee') return [];
  if (role === 'manager' || role === 'headchef') return ['revenue', 'cogs', 'wagesSuper'];
  return ['revenue'];
}
function filterAccObj(obj, allowed) { if (!obj || typeof obj !== 'object') return obj; const out = {}; allowed.forEach(function (k) { if (k in obj) out[k] = obj[k]; }); return out; }
function filterPeriodsForRole(periods, role) {
  if (role === 'owner' || !periods) return periods;
  const allowed = roleAccFields(role);
  const P = JSON.parse(JSON.stringify(periods));
  ['cur', 'prev', 'yoy'].forEach(function (sl) { if (P[sl] && P[sl].accounting) P[sl].accounting = filterAccObj(P[sl].accounting, allowed); });
  return P;
}
function filterTrendForRole(trend, role) {
  if (role === 'owner' || !trend) return trend;
  const allowed = roleAccFields(role);
  const T = JSON.parse(JSON.stringify(trend));
  if (T.accounting) { const a = {}; allowed.forEach(function (k) { if (k in T.accounting) a[k] = T.accounting[k]; }); T.accounting = a; }
  return T;
}
function htmlResponse(html) {
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer' } });
}
async function apiLogin(env, request) {
  if (!(await passcodeSet(env))) return json({ ok: false, error: 'no_passcode' }, 400);
  let body; try { body = await request.json(); } catch (e) { return json({ ok: false }, 400); }
  const passcode = String((body && body.passcode) || '');
  const username = normId(body && body.username);
  let role = null, user = null;
  if (username) {
    const u = await getUser(env, username);
    if (u && timingSafeEqual(await pbkdf2B64(passcode, u.saltHex), u.hash)) { role = u.role; user = u.id; }
  } else {
    let okPass = false;
    if (env.DASHBOARD_PASSCODE) {
      okPass = timingSafeEqual(await shaB64(passcode), await shaB64(env.DASHBOARD_PASSCODE));
    } else if (env.TOKENS) {
      const stored = await env.TOKENS.get('sys:passcode_hash');
      if (stored) {
        const dot = stored.indexOf('.');
        okPass = timingSafeEqual(await pbkdf2B64(passcode, stored.slice(0, dot)), stored.slice(dot + 1));
      }
    }
    if (okPass) { role = 'owner'; user = 'owner'; }
  }
  if (!role) return json({ ok: false }, 401);
  const token = await makeSession(env, role, user);
  return new Response(JSON.stringify({ ok: true, role: role }), { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Set-Cookie': 'vd_session=' + encodeURIComponent(token) + '; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=' + SESSION_TTL } });
}

/* First-run (or authenticated change): set the dashboard password. Allowed only
   when none is set yet, OR when the caller already holds a valid session - so a
   stranger can never overwrite an existing password. Stored PBKDF2-hashed in KV. */
async function apiSetup(env, request, sess) {
  if (!env.TOKENS) return json({ ok: false, error: 'no_store' }, 400);
  if ((await passcodeSet(env)) && !(sess && sess.role === 'owner')) return json({ ok: false, error: 'exists' }, 403);
  let body; try { body = await request.json(); } catch (e) { return json({ ok: false }, 400); }
  const passcode = String((body && body.passcode) || '');
  if (passcode.length < 6) return json({ ok: false, error: 'too_short' }, 400);
  const saltB = new Uint8Array(16); crypto.getRandomValues(saltB);
  const saltHex = Array.from(saltB).map((x) => x.toString(16).padStart(2, '0')).join('');
  await env.TOKENS.put('sys:passcode_hash', saltHex + '.' + (await pbkdf2B64(passcode, saltHex)));
  const token = await makeSession(env, 'owner', 'owner');
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Set-Cookie': 'vd_session=' + encodeURIComponent(token) + '; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=' + SESSION_TTL } });
}
function apiLogout() {
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Set-Cookie': 'vd_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0' } });
}
function loginPage() {
  return '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Sign in</title>'
    + '<link href="https://fonts.googleapis.com/css2?family=Khand:wght@600;700&family=DM+Sans:wght@300;400;500&display=swap" rel="stylesheet">'
    + '<style>'
    + 'body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#FFFFFF;font-family:"DM Sans",sans-serif;color:#2A2420}'
    + '.brandlogo{width:170px;max-width:72%;display:block;margin:0 auto 1.1rem}.box{width:90%;max-width:360px;background:#fffdf9;border:1px solid rgba(13,13,13,0.08);border-radius:16px;padding:2rem 1.75rem}'
    + 'h1{font-family:"Khand",sans-serif;font-size:30px;font-weight:700;color:#43372D;margin:0 0 0.4rem}'
    + 'p{font-size:14px;color:#8C8075;margin:0 0 1.25rem;line-height:1.6}'
    + 'input{width:100%;font-family:"DM Sans",sans-serif;font-size:15px;padding:12px 14px;border:1px solid rgba(13,13,13,0.14);border-radius:10px;background:#fff;color:#2A2420;box-sizing:border-box}'
    + 'input:focus{outline:none;border-color:#6FC0E4}'
    + 'button{width:100%;margin-top:12px;padding:13px;font-size:15px;font-weight:500;font-family:"DM Sans",sans-serif;color:#43372D;background:#6FC0E4;border:none;border-radius:10px;cursor:pointer}'
    + '.err{color:#C04B28;font-size:13px;margin-top:10px;min-height:16px}'
    + '</style></head><body>'
    + '<div class="box"><img class="brandlogo" src="'+'data:image/png;base64,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'+'" alt="Henry & Ted"><h1>Your dashboard</h1><p>Owners: enter just your password. Staff: your username and password.</p>'
    + '<form id="f"><input id="u" type="text" autocomplete="username" placeholder="Username (staff only)" autofocus><input id="p" type="password" autocomplete="current-password" placeholder="Password" style="margin-top:10px">'
    + '<button type="submit">Sign in</button><div class="err" id="e"></div></form></div>'
    + '<script>'
    + 'var f=document.getElementById("f");'
    + 'f.onsubmit=function(ev){ev.preventDefault();var e=document.getElementById("e");e.textContent="";'
    + 'fetch("/api/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({username:document.getElementById("u").value,passcode:document.getElementById("p").value})})'
    + '.then(function(r){if(r.ok){location.reload();}else{e.textContent="That password did not match. Try again.";}})'
    + '.catch(function(){e.textContent="Something went wrong. Try again.";});};'
    + '</script></body></html>';
}

function setupPage() {
  return '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Set your password</title>'
    + '<link href="https://fonts.googleapis.com/css2?family=Khand:wght@600;700&family=DM+Sans:wght@300;400;500&display=swap" rel="stylesheet">'
    + '<style>'
    + 'body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#FFFFFF;font-family:"DM Sans",sans-serif;color:#2A2420}'
    + '.brandlogo{width:170px;max-width:72%;display:block;margin:0 auto 1.1rem}.box{width:90%;max-width:360px;background:#fffdf9;border:1px solid rgba(13,13,13,0.08);border-radius:16px;padding:2rem 1.75rem}'
    + 'h1{font-family:"Khand",sans-serif;font-size:30px;font-weight:700;color:#43372D;margin:0 0 0.4rem}'
    + 'p{font-size:14px;color:#8C8075;margin:0 0 1.25rem;line-height:1.6}'
    + 'input{width:100%;font-family:"DM Sans",sans-serif;font-size:15px;padding:12px 14px;border:1px solid rgba(13,13,13,0.14);border-radius:10px;background:#fff;color:#2A2420;box-sizing:border-box}'
    + 'input:focus{outline:none;border-color:#6FC0E4}'
    + 'button{width:100%;margin-top:12px;padding:13px;font-size:15px;font-weight:500;font-family:"DM Sans",sans-serif;color:#43372D;background:#6FC0E4;border:none;border-radius:10px;cursor:pointer}'
    + '.err{color:#C04B28;font-size:13px;margin-top:10px;min-height:16px}'
    + '</style></head><body>'
    + '<div class="box"><img class="brandlogo" src="'+'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAASwAAADCCAMAAADEmg8BAAAAwFBMVEX///////7+//7//v7+/v/+/v7+/v3+/f39/v39/f39/fz8/fz9/Pz8/Pz8/Pv8+/v7+/v4+Pjy8fDp5+be3NrQzcqK1/uG0veEzvGEzfGEzfCEze+EzO+Dy+2CyOq/u7evqqSDr8KUmpqTjIR4hYh5dnFva2VnYFdeVUxXTEFRRTpPQjdOQTVNQTZNQDRMPzNLPjJLPTFKPTFKPC9IOi5HOSxINihFNytENipGNSdCNChBMydAMiU/MSQ+MSQ9LiFK3qw6AAAkxklEQVR42u19C3uiWBYtmVySi1erVECdRAOKPA8C4SHIQ///v7p7HzSRhynNmKrqtOebr6c7laR0uc/aaz9hmM8cTf3BMrdz3tF3ItO5wXDWudN3C6Z3w+FcsJQbWGcdlhuaO/kG1llY9Rk5i0SGu0HxK6PqdRlGtBK9f/OGH+HU6XUpQEOZBFvpZlinT4kTMxAkxUziRL5h9eHhRVnRDCdJ49y4EdYHN7B7J2lWXOy2eZZm5mJ4E6QfgMUsdtk29UxDVxV5yKBdAdX3etzDA9ftdW5cf4RVT7RDU5EEfkD/u/+zV7uFN0M7nB4j7xxPKGHr/3wsvzoUpIWiwlEW4pC5v8G0NyyWF61IPhhTnweYVN0M0ixNkjRJs8SU4ZtuQB2Otgt0ZSGDLWmGRWGKAaUsicI4TX1/p3A393igJI43dtsizzNEKY7BmDxTU2RJEkURhZd1CxWP3eFgoZMoSdMkJKauLiRheKTA1MQ3h8ztIr6hxXC8KKEp8cOD+Or1uh2u0/vB9PUwEZnuDaY3+XD0HyCxuCM76jNSmt3uYeU8dECGdrkHtsVdWrdk4Pl2d8ucnn045gbWmVbV6TOin9/A+hVOEEUjg4mmn98IvsbjHMd1QDCUZ58OZIaSGoZuKNxSXO/KoS2xgMG0ZmYpCba31OmxJmWYAS8IIgpTGc5CUTTd9LMi8QAq85aSP8KqLym6YTlhlED8nNOTJeGrTdwoT4zF8IbVuzLgdQyhIYaOoijcnyjJijy2dEUcMDesjsSBtgsDyzQM/fioykISefyG3i2GPpxHhrcjBQLoQZ99ZPfnPei5peCrjMVbidD88mOvGk/fTqk9MZrpc7fU8Rmnx0hFJMP/V2j8/gZduzvktDxRMOnHleq9w92XUvXmBRvn4T+8kSTmQjgK/9h+n6PsfztNh6jnQephQZqqd1XTQUhoinjLvLfp0qESpShEs4zWeKg2jbJ0cdOjbbbFiKoZUSFPIx5ALU0jspNuhYo2/cAwQ1GmJXtFWSxkiKglLY6MWwtgu09sfk1NvVsiq820ur2f/Z8g2jmus0//DTgxD2+NbW1BT9PU+oyS3SyrDauepCjy4C3kYbuAkRyFxuCmHupYsUNtmyUQIpZmxGGWWVASspNv3rAlPNxZUUjKugQCNpRUJ7N22uDxZlgNsOQs0PQox/kmQEdUzDRx/J12a55ptaw0l38Yhd654xhRT7IgTFNT7t6wagt3xChTGXm7Ehh2aBYkjg1FGjA3rFqdIW9lGiN4hQzEHpJEwzIF0727QdMaHOqF0e8b4A8BrGKBSHVvZtV+uoyys3hG3el9pq/pDNe7+36354oMnwUikJYtMMzgOwpR7nrv6QFIq5CQ5iVmwDLfsfzVv96vumc1UOuAmLoPBXvfqrTKcrJ1vURmD0hLYX7oiYed3SJtWf4+zpBjhCyzrqawe5y00xhGze043+aRpSvS8PvILIhQckL4a72fPiPvjAEyvG1ZxAmSPDfl/j8WLfaB7VY8oZZeb/ChxwhWCNpByux4m6ehQ4gdQmj4ParULDO0PIhQuCvdaZFEq0hkBDfSFUUz413mOmSnccDz7D8QHEHTgc/vj4SRfa1OzwdGDELbAdkwNHcSg4PlspaAeW2VUrJy/ziK2oVHG2LAe+Wh3rmWlZqR45OtzA70TFfpTKYompHrpIpI51u5f5hl8bYLb4f5cWBkI8yU6wzk4gdhE+Il4A71OMSaYbYrZMH3XSeLLENXROafpSI4eEfETSXm5144hHYuXac5HXxFEutyaieKHHjuyoFjewWvbG1v5QZRXCTKX9qQxHYOrejVyeQOhLnED0UKEBhD4djXEQ4sMzCCXBk4vpvlr97+2IUo7WzPsVeEEOctO/9X2U+vqhTZY8U+0AorJJTU0Rgi/TqfNiazXLjgZkRs+4CVR7aSmDtukoPiClb29u+s4+PqDnokjqlsCQAe1jMrNnmGQ+HgFleap4Egmt5veZuFrmPT47hpxIs5iXVJlBSSkEz70+1H9coJ+yAqOkmLgnJsqi/EAbyVI9rijdRK9SHOS2Ykla4HlpPL+9aQLZ4i9XQJb7pF25UFPf7Tg7+NS/TI8MEu9ghxwxgn4IsiNqTjl1iilWsDFA7etQJDvIaob/t0AEWmRxJYhl2AOGH6g36fERwv+NOlaYGvv2ri2uE2IYamKoqqu2m4rcgDRCuxtirTM0Jw9A9Xk1k+gPWjd2yo7AA+ENcS6QQUKIroT65MZNmhmuq9+qsOQkMW+TJR1ReUwNtV0jAQw5mxtVsIEWqu3pXAQs0GYAEqvX55fvTYH4yak9DTFyzXZ9X0j4KFRWDXqTn/Bx2V5l4/IEai5SdiDS0rdAI9uOpUmx6lFKzjg2CtXC+GTws7RH5nOw1bz9SCrPRJVuVojlGTRO3192x2x/UZMYz1wTG79SCO853ISfSf13ptD6BDUoX5WQXrJ1xDUBKOncFVVHL/93LWY5sUrIAFvJ1FGlNZE6AktTUBP8ATOq5dXG8QFz+jk2CBOgVHudiCvnv4TXYF6omv/WXwEtO4ggxN6AWVJh+OFcJI77P3FbQgDlldK9ahWk5Jm2DB51RQsIAcIdSy+N8kHe7u+/rWkavjVRixuFX3zzFi7NlVVPtGXHudQLh6QraLLwdrUbxZlrwzfxtY6Oq9YlEpMXUYMSFV9qaKp7rJBBOidYmDP2kn/3uww7IP2BTZ6XfariGAtbVp3HOwrKtfQxZH1nvd2iAHB/efOIDWkWZHoYAAVuyD08PqoDvHAufXbxzeYPSkn371uGiGrXjDrAUsGcBy7cQDgSrnscj0rxjw4NDZ40mdkDueAwrz/3DHRhMn1cQwopBWmBu/qbEIpncH0c6nSestWB8MeQGXPkmy5ebtYLkh7pYccACWiuj2rtQAUX7MAx4ihoWiVlUJhl++69k7tf/+dfB9RS3kQoaP9P8cm9+gZalCqbk/lzWhiQxekhVNNyyC2ao4yfxV3tBZCBYJTXkAEQ+8UoipZQF/lr1K9bXPSwvVsMIM4tCdXvsIOD12PJdstfe9ll2MhqtLjIHhE/+Y9LssEFvThsACM3Sb//mETGBosJ6ncRTF5fh4GjgOKPheA6yCYPoMf8T2XScpPF2ReOayhYncD64lgaYaTlakoUvguFujV3Ee8O5yx419Uuj84Z2DudlOIVcv3dDyY/HY+iDmiBp6ED0p+cyy6EdG1KIidlZhmsXE1DEGVVQztlMNbK4OFugYvCyiEvi2H/qOE2aZpcmXBPBsu5DyE8+2gzgrtllo6rU30qNsqbqhlZnCGzxdPaxVs4CioqNbBwo+JqDVWaYp/+1PBIccs0jTlRUVoaHK4tv6taEWRzrHNK+hYwGURpi6SU5My03zyPbSwpTPdi0s2HFjtIzGwE7gmziFVlkCd/D2Ukp2kpiEVmKJ+zfZxZDL6FdJS8kOpI/kIJihXTRXUNxj7JtolyofzOM7JMyMhTA4pLAhah7ARxIAeXJNgvdxv4OXxJrED3HNJASRWH09ly6RVnaNVNI9KKkoNPavoZwbqlme4wCJik5khaFUylO8TLYnHMdBtE8KNTzbRWKQzJjkba8MSevihBbKuIAkJjaLMr1+r7NH5+Gxb0SBwFZJq38PohQvXkrAXR1+hajS6usJT3zP3tdVQGaljXwFJsVDo1yz220OrWMkiHEL7lonPmgB/JaWEg18yXUjgXr3oayn2N7JtszAU9JKL8yL40uHSw1SvN/japENKpZB7YtAl6kOF4XH0RSQr90fOCKmpM4q0U9+TGyVIgVvVTRijQ5NlfEnVfUj6kiLBzCMDPhfAVXWGkvj/coX6NwVM0/sFbqpbqt9R+TSWJpaMoQDA5at0xPE5oGIrmufzwI04a4EqUL/gt67zfVZsEIIH9oLiT+HTY0TNOmih4F5fNo/0T8Hg+zjhC3ZCy7UoJHOVkEHO7dUzcoy33Ij0Buh2AIJtdRYv8wboorzzEG3VweLwzArtKQK1QpqFOs4K90/NrgeNzDD9sAUbrlhNtaj65QO2YZGtz7wT/T24t/Bge/ZEiq4uDKW5muydAv3NHYJuB3XMGI7MYYthRUkrZXLX1Ryoa8RJ3n7dbSwlc0KMlPDsUwck16AFkscCFOr39rtwzXMSNCagkDdE+7UCgTdVumD98L+oKvlERjepX/OgSTb2iC4sEgDkrPKPJh4cF03zjNTlYXBQC2sTO03b3cJ/mXigb0bmvAilZ8N0uqwvLmDzydOaVmJbgp2fdx7+259nZ/IWEOgLPvE+BPlbZ2rXyiraEYgvOUfD5w13t8PYz+QBoJGAQ+eA1oslv8WdVka+Jam7O/EgBYomhyP37dLLlRaHCAcwl8s9ak7BMS494uogqbOcUQ6SVKEKwY51eMeOfBY/XJvAVzNhZkTf7do1/AYvzUuipS3cSsENC4dZUSH2O7sV2VuFnCE30oyQOsOYuka/3F6CEqLBryP8AEKoUfadA3IPVm4XGhJ1tYJE1qR3GucfY0CkJDKEelysbksguVz77d8AC5H93KfZN6pNW0UmUSslqMEcAcNhkcw4Dt7hwHswbDBrltrrxPgg5Qzj+TAWwpQbi0BiKTfO6RQqPS3dy2dtp/qawELUkgeRiCGsc+WH/7qB35gZgLDbsNOs8gN8lA9mYwHZAK7Hr/BhWtjeLidW+wEG9KF6oalVL6jw4jpm0HeAwZxYBVaXyxIvXyjFM5RryhEhwVxkxY/y31m+wn8CL8wogwXEkA4YZTR4UKuHiB4PKqm6xDlYMU3Dv0gzhNDEU7H0S1S6A5CuthpRLGlDarwGZhhvs2SIDYrgQytoL4b5A9GCkJrq4lAWpXPAtfoHFd9WHYItAWu4UpVOxZ+T19cwKtEMqeEXp6iPDn+Ayv4wPPIXxEmJxJgfNfQ6OV9fPiw8lEvK3Bw4Ypm9hLYxU2KLPax3xd8iVbjeMD4KP3SY0QSWyl8cFUfiu6wQonwi63smuO35dLpoSjjqnzT8nFPSJpEtCWEOIFLCP6LT78Y2JZJrQ8CXspyH3ZMwu0q3lmlfDwUs9hZDYZHsYpNKEGSF9s88Qy1Rr+YpTm+cj8gSk6s0HeiSj2HJvYqlAhoaYtH9oq9d/A29r++X1ISELtOfM9z1sSw1pHjuqFBl+cLAj8cvKP8i+VjNEOHNQT0ceW38pIak7TRaYAqw/F8A4SdDH/LoEU/byvKqAeKNyOe51VryyyI3irpf0lVha0tMsdUrrvRXp5e5sYmWOEn+J7obQ942xjetYvFQ1n+HQoySFu4v27UmOFHZrZy5e3v6DzUo0dQoJUr12OGekE8u05ayi6xqx7yyx4hgRILhVRvoCW2t1mOx0+T0WS5WpPU4EE6cLgF8IK0Bg3CDutgwyILHeJ4rt/oUSwtZ8H0scORa0s8DKuyFT+JAYQ+NjiQioYXDEP+rYvR4E1qBfGj5Wg6e4L/jV70DUXr0uTiI+gnx1E1M8iLxMcET5EGoec0sjSUmTOV5U6/JPj04lrOva/urAT8ZoWR+r936TPL9dUtCYL5aPb8hGc2Hi/XdnKU0z07+sRaYwY4EYzYbF0FxyCnzY4fysyxzn7wmxRqesc/9gBifufK1VVC7G/uO8eLT3zE6ml/Zs+jeeDE1qVoIcM7nhOmRYIRG0/fBu86zQ3pwMyJ/0FLAPUVaU36w3/Ijb2X7P3vxUoqbHd9hNXT0/MM0HIjIl6G1gPDr3zPheigXAfLYOcUPi+kJaWl1OV4M9ZuSn/2D88voAvzV5vlMVZoXKN5tArty1rY/sP0jcj198/S6j68le3MpjuUi/d0xGHzfJW0UruZIPyzOxtZbqAnpIEVorXckNC+rC2LRsiZxA3euzoOlYZ6SkuICL2dbLf30J6pbEnu/OFD835rffw0fWqgpW1IYly0jaYhJg+OT2ph+CDWudJuB4Ik8/X0Pe+R7O96nDUWq5zAehnXDevpaTp+MYMLE/1dTBfktW6NlgaYUht41oDp0Dq+n+zUhu2pu6997BZ7YR8SXEIjJpv5qIlVeRGdVXHJ5nxMF3iJXoclTtVmUR1Uhq9BmJVu09CxPKNT1U8sy2vq8Iv05sMh5che0OrSxcTSRmvF6ulpMjNCMDuevYC2unoU1LtdlBxryQ0fnDpeQvsdnCDJGnmHL7So/VTUYDCgb+xMuLANwMNLOG0Fi5qWfdG8LDK8Xe2+69Em2Ho3GW3cW7lRnieRa9L59UbqnP2KreE0dOQlRdUNurgW8/edc99amyc8gDWev2KfpHS+fqAMX6VzWo3P2jqBIAYGlERBGP4+kgb4eVmzszwJgyAIkzwzFf6ch11SOo6MydOp898ZyCY3NM8fLKfpgnpZ8acR5grbYHh+/yQDCvIX7dxgG/JNVO1t4jhRSh/VkYbEL4h8RmqH7erJaj0/ZVhoWtra8ezt+X1zdB4va/YzxqeGZzDp8EWr8liqdLm7ykuR88wnYW5jX4KEjjhJibdTf7l+h2bCI+MEYb2Rluu+usL5HM/qEUTI/6lezdwhQqMgzH7hIx8O+c3BoBmfO4khv5n0QFSTAJcb/oIf2R5o948Mi4K1iqjYOhesLk5j1AtWWKsxBPZ3TSyynW6ZpVU0w1SOB1RQIduJhhxZPrsK35Zkxdavuqg6v2KsEqxX3Qrc8wfoaHRTy/2yA32n8IPfyOFgMAvNwk5Mr7JLmza2gWh+T/PcQRAhmBHZfiwnf+EK92CtN/P5ur1J7FRI0IhucMDkd4YlQ0kxom3iE8uJC0u4r1UaX2vJjD4jBJj6Zj/WWC5orMn0Y7DWy5G+ds5eG0wnkvNmTPfbJCdwuJUUEQAV5YWrL/hacy/2atV0TP+t5vtRVpNs1I8M6wDWPMLdIWfW4u5ZPc7rOpb9fbOKNJVpB0XuGypNFdZ6NHt6VE+vYdAXpNpHb6qnx6toPj4DrIke+Wf3ZEIElXrK7xohowKBq9uOE5jKvtDZa2mksyGeaPRHuxb/0S0MnciYTp4r8DzPZrPnOljj5eaSwdlHgf9tbq+pZe+xxJS+tda0vO96Q8a+ISyRP4xLmvQ+++9oNJrMamBNXzD3dInGZn+LRdG/hQe/VyHUDm0CH5yqCLN3tJGdbWRGyt6lU74QFGntFs7GT/Plcvb2xT1YLyi3Lnju9pc/NesgOVFJWWm2qwz70sD99OAttZJ6M2K5B+kDmYXdni+VWwiBs7Feb4w3nYpgRfPRy3ge2PnfsmFl/+wkXgIlleLTKu1drQGCr3fb1FNuTj2lierQMz6K4bx1NZEFWJF1GEU7cjC42UhDsGbTMVC8+Xes8MbXMETJmW6TgNhhVthqbXq1NdtYCVVDY9CQ0p75kXaslXSmkxczCvX5XNvo+68jSAgWLV4U0t+QEL/HVfVmvMXhH8fNUB/wLUHE0UeLyVC2HhKn1SJfj11sfePDqMSrUBYi4psvwPDz+fh5D5YRlZb1YnnwYT18JQv1emfUubDRM8tDQoIsdD1fFvpNjqS9mYDG/6NeoE02m36NVOgiJO0D6Za/GrNJpT4BFxMIajYb7xMRaGtBiIjifXQJ/1Vova9+/BVctBhlR0VqqkaIiPzfTkslbR8AvnuByj3tNJpTuTvBd9LFB5mU+EBZIK1mU6yqhqFBUZpN3/AjgT0f0z9cky+r4j1g4CsvFrL4S7Rwi1wW6Io4pEU35fHHicxHYPRKoHSSpbtK+EUTlMdjQPc/saGFCKf53XZLypo+jUbj0XiGJeia7gLGD8oM/TPaWKp9DcNzzGBhxHmeF7H+qxnKO6a/kAX8Ho533Vh/YNsTdRmJJLF0l66FCZhKYP+zEvKwPxg5t/bLIE9QVpnKgjs317Tly3g2fjHNaliN9gTGNtkT2hfdwweG13eBE0ShS3Ae/JwwstdhWVZPcKr+sT2YDzw7Ai8A5JYWkS7cs/WQ5y3rBBQgp3Zo8ezJD1NL3BXYDECkb9abDQHgxi+1Mg+VWTp1AmBk4dfcQ/ZhaORWFhi6bmW+vftlmXLvB2h7+ImpemyUcHwcrSxCU5XFxrvn3VVRpga4R2ag5DZuWzupYsV0FZqzyXQyMzZuYFgbLEqPa+ma2ViL1oeb+QyBufoFupRDyk4UCHs5XjZD/4PRurr4SU7l2ej0gBMFhiKXlaPm0AKuD2bpqKJkFGB+J+2AYwdGvFrrSFTqZhUsx3N9B2w/raW2gKj8Q9oZ76FnXV+XsvgpZwe+EOrjOR/94MAMI6PfNj1BswSxRnVF27zAYSwNjqilkZU6JzVkh27ndjYqxjERlabj2XLZKFxMgd89Z15+He+hnV9fl2I1wzcHD+jm6RC7b575oAOMbk8sAQY3QJvCmG57OE3bUiJ9KMh6khJ/q5/s2usxA4ihPWeDEbK2Doyn5+lsMho/t2Xgw7ccPVzYILt+fAjCKX1bBcKy2Nd+ZsROW7xOZI7onMoHE4Zd7KULTLuIiVtYcvfE33jXYwQ9c9aeAxfs6cX09gJi1tZGY4TvYgKhC8yrP94CpzKytwosXZBy5j18pJVu9QRpfbxTBTOErhs4VrglCn9K3QF5SiQOHNX1QJqP5y71iaeK9xBRzA9/ijrCTq6+n60E6/CuuqxS2y/zEWuBeAjaw3va55R/kApnH/XYDrLMWPDMqe/CWcfMW1vzeeStAKwXZ3cyCw8hTrTW3qJHjH28XLk2aR0vZ6C94cnZYNEqwomPr0wt9I++wDUiAVAVuIjgVKW3hzPHq43+Amr9lYqFpXa6hWa+ruToMT4Mr7c8r0rwpXk8PmDj27lqrrWv4jhRsNedoBBahO6gfFLHyfxvj87+R8vxZLwEYp9Nnp/Go8lJrIhX6dyi5enw2qv/6L6GVLqjc5i4Oq9lm8wH4iE4sQpkn2pn+/s8PCe0TbJyp1uzQIrasY059Xc/N5u1YoWRohW8Vjq3QEk49vbqXZ4sp+M07w8ca4e4gxTnK1+Oripob6a/6+n7sgUOEal6Y9/x/YdjWxwjRb4XgXt73scxp8qrmKRZuuGq3j45wZ0ud1d3hzjTREeJhwrYPSj4h7OvcHU2sy4e4HoPxYVqRkUWBBc9MBVeVOgFhL5/Wog41RwJ8eJorm9eG73xZU+N8AX+MHc8iRnKZmal1gX+lqV7opQTYImp4+pmss1CQsJ0d0n0wbK8GQZmaSsQ5azX7W7wGaECN7gChT+ePtcp/3qLd98zdRxvvQahbm6DoNAv+ixAPGBZ6/6ESA/dOCAWiYoYg8SLvM5iZztvgZ62Xre2hICUn2vhxl0Fm2W9N75MLl87qQXYCEZku0lIYkPqXGS3ODrrnFh+iOIBnzWxBaTECzt4UBtjCfCtENEK1mz8tPQ2rrNaA67TZrCoR67Nd/vXKwwCA4oasIPnkVWsD5nLts5TvitOkZa8S1OiKyKqrc5lcywc4PNG2JPjQOYYqxdj4zmOR2uHrcEiKYN1tnvWbOuvXSGuP7ODwnMTkmj9Cx9aQ+f9Tz73ZCDJZdNq7+JXyh6B9d/nVrAwWQpk5ayD5aStYQRJywnfei7oB/a/dTpiMsu2C0sRBK3ATfcXvi0UD1gD/GCMrveJzxRjMOD0l+k+cvFbwIJrtracaKNDiN1G/qi0fDfMU9fQjhbQ9bjPDrt3GWlHwhBDWRymtXDtz0Xjg7QGeEoo3/U++1GWWwfnWJmYIlO7TbDgy+vNZm1AzNi8gqVFTrHV2wvDGNcb4NK+g6F/6kXdswMjDHBBf++hA2jl1m5xeLDQeR2/j7QWf3UH/cDwjvcaLF9GozFY1sptbZBcasv5E05Kn4ytN6vA1E0SrNdREMZpnlj6Quwxn9rRQZ/hFYllhydHn2dySKtwZ3bi/KJU/3l6WOyIu7G0+ctk9OK5bW3KkxGcp190L2Mh9mW+XOrm63oduF6cxzqu42Q/ARbNOPQPL3Copyu6Ww1+Fy+c+SsW+Rd0YdxznLLzLG+ztgxN853Wnm6st37YCTiPEKzpeAwGiogZBABbRVtT/kRTFmZJc/ltfTE+oSP2LQHRWzjRWdNoKB6sWLz6Q4HuWWbhbuMVeY02ZaJ09vT8dIKd2g+wGtzfxWg2xSL2BBCbvMxVI1rb4Va9PImKlpVWNsnwWIPgmYG6swv1HARYoL3d7gueoHR3z/ALPS5CsnJKsJ7HT6On6QVoYSL+jeymmIsGwKZzLcCHIV786EjkLKzc/nz3joLjJaasbYmbnhcksoywkL5kAp/DDUeKmcclWC/jubkcU/84KxsefnVoJbESgeNPjiB6ArSU+wt5dj/7O3wfE//JSLEdFgnxcvmP986x5QJUI3YpWKN5vtFeRmOkoBG6yTqDtTF8cNy1C1iNRy9LrJaHl1czONBZVmKIdI6HK7f9aKltkyg+f63T448ve4rZPQe/+m3gfqJvQnM5h7NE1VBFC3xjXUTQloe3EgdFajxfmhu4hlH2CVug5egoVN5cHy+bwcrOTfFvmSTHhzWVnco0FlxvQseLQDftKsoLPJ+O8nTaSMyXfhSQAjRflrq7CVck3Faf1HV2bMgp24BkvrYQBRG7RHOfJJnK/z1T99gUaFHLmo2nS8NF3Q4KQK/ULkC5WjsIfCazasBTVmdnU7i5L3PNAsdKVnFhLoaf4hgszZnbwImzJIyyHOghyXXpb3quKZ3NpWABFCPs5lbV5XI+qfXQQFi9C9SXCp3vA6UxqizNWm8CQoI8QVH6yfcHTmG4MLMsDsMgiNLc1aQfzMNf9JjON7D+O3/Buzgq6b0uImg70gaTq9PjJt3XtQZyVCcbRMpLC0sVf342OiwrWjjGpRmmaejltM2fMytu/9BSjm2A9TLSwuV/xy8v4P7xH88NoTBehlGwfNdizyC0Im9FUNYiUltbo83C/9OEc1m7HwzLhXls9/6vIPYe+w4WEjw20WCaD7UDqIfxpIHW02juBGt1fCAuCpb7+roiqzArVlppCNz/uo/wMFrCdHp/9vmc2Nm6wDWEmH0q8zvl9NyS9rev16/afH+qTZLT/WooEmz06T4XWILlgUnF+wZ09lpj8yz75x8orBYprh3d5rFFb0z3GCzUTc5mE62I4wfBWqsw/ORp38Rs+Wt9v6zmAFa5shSQemC+04HgxrUsixA3AC4u9z3QTV9liAdYaCgd4Kx3x/PSk8nLEw6ITUu0jMNqn4lBVzlRMvxeSFFNrFjZFlQMLmsNCkumd1FND+NzWCZcqpqmgXg4voYTzTI0cJbjKQRFK3etP9E/nI71DckldsCxzPc7PXTMC1U3oyLFZ91scdqgb0Rv9eYplQ5UPhw1/yEowWYNodB4RLNYm/KOgipduZn0d+0Au6IPLFXLUJS1MHMckpsCFmuPivNlyqGadZgBKBG4vM2rPn8Zgx94G+ScGEH6bcEqp4jpvwhqEjp2bIs4mNmWg59O3wqrOHsIQd/KW29MdT73Dnno6UQPM/n7grU3MPTxkhWv7MQcClGj7QMzeZMxaK19YmY2nizNzdpdrYJNZLmeG5oYO87GerhdfHOwqP/q4pOVV3am9fW4Ur6nyZbR5AUOiNMyMQOKdLbUgw2u/PU9z1vRvQa4yydT/gVgYSZSMCPHSXXTf1/pUKalXpaqYVqWqVNOn+67RDBbFW0iz8HjzgHHkbZO1fLpT98drR4j+oHrxKGDAxY0nfxfipS+AnH66rmv0SbUsRZb9h9NAbj50lhhFmeDHabYrZRoh/iJ+96A/WCk1HNdF7fXlfnk6RyRWrtk5cdZlvhktV5rL4dUw2w2GY8m8/kSpFg5eYgdlvxgMBi2Lpn4bmjJWWCDd4t0mk5WjVdEyk22samrqmZmKVltrPes33NZw0EpRp2kGbiBZWJGRaONT132W99EyUvtFaC1dt0ILh/YVLzFcI82egwlHP0JNtpsXHEAZf0VbmGx8rwgjMIwSovEWAz/prTm9Q/4RC3L/BXEiy78w4kKfN5q6S/p+5bMjDi0RavRzjaZmiEE0g4pjxNtzcWA+c7U1QE8VJIX+PiTnLYR0lxE+ZbZLj7eaWuvIm9ZTcCjgYGWd7yVgw+exUeE2rZNSxVM9/uihdk6HErXdU2VabKlknTrMayydVf+5p3nDw2ny7XruFlqqgtZVlQzTxwICVJlyHS+s3Edg9NoTgQbk+GeupiAH+/TzcDzo5m2cUgSqYeH+/GynkW24xSmxHxrncrSR4RDFNRGOCx4gQhgCCMN4JoguU9GI4gWV85WF5l9Zv+BYR4lY+s6dpSBcXHfmeh/pV7N3AbjcjRMO9DSVxRZYbLoM1znbXMJwwyUKD4YV5f716LFa0VkE28TlfprvcH8Tr0ACnCJxhaYK8xU4fslms/2AgwjG0WKqxHW6806ICQssK5+17ixAyWNbNfJfIUuBYD7zf7r0IJIeSBrbpEnoe+HcUbb+1qfpgvKrHCclZeH2kGw/fuMC5ER5Ldq8anGUTCuoZKkK8d208LRj/rk/13GVcbJ/X21uPMBqqKWJfgkOz8pMtdQeYb9F+L1eNg+zn2UYMBMv6SneeisbGKTnTlg/41g4bk/I9OHLCWqZpLGYZRZIvOvFV3nMxwurAJ6E/6Rl/D/A0AWeD7yVir+AAAAAElFTkSuQmCC'+'" alt="Henry & Ted"><h1>Set your password</h1><p>Choose a password for your dashboard. You\u2019ll type it each time you open it - pick something only you and your team know, at least 6 characters.</p>'
    + '<form id="f"><input id="p" type="password" autocomplete="new-password" placeholder="New password" autofocus>'
    + '<input id="p2" type="password" autocomplete="new-password" placeholder="Confirm password" style="margin-top:10px">'
    + '<button type="submit">Save and open my dashboard</button><div class="err" id="e"></div></form></div>'
    + '<script>'
    + 'var f=document.getElementById("f");'
    + 'f.onsubmit=function(ev){ev.preventDefault();var e=document.getElementById("e");e.textContent="";'
    + 'var p=document.getElementById("p").value,p2=document.getElementById("p2").value;'
    + 'if(p.length<6){e.textContent="Use at least 6 characters.";return;}'
    + 'if(p!==p2){e.textContent="The two passwords do not match.";return;}'
    + 'fetch("/api/setup",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({passcode:p})})'
    + '.then(function(r){if(r.ok){location.reload();}else{e.textContent="Could not save that. Try again.";}})'
    + '.catch(function(){e.textContent="Something went wrong. Try again.";});};'
    + '</script></body></html>';
}

async function authStart(env, source, url) {
  const adapter = ADAPTERS[source];
  if (!adapter || adapter.auth !== 'oauth' || !adapter.oauth.authorizeUrl) {
    return new Response('This connection is not set up for browser authorisation yet.', { status: 404 });
  }
  const cfg = adapter.oauth;
  const state = randomState();
  await env.TOKENS.put('oauthstate:' + source, state, { expirationTtl: 600 });
  const redirectUri = url.origin + '/auth/' + source + '/callback';
  const p = new URLSearchParams({
    response_type: 'code',
    client_id: env[cfg.clientIdSecret] || '',
    redirect_uri: redirectUri,
    scope: cfg.scopes || '',
    state
  });
  return Response.redirect(cfg.authorizeUrl + '?' + p.toString(), 302);
}

async function authCallback(env, source, url) {
  const adapter = ADAPTERS[source];
  const cfg = (adapter && adapter.oauth) || {};
  const code = url.searchParams.get('code');
  const gotState = url.searchParams.get('state');
  const wantState = await env.TOKENS.get('oauthstate:' + source);
  if (!code || !gotState || gotState !== wantState) {
    return new Response('That authorisation didn’t complete cleanly. Go back to the dashboard and click Reconnect to try again.', { status: 400 });
  }
  await env.TOKENS.delete('oauthstate:' + source);
  const redirectUri = url.origin + '/auth/' + source + '/callback';
  const res = await fetch(cfg.tokenUrl, tokenRequestInit(cfg, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri
  }, env));
  if (!res.ok) {
    return new Response('The connection couldn’t be finished (the tool said no: ' + res.status + '). Your AI will check the app settings - the usual cause is a redirect address that doesn’t match exactly.', { status: 502 });
  }
  const t = await res.json();
  await saveTokens(env, source, {
    access_token: t.access_token,
    refresh_token: t.refresh_token || null,
    token_type: t.token_type || 'Bearer',
    expires_at: Date.now() + ((t.expires_in || 1800) * 1000),
    obtained_at: new Date().toISOString()
  });
  /* After token storage, adapters' status() should resolve org name etc. */
  return Response.redirect(url.origin + '/', 302);
}

/* ---------------- No-API ingest: KV day-store + endpoint ---------------- */

/* Day rows live at data:<source>:<YYYY-MM-DD> as JSON objects of numeric
   fields. Same-day re-uploads overwrite (idempotent; re-ingesting a corrected
   export is safe and expected). */
async function saveIngestedRows(env, source, rows) {
  if (!Array.isArray(rows)) return 0;
  let saved = 0;
  for (const r of rows) {
    if (!r || !/^\d{4}-\d{2}-\d{2}$/.test(r.date || '')) continue;
    const clean = {};
    for (const [k, v] of Object.entries(r)) {
      if (k !== 'date' && typeof v === 'number' && isFinite(v)) clean[k] = v;
    }
    if (Object.keys(clean).length === 0) continue;
    await env.TOKENS.put('data:' + source + ':' + r.date, JSON.stringify(clean));
    saved++;
  }
  return saved;
}

function eachDate(from, to, cap) {
  const out = [];
  const d = new Date(from + 'T12:00:00Z');
  const end = new Date(to + 'T12:00:00Z');
  while (d.getTime() <= end.getTime() && out.length < (cap || 400)) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

/* Sum stored day rows across a range. Returns { sums, daysWithData, lastDate }. */
async function readIngested(env, source, from, to) {
  const sums = {};
  let daysWithData = 0, lastDate = null;
  for (const date of eachDate(from, to)) {
    const raw = await env.TOKENS.get('data:' + source + ':' + date);
    if (!raw) continue;
    daysWithData++; lastDate = date;
    try {
      const row = JSON.parse(raw);
      for (const [k, v] of Object.entries(row)) {
        if (typeof v === 'number' && isFinite(v)) sums[k] = (sums[k] || 0) + v;
      }
    } catch (e) { /* skip bad row */ }
  }
  return { sums, daysWithData, lastDate };
}

async function monthlyIngested(env, source, fromMonth, toMonth) {
  const months = monthList(fromMonth, toMonth);
  const out = { months, byMonth: [] };
  for (const mo of months) {
    const [y, m] = mo.split('-').map(Number);
    const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const r = await readIngested(env, source, mo + '-01', mo + '-' + String(lastDay).padStart(2, '0'));
    out.byMonth.push(r.daysWithData ? r.sums : null);
  }
  return out;
}

/* Returns the list of whole calendar months a date range exactly covers, or
   null if the range starts mid-month, ends mid-month, or isn't month-aligned.
   Used by the manual-count POS adapter so a count only shows for whole months. */
function wholeMonthsInRange(from, to) {
  const fm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(from || '');
  const tm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(to || '');
  if (!fm || !tm) return null;
  if (fm[3] !== '01') return null;
  const lastDay = new Date(Date.UTC(+tm[1], +tm[2], 0)).getUTCDate();
  if (+tm[3] !== lastDay) return null;
  return monthList(fm[1] + '-' + fm[2], tm[1] + '-' + tm[2]);
}

/* GET /api/poscount -> { counts: { 'YYYY-MM': n, ... } } (session-authed). */
async function posCountList(env) {
  const out = {};
  try {
    const list = await env.TOKENS.list({ prefix: 'poscount:' });
    for (const k of list.keys) {
      const mo = k.name.slice('poscount:'.length);
      const v = await env.TOKENS.get(k.name);
      const n = parseInt(v, 10);
      if (isFinite(n)) out[mo] = n;
    }
  } catch (e) {}
  return json({ counts: out });
}

/* POST /api/poscount { month:'YYYY-MM', count:int|null } (session-authed).
   Saves/clears the month's transaction count and clears the metrics cache so
   the board reflects it immediately. */
async function posCountSave(env, request) {
  let body = {};
  try { body = await request.json(); } catch (e) {}
  const month = String(body.month || '');
  if (!/^\d{4}-\d{2}$/.test(month)) return json({ ok: false, plain: 'Pick a month first.' }, 400);
  if (body.count === null || body.count === '' || typeof body.count === 'undefined') {
    await env.TOKENS.delete('poscount:' + month);
  } else {
    const n = parseInt(body.count, 10);
    if (!isFinite(n) || n < 0) return json({ ok: false, plain: 'Enter a whole number (0 or more).' }, 400);
    await env.TOKENS.put('poscount:' + month, String(n));
  }
  try {
    const mc = await env.TOKENS.list({ prefix: 'metricscache:' });
    for (const k of mc.keys) await env.TOKENS.delete(k.name);
  } catch (e) {}
  await noteSync(env, 'pos');
  return json({ ok: true, month: month });
}

/* POST /api/ingest?source=pos|accounting|rostering
   Authorization: Bearer <INGEST_TOKEN>. Body: the exported file's text.
   The source's adapter.parseExport() turns it into day rows. */
async function apiIngest(env, request, url) {
  const source = url.searchParams.get('source');
  if (!['accounting', 'pos', 'rostering'].includes(source)) return json({ error: 'unknown source' }, 400);
  const auth = request.headers.get('Authorization') || '';
  if (!env.INGEST_TOKEN || auth !== 'Bearer ' + env.INGEST_TOKEN) {
    return json({ error: 'not authorised', plain: 'That upload code didn\u2019t match. Check it with your AI and try again.' }, 401);
  }
  const adapter = ADAPTERS[source];
  if (!adapter || typeof adapter.parseExport !== 'function') {
    return json({ error: 'no parser', plain: 'This source isn\u2019t set up for file uploads yet. Your AI adds that when this path is chosen.' }, 501);
  }
  const text = await request.text();
  if (text.length > 2000000) return json({ error: 'too big', plain: 'That file is too large. Export a shorter date range and try again.' }, 413);
  try {
    const rows = await adapter.parseExport(env, makeHelpers(env, source), {
      text, contentType: request.headers.get('Content-Type') || ''
    });
    const saved = await saveIngestedRows(env, source, rows);
    if (!saved) return json({ error: 'nothing parsed', plain: 'No usable rows were found in that file. Check it\u2019s the right report, or show it to your AI.' }, 422);
    await noteSync(env, source);
    return json({ ok: true, days: saved });
  } catch (e) {
    return json({ error: 'parse failed', plain: 'That file couldn\u2019t be read. Check it\u2019s the right report, or show it to your AI.' }, 422);
  }
}

/* ---------------- Metrics API ---------------- */

function parseRange(s) {
  if (!s) return null;
  const m = /^(\d{4}-\d{2}-\d{2}):(\d{4}-\d{2}-\d{2})$/.exec(s);
  return m ? { from: m[1], to: m[2] } : null;
}
function parseMonthRange(s) {
  if (!s) return null;
  const m = /^(\d{4}-\d{2}):(\d{4}-\d{2})$/.exec(s);
  return m ? { fromMonth: m[1], toMonth: m[2] } : null;
}

async function sourceStatus(env, source) {
  const adapter = ADAPTERS[source];
  if (!adapter || !adapter.configured) return { configured: false };
  try {
    const h = makeHelpers(env, source);
    const st = await adapter.status(env, h);
    return {
      configured: true,
      ingest: typeof adapter.parseExport === 'function',
      manualCount: !!(st && st.manualCount),
      connected: !!(st && st.connected),
      org: (st && st.org) || null,
      sandbox: !!(st && st.sandbox),
      lastSync: (st && st.lastSync) || (await lastSync(env, source)) || null,
      error: null
    };
  } catch (err) {
    return {
      configured: true,
      ingest: typeof adapter.parseExport === 'function',
      connected: false,
      org: null,
      sandbox: false,
      lastSync: (await lastSync(env, source)) || null,
      error: { code: err.status || 0, plain: plainError(err.status || 500) }
    };
  }
}

async function fetchSlot(env, q) {
  /* One period slot: pull each configured source; null where unavailable. */
  const out = {};
  for (const source of ['accounting', 'pos', 'rostering']) {
    const adapter = ADAPTERS[source];
    if (!adapter || !adapter.configured) { out[source] = null; continue; }
    try {
      const h = makeHelpers(env, source);
      out[source] = await adapter.fetchRange(env, h, q);
      await noteSync(env, source);
    } catch (err) {
      out[source] = null; /* per-source failure never breaks the whole payload */
    }
  }
  return out;
}

const METRICS_CACHE_TTL = 120; /* seconds: brief cache for live provider data */

async function apiMetrics(env, url, role) {
  const cur = parseRange(url.searchParams.get('cur'));
  if (!cur) return json({ error: 'bad cur range' }, 400);
  const prev = parseRange(url.searchParams.get('prev'));
  const yoy = parseRange(url.searchParams.get('yoy'));
  const trend = parseMonthRange(url.searchParams.get('trend'));
  const tz = url.searchParams.get('tz') || 'Australia/Sydney';
  const rollover = Math.max(0, Math.min(6, parseInt(url.searchParams.get('rollover') || '0', 10) || 0));

  const base = { tz, rollover };
  const [sAcc, sPos, sRos] = await Promise.all([
    sourceStatus(env, 'accounting'),
    sourceStatus(env, 'pos'),
    sourceStatus(env, 'rostering')
  ]);

  /* The provider calls (periods + trend) are the expensive part and the only
     thing that brushes provider rate limits on quick reopens/refreshes. Cache
     them briefly in KV, keyed by the requested ranges; source status stays live.
     generatedAt is stored with the data so the dashboard's "last synced" reflects
     the real fetch time even when served from cache. ?refresh=1 forces fresh. */
  const cacheKey = 'metricscache:' + [
    url.searchParams.get('cur') || '', url.searchParams.get('prev') || '',
    url.searchParams.get('yoy') || '', url.searchParams.get('trend') || '',
    tz, rollover
  ].join('|');
  const force = url.searchParams.get('refresh') === '1';
  let data = null;
  if (!force && env.TOKENS) {
    const cached = await env.TOKENS.get(cacheKey);
    if (cached) { try { data = JSON.parse(cached); } catch (e) { data = null; } }
  }
  if (!data) {
    const periods = {};
    periods.cur = await fetchSlot(env, { ...base, ...cur });
    periods.prev = prev ? await fetchSlot(env, { ...base, ...prev }) : null;
    periods.yoy = yoy ? await fetchSlot(env, { ...base, ...yoy }) : null;

    let trendOut = null;
    if (trend) {
      trendOut = { months: monthList(trend.fromMonth, trend.toMonth) };
      for (const source of ['accounting', 'pos']) {
        const adapter = ADAPTERS[source];
        if (!adapter || !adapter.configured) { trendOut[source] = null; continue; }
        try {
          const h = makeHelpers(env, source);
          const series = await adapter.fetchMonthly(env, h, { ...base, ...trend });
          trendOut[source] = alignSeries(trendOut.months, series);
        } catch (err) { trendOut[source] = null; }
      }
    }
    data = { generatedAt: new Date().toISOString(), periods: periods, trend: trendOut };
    if (env.TOKENS) {
      try { await env.TOKENS.put(cacheKey, JSON.stringify(data), { expirationTtl: METRICS_CACHE_TTL }); } catch (e) {}
    }
  }

  return json({
    generatedAt: data.generatedAt,
    protected: true,
    role: role || 'owner',
    sources: { accounting: sAcc, pos: sPos, rostering: sRos },
    periods: filterPeriodsForRole(data.periods, role || 'owner'),
    trend: filterTrendForRole(data.trend, role || 'owner')
  });
}

function monthList(fromMonth, toMonth) {
  const out = [];
  let [y, m] = fromMonth.split('-').map(Number);
  const [ey, em] = toMonth.split('-').map(Number);
  while (y < ey || (y === ey && m <= em)) {
    out.push(y + '-' + String(m).padStart(2, '0'));
    m++; if (m > 12) { m = 1; y++; }
    if (out.length > 60) break;
  }
  return out;
}
/* Adapters return {months:[...], <field>:[...]} - align onto the requested grid. */
function alignSeries(months, series) {
  if (!series || !Array.isArray(series.months)) return null;
  const idx = {};
  series.months.forEach((mo, i) => { idx[mo] = i; });
  const out = {};
  Object.keys(series).forEach((k) => {
    if (k === 'months') return;
    out[k] = months.map((mo) => (mo in idx && series[k] ? (series[k][idx[mo]] ?? null) : null));
  });
  return out;
}

/* ---------------- Router ---------------- */

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/favicon.ico') return new Response(null, { status: 204 });

    const sess = await sessionOf(request, env);
    const loggedIn = !!sess;
    const isOwner = loggedIn && sess.role === 'owner';

    if (path === '/api/login' && request.method === 'POST') return apiLogin(env, request);
    if (path === '/api/setup' && request.method === 'POST') return apiSetup(env, request, sess);
    if (path === '/api/logout' && request.method === 'POST') return apiLogout();
    if (path === '/api/ingest' && request.method === 'POST') return apiIngest(env, request, url);

    if (path === '/' || path === '/index.html') {
      if (loggedIn) return htmlResponse(dashboardHtml);
      return htmlResponse((await passcodeSet(env)) ? loginPage() : setupPage());
    }
    if (path === '/api/me' && request.method === 'GET') {
      if (!loggedIn) return json({ error: 'auth' }, 401);
      return json({ role: sess.role, user: sess.user, metrics: roleMetrics(sess.role), admin: isOwner });
    }
    if (path === '/api/metrics' && request.method === 'GET') {
      if (!loggedIn) return json({ error: 'auth' }, 401);
      return apiMetrics(env, url, sess.role);
    }
    if (path === '/api/poscount' && request.method === 'GET') {
      if (!loggedIn) return json({ error: 'auth' }, 401);
      return posCountList(env);
    }
    if (path === '/api/poscount' && request.method === 'POST') {
      if (!loggedIn) return json({ error: 'auth' }, 401);
      return posCountSave(env, request);
    }
    if (path === '/api/users' && request.method === 'GET') {
      if (!isOwner) return json({ error: 'forbidden' }, 403);
      return json({ users: await listUsers(env) });
    }
    if (path === '/api/users' && request.method === 'POST') {
      if (!isOwner) return json({ error: 'forbidden' }, 403);
      return apiUserSave(env, request);
    }
    if (path === '/api/users/delete' && request.method === 'POST') {
      if (!isOwner) return json({ error: 'forbidden' }, 403);
      return apiUserDelete(env, request);
    }
    if (path === '/api/training' && request.method === 'GET') {
      if (!loggedIn) return json({ error: 'auth' }, 401);
      return json({ content: await getTraining(env) });
    }
    if (path === '/api/training' && request.method === 'POST') {
      if (!isOwner) return json({ error: 'forbidden' }, 403);
      return apiTrainingSave(env, request);
    }
    const authRoute = /^\/auth\/(accounting|pos|rostering)\/(start|callback)$/.exec(path);
    if (authRoute && request.method === 'GET') {
      if (!loggedIn) return Response.redirect(url.origin + '/', 302);
      if (!isOwner) return new Response('Only the owner can change connections.', { status: 403 });
      return authRoute[2] === 'start' ? authStart(env, authRoute[1], url) : authCallback(env, authRoute[1], url);
    }
    if (path === '/api/disconnect' && request.method === 'POST') {
      if (!isOwner) return json({ error: 'forbidden' }, 403);
      const source = url.searchParams.get('source');
      if (['accounting', 'pos', 'rostering'].includes(source)) {
        await clearTokens(env, source);
        return json({ ok: true });
      }
      return json({ error: 'unknown source' }, 400);
    }
    return new Response('Not found', { status: 404 });
  },

  /* Cron rung: uncomment [triggers] in wrangler.toml and give any adapter a
     scheduledPull() to fetch its tool's own export on a schedule. */
  async scheduled(event, env, ctx) {
    for (const source of ['accounting', 'pos', 'rostering']) {
      const a = ADAPTERS[source];
      if (a && typeof a.scheduledPull === 'function') {
        try {
          await a.scheduledPull(env, makeHelpers(env, source));
          await noteSync(env, source);
        } catch (e) {
          console.log('scheduledPull failed for ' + source + ': ' + (e && e.message));
        }
      }
    }
  },

  /* Email rung (Path B): the tool's own report scheduler emails its export;
     the owner's domain on their Cloudflare routes that address here (Email
     Routing -> this Worker). Complete when this rung is chosen:
       1. parse the message with postal-mime (add the dependency)
       2. find the CSV/report attachment, work out which source sent it
          (sender address or subject)
       3. reuse adapter.parseExport + saveIngestedRows + noteSync, exactly
          like /api/ingest
     Until then this logs and discards. */
  async email(message, env, ctx) {
    console.log('email received from ' + message.from + '; email ingest not wired yet');
  }
};
// EOF worker.js
