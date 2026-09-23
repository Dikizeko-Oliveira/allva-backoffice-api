import { EnvService } from 'src/shared/infrastructure/config/env.service';
import { TokenCipherService } from './token-cipher.service';

function buildService(): TokenCipherService {
  const env = {
    get: () => 'integration-token-encryption-key-32-bytes-min',
  } as unknown as EnvService;

  const service = new TokenCipherService(env);
  service.onModuleInit();
  return service;
}

describe('TokenCipherService', () => {
  let service: TokenCipherService;

  beforeEach(() => {
    service = buildService();
  });

  it('round-trips a token through encrypt/decrypt', () => {
    const plaintext = 'meta-access-token-abc123';
    const encrypted = service.encrypt(plaintext);

    expect(encrypted).toMatch(/^v1:/);
    expect(encrypted).not.toContain(plaintext);
    expect(service.decrypt(encrypted)).toBe(plaintext);
  });

  it('produces a different ciphertext each time (random IV)', () => {
    expect(service.encrypt('same-token')).not.toBe(
      service.encrypt('same-token'),
    );
  });

  it('rejects empty input on both directions', () => {
    expect(() => service.encrypt('')).toThrow('Cannot encrypt empty token');
    expect(() => service.decrypt('')).toThrow('Cannot decrypt empty payload');
  });

  it('passes through legacy (unprefixed) plaintext for lazy re-encryption', () => {
    expect(service.decrypt('legacy-plaintext-token')).toBe(
      'legacy-plaintext-token',
    );
  });

  it('throws on a structurally malformed payload', () => {
    expect(() => service.decrypt('v1:only-one-part')).toThrow(
      'Malformed encrypted token payload',
    );
  });

  it('fails authentication when the ciphertext is tampered with', () => {
    const encrypted = service.encrypt('tamper-me');
    const [, iv, tag] = encrypted.split(':');
    const tampered = `v1:${iv}:${tag}:${Buffer.from('different-cipher-bytes').toString('base64')}`;

    expect(() => service.decrypt(tampered)).toThrow();
  });
});
