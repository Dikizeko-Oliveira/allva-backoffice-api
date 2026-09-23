import type { Platform } from 'src/modules/integrations/domain/entities/platform';
import type {
  AdActionCapability,
  AdActionCommand,
  AdActionResult,
  ExecutionContext,
  ObservedEntityState,
  ValidationResult,
} from 'src/modules/platform-actions/domain/contracts/action-contracts';

/**
 * §13.2 — **o único caminho por onde a Allva escreve em mídia paga.**
 *
 * §16.4 é verificado pelo harness: nenhum módulo fora de `platform-actions`
 * importa este port. A regra não é estética. Toda a proteção de P5 — RBAC,
 * kill switch, consentimento, revalidação, I2, teto diário, auditoria dupla —
 * mora no caminho que chama estes métodos; um segundo chamador não herdaria
 * nenhuma delas, e a escrita que ele fizesse seria indistinguível de uma
 * autorizada quando alguém fosse auditar.
 *
 * **`revert` é método próprio, não `execute` com parâmetro invertido.** Desfazer
 * um `ARCHIVE_AD` não é arquivá-lo de novo com sinal trocado: a plataforma tem
 * caminhos diferentes, alguns não têm caminho nenhum, e a reversão precisa do
 * `previousState` capturado antes — que `execute` não recebe.
 */
export abstract class AdActionGateway {
  abstract readonly platform: Platform;

  /**
   * O que esta plataforma sabe fazer, com motivo declarado para o que não sabe.
   *
   * Puro e síncrono de propósito: é consultado para montar tela e para decidir
   * se vale enfileirar, e uma chamada de rede aqui tornaria "quais ações estão
   * disponíveis?" uma pergunta cara o bastante para alguém decidir pular.
   */
  abstract capabilities(): AdActionCapability[];

  /**
   * Valida sem executar. O `depth` da resposta diz **o que ela não garante**.
   *
   * O dry-run de §13.5 é isto — e é por isso que ele responde com profundidade
   * em vez de um booleano: "válido localmente" e "válido na plataforma" levam a
   * decisões diferentes acima de dez itens.
   */
  abstract validate(cmd: AdActionCommand): Promise<ValidationResult>;

  abstract execute(
    cmd: AdActionCommand,
    ctx: ExecutionContext,
  ): Promise<AdActionResult>;

  /**
   * Desfaz uma execução a partir do estado capturado **antes** dela.
   *
   * `previousState` é `unknown` porque só o gateway que o capturou sabe lê-lo:
   * um orçamento na Meta é string em unidade menor, e tipá-lo aqui obrigaria o
   * domínio a conhecer o formato de cada plataforma.
   */
  abstract revert(
    cmd: AdActionCommand,
    previousState: unknown,
    ctx: ExecutionContext,
  ): Promise<AdActionResult>;

  /**
   * Lê o estado atual do alvo — o insumo da escada de verificação (§13.4) e da
   * captura de `previousState` que precede toda escrita reversível.
   */
  abstract observe(
    cmd: AdActionCommand,
    ctx: ExecutionContext,
  ): Promise<ObservedEntityState>;
}
