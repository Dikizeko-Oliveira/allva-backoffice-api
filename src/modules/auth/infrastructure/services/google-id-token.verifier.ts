import {
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import {
  GoogleIdentityVerifierInterface,
  VerifiedGoogleIdentity,
} from 'src/modules/auth/domain/ports';
import { EnvService } from 'src/shared/infrastructure/config/env.service';
import { loadJose } from 'src/shared/infrastructure/esm/jose-loader';

const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];
type JoseModule = typeof import('jose');
type GoogleJwks = ReturnType<JoseModule['createRemoteJWKSet']>;

@Injectable()
export class GoogleIdTokenVerifier implements GoogleIdentityVerifierInterface {
  private googleJwks?: GoogleJwks;

  constructor(private readonly envService: EnvService) {}

  private async getJose() {
    const jose = await loadJose();

    this.googleJwks ??= jose.createRemoteJWKSet(
      new URL('https://www.googleapis.com/oauth2/v3/certs'),
    );

    return { ...jose, googleJwks: this.googleJwks };
  }

  async verifyIdToken(idToken: string): Promise<VerifiedGoogleIdentity> {
    const clientId = this.envService.get('GOOGLE_CLIENT_ID');

    if (!clientId) {
      throw new ServiceUnavailableException({
        code: 'GOOGLE_SSO_NOT_CONFIGURED',
        message: 'Google SSO is not configured',
      });
    }

    try {
      const { jwtVerify, googleJwks } = await this.getJose();
      const { payload } = await jwtVerify(idToken, googleJwks, {
        audience: clientId,
        issuer: GOOGLE_ISSUERS,
      });

      const subject = payload.sub;
      const email =
        typeof payload.email === 'string' ? payload.email : undefined;
      const emailVerified =
        payload.email_verified === true || payload.email_verified === 'true';
      const name =
        typeof payload.name === 'string' && payload.name.trim().length > 0
          ? payload.name
          : email;

      if (!subject) {
        throw new UnauthorizedException({
          code: 'INVALID_GOOGLE_TOKEN',
          message: 'Google token subject is missing',
        });
      }

      if (!email) {
        throw new UnauthorizedException({
          code: 'GOOGLE_EMAIL_NOT_AVAILABLE',
          message: 'Google account did not provide an email',
        });
      }

      if (!emailVerified) {
        throw new UnauthorizedException({
          code: 'GOOGLE_EMAIL_NOT_VERIFIED',
          message: 'Google account email is not verified',
        });
      }

      return {
        subject,
        email: email.trim().toLowerCase(),
        emailVerified,
        name: name ?? email,
      };
    } catch (error) {
      if (error instanceof UnauthorizedException) {
        throw error;
      }

      const { errors } = await this.getJose();

      if (error instanceof errors.JWTExpired) {
        throw new UnauthorizedException({
          code: 'GOOGLE_TOKEN_EXPIRED',
          message: 'Google token is expired',
        });
      }

      if (error instanceof errors.JWTClaimValidationFailed) {
        if (error.claim === 'aud') {
          throw new UnauthorizedException({
            code: 'GOOGLE_TOKEN_AUDIENCE_INVALID',
            message: 'Google token audience is invalid',
          });
        }

        if (error.claim === 'iss') {
          throw new UnauthorizedException({
            code: 'GOOGLE_TOKEN_ISSUER_INVALID',
            message: 'Google token issuer is invalid',
          });
        }
      }

      if (error instanceof errors.JOSEError) {
        throw new UnauthorizedException({
          code: 'INVALID_GOOGLE_TOKEN',
          message: 'Google token is invalid',
        });
      }

      throw new ServiceUnavailableException({
        code: 'GOOGLE_VERIFICATION_UNAVAILABLE',
        message: 'Google token verification is unavailable',
      });
    }
  }
}
