import { ExecutionContext, HttpException, HttpStatus } from '@nestjs/common';
import { Injectable } from '@nestjs/common';
import { ThrottlerGuard, ThrottlerLimitDetail } from '@nestjs/throttler';
import { Request, Response } from 'express';
import { resolveClientIp } from '../client-ip';

type RequestWithUser = Request & { user?: { id?: string } | null };

/**
 * Throttler that counts against the caller's identity rather than their address.
 *
 * The stock guard tracks `req.ip`. Every request reaches this API through the Next
 * BFF, so that value is the proxy for all customers alike: one heavy account
 * exhausted a route's budget for everybody, and no per-account limit existed at
 * all. Keying on the account id makes each customer's allowance their own, and
 * leaves IP keying where it is the only identity available — the public routes.
 */
@Injectable()
export class ApiThrottlerGuard extends ThrottlerGuard {
  // Promise-returning rather than `async`: the base class declares it async, but
  // nothing here awaits, and the identity has to be available synchronously.
  protected getTracker(req: Record<string, unknown>): Promise<string> {
    const request = req as unknown as RequestWithUser;
    const accountId = request.user?.id;

    // Prefixed so a user id and an IP can never collide in the same bucket.
    if (accountId) return Promise.resolve(`user:${accountId}`);

    const ip = resolveClientIp(request);

    // An unresolvable address shares one bucket on purpose: it should be the
    // stricter outcome, never a way to opt out of the limit entirely.
    return Promise.resolve(`ip:${ip ?? 'unknown'}`);
  }

  /**
   * The stock exception carries a bare string, which the global filter renders
   * without a `code` — the one field clients switch on. Every other error in this
   * API answers `{ code, message }` in UPPER_SNAKE_CASE, so this one does too.
   *
   * Also emits a plain `Retry-After`. The library suffixes its headers with the
   * throttler name unless it is literally `default`, so a policy-based setup would
   * only ever answer `Retry-After-public` — a header no client, proxy or HTTP
   * library knows to read.
   */
  protected throwThrottlingException(
    context: ExecutionContext,
    detail: ThrottlerLimitDetail,
  ): Promise<void> {
    const { res } = this.getRequestResponse(context);

    (res as Response).header(
      'Retry-After',
      String(Math.max(1, detail.timeToBlockExpire)),
    );

    throw new HttpException(
      {
        code: 'RATE_LIMIT_EXCEEDED',
        message: 'Too many requests. Please wait before trying again.',
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}
