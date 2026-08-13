/**
 * RRA Boathouse: shared helpers for the API functions.
 * Files starting with "_" are not exposed as endpoints by Vercel.
 *
 * Talks to Supabase's auto-generated REST API (PostgREST) with the
 * service role key from environment variables. No npm dependencies.
 */

const TZ = 'America/New_York';

function env(name) {
  const v = process.env[name];
  if (!v) throw new Error('Missing environment variable ' + name + '. Set it in Vercel > Project > Settings > Environment Variables, then redeploy.');
  return v;
}

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

/**
 * Worth retrying: a momentary server-side stumble rather than a real refusal.
 * Supabase occasionally answers "JWT issued at future" when the clock on the
 * instance handling the request lags the one that signed the key. It clears on
 * its own in well under a second, so a quiet retry keeps it off members' screens.
 */
function isTransient(status, message) {
  if (status >= 500 || status === 408 || status === 429) return true;
  return /jwt|clock|issued at future|timeout|temporarily/i.test(String(message || ''));
}

/**
 * Supabase REST call. Throws Error with .code (Postgres error code) on failure.
 * Reads retry twice on transient failures; writes never retry, since a repeated
 * checkout or booking would be worse than an error message.
 */
async function sb(path, opts = {}) {
  const key = env('SUPABASE_SERVICE_ROLE_KEY');
  const url = env('SUPABASE_URL').replace(/\/+$/, '').replace(/\/rest\/v1$/, '') + '/rest/v1/' + path;
  const method = opts.method || 'GET';
  const headers = {
    apikey: key,
    Authorization: 'Bearer ' + key,
    'Content-Type': 'application/json',
  };
  if (method !== 'GET') headers.Prefer = 'return=representation';

  const maxAttempts = method === 'GET' ? 3 : 1;
  let lastErr = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let res, text;
    try {
      res = await fetch(url, {
        method: method,
        headers: headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      });
      text = await res.text();
    } catch (netErr) {
      lastErr = netErr;
      if (attempt < maxAttempts) { await sleep(attempt * 250); continue; }
      throw netErr;
    }

    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (e) { /* non-JSON error body */ }

    if (res.ok) return data;

    const message = (data && (data.message || data.details)) || ('Database error (HTTP ' + res.status + ')');
    const err = new Error(message);
    err.code = data && data.code;
    err.status = res.status;
    lastErr = err;

    if (attempt < maxAttempts && isTransient(res.status, message)) { await sleep(attempt * 250); continue; }
    throw err;
  }
  throw lastErr;
}

function enc(v) { return encodeURIComponent(String(v)); }
function str(v) { return String(v == null ? '' : v).trim(); }

/** Today's date in club time, as yyyy-mm-dd. */
function nyToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date());
}

/** yyyy-mm-dd plus n days, still as yyyy-mm-dd. */
function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Minutes since midnight, club time. */
function nyNowMinutes() {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: 'numeric', hour12: false })
    .formatToParts(new Date());
  let h = Number(parts.find(function (x) { return x.type === 'hour'; }).value);
  const m = Number(parts.find(function (x) { return x.type === 'minute'; }).value);
  if (h === 24) h = 0;
  return h * 60 + m;
}

/** '7:05 AM' style label for a timestamp, club time. */
function timeLabel(iso) {
  return new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' })
    .format(new Date(iso));
}

/** 'Sun Aug 9' style label for a yyyy-mm-dd date. */
function niceDate(dateStr) {
  return new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric' })
    .format(new Date(dateStr + 'T12:00:00Z'));
}

function minToLabel(min) {
  const h = Math.floor(min / 60), m = min % 60;
  const ap = h >= 12 ? 'PM' : 'AM';
  let h12 = h % 12; if (h12 === 0) h12 = 12;
  return h12 + ':' + (m < 10 ? '0' : '') + m + ' ' + ap;
}

/** Reads the settings table into plain numbers, with fallbacks. */
async function config() {
  const rows = await sb('settings?select=*');
  const sv = {};
  rows.forEach(function (r) { sv[r.key] = r.value; });
  return {
    maxOutingHours: sv.max_outing_hours != null ? sv.max_outing_hours : 3,
    defaultInterval: sv.default_service_interval != null ? sv.default_service_interval : 50,
    windowDays: sv.reservation_window_days != null ? sv.reservation_window_days : 7,
    adminOpen: sv.admin_open == null ? 1 : sv.admin_open,
  };
}

