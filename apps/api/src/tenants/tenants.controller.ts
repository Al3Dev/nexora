import { Body, ConflictException, Controller, Get, HttpCode, Inject, Post, Put } from '@nestjs/common';
import { z } from 'zod';
import type { AuthContext, TenantAuthContext } from '../auth/auth.types.js';
import { Member, NoTenant, Roles, User } from '../auth/decorators.js';
import { zod } from '../common/zod-validation.pipe.js';
import { Database } from '../db/database.js';

const createTenantSchema = z.object({ name: z.string().trim().min(1).max(120) });
const upsertMemberSchema = z.object({
  userId: z.uuid(),
  // Ownership transfer is intentionally not supported through this endpoint.
  role: z.enum(['admin', 'cashier']),
});

@Controller()
export class TenantsController {
  constructor(@Inject(Database) private readonly db: Database) {}

  /** Tenants the caller belongs to, with their role in each. */
  @NoTenant()
  @Get('me')
  async me(@User() user: AuthContext) {
    const tenants = await this.db.withContext({ userId: user.userId }, (q) =>
      q.query(
        `SELECT t.id, t.name, t.currency, m.role
           FROM memberships m JOIN tenants t ON t.id = m.tenant_id
          WHERE m.user_id = $1
          ORDER BY t.created_at`,
        [user.userId],
      ),
    );
    return { userId: user.userId, tenants };
  }

  @NoTenant()
  @Post('tenants')
  async create(@User() user: AuthContext, @Body(zod(createTenantSchema)) body: z.infer<typeof createTenantSchema>) {
    const [row] = await this.db.withContext({ userId: user.userId }, (q) =>
      q.query<{ id: string }>('SELECT create_tenant_with_owner($1) AS id', [body.name]),
    );
    return { id: row!.id, name: body.name, role: 'owner' };
  }

  @Roles('owner', 'admin')
  @Get('members')
  async members(@Member() m: TenantAuthContext) {
    return this.db.withContext(m, (q) =>
      q.query('SELECT user_id AS "userId", role, created_at AS "createdAt" FROM memberships WHERE tenant_id = $1 ORDER BY created_at', [
        m.tenantId,
      ]),
    );
  }

  /** Add a member or change their role. Only the owner manages members. */
  @Roles('owner')
  @Put('members')
  @HttpCode(200)
  async upsertMember(@Member() m: TenantAuthContext, @Body(zod(upsertMemberSchema)) body: z.infer<typeof upsertMemberSchema>) {
    const rows = await this.db.withContext(m, (q) =>
      q.query(
        `INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, $3)
         ON CONFLICT (tenant_id, user_id) DO UPDATE SET role = EXCLUDED.role
           WHERE memberships.role <> 'owner'
         RETURNING user_id AS "userId", role`,
        [m.tenantId, body.userId, body.role],
      ),
    );
    if (rows.length === 0) throw new ConflictException("The owner's role cannot be changed");
    return rows[0];
  }
}
