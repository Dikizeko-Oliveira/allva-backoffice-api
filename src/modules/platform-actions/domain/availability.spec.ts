import type { AdActionCapability } from './contracts/action-contracts';
import { resolveAvailability } from './availability';

const supported: AdActionCapability = {
  type: 'PAUSE_AD',
  supported: true,
  reversible: true,
  requiresRecreate: false,
  createsEntity: false,
  validationDepth: 'LOCAL_ONLY',
};

function ask(overrides: Partial<Parameters<typeof resolveAvailability>[0]>) {
  return resolveAvailability({
    capability: supported,
    level: 'AD',
    observedStatus: 'ACTIVE',
    syncState: 'IN_SYNC',
    irreversibleStatuses: ['DELETED'],
    format: null,
    unitKind: 'AD',
    unitLabel: 'anúncio',
    ...overrides,
  });
}

describe('recorte por formato', () => {
  const cta: AdActionCapability = {
    ...supported,
    type: 'REPLACE_CTA',
    formats: {
      formats: ['RESPONSIVE_DISPLAY_AD'],
      label: 'anúncios responsivos de display',
    },
  };

  it('oferece a ação no formato declarado', () => {
    expect(
      ask({ capability: cta, format: 'RESPONSIVE_DISPLAY_AD' }).available,
    ).toBe(true);
  });

  it('recusa com o motivo quando o anúncio é de outro formato', () => {
    const result = ask({ capability: cta, format: 'RESPONSIVE_SEARCH_AD' });

    expect(result).toEqual({
      available: false,
      reason: 'UNSUPPORTED_BY_PLATFORM',
      detail:
        'Vale para anúncios responsivos de display; este anúncio é RESPONSIVE_SEARCH_AD.',
    });
  });

  it('recusa quando o formato ainda não foi lido', () => {
    const result = ask({ capability: cta, format: null });

    expect(result.available).toBe(false);
    expect(result.detail).toContain('ainda não foi lido');
  });

  it('ação sem recorte vale para qualquer formato, inclusive desconhecido', () => {
    expect(ask({ format: null }).available).toBe(true);
  });
});

