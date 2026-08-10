/**
 * POST /api/action — all mutations.
 * Body: { action: 'apiCheckout' | 'apiCheckoutOwn' | 'apiCheckin' | 'apiReserve'
 *                 | 'apiCancelRes' | 'apiAddFlag' | 'apiResolveFlag' | 'apiMarkServiced',
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
      if (!boat || !rower || !dateStr || isNaN(startMin) || !(durMin > 0)) return fail('Fill in every field to book.');
      try {
        await sb('reservations', {
          method: 'POST',
          body: { date: dateStr, start_min: startMin, end_min: startMin + durMin, boat: boat, name: rower },
        });
      } catch (e) {
        if (e.code === '23P01') {
          const others = await sb('reservations?select=*&boat=eq.' + enc(boat) + '&date=eq.' + enc(dateStr) + '&status=eq.Booked');
          const conf = others
            .filter(function (r) { return startMin < r.end_min && (startMin + durMin) > r.start_min; })
            .map(function (r) { return r.name + ' (' + lib.minToLabel(r.start_min) + ' to ' + lib.minToLabel(r.end_min) + ')'; });
          return fail(boat + ' is already booked then: ' + (conf.join(', ') || 'time conflict'));
        }
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
