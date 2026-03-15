const { getSQL } = require('./_lib/db');
const { verifyToken } = require('./_lib/auth');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Require auth OR a setup secret
  const setupSecret = process.env.SETUP_SECRET;
  const providedSecret = req.headers['x-setup-secret'];
  const payload = verifyToken(req);

  if (!payload && (!setupSecret || providedSecret !== setupSecret)) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const sql = getSQL();

  try {
    await sql`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        display_name VARCHAR(100) NOT NULL,
        ticket_type VARCHAR(50) DEFAULT 'adult_pre',
        created_at TIMESTAMP DEFAULT NOW()
      )
    `;
    await sql`
      CREATE TABLE IF NOT EXISTS activities (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        venue_id VARCHAR(100) NOT NULL,
        venue_name VARCHAR(255) NOT NULL,
        category VARCHAR(50) NOT NULL,
        icon VARCHAR(10) NOT NULL,
        price DECIMAL(10,2) NOT NULL,
        activity_date DATE NOT NULL,
        hours DECIMAL(3,1) NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `;
    await sql`
      CREATE TABLE IF NOT EXISTS groups (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        code VARCHAR(10) UNIQUE NOT NULL,
        created_by INTEGER REFERENCES users(id),
        created_at TIMESTAMP DEFAULT NOW()
      )
    `;
    await sql`
      CREATE TABLE IF NOT EXISTS group_members (
        id SERIAL PRIMARY KEY,
        group_id INTEGER REFERENCES groups(id) ON DELETE CASCADE,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        joined_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(group_id, user_id)
      )
    `;
    await sql`
      CREATE TABLE IF NOT EXISTS reset_codes (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        code VARCHAR(6) NOT NULL,
        expires_at TIMESTAMP NOT NULL,
        used BOOLEAN DEFAULT FALSE,
        attempts INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `;
    await sql`CREATE INDEX IF NOT EXISTS idx_reset_codes_user ON reset_codes(user_id)`;
    // Add avatar column if not exists
    await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar TEXT`;
    await sql`CREATE INDEX IF NOT EXISTS idx_activities_user ON activities(user_id)`;
    await sql`CREATE INDEX IF NOT EXISTS idx_gm_group ON group_members(group_id)`;
    await sql`CREATE INDEX IF NOT EXISTS idx_gm_user ON group_members(user_id)`;
    await sql`CREATE INDEX IF NOT EXISTS idx_groups_code ON groups(code)`;

    res.status(200).json({ ok: true, message: 'Database tables created' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};
