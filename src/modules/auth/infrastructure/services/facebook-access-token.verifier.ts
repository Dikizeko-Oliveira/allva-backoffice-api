import {
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import {
  FacebookIdentityVerifierInterface,
  VerifiedFacebookIdentity,
} from 'src/modules/auth/domain/ports';
import { EnvService } from 'src/shared/infrastructure/config/env.service';

type DebugTokenResponse = {
  data: {
    app_id: string;
    is_valid: boolean;
    user_id?: string;
    error?: { message: string };
  };
};

type MeResponse = {
  id: string;
  name?: string;
  email?: string;
  error?: { message: string };
};

@Injectable()
export class FacebookAccessTokenVerifier implements FacebookIdentityVerifierInterface {
  constructor(private readonly envService: EnvService) {}

  async verifyAccessToken(
    accessToken: string,
  ): Promise<VerifiedFacebookIdentity> {
    const appId = this.envService.get('META_APP_ID');
    const appSecret = this.envService.get('META_APP_SECRET');

    if (!appId || !appSecret) {
      throw new ServiceUnavailableException({
        code: 'FACEBOOK_SSO_NOT_CONFIGURED',
        message: 'Facebook SSO is not configured',
      });
    }

    const appToken = `${appId}|${appSecret}`;

    let debugData: DebugTokenResponse['data'];

    try {
      const debugUrl = new URL('https://graph.facebook.com/debug_token');
      debugUrl.searchParams.set('input_token', accessToken);
      debugUrl.searchParams.set('access_token', appToken);

      const debugRes = await fetch(debugUrl.toString());
      const debugBody = (await debugRes.json()) as DebugTokenResponse;
      debugData = debugBody.data;
    } catch {
      throw new ServiceUnavailableException({
        code: 'FACEBOOK_VERIFICATION_UNAVAILABLE',
        message: 'Facebook token verification is unavailable',
      });
    }

    if (!debugData.is_valid) {
      throw new UnauthorizedException({
        code: 'INVALID_FACEBOOK_TOKEN',
        message: 'Facebook access token is invalid or expired',
      });
    }

    if (debugData.app_id !== appId) {
      throw new UnauthorizedException({
        code: 'FACEBOOK_TOKEN_APP_MISMATCH',
        message: 'Facebook token was not issued for this app',
      });
    }

    let me: MeResponse;

    try {
      const meUrl = new URL('https://graph.facebook.com/me');
      meUrl.searchParams.set('fields', 'id,name,email');
      meUrl.searchParams.set('access_token', accessToken);

      const meRes = await fetch(meUrl.toString());
      me = (await meRes.json()) as MeResponse;
    } catch {
      throw new ServiceUnavailableException({
        code: 'FACEBOOK_VERIFICATION_UNAVAILABLE',
        message: 'Facebook token verification is unavailable',
      });
    }

    if (me.error || !me.id) {
      throw new UnauthorizedException({
        code: 'INVALID_FACEBOOK_TOKEN',
        message: 'Failed to retrieve Facebook user data',
      });
    }

    return {
      subject: me.id,
      email: me.email?.trim().toLowerCase() ?? null,
      name: me.name ?? `facebook_${me.id}`,
    };
  }
}
