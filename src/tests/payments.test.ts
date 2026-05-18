import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { app } from '../app';
import { pool } from '../db/pool';
import { seedDatabase } from '../db/seed';

describe('payments API', () => {
  beforeAll(async () => {
    const migration = fs.readFileSync(path.join(__dirname, '../db/migrations/001_init.sql'), 'utf-8');
    await pool.query(migration);
    await seedDatabase();
  });

  afterAll(async () => {
    await pool.end();
  });

  it('accepts paycash webhook', async () => {
    const response = await request(app).post('/api/webhooks/paycash').send({
      eventId: 'evt-100-new',
      folio: 'ORD-1002',
      amount: 200,
      paidAt: new Date().toISOString(),
    });

    expect(response.status).toBe(202);
    expect(response.body.applied).toBe(true);
  });

  it('does not process the same webhook event twice', async () => {
    const payload = {
      eventId: 'evt-idempotent-test',
      folio: 'ORD-1007',
      amount: 100,
      paidAt: new Date().toISOString(),
    };

    const first = await request(app).post('/api/webhooks/paycash').send(payload);
    expect(first.status).toBe(202);
    expect(first.body.applied).toBe(true);

    const second = await request(app).post('/api/webhooks/paycash').send(payload);
    expect(second.status).toBe(202);
    expect(second.body.applied).toBe(false);
    expect(second.body.reason).toBe('Duplicate event');
  });

  it('does not apply payment to cancelled orders from webhook', async () => {
    const response = await request(app).post('/api/webhooks/paycash').send({
      eventId: 'evt-cancelled-test',
      folio: 'ORD-1004',
      amount: 300,
      paidAt: new Date().toISOString(),
    });

    expect(response.status).toBe(202);
    expect(response.body.applied).toBe(false);
    expect(response.body.reason).toBe('Order is cancelled');
  });
});
