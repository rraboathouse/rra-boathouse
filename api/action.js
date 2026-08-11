/**
 * POST /api/action — all mutations.
 * Body: { action: 'apiCheckout' | 'apiCheckoutOwn' | 'apiCheckin' | 'apiReserve'
 *                 | 'apiEditRes' | 'apiCancelRes' | 'apiAddFlag' | 'apiResolveFlag'
 *                 | 'apiMarkServiced'
 *                 | 'apiSaveBoat' | 'apiDeleteBoat' | 'apiSaveMember'
 *                 | 'apiDeleteMember' | 'apiSaveSettings',
 *         payload: {...} }
 * Response: { ok, error?, state } — state is always the fresh full state.
 *
 * The two race-sensitive invariants (no double checkout, no overlapping
 * bookings) are enforced by the database itself (see schema.sql); this code
 * just translates those violations into friendly messages.
 */
const lib = require('./_lib.js');
const sb = lib.sb, enc = lib.enc, str = lib.str;

function ok() { return { ok: true }; }
function fail(msg) { return { ok: false, error: msg }; }

/** Shared validation for booking and editing: date inside the window, sane times. */
async function validateSlot(dateStr, startMin, durMin) {
  if (!dateStr || isNaN(startMin) || !(durMin > 0)) return 'Fill in every field to book.';
  const today = lib.nyToday();
  if (dateStr < today) return 'That day has already passed.';
  const cfg = await lib.config();
  const latest = lib.addDays(today, cfg.windowDays);
  if (dateStr > latest) {
    return 'Bookings only open ' + cfg.windowDays + ' days ahead. Try again closer to the day.';
  }
  if (startMin < 0 || startMin + durMin > 24 * 60) return 'That outing would run past midnight.';
  return null;
}

/** Human list of what a boat is already booked for, ignoring one reservation id. */
async function conflictText(boat, dateStr, startMin, endMin, ignoreId) {
  const others = await sb('reservations?select=*&boat=eq.' + enc(boat) + '&date=eq.' + enc(dateStr) + '&status=eq.Booked');
  const conf = others
    .filter(function (r) { return String(r.id) !== String(ignoreId || ''); })
    .filter(function (r) { return startMin < r.end_min && endMin > r.start_min; })
    .map(function (r) { return r.name + ' (' + lib.minToLabel(r.start_min) + ' to ' + lib.minToLabel(r.end_min) + ')'; });
  return boat + ' is already booked then: ' + (conf.join(', ') || 'time conflict');
}

/**
 * The admin gate. While settings.admin_open is 1 (how the club starts), anyone
 * can use the gear. Set it to 0 and only roster members with is_admin can.
 * Identity here is the name picked in the app, same honor system as checkout:
 * it keeps the wrong people out by accident, not by force.
 */
async function requireAdmin(actor) {
  const cfg = await lib.config();
  if (Number(cfg.adminOpen) === 1) return null;
  const name = str(actor);
  if (!name) return 'Pick your name in the app first: admin changes are limited to club admins.';
  const rows = await sb('roster?select=is_admin&name=eq.' + enc(name));
  if (!rows[0] || !rows[0].is_admin) return name + ' is not set up as a club admin. Ask an admin to add you.';
  return null;
}

/** Renaming a boat or a person rewrites the history that points at the old name. */
async function cascadeRename(kind, oldName, newName) {
  if (oldName === newName) return;
  if (kind === 'boat') {
    await sb('log?boat=eq.' + enc(oldName), { method: 'PATCH', body: { boat: newName } });
    await sb('reservations?boat=eq.' + enc(oldName), { method: 'PATCH', body: { boat: newName } });
    await sb('flags?boat=eq.' + enc(oldName), { method: 'PATCH', body: { boat: newName } });
  } else {
    await sb('log?rower=eq.' + enc(oldName), { method: 'PATCH', body: { rower: newName } });
    await sb('reservations?name=eq.' + enc(oldName), { method: 'PATCH', body: { name: newName } });
    await sb('flags?reported_by=eq.' + enc(oldName), { method: 'PATCH', body: { reported_by: newName } });
  }
}

const BOAT_TYPES = ['1x', '2x', '4x', '4+', '8+'];
const WEIGHTS = ['', 'lightweight', 'midweight', 'heavyweight'];
const STATUSES = ['Available', 'Out of service'];

