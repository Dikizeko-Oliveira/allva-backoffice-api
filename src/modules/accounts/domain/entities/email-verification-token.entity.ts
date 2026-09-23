import { createHash, randomInt, randomUUID, timingSafeEqual } from 'crypto';

/**
 * Quinze minutos, e não vinte e quatro horas.
 *
 * A janela antiga foi dimensionada para um link de 256 bits, que ninguém
 * adivinha por mais tempo que se deixe aberto. Seis dígitos são 10^6
 * possibilidades: o que protege o código é a **combinação** de janela curta,
 * teto de tentativas e throttle por IP — encurtar a janela é a metade barata
 * dessa conta, e é a que o usuário nem percebe, porque ele está com a caixa de
 * entrada aberta na outra aba.
 */
const CODE_TTL_MINUTES = 15;

/**
 * Cinco erros queimam o código.
 *
 * Sem isto o throttle por IP (10/min) ainda deixaria uma botnet varrer 10^6 em
 * tempo hábil. Com isto, cada código emitido só admite cinco palpites — e um
 * sexto obriga a pedir outro, que reinicia o sorteio.
 */
const MAX_ATTEMPTS = 5;

type CreateEmailVerificationTokenProps = {
  accountId: string;
  tokenHash: string;
  expiresAt?: Date;
};

type RestoreEmailVerificationTokenProps = {
  id: string;
  accountId: string;
  tokenHash: string;
  expiresAt: Date;
  usedAt: Date | null;
  attempts: number;
  createdAt: Date;
};

/**
 * Código de confirmação de email — seis dígitos, uso único.
 *
 * Substituiu o link de confirmação porque o link quebrava o cadastro: o usuário
 * saía do fluxo para o cliente de email e voltava (quando voltava) numa aba
 * nova, sem o plano que tinha escolhido e sem sessão. Com o código, a mesma aba
 * que criou a conta confirma o email e segue para o pagamento.
 *
 * Só o hash é persistido — o valor cru existe apenas no email. O hash é
 * **escopado pela conta** (`sha256("<accountId>:<code>")`), e não pelo código
 * puro, por duas razões:
 *
 * 1. Seis dígitos colidem. Com o código puro, duas contas sorteando `048213`
 *    gravariam o mesmo hash, e o índice único que o link 256-bit podia manter
 *    viraria um 500 no cadastro de quem chegasse depois.
 * 2. Escopar impede que o código de uma conta valide outra: a busca é sempre
 *    "o código pendente **desta** conta", nunca "quem tem este hash".
 */
export class EmailVerificationToken {
  private _id: string;
  private _accountId: string;
  private _tokenHash: string;
  private _expiresAt: Date;
  private _usedAt: Date | null;
  private _attempts: number;
  private _createdAt: Date;

  private constructor(props: RestoreEmailVerificationTokenProps) {
    this._id = props.id;
    this._accountId = props.accountId;
    this._tokenHash = props.tokenHash;
    this._expiresAt = props.expiresAt;
    this._usedAt = props.usedAt;
    this._attempts = props.attempts;
    this._createdAt = props.createdAt;
  }

  static create(
    props: CreateEmailVerificationTokenProps,
  ): EmailVerificationToken {
    return new EmailVerificationToken({
      id: randomUUID(),
      accountId: props.accountId,
      tokenHash: props.tokenHash,
      expiresAt:
        props.expiresAt ?? new Date(Date.now() + CODE_TTL_MINUTES * 60 * 1000),
      usedAt: null,
      attempts: 0,
      createdAt: new Date(),
    });
  }

  static restore(
    props: RestoreEmailVerificationTokenProps,
  ): EmailVerificationToken {
    return new EmailVerificationToken(props);
  }

  /** Quanto tempo o email pode prometer. Fonte única do texto e da expiração. */
  static get ttlMinutes(): number {
    return CODE_TTL_MINUTES;
  }

  static get maxAttempts(): number {
    return MAX_ATTEMPTS;
  }

  /**
   * Sorteia o código que vai no email, junto do hash que vai para o banco.
   *
   * `randomInt` e não `Math.random()`: é o mesmo CSPRNG do `randomBytes`, e um
   * gerador previsível aqui dispensaria o atacante de adivinhar coisa alguma.
   * O `padStart` preserva os zeros à esquerda — sem ele, um em cada dez códigos
   * teria cinco dígitos e o espaço de busca encolheria de graça.
   */
  static generateCode(accountId: string): { code: string; codeHash: string } {
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    return { code, codeHash: EmailVerificationToken.hashCode(accountId, code) };
  }

  static hashCode(accountId: string, code: string): string {
    return createHash('sha256').update(`${accountId}:${code}`).digest('hex');
  }

  /** O código informado é o desta linha? Comparação em tempo constante. */
  matches(accountId: string, code: string): boolean {
    const expected = Buffer.from(
      EmailVerificationToken.hashCode(accountId, code),
      'hex',
    );
    const stored = Buffer.from(this._tokenHash, 'hex');

    // `timingSafeEqual` exige comprimentos iguais — um hash corrompido no banco
    // faria a comparação lançar em vez de recusar.
    if (expected.length !== stored.length) return false;

    return timingSafeEqual(expected, stored);
  }

  markAsUsed() {
    this._usedAt = new Date();
  }

  registerFailedAttempt() {
    this._attempts += 1;
  }

  isExpired(reference: Date = new Date()): boolean {
    return reference > this._expiresAt;
  }

  isUsed(): boolean {
    return this._usedAt !== null;
  }

  hasAttemptsLeft(): boolean {
    return this._attempts < MAX_ATTEMPTS;
  }

  /** Usável exatamente uma vez, dentro da janela e do teto de tentativas. */
  isPending(reference: Date = new Date()): boolean {
    return (
      !this.isUsed() && !this.isExpired(reference) && this.hasAttemptsLeft()
    );
  }

  get id() {
    return this._id;
  }

  get accountId() {
    return this._accountId;
  }

  get tokenHash() {
    return this._tokenHash;
  }

  get expiresAt() {
    return this._expiresAt;
  }

  get usedAt() {
    return this._usedAt;
  }

  get attempts() {
    return this._attempts;
  }

  get createdAt() {
    return this._createdAt;
  }
}
