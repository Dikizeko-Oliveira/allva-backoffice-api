import { AlertRule, type AlertEvent } from 'src/modules/alerts/domain/entities';
import { AlertRuleEvaluatorService } from './alert-rule-evaluator.service';

const rule = (
  overrides: Partial<Parameters<typeof AlertRule.create>[0]> = {},
) =>
  AlertRule.create({
    source: 'support.sla_breached',
    threshold: '>= 1',
    channel: 'EMAIL',
    target: 'suporte@allva.com',
    requiredPermission: 'support:read',
    ...overrides,
  });

function build(
  rules: AlertRule[],
  counts: Record<string, number> = { 'support.sla_breached': 2 },
) {
  const saved: AlertEvent[] = [];
  const events = {
    save: jest.fn(async (event: AlertEvent) => {
      saved.push(event);
    }),
    hasOpenForRule: jest.fn(async (ruleId: string) =>
      saved.some((event) => event.ruleId === ruleId && !event.isAcknowledged),
    ),
  };
  const countsReader = { countSupport: jest.fn().mockResolvedValue(counts) };

  return {
    saved,
    countsReader,
    service: new AlertRuleEvaluatorService(
      { list: jest.fn().mockResolvedValue(rules) } as never,
      events as never,
      countsReader as never,
    ),
  };
}

/** GAP-044: uma regra ativa gera um evento visível, uma vez. */
describe('AlertRuleEvaluatorService', () => {
  it('dispara uma vez e segura enquanto o evento está aberto', async () => {
    const breached = rule();
    const { service, saved } = build([breached]);

    const first = await service.evaluate();
    const second = await service.evaluate();

    expect(first.FIRE).toBe(1);
    expect(second).toMatchObject({ FIRE: 0, HOLD_OPEN_EVENT: 1 });
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({
      ruleId: breached.id,
      source: 'support.sla_breached',
      severity: 'CRITICAL',
      requiredPermission: 'support:read',
    });
  });

  it('reconhecido o evento, o sinal ainda alto dispara de novo', async () => {
    const { service, saved } = build([rule()]);

    await service.evaluate();
    saved[0].acknowledge('op-1');

    expect((await service.evaluate()).FIRE).toBe(1);
    expect(saved).toHaveLength(2);
  });

  it('regra inativa não é avaliada', async () => {
    const { service, saved } = build([rule({ active: false })]);

    await service.evaluate();

    expect(saved).toHaveLength(0);
  });

  it('só os sinais locais vão ao leitor; os do produto ficam sem avaliar', async () => {
    const { service, countsReader, saved } = build([
      rule(),
      rule({ source: 'billing.invoices_overdue' }),
    ]);

    const summary = await service.evaluate();

    expect(countsReader.countSupport).toHaveBeenCalledWith(
      ['support.sla_breached'],
      expect.any(String),
      expect.any(Date),
    );
    expect(summary).toMatchObject({ FIRE: 1, NOT_EVALUATED: 1 });
    expect(saved).toHaveLength(1);
  });

  it('sem regra local, não consulta contagem nenhuma', async () => {
    const { service, countsReader } = build([
      rule({ source: 'billing.invoices_overdue' }),
    ]);

    await service.evaluate();

    expect(countsReader.countSupport).not.toHaveBeenCalled();
  });
});
