import { ForbiddenException } from '@nestjs/common';
import { PlatformRoleService } from 'src/modules/accounts/application/services/platform-role.service';
import { GetContactUseCase } from './get-contact.usecase';
import { ListContactsUseCase } from './list-contacts.usecase';
import { UpdateContactStatusUseCase } from './update-contact-status.usecase';

function platformRole(role: string) {
  return new PlatformRoleService({
    findById: jest.fn().mockResolvedValue({ id: 'ator-1', role }),
  } as never);
}

function repository() {
  return {
    list: jest
      .fn()
      .mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 }),
    findById: jest.fn().mockResolvedValue({
      id: 'c-1',
      status: 'NEW',
      changeStatus: jest.fn(),
    }),
    update: jest.fn().mockResolvedValue(undefined),
  };
}

/**
 * B11 do mapa de endpoints do backoffice.
 *
 * As três rotas eram "autenticadas", e autenticado queria dizer qualquer
 * cliente logado: a caixa de fale-conosco inteira da Allva ficava legível —
 * e editável — por quem tivesse uma conta no produto.
 */
describe('a caixa de fale-conosco é do operador', () => {
  describe.each([
    ['USER'], // o cliente logado que lia a caixa inteira
    ['ALLVA_FINANCE'],
    ['ALLVA_SALES'],
    ['ALLVA_OPERATOR'],
  ])('conta com papel %s', (role) => {
    it('não lista', async () => {
      const useCase = new ListContactsUseCase(
        repository() as never,
        platformRole(role),
      );

      await expect(useCase.execute({} as never, 'ator-1')).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('não lê um contato', async () => {
      const repo = repository();
      const useCase = new GetContactUseCase(repo as never, platformRole(role));

      await expect(useCase.execute('c-1', 'ator-1')).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('não muda status — e recusa antes de procurar o contato', async () => {
      const repo = repository();
      const useCase = new UpdateContactStatusUseCase(
        repo as never,
        platformRole(role),
      );

      await expect(
        useCase.execute('c-1', { status: 'REPLIED' } as never, 'ator-1'),
      ).rejects.toThrow(ForbiddenException);

      // Um 404 para quem não pode diria se o id existe.
      expect(repo.findById).not.toHaveBeenCalled();
      expect(repo.update).not.toHaveBeenCalled();
    });
  });

  describe.each([['ALLVA_SUPPORT'], ['ALLVA_ADMIN']])(
    'conta com papel %s',
    (role) => {
      it('lista e atualiza', async () => {
        const repo = repository();

        await expect(
          new ListContactsUseCase(repo as never, platformRole(role)).execute(
            {} as never,
            'ator-1',
          ),
        ).resolves.toBeDefined();

        await new UpdateContactStatusUseCase(
          repo as never,
          platformRole(role),
        ).execute('c-1', { status: 'REPLIED' } as never, 'ator-1');

        expect(repo.update).toHaveBeenCalledTimes(1);
      });
    },
  );
});
