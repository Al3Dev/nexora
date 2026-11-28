import { Controller, Get, Inject } from '@nestjs/common';
import { Public } from '../auth/decorators.js';
import { Database } from '../db/database.js';

@Controller('health')
export class HealthController {
  constructor(@Inject(Database) private readonly db: Database) {}

  @Public()
  @Get()
  async check() {
    await this.db.ownerTransaction((q) => q.query('SELECT 1'));
    return { status: 'ok' };
  }
}
