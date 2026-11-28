export type Row = Record<string, unknown>;

export interface Queryable {
  /** Single parameterized statement. Never interpolate values into `sql`. */
  query<T extends Row = Row>(sql: string, params?: unknown[]): Promise<T[]>;
  /** Multiple statements without parameters (migrations only). */
  exec(sql: string): Promise<void>;
}

export interface RequestContext {
  userId: string;
  tenantId?: string;
}

/**
 * Database access. Also used as the Nest injection token.
 *
 * Business queries must go through `withContext`, which switches to the
 * least-privileged `nexora_app` role so row level security applies.
 */
export abstract class Database {
  /** Transaction as the connecting (owner) role. Only for migrations and test setup. */
  abstract ownerTransaction<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  abstract close(): Promise<void>;

  withContext<T>(ctx: RequestContext, fn: (q: Queryable) => Promise<T>): Promise<T> {
    return this.ownerTransaction(async (q) => {
      await q.query('SET LOCAL ROLE nexora_app');
      await q.query(
        "SELECT set_config('app.user_id', $1, true), set_config('app.tenant_id', $2, true)",
        [ctx.userId, ctx.tenantId ?? ''],
      );
      return fn(q);
    });
  }
}
