const { getSQL } = require('./_lib/db');
const { verifyToken } = require('./_lib/auth');

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

module.exports = async function handler(req, res) {
  const payload = verifyToken(req);
  if (!payload) return res.status(401).json({ error: 'Nicht angemeldet' });

  const sql = getSQL();
  const action = req.query.action;

  // GET /api/groups?action=mine
  if (req.method === 'GET' && action === 'mine') {
    try {
      const rows = await sql`
        SELECT g.id, g.name, g.code, g.created_by,
          (SELECT COUNT(*) FROM group_members WHERE group_id = g.id) as member_count
        FROM groups g
        JOIN group_members gm ON g.id = gm.group_id
        WHERE gm.user_id = ${payload.userId}
        ORDER BY gm.joined_at DESC
      `;
      return res.status(200).json({
        groups: rows.map(g => ({
          id: g.id, name: g.name, code: g.code,
          isOwner: g.created_by === payload.userId,
          memberCount: parseInt(g.member_count),
        })),
      });
    } catch (e) {
      return res.status(500).json({ error: 'Fehler beim Laden' });
    }
  }

  // GET /api/groups?action=leaderboard&code=XYZ
  if (req.method === 'GET' && action === 'leaderboard') {
    const code = req.query.code;
    if (!code) return res.status(400).json({ error: 'Code erforderlich' });
    try {
      const groups = await sql`SELECT id, name, code FROM groups WHERE code = ${code.toUpperCase()}`;
      if (groups.length === 0) return res.status(404).json({ error: 'Gruppe nicht gefunden' });

      const membership = await sql`SELECT id FROM group_members WHERE group_id = ${groups[0].id} AND user_id = ${payload.userId}`;
      if (membership.length === 0) return res.status(403).json({ error: 'Nicht in dieser Gruppe' });

      const lb = await sql`
        SELECT u.id, u.display_name, u.ticket_type, u.avatar,
          COALESCE(SUM(a.price), 0) as total_value,
          COUNT(a.id) as activity_count
        FROM group_members gm
        JOIN users u ON gm.user_id = u.id
        LEFT JOIN activities a ON a.user_id = u.id
        WHERE gm.group_id = ${groups[0].id}
        GROUP BY u.id, u.display_name, u.ticket_type, u.avatar
        ORDER BY total_value DESC
      `;
      return res.status(200).json({
        group: { id: groups[0].id, name: groups[0].name, code: groups[0].code },
        leaderboard: lb.map((r, i) => ({
          rank: i + 1, userId: r.id, displayName: r.display_name, ticketType: r.ticket_type,
          totalValue: parseFloat(r.total_value), activityCount: parseInt(r.activity_count),
          isMe: r.id === payload.userId, avatar: r.avatar || null,
        })),
      });
    } catch (e) {
      return res.status(500).json({ error: 'Fehler beim Laden' });
    }
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // POST /api/groups?action=create
  if (action === 'create') {
    const { name } = req.body || {};
    if (!name || !name.trim()) return res.status(400).json({ error: 'Name erforderlich' });
    try {
      let code, attempts = 0;
      while (attempts < 10) {
        code = generateCode();
        const exists = await sql`SELECT id FROM groups WHERE code = ${code}`;
        if (exists.length === 0) break;
        attempts++;
      }
      const rows = await sql`
        INSERT INTO groups (name, code, created_by) VALUES (${name.trim()}, ${code}, ${payload.userId})
        RETURNING id, name, code
      `;
      await sql`INSERT INTO group_members (group_id, user_id) VALUES (${rows[0].id}, ${payload.userId})`;
      return res.status(201).json({ group: { id: rows[0].id, name: rows[0].name, code: rows[0].code } });
    } catch (e) {
      return res.status(500).json({ error: 'Fehler beim Erstellen' });
    }
  }

  // POST /api/groups?action=join
  if (action === 'join') {
    const { code } = req.body || {};
    if (!code) return res.status(400).json({ error: 'Code erforderlich' });
    try {
      const groups = await sql`SELECT id, name, code FROM groups WHERE code = ${code.toUpperCase().trim()}`;
      if (groups.length === 0) return res.status(404).json({ error: 'Gruppe nicht gefunden' });
      const existing = await sql`SELECT id FROM group_members WHERE group_id = ${groups[0].id} AND user_id = ${payload.userId}`;
      if (existing.length > 0) return res.status(409).json({ error: 'Bereits in dieser Gruppe' });
      await sql`INSERT INTO group_members (group_id, user_id) VALUES (${groups[0].id}, ${payload.userId})`;
      return res.status(200).json({ group: { id: groups[0].id, name: groups[0].name, code: groups[0].code } });
    } catch (e) {
      return res.status(500).json({ error: 'Beitritt fehlgeschlagen' });
    }
  }

  // POST /api/groups?action=leave
  if (action === 'leave') {
    const { groupId } = req.body || {};
    if (!groupId) return res.status(400).json({ error: 'Gruppen-ID erforderlich' });
    try {
      await sql`DELETE FROM group_members WHERE group_id = ${groupId} AND user_id = ${payload.userId}`;
      const remaining = await sql`SELECT id FROM group_members WHERE group_id = ${groupId}`;
      if (remaining.length === 0) await sql`DELETE FROM groups WHERE id = ${groupId}`;
      return res.status(200).json({ ok: true });
    } catch (e) {
      return res.status(500).json({ error: 'Fehler' });
    }
  }

  res.status(400).json({ error: 'Unknown action' });
};
