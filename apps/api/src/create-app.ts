import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { AppModule } from './app.module.js';
import type { Config } from './config.js';
import type { Database } from './db/database.js';

export async function createApp(config: Config, db: Database): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule.forRoot(config, db), {
    logger: config.NODE_ENV === 'test' ? false : ['log', 'warn', 'error'],
    bodyParser: true,
  });
  app.enableCors({
    origin: config.CORS_ORIGIN.split(',').map((o) => o.trim()),
    allowedHeaders: ['Authorization', 'Content-Type', 'X-Tenant-Id'],
    methods: ['GET', 'POST', 'PATCH', 'PUT'],
  });
  const http = app.getHttpAdapter().getInstance() as { disable?: (name: string) => void };
  http.disable?.('x-powered-by');
  app.enableShutdownHooks();
  return app;
}
