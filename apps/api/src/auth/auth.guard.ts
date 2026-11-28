import {
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { z } from 'zod';
import { Database } from '../db/database.js';
import type { AuthContext, Role } from './auth.types.js';
import { IS_PUBLIC, NO_TENANT, ROLES } from './decorators.js';
import { TokenVerifier } from './token-verifier.js';

const tenantIdSchema = z.uuid();

interface HttpRequest {
  headers: Record<string, string | string[] | undefined>;
  auth?: AuthContext;
}

/**
 * Global guard: authenticates every request (unless @Public), then verifies the
 * caller's membership in the tenant named by the X-Tenant-Id header and the
 * route's required roles.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(TokenVerifier) private readonly verifier: TokenVerifier,
    @Inject(Database) private readonly db: Database,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;

    const req = context.switchToHttp().getRequest<HttpRequest>();
    const header = req.headers.authorization;
    const match = typeof header === 'string' ? /^Bearer (\S+)$/.exec(header) : null;
    const userId = match?.[1] ? await this.verifier.verify(match[1]) : null;
    if (!userId) throw new UnauthorizedException('Valid bearer token required');

    if (this.reflector.getAllAndOverride<boolean>(NO_TENANT, targets)) {
      req.auth = { userId };
      return true;
    }

    const tenant = tenantIdSchema.safeParse(req.headers['x-tenant-id']);
    if (!tenant.success) throw new ForbiddenException('X-Tenant-Id header with a tenant id is required');

    const rows = await this.db.withContext({ userId, tenantId: tenant.data }, (q) =>
      q.query<{ role: Role }>('SELECT role FROM memberships WHERE tenant_id = $1 AND user_id = $2', [
        tenant.data,
        userId,
      ]),
    );
    const role = rows[0]?.role;
    if (!role) throw new ForbiddenException('Not a member of this tenant');

    const allowed = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES, targets);
    if (allowed && !allowed.includes(role)) throw new ForbiddenException('Insufficient role');

    req.auth = { userId, tenantId: tenant.data, role };
    return true;
  }
}