/**
 * Assembles the full app state in the exact shape the front end renders.
 * Boats come back alphabetical; the front end groups them by type, so each
 * type section ends up alphabetical too.
 */
async function buildState() {
  const results = await Promise.all([
    sb('boats?select=*'),
    sb('roster?select=*&order=name'),
    sb('log?select=*&in_at=is.null'),
    sb('reservations?select=*&status=eq.Booked&order=date,start_min'),
    sb('flags?select=*&status=eq.Open&order=id'),
    sb('settings?select=*'),
  ]);
  const boats = results[0], roster = results[1], log = results[2],
        reservations = results[3], flags = results[4], settings = results[5];

  const sv = {};
  settings.forEach(function (r) { sv[r.key] = r.value; });
  const cfg = {
    maxOutingHours: sv.max_outing_hours != null ? sv.max_outing_hours : 3,
    defaultInterval: sv.default_service_interval != null ? sv.default_service_interval : 50,
    windowDays: sv.reservation_window_days != null ? sv.reservation_window_days : 7,
    adminOpen: sv.admin_open == null ? 1 : sv.admin_open,
  };

  const onWater = log.map(function (r) {
    return {
      logId: String(r.id), boat: r.boat, ownBoat: !!r.own_boat, rower: r.rower,
      crew: r.crew || '', outEpoch: new Date(r.out_at).getTime(), outLabel: timeLabel(r.out_at),
    };
  }).sort(function (a, b) { return a.outEpoch - b.outEpoch; });

  const outByBoat = {};
  onWater.forEach(function (o) { if (!o.ownBoat) outByBoat[o.boat] = o.rower; });

  const openFlags = flags.map(function (f) {
    return {
      flagId: String(f.id), boat: f.boat, issue: f.issue,
      by: f.reported_by || '', dateLabel: f.reported_on ? niceDate(f.reported_on) : '',
    };
  });
  const flagsByBoat = {};
  openFlags.forEach(function (f) { flagsByBoat[f.boat] = (flagsByBoat[f.boat] || 0) + 1; });

  const boatsDto = boats.map(function (b) {
    return {
      name: b.name, type: b.type, quickRelease: !!b.quick_release, status: b.status,
      weightClass: b.weight_class || '',
      usesTotal: b.uses_total, usesSinceService: b.uses_since_service,
      serviceInterval: b.service_interval,
      lastServiced: b.last_serviced ? niceDate(b.last_serviced) : '',
      notes: b.notes || '',
      maintenanceDue: b.service_interval > 0 && b.uses_since_service >= b.service_interval,
      openFlags: flagsByBoat[b.name] || 0,
      outBy: outByBoat[b.name] || '',
    };
  }).sort(function (a, b) {
    return a.name.localeCompare(b.name, 'en', { numeric: true, sensitivity: 'base' });
  });

  const sortPeople = function (a, b) {
    if (a.program !== b.program) return a.program < b.program ? -1 : 1;
    return a.name.toLowerCase() < b.name.toLowerCase() ? -1 : 1;
  };
  const everyone = roster.map(function (r) {
    return {
      name: r.name, program: r.program || 'Members',
      active: r.active !== false, isAdmin: !!r.is_admin,
    };
  }).sort(sortPeople);
  // roster = who appears in the name pickers; allPeople = admin's full list
  const rosterDto = everyone.filter(function (r) { return r.active; });

  const today = nyToday();
  const resDto = reservations.map(function (r) {
    return {
      resId: String(r.id), boat: r.boat, name: r.name, dateStr: r.date,
      startMin: r.start_min, endMin: r.end_min,
      startLabel: minToLabel(r.start_min), endLabel: minToLabel(r.end_min),
    };
  }).filter(function (r) { return r.dateStr >= today; });

  return {
    now: Date.now(), today: today, settings: cfg,
    boats: boatsDto, roster: rosterDto, allPeople: everyone, onWater: onWater,
    reservations: resDto, flags: openFlags,
  };
}

module.exports = { sb, enc, str, nyToday, nyNowMinutes, addDays, minToLabel, config, buildState };
