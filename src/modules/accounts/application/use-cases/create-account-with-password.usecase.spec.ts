import { CreateAccountWithPasswordUseCase } from './create-account-with-password.usecase';

function buildHarness(
  existingAccount: unknown = null,
  plan: { type: string } | null = null,
  registrationDisabled = false,
) {
  const accountsRepository = {
    findByEmail: jest.fn().mockResolvedValue(existingAccount),
    save: jest.fn().mockResolvedValue(undefined),
  };
  const passwordHasher = { hash: jest.fn().mockResolvedValue('hashed') };
  const onboarding = { execute: jest.fn().mockResolvedValue(undefined) };
  const sendEmailVerification = {
    executeForAccount: jest.fn().mockResolvedValue(undefined),
  };
  const auditLog = { record: jest.fn().mockResolvedValue(undefined) };
  const plansRepository = { findById: jest.fn().mockResolvedValue(plan) };
  const env = {
    get: jest.fn((key: string) =>
      key === 'REGISTRATION_DISABLED' ? registrationDisabled : undefined,
    ),
  };

  const useCase = new CreateAccountWithPasswordUseCase(
    accountsRepository as any,
    passwordHasher as any,
    onboarding as any,
    sendEmailVerification as any,
    plansRepository as any,
    auditLog as any,
    env as any,
  );

  return {
    useCase,
    accountsRepository,
    plansRepository,
    onboarding,
    sendEmailVerification,
    auditLog,
    env,
  };
}

const signup = {
  name: 'Ana',
  email: 'ana@empresa.com',
  password: 'senha-forte',
} as any;

describe('CreateAccountWithPasswordUseCase (A-4 / M-7)', () => {
  it('creates an unverified account and emails the verification link', async () => {
    const h = buildHarness();

    const result = await h.useCase.execute(signup);

    expect(result.accountId).toBeDefined();
    const [saved] = h.accountsRepository.save.mock.calls[0];
    expect(saved.emailVerified).toBe(false);
    expect(h.sendEmailVerification.executeForAccount).toHaveBeenCalledTimes(1);
  });

  it('withholds the welcome email until the address is confirmed', async () => {
    const h = buildHarness();

    await h.useCase.execute(signup);

    expect(h.onboarding.execute).toHaveBeenCalledWith(expect.anything(), {
      sendWelcomeEmail: false,
    });
  });

  it('creates a Preference row for every signup', async () => {
    const h = buildHarness();

    await h.useCase.execute(signup);

    expect(h.onboarding.execute).toHaveBeenCalledTimes(1);
  });

  it('marks a federated signup verified and skips the verification email', async () => {
    const h = buildHarness();

    await h.useCase.execute(signup, { emailVerified: true });

    const [saved] = h.accountsRepository.save.mock.calls[0];
    expect(saved.emailVerified).toBe(true);
    expect(h.sendEmailVerification.executeForAccount).not.toHaveBeenCalled();
    // A confirmed address gets the welcome email right away.
    expect(h.onboarding.execute).toHaveBeenCalledWith(expect.anything(), {
      sendWelcomeEmail: true,
    });
  });

  it('rejects a duplicate email', async () => {
    const h = buildHarness({ id: 'existing' });

    await expect(h.useCase.execute(signup)).rejects.toMatchObject({
      response: { code: 'ACCOUNT_ALREADY_EXISTS' },
    });
    expect(h.accountsRepository.save).not.toHaveBeenCalled();
  });

  it('recusa o cadastro quando as inscrições estão fechadas', async () => {
    const h = buildHarness(null, null, true);

    await expect(h.useCase.execute(signup)).rejects.toMatchObject({
      code: 'REGISTRATION_DISABLED',
    });

    // A guarda vem antes do trabalho: sem conta salva, sem e-mail de
    // verificação e sem linha na trilha de auditoria.
    expect(h.accountsRepository.save).not.toHaveBeenCalled();
    expect(h.sendEmailVerification.executeForAccount).not.toHaveBeenCalled();
    expect(h.auditLog.record).not.toHaveBeenCalled();
  });
});

/**
 * **O plano negociado não entra por autoatendimento.**
 *
 * O Enterprise nasce de um acordo comercial — lead, proposta, contrato
 * assinado, ativação. Um cadastro que o escolhesse criaria conta e organização
 * fora desse caminho, e o provisionamento por contrato teria depois de
 * reconciliar duas origens para o mesmo cliente.
 *
 * O card da vitrine já leva a `/sales`, mas isso é a porta da frente:
 * `?next=<id do Enterprise>` sobrevive em link salvo, aba antiga e URL montada
 * à mão. Uma regra que só a interface aplica não é regra.
 */
describe('cadastro com plano negociado', () => {
  const INPUT = {
    name: 'Fulana',
    email: 'fulana@empresa.com.br',
    password: 'SenhaSuperSegura1',
    selectedPlanId: 'plan-enterprise',
  };

  it('recusa antes de criar a conta', async () => {
    const h = buildHarness(null, { type: 'ENTERPRISE' });

    await expect(h.useCase.execute(INPUT as never)).rejects.toMatchObject({
      response: { code: 'PLAN_REQUIRES_SALES_CONTACT', redirectTo: '/sales' },
    });

    // Antes, e não depois: uma conta criada com um erro devolvido deixaria a
    // pessoa sem conseguir cadastrar de novo com o mesmo e-mail.
    expect(h.accountsRepository.save).not.toHaveBeenCalled();
  });

  it('aceita plano self-serve', async () => {
    const h = buildHarness(null, { type: 'PRO' });

    await expect(h.useCase.execute(INPUT as never)).resolves.toBeDefined();
    expect(h.accountsRepository.save).toHaveBeenCalled();
  });

  it('não consulta o catálogo quando não há plano escolhido', async () => {
    const h = buildHarness();

    await h.useCase.execute({ ...INPUT, selectedPlanId: undefined } as never);

    expect(h.plansRepository.findById).not.toHaveBeenCalled();
    expect(h.accountsRepository.save).toHaveBeenCalled();
  });

  it('plano que saiu do catálogo recusa antes de criar a conta', async () => {
    // Seguir em frente dava o teste gratuito a quem escolheu um plano pago: o
    // provisionamento não acha o id e cai no padrão de quem não escolheu nada.
    const h = buildHarness(null, null);

    await expect(h.useCase.execute(INPUT as never)).rejects.toMatchObject({
      response: { code: 'PLAN_NOT_FOUND' },
    });
    expect(h.accountsRepository.save).not.toHaveBeenCalled();
  });
});
