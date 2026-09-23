import { Injectable, Logger } from '@nestjs/common';
import { DomainEventBus } from 'src/shared/domain/events/domain-event-bus';
import { JobContext } from 'src/shared/domain/events/job-context';
import { WasteItemsRepositoryInterface } from 'src/modules/waste/domain/ports/waste-items.repository';
import { WasteReadRepositoryInterface } from 'src/modules/waste/domain/ports/waste-read.repository';
import { WasteTargetsRepositoryInterface } from 'src/modules/waste/domain/ports/waste-targets.repository';

export type ReconciliationOutcome = {
  adAccountId: string;
  adsChecked: number;
  corrected: number;
};

/**
 * `denormalization-reconcile` (C3, §5.4 r.2, §10.8).
 *
 * > **As denormalizações são cache, e cache diverge.**
 *
 * O job compara diariamente `ads.open_waste_amount_base` com a agregação real da
 * view `open_waste`, **corrige** a coluna — a agregação é a verdade — e emite o
 * drift. Sem ele a divergência é invisível por construção: a tela lê exatamente
 * a coluna que está errada, então nada no produto denuncia o erro.
 *
 * Divergência recorrente é **bug do worker**, não ruído. É por isso que o
 * desfecho vira alerta e não só log: um número de capa que precisa ser corrigido
 * todo dia está errado todo dia entre uma correção e a seguinte.
 */
@Injectable()
export class WasteReconciliationService {
  private readonly logger = new Logger(WasteReconciliationService.name);

  constructor(
    private readonly targets: WasteTargetsRepositoryInterface,
    private readonly read: WasteReadRepositoryInterface,
    private readonly items: WasteItemsRepositoryInterface,
    private readonly events: DomainEventBus,
  ) {}

  async execute(input: {
    adAccountId: string;
    ctx: JobContext;
    now?: Date;
  }): Promise<ReconciliationOutcome> {
    const now = input.now ?? new Date();
    const settings = await this.targets.settingsForAccount(input.adAccountId);

    if (!settings) {
      throw new Error(`AdAccount ${input.adAccountId} não encontrada`);
    }

    const drifts = await this.read.findDenormalizationDrift({
      adAccountId: input.adAccountId,
    });

    const outcome: ReconciliationOutcome = {
      adAccountId: input.adAccountId,
      adsChecked: drifts.length,
      corrected: 0,
    };

    if (drifts.length === 0) return outcome;

    // A correção usa **o mesmo caminho de escrita** da detecção. Uma segunda
    // rota de atualização das mesmas colunas é como as duas divergem: bastaria
    // uma delas esquecer `wasteAsOf` para a tela passar a apresentar número
    // corrigido com carimbo de tempo antigo.
    await this.items.denormalizeIntoAds(
      drifts.map((drift) => ({
        adId: drift.adId,
        openWasteCount: drift.actual.openWasteCount,
        openWasteAmount: drift.actual.openWasteAmount,
        openWasteAmountBase: drift.actual.openWasteAmountBase,
        openWasteCurrency: drift.actual.openWasteCurrency,
        avoidableDailyAmountBase: drift.actual.avoidableDailyAmountBase,
        wasteAsOf: now,
      })),
    );

    outcome.corrected = drifts.length;

    const emit = { ...input.ctx, organizationId: settings.organizationId };

    for (const drift of drifts) {
      this.events.emitFrom(emit, 'denormalization.drift_detected', {
        adId: drift.adId,
        adAccountId: input.adAccountId,
        field: 'open_waste_amount_base',
        stored: drift.stored.openWasteAmountBase,
        actual: drift.actual.openWasteAmountBase,
      });
    }

    this.logger.warn(
      `waste.denormalization_drift adAccountId=${input.adAccountId} ` +
        `corrigidos=${outcome.corrected}`,
    );

    return outcome;
  }
}
