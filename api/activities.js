const { getSQL } = require('./_lib/db');
const { verifyToken } = require('./_lib/auth');

module.exports = async function handler(req, res) {
  const payload = verifyToken(req);
  if (!payload) return res.status(401).json({ error: 'Nicht angemeldet' });

  const sql = getSQL();
  const userId = payload.userId;
  const action = req.query.action;

  // POST /api/activities?action=import
  if (req.method === 'POST' && action === 'import') {
    const { activities } = req.body || {};
    if (!Array.isArray(activities) || activities.length === 0) return res.status(400).json({ error: 'Keine Aktivitäten' });
    try {
      let imported = 0;
      for (const a of activities.slice(0, 500)) {
        if (!a.venueId || !a.venueName || !a.category || !a.price || !a.date) continue;
        await sql`
          INSERT INTO activities (user_id, venue_id, venue_name, category, icon, price, activity_date, hours)
          VALUES (${userId}, ${a.venueId}, ${a.venueName}, ${a.category}, ${a.icon || ''}, ${a.price}, ${a.date}, ${a.hours || 4})
        `;
        imported++;
      }
      return res.status(200).json({ ok: true, imported });
    } catch (e) {
      return res.status(500).json({ error: 'Import fehlgeschlagen' });
    }
  }

  // GET
  if (req.method === 'GET') {
    try {
      const rows = await sql`
        SELECT id, venue_id, venue_name, category, icon, price, activity_date, hours
        FROM activities WHERE user_id = ${userId}
        ORDER BY activity_date DESC, created_at DESC
      `;
      return res.status(200).json({ activities: rows.map(fmt) });
    } catch (e) {
      return res.status(500).json({ error: 'Fehler beim Laden' });
    }
  }

  // POST
  if (req.method === 'POST') {
    const { venueId, venueName, category, icon, price, date, hours } = req.body || {};
    if (!venueId || !venueName || !category || !price || !date) return res.status(400).json({ error: 'Fehlende Felder' });
    try {
      const rows = await sql`
        INSERT INTO activities (user_id, venue_id, venue_name, category, icon, price, activity_date, hours)
        VALUES (${userId}, ${venueId}, ${venueName}, ${category}, ${icon || ''}, ${price}, ${date}, ${hours || 4})
        RETURNING id, venue_id, venue_name, category, icon, price, activity_date, hours
      `;
      return res.status(201).json({ activity: fmt(rows[0]) });
    } catch (e) {
      return res.status(500).json({ error: 'Fehler beim Speichern' });
    }
  }

  // DELETE
  if (req.method === 'DELETE') {
    const { id } = req.body || {};
    if (!id) return res.status(400).json({ error: 'ID erforderlich' });
    try {
      await sql`DELETE FROM activities WHERE id = ${id} AND user_id = ${userId}`;
      return res.status(200).json({ ok: true });
    } catch (e) {
      return res.status(500).json({ error: 'Fehler beim Löschen' });
    }
  }

  res.status(405).json({ error: 'Method not allowed' });
};

function fmt(r) {
  return {
    id: r.id, venueId: r.venue_id, venueName: r.venue_name, category: r.category,
    icon: r.icon, price: parseFloat(r.price), date: r.activity_date, hours: parseFloat(r.hours),
  };
}
