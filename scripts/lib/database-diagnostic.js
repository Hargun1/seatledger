// Deliberately no migrations, seeds, role changes or Docker commands here.
export async function diagnoseDatabase(pool, expectedMigrations) {
  let db;
  try {
    db = await pool.connect();
    await db.query('BEGIN READ ONLY');
    await db.query("SELECT set_config('statement_timeout','3000ms',true)");
    const ledger = await db.query('SELECT name,checksum FROM schema_migrations ORDER BY name');
    const applied = new Map(ledger.rows.map(row => [row.name, row.checksum]));
    if (expectedMigrations.some(row => applied.has(row.name) && applied.get(row.name) !== row.checksum)) {
      return { ok: false, code: 'MIGRATION_MISMATCH' };
    }
    if (expectedMigrations.some(row => !applied.has(row.name))) return { ok: false, code: 'MIGRATIONS_PENDING' };
    if (applied.size !== expectedMigrations.length) return { ok: false, code: 'MIGRATIONS_UNKNOWN' };
    // A migration ledger alone cannot prove that its tables still exist.
    const tables = ['users', 'sessions', 'organizers', 'organizer_memberships', 'events', 'show_seats', 'audit_events', 'auth_rate_limits'];
    for (const table of tables) {
      const result = await db.query('SELECT to_regclass($1) IS NOT NULL AS present', [table]);
      if (!result.rows[0]?.present) return { ok: false, code: 'SCHEMA_INCOMPLETE' };
    }
    return { ok: true, code: 'DATABASE_READY' };
  } catch (error) {
    // Never return server messages, connection strings, hostnames or credentials.
    const codes = {
      ECONNREFUSED: 'DATABASE_OFFLINE', ETIMEDOUT: 'DATABASE_UNREACHABLE',
      ENOTFOUND: 'DATABASE_DNS', EAI_AGAIN: 'DATABASE_DNS',
      '28P01': 'DATABASE_LOGIN', '28000': 'DATABASE_LOGIN',
      '3D000': 'DATABASE_MISSING', '42P01': 'SCHEMA_MISSING',
      '42501': 'DATABASE_PERMISSION', '57014': 'DATABASE_TIMEOUT'
    };
    return { ok: false, code: codes[error.code] ?? 'DATABASE_CHECK_FAILED' };
  } finally {
    if (db) {
      let discard = false;
      try { await db.query('ROLLBACK'); }
      catch { discard = true; }
      finally { db.release(discard); }
    }
  }
}
