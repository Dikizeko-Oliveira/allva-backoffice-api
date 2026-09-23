import type { CrossAdVerdict } from './cross-ad-dispersion';
import {
  CRITICAL_COMPONENT,
  MIN_CONFIDENCE_TO_SUGGEST,
  THIN_BODY_CHARS,
  countSuggestions,
  rankedSuggestions,
  suggestCopyChanges,
  type ScoreComponentReading,
  type SuggestionInput,
} from './creative-suggestions';

/**
 * O que estas asserções protegem não é a redação das sugestões — é a ordem
 * causal da feature: **o determinístico decide o que mudar; o LLM escreve as
 * palavras**. Nenhum teste aqui toca em provider de IA, e é essa ausência que
 * prova a propriedade.
 */

const strong = (value: number): ScoreComponentReading => ({
  available: true,
  normalizedValue: value,
  confidence: 0.8,
});

const fullCopy = {
  headline: 'Reduza 6 horas de trabalho manual por semana',
  body: 'Times de performance usam a Allva para achar o desperdício antes do fim do mês, com evidência por anúncio.',
  callToAction: 'LEARN_MORE',
};

function input(overrides: Partial<SuggestionInput> = {}): SuggestionInput {
  return {
    components: {
      attention: strong(70),
      audienceFit: strong(70),
      negativeFeedbackRisk: strong(70),
      fatigue: strong(70),
      learningStability: strong(70),
    },
    verdict: null,
    copy: fullCopy,
    ...overrides,
  };
}

const verdict = (value: CrossAdVerdict['value']): CrossAdVerdict => ({
  value,
  confidence: 0.7,
  alternativeExplanations: ['orçamentos díspares entre ad sets'],
});

describe('sugestões criativas — as regras de desempenho', () => {
  it('anúncio saudável e completo não produz sugestão nenhuma', () => {
    expect(countSuggestions(suggestCopyChanges(input()))).toBe(0);
  });

  it('atenção baixa vira sugestão de hook, com o número no motivo', () => {
    const set = suggestCopyChanges(
      input({ components: { attention: strong(22) } }),
    );

    expect(set.hook).toHaveLength(1);
    expect(set.hook[0].type).toBe('WEAK_HOOK');
    expect(set.hook[0].sourceComponent).toBe('attention');
    // P7: a medida que originou a sugestão viaja com ela.
    expect(set.hook[0].reason).toContain('22/100');
  });

  it('abaixo do crítico a prioridade sobe sem precisar de veredito', () => {
    const critical = suggestCopyChanges(
      input({ components: { attention: strong(CRITICAL_COMPONENT - 1) } }),
    );
    const merelyWeak = suggestCopyChanges(
      input({ components: { attention: strong(CRITICAL_COMPONENT + 5) } }),
    );

    expect(critical.hook[0].priority).toBe('HIGH');
    expect(merelyWeak.hook[0].priority).toBe('MEDIUM');
  });

  it('CREATIVE_UNDERPERFORMS eleva a prioridade do que é meramente fraco', () => {
    const set = suggestCopyChanges(
      input({
        components: { attention: strong(CRITICAL_COMPONENT + 5) },
        verdict: verdict('CREATIVE_UNDERPERFORMS'),
      }),
    );

    expect(set.hook[0].priority).toBe('HIGH');
  });

  it('componente indisponível na plataforma não gera sugestão', () => {
    const set = suggestCopyChanges(
      input({
        components: {
          attention: { available: false, normalizedValue: null, confidence: 0 },
        },
      }),
    );

    expect(set.hook).toHaveLength(0);
  });

  it('componente medido com confiança abaixo do piso não gera sugestão', () => {
    // O anúncio de três dias não deve mandar ninguém reescrever nada.
    const set = suggestCopyChanges(
      input({
        components: {
          attention: {
            available: true,
            normalizedValue: 10,
            confidence: MIN_CONFIDENCE_TO_SUGGEST - 0.01,
          },
        },
      }),
    );

    expect(set.hook).toHaveLength(0);
  });
});

describe('sugestões criativas — a recusa é o produto', () => {
  it('AUDIENCE_MISMATCH retém as sugestões de desempenho e declara o motivo', () => {
    const set = suggestCopyChanges(
      input({
        components: { attention: strong(10), audienceFit: strong(10) },
        verdict: verdict('AUDIENCE_MISMATCH'),
      }),
    );

    // A peça funciona nos outros anúncios: reescrever consertaria o que não
    // está quebrado.
    expect(set.hook.some((item) => item.type === 'WEAK_HOOK')).toBe(false);
    expect(set.body).toHaveLength(0);
    expect(set.withheld).toContain('público errado');
  });

  it('a recusa não engole os fatos sobre o criativo', () => {
    const set = suggestCopyChanges(
      input({
        components: { attention: strong(10) },
        verdict: verdict('AUDIENCE_MISMATCH'),
        copy: { headline: null, body: fullCopy.body, callToAction: null },
      }),
    );

    // Campo vazio continua vazio mesmo quando o criativo vai bem.
    expect(set.hook.map((item) => item.type)).toEqual(['MISSING_HEADLINE']);
    expect(set.cta.map((item) => item.type)).toEqual(['MISSING_CTA']);
    expect(set.withheld).not.toBeNull();
  });

  it('sem recusa, `withheld` é null — e não string vazia', () => {
    expect(suggestCopyChanges(input()).withheld).toBeNull();
  });
});

describe('sugestões criativas — as regras factuais', () => {
  it('corpo curto demais é medido, não julgado', () => {
    const body = 'a'.repeat(THIN_BODY_CHARS - 1);
    const set = suggestCopyChanges(input({ copy: { ...fullCopy, body } }));

    expect(set.body[0].type).toBe('THIN_BODY');
    expect(set.body[0].reason).toContain(`${THIN_BODY_CHARS - 1} caracteres`);
    expect(set.body[0].sourceComponent).toBeNull();
  });

  it('corpo ausente não vira THIN_BODY — ausência e insuficiência diferem', () => {
    const set = suggestCopyChanges(
      input({ copy: { ...fullCopy, body: null } }),
    );

    expect(set.body.some((item) => item.type === 'THIN_BODY')).toBe(false);
  });
});

describe('sugestões criativas — ordenação', () => {
  it('a lista ranqueada põe o crítico antes do meramente fraco', () => {
    const set = suggestCopyChanges(
      input({
        components: {
          attention: strong(CRITICAL_COMPONENT + 5),
          audienceFit: strong(5),
        },
      }),
    );

    const ranked = rankedSuggestions(set);

    expect(ranked[0].type).toBe('MESSAGE_ATTRACTS_WRONG_AUDIENCE');
    expect(ranked[0].priority).toBe('HIGH');
  });
});
