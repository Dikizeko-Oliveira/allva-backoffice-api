export type VerifiedFacebookIdentity = {
  subject: string;
  email: string | null;
  name: string;
};

export abstract class FacebookIdentityVerifierInterface {
  abstract verifyAccessToken(
    accessToken: string,
  ): Promise<VerifiedFacebookIdentity>;
}
