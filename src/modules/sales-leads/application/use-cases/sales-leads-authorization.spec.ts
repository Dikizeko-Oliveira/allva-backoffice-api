import { ForbiddenException } from '@nestjs/common';
import { PlatformRoleService } from 'src/modules/accounts/application/services/platform-role.service';
import type { CreateAdminSalesLeadInputDto } from '../dtos';
import { CreateAdminSalesLeadUseCase } from './create-admin-sales-lead.usecase';
import { GetSalesLeadUseCase } from './get-sales-lead.usecase';
import { ListSalesLeadsUseCase } from './list-sales-leads.usecase';
import { UpdateSalesLeadStatusUseCase } from './update-sales-lead-status.usecase';

/**
 * O pipeline comercial só responde a quem opera a plataforma.
 *
 * As três rotas exigiam apenas sessão válida. Qualquer conta autenticada
 * listava a base de leads inteira — nome, e-mail corporativo, telefone, empresa,
 * estágio da negociação — e movia qualquer lead para `CLOSED_WON`, que
 * **provisiona uma organização Enterprise**. Autoatendimento de plano negociado,
 * de graça, e dado pessoal de terceiros ao alcance de qualquer cliente.
 *
 * O teste ataca pelo caso do cliente comum (`ADMIN` é o papel padrão de quem se
 * cadastra), que é exatamente quem conseguia passar.
 */

function platformRole(role: string) {
  return new PlatformRoleService({
    findById: jest.fn().mockResolvedValue({ id: 'ator-1', role }),
  } as never);
}

const LEAD = {
  id: 'lead-1',
  status: 'NEW',
  changeStatus: jest.fn(),
  toJSON: () => ({ id: 'lead-1' }),
};

function repository() {
  return {
    findById: jest.fn().mockResolvedValue(LEAD),
    list: jest
      .fn()
      .mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 }),
    update: jest.fn().mockResolvedValue(undefined),
  };
}

describe('pipeline comercial exige papel de plataforma', () => {
  describe.each([
    ['MEMBER'],
    ['ADMIN'], // o papel padrão de toda conta que se cadastra
    // Papéis de plataforma **sem** `leads:*`. Com a guarda binária, todos
    // estes entravam no funil — foi o que tornou o comercial um papel próprio.
    ['ALLVA_OPERATOR'],
    ['ALLVA_SUPPORT'],
    ['ALLVA_FINANCE'],
  ])('conta com papel %s', (role) => {
    it('não lista os leads', async () => {
      const useCase = new ListSalesLeadsUseCase(
        repository() as never,
        platformRole(role),
      );

      await expect(useCase.execute({} as never, 'ator-1')).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('não lê um lead', async () => {
      const useCase = new GetSalesLeadUseCase(
        repository() as never,
        platformRole(role),
      );

      await expect(useCase.execute('lead-1', 'ator-1')).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('não move um lead no funil', async () => {
      const repo = repository();
      const useCase = new UpdateSalesLeadStatusUseCase(
        repo as never,
        platformRole(role),
      );

      await expect(
        useCase.execute('lead-1', { status: 'CLOSED_WON' } as never, 'ator-1'),
      ).rejects.toThrow(ForbiddenException);

      // A recusa vem antes da escrita: mover o lead e devolver erro seriam o
      // pior dos dois mundos.
      expect(repo.update).not.toHaveBeenCalled();
    });
  });

  describe.each([['ALLVA_SALES'], ['ALLVA_ADMIN']])(
    'conta com papel %s',
    (role) => {
      it('lista os leads', async () => {
        const useCase = new ListSalesLeadsUseCase(
          repository() as never,
          platformRole(role),
        );

        await expect(
          useCase.execute({} as never, 'ator-1'),
        ).resolves.toBeDefined();
      });
    },
  );
});

/**
 * O lead cadastrado pelo operador.
 *
 * Todo contrato Enterprise parte de um lead, mas nem todo negócio entra pelo
 * site. Sem esta porta, indicação e evento ficariam fora do sistema — ou
 * obrigariam alguém a preencher o formulário público fingindo ser o cliente.
 */
describe('lead cadastrado pelo operador', () => {
  const LEAD_INPUT: CreateAdminSalesLeadInputDto = {
    companyName: 'Empresa da Indicação',
    // Pessoal de propósito: é o caso que a rota pública recusaria.
    workEmail: 'contato@pessoal.com',
    fullName: 'Contato Colhido em Evento',
    desiredPlan: 'ENTERPRISE',
  } as CreateAdminSalesLeadInputDto;

  function buildUseCase(role: string) {
    const repo = { save: jest.fn().mockResolvedValue(undefined) };
    const useCase = new CreateAdminSalesLeadUseCase(
      repo as never,
      platformRole(role),
    );
    return { useCase, repo };
  }

  it('recusa quem não opera a plataforma', async () => {
    const { useCase, repo } = buildUseCase('ADMIN');

    await expect(useCase.execute(LEAD_INPUT, 'ator-1')).rejects.toThrow(
      ForbiddenException,
    );
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('não grava o operador como conta do prospect', async () => {
    const { useCase, repo } = buildUseCase('ALLVA_SALES');

    await useCase.execute(LEAD_INPUT, 'operador-1');

    const saved = repo.save.mock.calls[0][0] as {
      accountId: string | null;
      assignedTo: string | null;
    };

    /**
     * `accountId` é a conta do **prospect**, e o provisionamento a lê primeiro
     * em `resolveOwnerAccount`. Gravar o operador ali o tornaria dono da
     * organização Enterprise do cliente.
     */
    expect(saved.accountId).toBeNull();
    expect(saved.assignedTo).toBe('operador-1');
  });

  it('marca a origem quando o operador não informa canal', async () => {
    const { useCase, repo } = buildUseCase('ALLVA_SALES');

    await useCase.execute(LEAD_INPUT, 'operador-1');

    const saved = repo.save.mock.calls[0][0] as { source: string | null };
    expect(saved.source).toBe('backoffice');
  });

  it('respeita o canal informado, quando há um', async () => {
    const { useCase, repo } = buildUseCase('ALLVA_SALES');

    await useCase.execute({ ...LEAD_INPUT, source: 'indicacao' }, 'operador-1');

    const saved = repo.save.mock.calls[0][0] as { source: string | null };
    expect(saved.source).toBe('indicacao');
  });
});
