import { pool } from '../db/pool';

export async function setupDatabaseForTests(): Promise<void> {
  await pool.query('SELECT 1');
}

export async function teardownDatabaseForTests(): Promise<void> {
  await pool.end();
}