async function handle(action, p) {
  switch (action) {

    case 'apiCheckout': {
      const boat = str(p.boat), rower = str(p.rower);
      if (!boat || !rower) return fail('Pick your name and a boat.');
      const rows = await sb('boats?select=*&name=eq.' + enc(boat));
      const b = rows[0];
      if (!b) return fail('Boat "' + boat + '" not found.');
      if (b.status !== 'Available') return fail(boat + ' is marked "' + b.status + '" and cannot go out.');
      const open = await sb('log?select=rower&boat=eq.' + enc(boat) + '&in_at=is.null&own_boat=eq.false');
      if (open.length) return fail(boat + ' is already on the water with ' + open[0].rower + '.');
      try {
        await sb('log', { method: 'POST', body: { boat: boat, own_boat: false, rower: rower, crew: str(p.crew) } });
      } catch (e) {
        if (e.code === '23505') return fail(boat + ' was just checked out by someone else. Pick another boat.');
        throw e;
      }
      // If this rower booked this boat for right about now, mark it fulfilled
      const today = lib.nyToday();
      const nowMin = lib.nyNowMinutes();
      const myres = await sb('reservations?select=*&boat=eq.' + enc(boat) + '&date=eq.' + today +
                             '&status=eq.Booked&name=eq.' + enc(rower));
      for (const r of myres) {
        if (nowMin >= r.start_min - 45 && nowMin <= r.end_min) {
          await sb('reservations?id=eq.' + r.id, { method: 'PATCH', body: { status: 'Fulfilled' } });
        }
      }
      return ok();
    }

    case 'apiCheckoutOwn': {
      const rower = str(p.rower);
      if (!rower) return fail('Pick your name first.');
      const desc = str(p.boatDesc) || 'private boat';
      await sb('log', { method: 'POST', body: { boat: 'OWN: ' + desc, own_boat: true, rower: rower, crew: str(p.crew) } });
      return ok();
    }

    case 'apiCheckin': {
      const id = parseInt(p.logId, 10);
      if (!id) return fail('Could not find that outing in the Log.');
      const rows = await sb('log?select=*&id=eq.' + id);
      const l = rows[0];
      if (!l) return fail('Could not find that outing in the Log.');
      if (l.in_at) return fail('That outing was already checked in.');
      const minutes = Math.max(1, Math.round((Date.now() - new Date(l.out_at).getTime()) / 60000));
      const issue = str(p.issue);
      await sb('log?id=eq.' + id, { method: 'PATCH', body: { in_at: new Date().toISOString(), minutes: minutes, issue_reported: issue } });
      if (!l.own_boat) {
        const brows = await sb('boats?select=*&name=eq.' + enc(l.boat));
        if (brows[0]) {
          await sb('boats?id=eq.' + brows[0].id, {
            method: 'PATCH',
            body: { uses_total: brows[0].uses_total + 1, uses_since_service: brows[0].uses_since_service + 1 },
          });
        }
        if (issue) {
          await sb('flags', { method: 'POST', body: { boat: l.boat, issue: issue, reported_by: l.rower } });
        }
      }
      return ok();
    }

    case 'apiReserve': {
      const boat = str(p.boat), rower = str(p.rower), dateStr = str(p.dateStr);
      const startMin = parseInt(p.startMin, 10), durMin = parseInt(p.durMin, 10);
      if (!boat || !rower) return fail('Fill in every field to book.');
      const bad = await validateSlot(dateStr, startMin, durMin);
      if (bad) return fail(bad);
      try {
        await sb('reservations', {
          method: 'POST',
          body: { date: dateStr, start_min: startMin, end_min: startMin + durMin, boat: boat, name: rower },
        });
      } catch (e) {
        if (e.code === '23P01') return fail(await conflictText(boat, dateStr, startMin, startMin + durMin, null));
        throw e;
      }
      return ok();
    }

    case 'apiEditRes': {
      const id = parseInt(p.resId, 10);
      if (!id) return fail('Could not find that booking.');
      const rows = await sb('reservations?select=*&id=eq.' + id);
      const r = rows[0];
      if (!r) return fail('Could not find that booking.');
      if (r.status !== 'Booked') return fail('That booking was already cancelled.');

      const boat = str(p.boat) || r.boat;
      const dateStr = str(p.dateStr) || r.date;
      const startMin = p.startMin != null ? parseInt(p.startMin, 10) : r.start_min;
      const durMin = p.durMin != null ? parseInt(p.durMin, 10) : (r.end_min - r.start_min);
      const bad = await validateSlot(dateStr, startMin, durMin);
      if (bad) return fail(bad);

      const brows = await sb('boats?select=status&name=eq.' + enc(boat));
      if (!brows[0]) return fail('Boat "' + boat + '" not found.');
      if (brows[0].status !== 'Available' && boat !== r.boat) {
        return fail(boat + ' is marked "' + brows[0].status + '" and cannot be booked.');
      }

      try {
        await sb('reservations?id=eq.' + id, {
          method: 'PATCH',
          body: { boat: boat, date: dateStr, start_min: startMin, end_min: startMin + durMin },
        });
      } catch (e) {
        if (e.code === '23P01') return fail(await conflictText(boat, dateStr, startMin, startMin + durMin, id));
        throw e;
      }
      return ok();
    }

    case 'apiCancelRes': {
      const id = parseInt(p.resId, 10);
      if (!id) return fail('Could not find that booking.');
      const rows = await sb('reservations?select=id&id=eq.' + id);
      if (!rows[0]) return fail('Could not find that booking.');
      await sb('reservations?id=eq.' + id, { method: 'PATCH', body: { status: 'Cancelled' } });
      return ok();
    }

    case 'apiAddFlag': {
      const boat = str(p.boat), issue = str(p.issue);
      if (!boat || !issue) return fail('Describe the issue first.');
      await sb('flags', { method: 'POST', body: { boat: boat, issue: issue, reported_by: str(p.rower) } });
      return ok();
    }

    case 'apiResolveFlag': {
      const id = parseInt(p.flagId, 10);
      if (!id) return fail('Could not find that flag.');
      const rows = await sb('flags?select=id&id=eq.' + id);
      if (!rows[0]) return fail('Could not find that flag.');
      await sb('flags?id=eq.' + id, { method: 'PATCH', body: { status: 'Resolved', resolved_on: lib.nyToday() } });
      return ok();
    }

    case 'apiMarkServiced': {
      const boat = str(p.boat);
      const rows = await sb('boats?select=id&name=eq.' + enc(boat));
      if (!rows[0]) return fail('Could not find that boat.');
      await sb('boats?id=eq.' + rows[0].id, { method: 'PATCH', body: { uses_since_service: 0, last_serviced: lib.nyToday() } });
      return ok();
    }

    /* ---------------------------------------------------- admin: boats --- */
    case 'apiSaveBoat': {
      const denied = await requireAdmin(p.actor);
      if (denied) return fail(denied);

      const original = str(p.originalName);          // blank = adding a new boat
      const name = str(p.name).toUpperCase();
      const type = str(p.type);
      const weight = str(p.weightClass).toLowerCase();
      const status = str(p.status) || 'Available';
      if (!name) return fail('Give the boat a name.');
      if (BOAT_TYPES.indexOf(type) < 0) return fail('Pick a boat type.');
      if (WEIGHTS.indexOf(weight) < 0) return fail('Weight class must be lightweight, midweight, or heavyweight.');
      if (STATUSES.indexOf(status) < 0) return fail('Unknown status.');
      const interval = Math.max(0, parseInt(p.serviceInterval, 10) || 0);

      const clash = await sb('boats?select=id&name=eq.' + enc(name));
      const body = {
        name: name, type: type, weight_class: weight, status: status,
        quick_release: !!p.quickRelease, service_interval: interval, notes: str(p.notes),
      };

      if (!original) {
        if (clash.length) return fail('There is already a boat called ' + name + '.');
        // start the counters explicitly rather than leaning on column defaults
        await sb('boats', { method: 'POST', body: Object.assign({ uses_total: 0, uses_since_service: 0 }, body) });
        return ok();
      }

      const rows = await sb('boats?select=*&name=eq.' + enc(original));
      if (!rows[0]) return fail('Could not find ' + original + '.');
      if (name !== original && clash.length) return fail('There is already a boat called ' + name + '.');
      await sb('boats?id=eq.' + rows[0].id, { method: 'PATCH', body: body });
      await cascadeRename('boat', original, name);
      return ok();
    }

    case 'apiDeleteBoat': {
      const denied = await requireAdmin(p.actor);
      if (denied) return fail(denied);
      const name = str(p.name);
      const rows = await sb('boats?select=id&name=eq.' + enc(name));
      if (!rows[0]) return fail('Could not find that boat.');
      const out = await sb('log?select=id&boat=eq.' + enc(name) + '&in_at=is.null');
      if (out.length) return fail(name + ' is on the water right now. Check it in first.');
      const booked = await sb('reservations?select=id&boat=eq.' + enc(name) + '&status=eq.Booked&date=gte.' + lib.nyToday());
      if (booked.length) return fail(name + ' still has ' + booked.length + ' booking' + (booked.length > 1 ? 's' : '') + '. Cancel those first, or set it Out of service instead.');
      await sb('boats?id=eq.' + rows[0].id, { method: 'DELETE' });
      return ok();
    }

    /* --------------------------------------------------- admin: roster --- */
    case 'apiSaveMember': {
      const denied = await requireAdmin(p.actor);
      if (denied) return fail(denied);

      const original = str(p.originalName);          // blank = adding someone new
      const name = str(p.name);
      const program = str(p.program) || 'Masters';
      if (!name) return fail('Enter a name.');

      const clash = await sb('roster?select=id&name=eq.' + enc(name));
      const body = {
        name: name, program: program,
        active: p.active !== false, is_admin: !!p.isAdmin,
      };

      if (!original) {
        if (clash.length) return fail(name + ' is already on the roster.');
        await sb('roster', { method: 'POST', body: body });
        return ok();
      }

      const rows = await sb('roster?select=*&name=eq.' + enc(original));
      if (!rows[0]) return fail('Could not find ' + original + '.');
      if (name !== original && clash.length) return fail(name + ' is already on the roster.');

      // Do not let the last admin remove their own admin rights while the gate is on
      if (rows[0].is_admin && !body.is_admin) {
        const cfg = await lib.config();
        if (Number(cfg.adminOpen) !== 1) {
          const admins = await sb('roster?select=id&is_admin=eq.true');
          if (admins.length <= 1) return fail('That is the only admin left. Make someone else an admin first.');
        }
      }

      await sb('roster?id=eq.' + rows[0].id, { method: 'PATCH', body: body });
      await cascadeRename('member', original, name);
      return ok();
    }

    case 'apiDeleteMember': {
      const denied = await requireAdmin(p.actor);
      if (denied) return fail(denied);
      const name = str(p.name);
      const rows = await sb('roster?select=*&name=eq.' + enc(name));
      if (!rows[0]) return fail('Could not find that person.');
      const out = await sb('log?select=id&rower=eq.' + enc(name) + '&in_at=is.null');
      if (out.length) return fail(name + ' is on the water right now.');
      if (rows[0].is_admin) {
        const cfg = await lib.config();
        if (Number(cfg.adminOpen) !== 1) {
          const admins = await sb('roster?select=id&is_admin=eq.true');
          if (admins.length <= 1) return fail('That is the only admin left. Make someone else an admin first.');
        }
      }
      await sb('roster?id=eq.' + rows[0].id, { method: 'DELETE' });
      return ok();
    }

    /* ------------------------------------------------- admin: settings --- */
    case 'apiSaveSettings': {
      const denied = await requireAdmin(p.actor);
      if (denied) return fail(denied);

      const windowDays = parseInt(p.windowDays, 10);
      const interval = parseInt(p.defaultInterval, 10);
      const hours = parseInt(p.maxOutingHours, 10);
      if (!(windowDays >= 1 && windowDays <= 60)) return fail('Booking window should be between 1 and 60 days.');
      if (!(interval >= 1 && interval <= 500)) return fail('Service interval should be between 1 and 500 rows.');
      if (!(hours >= 1 && hours <= 24)) return fail('Overdue threshold should be between 1 and 24 hours.');

      const adminOpen = p.adminOpen ? 1 : 0;
      if (adminOpen === 0) {
        const admins = await sb('roster?select=id&is_admin=eq.true');
        if (!admins.length) {
          return fail('Mark at least one person as an admin before locking the gear, or nobody will be able to get back in.');
        }
      }

      const pairs = [
        ['reservation_window_days', windowDays],
        ['default_service_interval', interval],
        ['max_outing_hours', hours],
        ['admin_open', adminOpen],
      ];
      for (const kv of pairs) {
        const existing = await sb('settings?select=key&key=eq.' + enc(kv[0]));
        if (existing.length) await sb('settings?key=eq.' + enc(kv[0]), { method: 'PATCH', body: { value: kv[1] } });
        else await sb('settings', { method: 'POST', body: { key: kv[0], value: kv[1] } });
      }
      return ok();
    }

    default:
      return fail('Unknown action: ' + action);
  }
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  if (!body || typeof body !== 'object') body = {};
  try {
    const out = await handle(body.action, body.payload || {});
    out.state = await lib.buildState();
    res.status(200).json(out);
  } catch (e) {
    try {
      res.status(200).json({ ok: false, error: e.message || 'Server error', state: await lib.buildState() });
    } catch (e2) {
      res.status(500).json({ ok: false, error: e.message || 'Server error' });
    }
  }
};
