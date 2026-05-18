import request from 'supertest';
import { app } from '../app';
import { pool } from '../db/pool';
import { seedDatabase } from '../db/seed';
import fs from 'node:fs';
import path from 'node:path';

describe('orders API', () => {
  beforeAll(async () => {
    const migration = fs.readFileSync(path.join(__dirname, '../db/migrations/001_init.sql'), 'utf-8');
    await pool.query(migration);
    await seedDatabase();
  });

  afterAll(async () => {
    await pool.end();
  });

  it('returns health status', async () => {
    const response = await request(app).get('/health');
    expect(response.status).toBe(200);
    expect(response.body.status).toBe('ok');
  });

  it('returns one order by id', async () => {
    const response = await request(app).get('/api/orders/1');
    expect(response.status).toBe(200);
    expect(response.body.folio).toBe('ORD-1001');
  });

  it('allows payment update', async () => {
    const response = await request(app).patch('/api/orders/1/pay').send({ amount: 100, source: 'manual' });
    expect(response.status).toBe(200);
    expect(response.body.paid_amount).toBe(100);
  });

  it('does not allow paying a cancelled order', async () => {
    const response = await request(app)
      .patch('/api/orders/4/pay')
      .send({ amount: 100, source: 'manual' });
    expect(response.status).toBe(500);
    expect(response.body.error).toBe('Cannot pay a cancelled order');
  });

  it('handles orders with null recipient_name', async () => {
    const response = await request(app).get('/api/orders/5');
    expect(response.status).toBe(200);
    expect(response.body.folio).toBe('ORD-1005');
    expect(response.body.recipient_name).toBeNull();
  });

  it('applies status filter correctly when combined with date filters', async () => {
    const from = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const response = await request(app).get(`/api/orders?status=cancelled&from=${from}`);
    expect(response.status).toBe(200);
    expect(response.body.data).toHaveLength(1);
    expect(response.body.data[0].folio).toBe('ORD-1004');
  });
});
