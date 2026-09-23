import type { Request } from 'express';
import type { Operator } from 'src/modules/auth/domain/entities';

/** A requisição depois que `OperatorAuthGuard` identificou quem opera. */
export type OperatorRequest = Request & { operator?: Operator };
