export type VerifiedGoogleIdentity = {
  subject: string;
  email: string;
  emailVerified: boolean;
  name: string;
};

export abstract class GoogleIdentityVerifierInterface {
  abstract verifyIdToken(idToken: string): Promise<VerifiedGoogleIdentity>;
}
