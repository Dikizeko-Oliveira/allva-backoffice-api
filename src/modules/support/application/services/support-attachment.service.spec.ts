import { BadRequestException } from '@nestjs/common';
import {
  MAX_SUPPORT_ATTACHMENT_BYTES,
  SupportAttachmentService,
} from './support-attachment.service';

function buildFile(
  overrides: Partial<Express.Multer.File> = {},
): Express.Multer.File {
  return {
    buffer: Buffer.from('fake-bytes'),
    originalname: 'print.png',
    mimetype: 'image/png',
    size: 1024,
    ...overrides,
  } as Express.Multer.File;
}

function buildHarness() {
  const upload = jest.fn().mockResolvedValue({
    url: 'https://storage.googleapis.com/bucket/print-abc123.png',
    key: 'support-tickets/org-1/print-abc123.png',
  });
  const storage = { provider: 'gcs', upload } as never;

  const service = new SupportAttachmentService(storage);

  return { service, upload };
}

describe('SupportAttachmentService', () => {
  describe('validate', () => {
    it('não faz nada sem arquivo — o anexo é opcional', () => {
      const { service } = buildHarness();
      expect(() => service.validate(undefined)).not.toThrow();
    });

    it.each(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])(
      'aceita %s',
      (mimetype) => {
        const { service } = buildHarness();
        expect(() => service.validate(buildFile({ mimetype }))).not.toThrow();
      },
    );

    it('recusa um mimetype que não é imagem', () => {
      const { service } = buildHarness();

      expect(() =>
        service.validate(buildFile({ mimetype: 'application/pdf' })),
      ).toThrow(BadRequestException);

      try {
        service.validate(buildFile({ mimetype: 'application/pdf' }));
      } catch (error) {
        expect((error as BadRequestException).getResponse()).toMatchObject({
          code: 'INVALID_ATTACHMENT_TYPE',
        });
      }
    });

    it('recusa um arquivo acima do teto', () => {
      const { service } = buildHarness();

      expect(() =>
        service.validate(buildFile({ size: MAX_SUPPORT_ATTACHMENT_BYTES + 1 })),
      ).toThrow(BadRequestException);
    });

    it('aceita um arquivo exatamente no teto', () => {
      const { service } = buildHarness();

      expect(() =>
        service.validate(buildFile({ size: MAX_SUPPORT_ATTACHMENT_BYTES })),
      ).not.toThrow();
    });
  });

  describe('upload', () => {
    it('namespacia a pasta pela organização — do contrário todo print cairia junto no bucket', async () => {
      const { service, upload } = buildHarness();
      const file = buildFile();

      await service.upload(file, 'org-1');

      expect(upload).toHaveBeenCalledWith(
        file.buffer,
        file.originalname,
        file.mimetype,
        'support-tickets/org-1',
      );
    });

    it('devolve o provedor gravado no momento do upload, não um literal', async () => {
      const { service } = buildHarness();

      const attachment = await service.upload(buildFile(), 'org-1');

      expect(attachment).toEqual({
        url: 'https://storage.googleapis.com/bucket/print-abc123.png',
        key: 'support-tickets/org-1/print-abc123.png',
        storageProvider: 'gcs',
        filename: 'print.png',
      });
    });
  });
});
