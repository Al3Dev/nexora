import { Inject, Injectable } from '@nestjs/common';
import { jwtVerify } from 'jose';
import { z } from 'zod';
import type { Config } from '../config.js';
import { CONFIG } from '../tokens.js';

const uuid = z.uuid();

/**
 * Verifies HS256 access tokens issued by the identity provider (Supabase Auth
 * can sign with the project JWT secret). Returns the user id (`sub`) or null.
 */
@Injectable()
export class TokenVerifier {
  private readonly key: Uint8Array;

  constructor(@Inject(CONFIG) private readonly config: Config) {
    this.key = new TextEncoder().encode(config.AUTH_JWT_SECRET);
  }

  async verify(token: string): Promise<string | null> {
    try {
      const { payload } = await jwtVerify(token, this.key, {
        algorithms: ['HS256'],
        issuer: this.config.AUTH_JWT_ISSUER,
        audience: this.config.AUTH_JWT_AUDIENCE,
        requiredClaims: ['sub', 'exp'],
      });
      const sub = uuid.safeParse(payload.sub);
      return sub.success ? sub.data : null;
    } catch {
      return null;
    }
  }
}
