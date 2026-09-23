import { AdAccountLinkerService } from './ad-account-linker.service';
import { AdAccount } from 'src/modules/integrations/domain/entities';

/**
 * Regressão do 500 ao reconectar (FI-3).
 *
 * A busca de duplicata usava `(integrationId, externalAccountId)` e a constraint
 * do banco é `(organizationId, platform, externalAccountId)`. Desconectar zera o
 * `integrationId`, então a linha órfã não era encontrada, o `create` batia na
 * unique e o P2002 subia como "Internal server error" — no fluxo mais comum de
 * suporte que existe.
 */
function buildHarness(existing: AdAccount | null = null) {
  const stored: AdAccount[] = existing ? [existing] : [];

  const adAccounts = {
    findByOrganizationPlatformAndExternalId: jest
      .fn()
      .mockImplementation((organizationId, platform, externalAccountId) =>
        Promise.resolve(
          stored.find(
            (a) =>
              a.organizationId === organizationId &&
              a.platform === platform &&
              a.externalAccountId === externalAccountId,
          ) ?? null,
        ),
      ),
    save: jest.fn().mockImplementation((account: AdAccount) => {
      stored.push(account);
      return Promise.resolve();
    }),
    update: jest.fn().mockResolvedValue(undefined),
  };

  const auditLog = { record: jest.fn().mockResolvedValue(undefined) };

  return {
    service: new AdAccountLinkerService(adAccounts as never, auditLog as never),
    adAccounts,
    auditLog,
    stored,
  };
}

const target = {
  integrationId: 'int-nova',
  organizationId: 'org-1',
  accountId: 'acc-1',
  platform: 'META' as const,
  externalAccountId: 'act_984957920541170',
  name: 'allva test',
  currency: 'BRL',
  timezone: 'America/Sao_Paulo',
};

describe('vincular conta de anúncios', () => {
  it('cria a conta quando a organização ainda não a conhece', async () => {
    const h = buildHarness();

    const result = await h.service.link(target);

    expect(result.relinked).toBe(false);
    expect(h.adAccounts.save).toHaveBeenCalledTimes(1);
    expect(h.auditLog.record).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'ad_account.linked' }),
    );
  });

  it('revincula a conta órfã que sobrou de uma desconexão, sem estourar', async () => {
    // Estado que a desconexão deixa: a linha continua, sem credencial.
    const orphan = AdAccount.create({
      integrationId: 'int-antiga',
      organizationId: 'org-1',
      accountId: 'acc-1',
      platform: 'META',
      externalAccountId: 'act_984957920541170',
      name: 'allva test',
      currency: 'BRL',
      timezone: 'America/Sao_Paulo',
    });
    orphan.detachIntegration();

    const h = buildHarness(orphan);

    const result = await h.service.link(target);

    expect(result.relinked).toBe(true);
    expect(result.id).toBe(orphan.id);
    // O ponto da regressão: nenhum INSERT, logo nenhum P2002, logo nenhum 500.
    expect(h.adAccounts.save).not.toHaveBeenCalled();
    expect(h.adAccounts.update).toHaveBeenCalledTimes(1);
  });

  it('registra auditoria também no religamento', async () => {
    const existing = AdAccount.create({
      ...target,
      integrationId: 'int-velha',
    });
    const h = buildHarness(existing);

    await h.service.link(target);

    expect(h.auditLog.record).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'ad_account.linked',
        metadata: expect.objectContaining({ relinked: true }),
      }),
    );
  });

  it('quem perde a corrida de dois cliques relê em vez de devolver erro', async () => {
    const h = buildHarness();

    const winner = AdAccount.create({ ...target, integrationId: 'int-nova' });

    // Primeira leitura não vê nada; o INSERT perde para o clique concorrente;
    // a releitura encontra o vencedor.
    h.adAccounts.findByOrganizationPlatformAndExternalId
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(winner);
    h.adAccounts.save.mockRejectedValueOnce({ code: 'P2002' });

    const result = await h.service.link(target);

    expect(result.id).toBe(winner.id);
    expect(result.relinked).toBe(true);
  });

  it('erro que não é violação de unicidade continua subindo', async () => {
    const h = buildHarness();
    h.adAccounts.save.mockRejectedValueOnce(new Error('conexão caiu'));

    await expect(h.service.link(target)).rejects.toThrow('conexão caiu');
  });
});
