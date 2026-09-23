export abstract class JwtServiceInterface {
  abstract sign(payload: Record<string, unknown>): Promise<string>;
  abstract verify(token: string): Promise<Record<string, unknown>>;
}
