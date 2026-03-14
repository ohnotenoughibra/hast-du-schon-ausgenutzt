const { getSQL } = require('./_lib/db');
const bcrypt = require('bcryptjs');
const { createToken, verifyToken, setAuthCookie, clearAuthCookie } = require('./_lib/auth');

module.exports = async function handler(req, res) {
  const sql = getSQL();
  const action = req.query.action;

  // GET /api/auth?action=me
  if (req.method === 'GET' && action === 'me') {
    const payload = verifyToken(req);
    if (!payload) return res.status(401).json({ error: 'Nicht angemeldet' });
    try {
      const rows = await sql`SELECT id, email, display_name, ticket_type FROM users WHERE id = ${payload.userId}`;
      if (rows.length === 0) return res.status(401).json({ error: 'Benutzer nicht gefunden' });
      const u = rows[0];
      return res.status(200).json({ user: { id: u.id, email: u.email, displayName: u.display_name, ticketType: u.ticket_type } });
    } catch (e) {
      return res.status(500).json({ error: 'Fehler beim Laden' });
    }
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // POST /api/auth?action=login
  if (action === 'login') {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'Email und Passwort erforderlich' });
    try {
      const rows = await sql`SELECT id, email, password_hash, display_name, ticket_type FROM users WHERE email = ${email.toLowerCase().trim()}`;
      if (rows.length === 0) return res.status(401).json({ error: 'Ungültige Anmeldedaten' });
      const user = rows[0];
      if (!(await bcrypt.compare(password, user.password_hash))) return res.status(401).json({ error: 'Ungültige Anmeldedaten' });
      setAuthCookie(res, createToken(user.id));
      return res.status(200).json({ user: { id: user.id, email: user.email, displayName: user.display_name, ticketType: user.ticket_type } });
    } catch (e) {
      return res.status(500).json({ error: 'Anmeldung fehlgeschlagen' });
    }
  }

  // POST /api/auth?action=register
  if (action === 'register') {
    const { email, password, displayName } = req.body || {};
    if (!email || !password || !displayName) return res.status(400).json({ error: 'Alle Felder erforderlich' });
    if (password.length < 6) return res.status(400).json({ error: 'Passwort mind. 6 Zeichen' });
    try {
      const existing = await sql`SELECT id FROM users WHERE email = ${email.toLowerCase().trim()}`;
      if (existing.length > 0) return res.status(409).json({ error: 'E-Mail bereits registriert' });
      const hash = await bcrypt.hash(password, 10);
      const rows = await sql`
        INSERT INTO users (email, password_hash, display_name)
        VALUES (${email.toLowerCase().trim()}, ${hash}, ${displayName.trim()})
        RETURNING id, email, display_name, ticket_type
      `;
      const u = rows[0];
      setAuthCookie(res, createToken(u.id));
      return res.status(201).json({ user: { id: u.id, email: u.email, displayName: u.display_name, ticketType: u.ticket_type } });
    } catch (e) {
      return res.status(500).json({ error: 'Registrierung fehlgeschlagen' });
    }
  }

  // POST /api/auth?action=logout
  if (action === 'logout') {
    clearAuthCookie(res);
    return res.status(200).json({ ok: true });
  }

  // POST /api/auth?action=settings
  if (action === 'settings') {
    const payload = verifyToken(req);
    if (!payload) return res.status(401).json({ error: 'Nicht angemeldet' });
    const { ticketType, displayName } = req.body || {};
    try {
      if (ticketType) await sql`UPDATE users SET ticket_type = ${ticketType} WHERE id = ${payload.userId}`;
      if (displayName) await sql`UPDATE users SET display_name = ${displayName.trim()} WHERE id = ${payload.userId}`;
      const rows = await sql`SELECT id, email, display_name, ticket_type FROM users WHERE id = ${payload.userId}`;
      const u = rows[0];
      return res.status(200).json({ user: { id: u.id, email: u.email, displayName: u.display_name, ticketType: u.ticket_type } });
    } catch (e) {
      return res.status(500).json({ error: 'Fehler beim Speichern' });
    }
  }

  res.status(400).json({ error: 'Unknown action' });
};
