/** GET /api/state — the full app state. Also the target of the daily keepalive cron. */
const lib = require('./_lib.js');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    res.status(200).json(await lib.buildState());
  } catch (e) {
    res.status(500).json({ error: e.message || 'Server error' });
  }
};
