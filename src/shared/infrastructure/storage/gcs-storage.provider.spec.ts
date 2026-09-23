import { ServiceUnavailableException } from '@nestjs/common';
import { EnvService } from 'src/shared/infrastructure/config/env.service';
import { GcsStorageProvider } from './gcs-storage.provider';

const mockSave = jest.fn().mockResolvedValue(undefined);
const mockGetSignedUrl = jest
  .fn()
  .mockResolvedValue(['https://storage.googleapis.com/assinada']);
const mockDelete = jest.fn().mockResolvedValue(undefined);
const mockFile = jest.fn(() => ({
  save: mockSave,
  getSignedUrl: mockGetSignedUrl,
  delete: mockDelete,
}));
const mockBucket = jest.fn(() => ({ file: mockFile }));
const mockStorage = jest.fn((_options?: unknown) => ({ bucket: mockBucket }));

jest.mock('@google-cloud/storage', () => ({
  Storage: jest.fn((options?: unknown) => mockStorage(options)),
}));

function build(values: Record<string, unknown> = {}): GcsStorageProvider {
  const env = {
    get: (key: string) => values[key],
  } as unknown as EnvService;

  const provider = new GcsStorageProvider(env);
  jest
    .spyOn((provider as any).logger, 'log')
    .mockImplementation(() => undefined);
  jest
    .spyOn((provider as any).logger, 'error')
    .mockImplementation(() => undefined);

  return provider;
}

const CONFIGURED = {
  GCS_BUCKET: 'allva-media',
  GCS_PROJECT_ID: 'allva-prod',
};

describe('GcsStorageProvider', () => {
  beforeEach(() => jest.clearAllMocks());

  it('sobe o buffer com o content type e sem sessão retomável', async () => {
    const provider = build(CONFIGURED);
    const buffer = Buffer.from('imagem');

    const { url, key } = await provider.upload(
      buffer,
      'arte.png',
      'image/png',
      'creatives',
    );

    expect(mockBucket).toHaveBeenCalledWith('allva-media');
    expect(mockFile).toHaveBeenCalledWith(key);
    expect(mockSave).toHaveBeenCalledWith(buffer, {
      contentType: 'image/png',
      resumable: false,
    });
    expect(url).toBe(`https://storage.googleapis.com/allva-media/${key}`);
  });

  it('assina a URL de escrita em V4, com validade e content type', async () => {
    const provider = build(CONFIGURED);

    const { uploadUrl, fileUrl, key } = await provider.getPresignedUrl(
      'arte.png',
      'image/png',
    );

    const [config] = mockGetSignedUrl.mock.calls[0];
    expect(config).toMatchObject({
      version: 'v4',
      action: 'write',
      contentType: 'image/png',
    });
    expect(config.expires).toBeGreaterThan(Date.now());
    expect(uploadUrl).toBe('https://storage.googleapis.com/assinada');
    expect(fileUrl).toBe(`https://storage.googleapis.com/allva-media/${key}`);
  });

  /**
   * O CDN costuma servir só GET. Devolver a URL do domínio próprio como destino
   * do PUT faria todo upload direto do browser falhar — e falhar longe daqui.
   */
  it('mantém a escrita no host que assinou mesmo com domínio próprio', async () => {
    const provider = build({
      ...CONFIGURED,
      GCS_PUBLIC_BASE_URL: 'https://cdn.allva.app',
    });

    const { uploadUrl, fileUrl, key } = await provider.getPresignedUrl(
      'arte.png',
      'image/png',
    );

    expect(uploadUrl).toBe('https://storage.googleapis.com/assinada');
    expect(fileUrl).toBe(`https://cdn.allva.app/${key}`);
  });

  it('apaga pela URL e tolera o objeto já ausente', async () => {
    const provider = build(CONFIGURED);

    await provider.deleteByUrl(
      'https://storage.googleapis.com/allva-media/creatives/arte-ab12.png',
    );

    expect(mockFile).toHaveBeenCalledWith('creatives/arte-ab12.png');
    expect(mockDelete).toHaveBeenCalledWith({ ignoreNotFound: true });
  });

  describe('credenciais', () => {
    it('deixa o SDK cair em Application Default Credentials quando não há chave', async () => {
      await build(CONFIGURED).upload(Buffer.from('x'), 'a.png', 'image/png');

      expect(mockStorage).toHaveBeenCalledWith({ projectId: 'allva-prod' });
    });

    it('desfaz o \\n literal da chave PEM antes de assinar', async () => {
      await build({
        ...CONFIGURED,
        GCS_CLIENT_EMAIL: 'svc@allva-prod.iam.gserviceaccount.com',
        GCS_PRIVATE_KEY:
          '-----BEGIN PRIVATE KEY-----\\nMIIE\\n-----END-----\\n',
      }).upload(Buffer.from('x'), 'a.png', 'image/png');

      expect(mockStorage).toHaveBeenCalledWith({
        projectId: 'allva-prod',
        credentials: {
          client_email: 'svc@allva-prod.iam.gserviceaccount.com',
          private_key: '-----BEGIN PRIVATE KEY-----\nMIIE\n-----END-----\n',
        },
      });
    });

    it('prefere o arquivo da service account ao par solto', async () => {
      await build({
        ...CONFIGURED,
        GCS_KEY_FILENAME: '/secrets/gcs.json',
        GCS_CLIENT_EMAIL: 'svc@allva-prod.iam.gserviceaccount.com',
        GCS_PRIVATE_KEY: 'chave',
      }).upload(Buffer.from('x'), 'a.png', 'image/png');

      expect(mockStorage).toHaveBeenCalledWith({
        projectId: 'allva-prod',
        keyFilename: '/secrets/gcs.json',
      });
    });

    /**
     * A razão de o cliente ser preguiçoso: o provider é instanciado no boot de
     * toda instalação, inclusive as que nunca vão subir arquivo.
     */
    it('só constrói o cliente na primeira chamada', async () => {
      const provider = build(CONFIGURED);

      expect(mockStorage).not.toHaveBeenCalled();

      await provider.upload(Buffer.from('x'), 'a.png', 'image/png');
      await provider.upload(Buffer.from('y'), 'b.png', 'image/png');

      expect(mockStorage).toHaveBeenCalledTimes(1);
    });
  });

  describe('sem bucket', () => {
    it('recusa dizendo o que falta, em vez de errar na rede', async () => {
      const provider = build({ GCS_PROJECT_ID: 'allva-prod' });

      await expect(
        provider.upload(Buffer.from('x'), 'a.png', 'image/png'),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
      await expect(
        provider.getPresignedUrl('a.png', 'image/png'),
      ).rejects.toMatchObject({
        response: { code: 'STORAGE_NOT_CONFIGURED' },
      });
      expect(mockStorage).not.toHaveBeenCalled();
    });

    /** Camada opcional (P-6): configuração incompleta não derruba o processo. */
    it('constrói sem reclamar — a falha é na chamada, não no boot', () => {
      expect(() => build({})).not.toThrow();
    });
  });
});
