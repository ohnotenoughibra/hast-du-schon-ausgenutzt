const { getSQL } = require('./_lib/db');
const bcrypt = require('bcryptjs');
const { createToken, verifyToken, setAuthCookie, clearAuthCookie } = require('./_lib/auth');

const crypto = require('crypto');

function generateCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

async function sendResetEmail(email, code) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error('Email-Versand nicht konfiguriert');

  const fromEmail = process.env.RESEND_FROM || 'noreply@hast-du-schon-ausgenutzt.vercel.app';

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: `Freizeitticket Tracker <${fromEmail}>`,
      to: [email],
      subject: `Dein Reset-Code: ${code}`,
      html: `
        <div style="font-family:sans-serif;max-width:400px;margin:0 auto;padding:32px">
          <h2 style="color:#1B7A9A;margin-bottom:8px">Passwort zurücksetzen</h2>
          <p style="color:#555;font-size:14px">Dein Code zum Zurücksetzen des Passworts:</p>
          <div style="background:#F4F7FA;border-radius:12px;padding:24px;text-align:center;margin:24px 0">
            <div style="font-size:36px;font-weight:900;letter-spacing:8px;color:#2C3E50">${code}</div>
          </div>
          <p style="color:#888;font-size:12px">Der Code ist 15 Minuten gültig. Falls du kein Zurücksetzen angefordert hast, ignoriere diese E-Mail.</p>
          <hr style="border:none;border-top:1px solid #eee;margin:24px 0">
          <p style="color:#aaa;font-size:11px">Freizeitticket Tirol Tracker</p>
        </div>
      `,
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || 'Email konnte nicht gesendet werden');
  }
}

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

  // POST /api/auth?action=forgot
  if (action === 'forgot') {
    const { email } = req.body || {};
    if (!email) return res.status(400).json({ error: 'E-Mail erforderlich' });

    try {
      const users = await sql`SELECT id, email FROM users WHERE email = ${email.toLowerCase().trim()}`;
      if (users.length === 0) {
        // Don't reveal whether email exists — always return success
        return res.status(200).json({ ok: true });
      }

      const user = users[0];

      // Rate limit: max 3 codes per hour per user
      const recentCodes = await sql`
        SELECT COUNT(*) as cnt FROM reset_codes
        WHERE user_id = ${user.id} AND created_at > NOW() - INTERVAL '1 hour'
      `;
      if (parseInt(recentCodes[0].cnt) >= 3) {
        return res.status(429).json({ error: 'Zu viele Anfragen. Bitte warte eine Stunde.' });
      }

      // Clean up expired codes and invalidate existing unused ones
      await sql`DELETE FROM reset_codes WHERE expires_at < NOW()`;
      await sql`UPDATE reset_codes SET used = TRUE WHERE user_id = ${user.id} AND used = FALSE`;

      // Generate and store new code
      const code = generateCode();
      const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 min

      await sql`
        INSERT INTO reset_codes (user_id, code, expires_at)
        VALUES (${user.id}, ${code}, ${expiresAt.toISOString()})
      `;

      // Send email
      try {
        await sendResetEmail(user.email, code);
      } catch (emailErr) {
        console.error('Reset email failed:', emailErr.message);
        // Code is still in DB — admin can look up in logs
        console.log(`RESET CODE for ${user.email}: ${code}`);
        return res.status(500).json({ error: 'Email konnte nicht gesendet werden. Bitte verifiziere eine Domain in resend.com oder kontaktiere den Administrator.' });
      }

      return res.status(200).json({ ok: true });
    } catch (e) {
      if (e.message.includes('nicht konfiguriert')) {
        return res.status(500).json({ error: 'Email-Versand nicht konfiguriert. Kontaktiere den Administrator.' });
      }
      return res.status(500).json({ error: 'Fehler beim Senden. Bitte versuche es erneut.' });
    }
  }

  // POST /api/auth?action=reset
  if (action === 'reset') {
    const { email, code, password } = req.body || {};
    if (!email || !code || !password) return res.status(400).json({ error: 'Alle Felder erforderlich' });
    if (password.length < 6) return res.status(400).json({ error: 'Passwort mind. 6 Zeichen' });

    try {
      const users = await sql`SELECT id FROM users WHERE email = ${email.toLowerCase().trim()}`;
      if (users.length === 0) return res.status(400).json({ error: 'Ungültiger Code' });

      const userId = users[0].id;

      // Find valid code
      const codes = await sql`
        SELECT id, code, attempts FROM reset_codes
        WHERE user_id = ${userId} AND used = FALSE AND expires_at > NOW()
        ORDER BY created_at DESC LIMIT 1
      `;

      if (codes.length === 0) return res.status(400).json({ error: 'Code abgelaufen oder ungültig' });

      const resetRow = codes[0];

      // Max 5 attempts per code
      if (resetRow.attempts >= 5) {
        await sql`UPDATE reset_codes SET used = TRUE WHERE id = ${resetRow.id}`;
        return res.status(400).json({ error: 'Zu viele Versuche. Fordere einen neuen Code an.' });
      }

      // Increment attempts
      await sql`UPDATE reset_codes SET attempts = attempts + 1 WHERE id = ${resetRow.id}`;

      // Verify code (constant-time comparison)
      const codeMatch = constantTimeEqual(code.trim(), resetRow.code);
      if (!codeMatch) {
        const remaining = 4 - resetRow.attempts;
        return res.status(400).json({ error: `Ungültiger Code. ${remaining > 0 ? remaining + ' Versuche übrig.' : 'Fordere einen neuen Code an.'}` });
      }

      // Mark code as used
      await sql`UPDATE reset_codes SET used = TRUE WHERE id = ${resetRow.id}`;

      // Update password
      const hash = await bcrypt.hash(password, 10);
      await sql`UPDATE users SET password_hash = ${hash} WHERE id = ${userId}`;

      return res.status(200).json({ ok: true });
    } catch (e) {
      return res.status(500).json({ error: 'Fehler beim Zurücksetzen' });
    }
  }

  // POST /api/auth?action=change-password
  if (action === 'change-password') {
    const payload = verifyToken(req);
    if (!payload) return res.status(401).json({ error: 'Nicht angemeldet' });
    const { oldPassword, newPassword } = req.body || {};
    if (!oldPassword || !newPassword) return res.status(400).json({ error: 'Alle Felder erforderlich' });
    if (newPassword.length < 6) return res.status(400).json({ error: 'Neues Passwort mind. 6 Zeichen' });
    try {
      const rows = await sql`SELECT password_hash FROM users WHERE id = ${payload.userId}`;
      if (rows.length === 0) return res.status(401).json({ error: 'Benutzer nicht gefunden' });
      if (!(await bcrypt.compare(oldPassword, rows[0].password_hash))) {
        return res.status(400).json({ error: 'Aktuelles Passwort ist falsch' });
      }
      const hash = await bcrypt.hash(newPassword, 10);
      await sql`UPDATE users SET password_hash = ${hash} WHERE id = ${payload.userId}`;
      return res.status(200).json({ ok: true });
    } catch (e) {
      return res.status(500).json({ error: 'Fehler beim Ändern' });
    }
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

  // ========== ADMIN ACTIONS ==========

  // GET /api/auth?action=admin-users
  if (req.method === 'GET' && action === 'admin-users') {
    const payload = verifyToken(req);
    if (!payload) return res.status(401).json({ error: 'Nicht angemeldet' });
    if (!(await isAdmin(sql, payload.userId))) return res.status(403).json({ error: 'Kein Zugriff' });

    try {
      const rows = await sql`
        SELECT u.id, u.email, u.display_name, u.ticket_type, u.created_at,
          (SELECT COUNT(*) FROM activities WHERE user_id = u.id) as activity_count,
          (SELECT COALESCE(SUM(price), 0) FROM activities WHERE user_id = u.id) as total_value
        FROM users u ORDER BY u.created_at DESC
      `;
      return res.status(200).json({ users: rows });
    } catch (e) {
      return res.status(500).json({ error: 'Fehler beim Laden' });
    }
  }

  // POST /api/auth?action=admin-reset
  if (action === 'admin-reset') {
    const payload = verifyToken(req);
    if (!payload) return res.status(401).json({ error: 'Nicht angemeldet' });
    if (!(await isAdmin(sql, payload.userId))) return res.status(403).json({ error: 'Kein Zugriff' });

    const { userId, newPassword } = req.body || {};
    if (!userId || !newPassword) return res.status(400).json({ error: 'User-ID und Passwort erforderlich' });
    if (newPassword.length < 6) return res.status(400).json({ error: 'Passwort mind. 6 Zeichen' });

    try {
      const hash = await bcrypt.hash(newPassword, 10);
      const rows = await sql`UPDATE users SET password_hash = ${hash} WHERE id = ${userId} RETURNING email, display_name`;
      if (rows.length === 0) return res.status(404).json({ error: 'Benutzer nicht gefunden' });
      return res.status(200).json({ ok: true, user: rows[0] });
    } catch (e) {
      return res.status(500).json({ error: 'Fehler beim Zurücksetzen' });
    }
  }

  // POST /api/auth?action=admin-delete-user
  if (action === 'admin-delete-user') {
    const payload = verifyToken(req);
    if (!payload) return res.status(401).json({ error: 'Nicht angemeldet' });
    if (!(await isAdmin(sql, payload.userId))) return res.status(403).json({ error: 'Kein Zugriff' });

    const { userId } = req.body || {};
    if (!userId) return res.status(400).json({ error: 'User-ID erforderlich' });
    if (userId === payload.userId) return res.status(400).json({ error: 'Du kannst dich nicht selbst löschen' });

    try {
      await sql`DELETE FROM users WHERE id = ${userId}`;
      return res.status(200).json({ ok: true });
    } catch (e) {
      return res.status(500).json({ error: 'Fehler beim Löschen' });
    }
  }

  res.status(400).json({ error: 'Unknown action' });
};

async function isAdmin(sql, userId) {
  const adminEmails = (process.env.ADMIN_EMAILS || '').split(',').map(e => e.trim().toLowerCase()).filter(e => e.length > 0);
  if (adminEmails.length === 0) return false;
  const rows = await sql`SELECT email FROM users WHERE id = ${userId}`;
  if (rows.length === 0) return false;
  return adminEmails.includes(rows[0].email.toLowerCase());
}