describe('§13.3 — disponibilidade declarada, nunca omitida', () => {
  it('oferece a ação quando o alvo está saudável e no estado oposto', () => {
    const result = ask({});

    expect(result.available).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it('devolve o motivo da plataforma quando ela não faz a ação', () => {
    const result = ask({
      capability: {
        ...supported,
        supported: false,
        unsupportedReason: 'Entra na segunda metade do sprint.',
      },
    });

    expect(result.available).toBe(false);
    expect(result.reason).toBe('UNSUPPORTED_BY_PLATFORM');
    expect(result.detail).toBe('Entra na segunda metade do sprint.');
  });

  /**
   * Sem esta regra, "pausar" aparece num anúncio já pausado, o usuário clica, a
   * plataforma aceita sem efeito e o produto registra uma ação bem-sucedida que
   * não mudou nada — poluindo o dataset de P8 com um caso de impacto zero que
   * parece fracasso da recomendação.
   */
  it('recusa a ação cujo efeito já é o estado atual', () => {
    const result = ask({ observedStatus: 'PAUSED' });

    expect(result.available).toBe(false);
    expect(result.reason).toBe('ALREADY_IN_TARGET_STATE');
  });

  it('recusa qualquer coisa sobre estado terminal', () => {
    const result = ask({
      observedStatus: 'DELETED',
      capability: { ...supported, type: 'ENABLE_AD' },
    });

    expect(result.available).toBe(false);
    expect(result.reason).toBe('TERMINAL_STATE');
  });

  /**
   * A ordem entre I2 e coerência de estado não é arbitrária: com escrita em
   * voo, o estado observado é exatamente o que está prestes a mudar. Responder
   * `ALREADY_IN_TARGET_STATE` ali seria julgar um mundo com data de validade —
   * e esconder do usuário a informação que ele precisa, que é *"espere"*.
   */
  it('reporta a escrita em voo antes de julgar o estado', () => {
    const result = ask({
      observedStatus: 'PAUSED',
      inFlightExecutionId: 'exec-7',
    });

    expect(result.reason).toBe('WRITE_IN_FLIGHT');
    expect(result.detail).toContain('exec-7');
  });

  it.each(['STALE', 'UNREACHABLE'] as const)(
    'recusa escrever quando a leitura não vale (%s)',
    (syncState) => {
      const result = ask({ syncState });

      expect(result.available).toBe(false);
      expect(result.reason).toBe('SYNC_UNRELIABLE');
    },
  );

  /**
   * `PENDING_WRITE` e `DRIFTED` não bloqueiam por si: o primeiro é coberto por
   * I2 com o id da execução em voo — informação melhor que um estado genérico —
   * e o segundo significa que a plataforma divergiu do que sabíamos, que é
   * justamente quando reconciliar por uma ação faz sentido.
   */
  it('deixa passar PENDING_WRITE e DRIFTED, que têm tratamento próprio', () => {
    expect(ask({ syncState: 'PENDING_WRITE' }).available).toBe(true);
    expect(ask({ syncState: 'DRIFTED' }).available).toBe(true);
  });

  it('acompanha toda ação de campanha com aviso de escopo (§13.1)', () => {
    const result = ask({
      level: 'CAMPAIGN',
      capability: { ...supported, type: 'PAUSE_CAMPAIGN' },
    });

    expect(result.available).toBe(true);
    expect(result.scopeWarning).toContain('campanha inteira');
  });

  it('não avisa de escopo em ação de anúncio', () => {
    expect(ask({}).scopeWarning).toBeUndefined();
  });

  /**
   * A irreversibilidade vem da capability, não do estado resultante:
   * `ARCHIVE_AD` produz `ARCHIVED`, que **não** está na lista de irreversíveis
   * da Meta — mas §13.1 declara a ação sem volta, e é a ação que o usuário
   * confirma.
   */
  it('marca como irreversível o que a capability declara sem volta', () => {
    const result = ask({
      capability: { ...supported, type: 'ARCHIVE_AD', reversible: false },
    });

    expect(result.available).toBe(true);
    expect(result.irreversible).toBe(true);
  });

  it('não marca irreversível o que tem volta', () => {
    expect(ask({}).irreversible).toBeUndefined();
  });
});

describe('recorte por unidade (D23/D24)', () => {
  const onAssetGroup = {
    unitKind: 'ASSET_GROUP',
    unitLabel: 'grupo de recursos',
  } as const;

  it('ação de anúncio sem declaração não é oferecida no grupo de recursos', () => {
    const result = ask(onAssetGroup);

    expect(result.available).toBe(false);
    expect(result.reason).toBe('UNSUPPORTED_BY_PLATFORM');
    expect(result.detail).toBe(
      'Esta ação ainda não está disponível para grupo de recursos.',
    );
  });

  it('a ação que declara o grupo de recursos é oferecida nele', () => {
    const result = ask({
      capability: { ...supported, units: ['AD', 'ASSET_GROUP'] },
      ...onAssetGroup,
    });

    expect(result.available).toBe(true);
  });

  it('declarar o grupo não tira a ação do anúncio', () => {
    expect(
      ask({ capability: { ...supported, units: ['AD', 'ASSET_GROUP'] } })
        .available,
    ).toBe(true);
  });

  it('ação de campanha também precisa declarar a unidade', () => {
    // A campanha de um anúncio Smart+ tem rota própria no TikTok: a ação padrão
    // de campanha escreveria no lugar errado. Quem declara é o gateway.
    const undeclared = ask({
      capability: { ...supported, type: 'PAUSE_CAMPAIGN' },
      level: 'CAMPAIGN',
      unitKind: 'ASSET_GROUP',
      unitLabel: 'anúncio Smart+',
    });
    const declared = ask({
      capability: {
        ...supported,
        type: 'PAUSE_CAMPAIGN',
        units: ['AD', 'ASSET_GROUP'],
      },
      level: 'CAMPAIGN',
      ...onAssetGroup,
    });

    expect(undeclared).toMatchObject({
      available: false,
      detail: 'Esta ação ainda não está disponível para anúncio Smart+.',
    });
    expect(declared.available).toBe(true);
  });

  it('a recusa por unidade vem antes da recusa por formato', () => {
    const result = ask({
      capability: {
        ...supported,
        type: 'REPLACE_COPY',
        formats: {
          formats: ['RESPONSIVE_SEARCH_AD'],
          label: 'anúncios de busca',
        },
      },
      ...onAssetGroup,
      format: 'PERFORMANCE_MAX',
    });

    expect(result.detail).toMatch(/grupo de recursos/);
  });
});
