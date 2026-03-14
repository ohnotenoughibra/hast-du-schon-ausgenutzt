const { neon } = require('@neondatabase/serverless');

function getSQL() {
  return neon(process.env.DATABASE_URL || process.env.POSTGRES_URL);
}

module.exports = { getSQL };
