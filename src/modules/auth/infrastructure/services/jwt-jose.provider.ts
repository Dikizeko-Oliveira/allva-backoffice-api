import { Injectable } from '@nestjs/common';
import { JwtServiceInterface } from 'src/modules/auth/domain/ports';
import { EnvService } from 'src/shared/infrastructure/config/env.service';
import { loadJose } from 'src/shared/infrastructure/esm/jose-loader';

@Injectable()
export class JwtJoseProvider implements JwtServiceInterface {
  private readonly secret: Uint8Array;
  private readonly expiresIn: string;

  constructor(private readonly env: EnvService) {
    // Both values come from the validated schema rather than raw `process.env`
    // (PLAN.md D-4). `JWT_EXPIRES_IN` in particular now carries a default, and a
    // default only exists on the parsed object — reading `process.env` directly
    // would still have produced `undefined`, and `String(undefined)` would reach
    // jose as the literal "undefined" and throw at sign time.
    const secret = this.env.get('JWT_SECRET_KEY');

    if (!secret) {
      throw new Error('JWT_SECRET_KEY is not defined');
    }

    this.secret = new TextEncoder().encode(secret);
    this.expiresIn = this.env.get('JWT_EXPIRES_IN');
  }

  async sign(payload: Record<string, unknown>): Promise<string> {
    const { SignJWT } = await loadJose();

    return new SignJWT(payload)
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime(this.expiresIn)
      .sign(this.secret);
  }

  async verify(token: string): Promise<Record<string, unknown>> {
    const { jwtVerify } = await loadJose();

    const { payload } = await jwtVerify(token, this.secret);
    return payload;
  }
}
