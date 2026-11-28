import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { SignJWT } from 'jose';
import request from 'supertest';
import type { Config } from '../src/config.js';
import { createApp } from '../src/create-app.js';
import { PgliteDatabase } from '../src/db/pglite-database.js';
import { migrate } from '../src/db/migrate.js';

export const TEST_SECRET = 'test-secret-that-is-at-least-32-characters-long';

export const testConfig: Config = {
  NODE_ENV: 'test',
  PORT: 0,
  PGLITE_DATA_DIR: 'memory://',
  AUTH_JWT_SECRET: TEST_SECRET,
  CORS_ORIGIN: 'http://localhost:5173',
};

export interface TestEnv {
  app: INestApplication;
  db: PgliteDatabase;
  http: ReturnType<typeof request>;
  close(): Promise<void>;
}

export async function setup(): Promise<TestEnv> {
  const db = new PgliteDatabase(); // in-memory PostgreSQL
  await migrate(db);
  const app = await createApp(testConfig, db);
  await app.init();
  return {
    app,
    db,
    http: request(app.getHttpServer()),
    async close() {
      await app.close();
      await db.close();
    },
  };
}

export async function token(sub: string, secret = TEST_SECRET, expiresIn = '1h'): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(sub)
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(new TextEncoder().encode(secret));
}

export interface Actor {
  userId: string;
  headers: Record<string, string>;
}

/** A user with a bearer token, optionally acting within a tenant. */
export async function actor(tenantId?: string, userId: string = randomUUID()): Promise<Actor> {
  const headers: Record<string, string> = { Authorization: `Bearer ${await token(userId)}` };
  if (tenantId) headers['X-Tenant-Id'] = tenantId;
  return { userId, headers };
}

/** Creates a tenant and returns its owner acting within it. */
export async function ownerWithTenant(env: TestEnv, name = 'Tienda'): Promise<{ tenantId: string; owner: Actor }> {
  const user = await actor();
  const res = await env.http.post('/tenants').set(user.headers).send({ name }).expect(201);
  const tenantId = res.body.id as string;
  return { tenantId, owner: await actor(tenantId, user.userId) };
}

export async function addMember(env: TestEnv, owner: Actor, tenantId: string, role: 'admin' | 'cashier'): Promise<Actor> {
  const member = await actor(tenantId);
  await env.http.put('/members').set(owner.headers).send({ userId: member.userId, role }).expect(200);
  return member;
}

export async function createProduct(
  env: TestEnv,
  who: Actor,
  body: { name: string; priceCents: number; costCents: number; stock?: number; sku?: string },
): Promise<{ id: string; stock: number }> {
  const res = await env.http.post('/products').set(who.headers).send(body).expect(201);
  return res.body;
}
