import { EnvService } from 'src/shared/infrastructure/config/env.service';
import { LoginWithFacebookUseCase } from './login-with-facebook.usecase';
import { RegisterWithGoogleUseCase } from './register-with-google.usecase';

/**
 * As duas portas federadas de cadastro, e a linha que as separa do login.
 *
 * `POST /auth/google/register` e `POST /auth/facebook` atendem os dois casos na
 * mesma chamada: quem já tem conta entra, e quem não tem ganha uma criada na
 * hora. Por isso a guarda de `REGISTRATION_DISABLED` não fica no topo do caso
 * de uso - ela fica dentro do ramo que cria. Posta no topo, ela trancaria fora
 * os testers que entram por Google todo dia, que é o oposto do que o
 * pré-lançamento quer.
 *
 * É essa distinção que este arquivo trava. Um refactor que "simplifique" a
 * guarda para o começo do método continua passando em qualquer teste que só
 * verifique a recusa.
 *
 * O plano escolhido na vitrine segue a mesma linha, e pelo mesmo motivo: é
 * conferido e gravado só no ramo que cria a conta.
 */
function buildHarness(options: {
  existingAccount: unknown;
  registrationDisabled: boolean;
  plan?: { type: string } | null;
}) {
  const identity = {
    subject: 'provider-subject',
    email: 'tester@empresa.com',
    name: 'Tester',
  };

  const accountProviderIdentitiesRepository = {
    // Sem identidade vinculada: é o caminho que consulta a conta por e-mail.
    findByProviderSubject: jest.fn().mockResolvedValue(null),
    save: jest.fn().mockResolvedValue(undefined),
  };
  const accountsRepository = {
    findByEmail: jest.fn().mockResolvedValue(options.existingAccount),
    findById: jest.fn().mockResolvedValue(options.existingAccount),
    save: jest.fn().mockResolvedValue(undefined),
  };
  const passwordHasher = { hash: jest.fn().mockResolvedValue('hashed') };
  const issueAuthSessionUseCase = {
    execute: jest.fn().mockResolvedValue({ accessToken: 'token' }),
  };
  const onboarding = { execute: jest.fn().mockResolvedValue(undefined) };
  const plansRepository = {
    findById: jest.fn().mockResolvedValue(options.plan ?? null),
  };
  const env = {
    get: (key: string) =>
      key === 'REGISTRATION_DISABLED'
        ? options.registrationDisabled
        : undefined,
  } as unknown as EnvService;

  const google = new RegisterWithGoogleUseCase(
    { verifyIdToken: jest.fn().mockResolvedValue(identity) } as never,
    accountProviderIdentitiesRepository as never,
    accountsRepository as never,
    passwordHasher as never,
    issueAuthSessionUseCase as never,
    onboarding as never,
    env,
    plansRepository as never,
  );

  const facebook = new LoginWithFacebookUseCase(
    { verifyAccessToken: jest.fn().mockResolvedValue(identity) } as never,
    accountProviderIdentitiesRepository as never,
    accountsRepository as never,
    passwordHasher as never,
    issueAuthSessionUseCase as never,
    onboarding as never,
    env,
    plansRepository as never,
  );

  return { google, facebook, accountsRepository, onboarding, plansRepository };
}

type Harness = ReturnType<typeof buildHarness>;
type Extra = { selectedPlanId?: string };

const EXISTING_ACCOUNT = { id: 'account-1', email: 'tester@empresa.com' };
const PLAN_ID = '0cffc5b4-4648-4280-b15a-f912d16b36a9';

const PROVIDERS: [string, (h: Harness, extra?: Extra) => Promise<unknown>][] = [
  [
    'Google',
    (h, extra = {}) => h.google.execute({ idToken: 'token', ...extra } as never),
  ],
  [
    'Facebook',
    (h, extra = {}) =>
      h.facebook.execute({ accessToken: 'token', ...extra } as never),
  ],
];

describe('cadastro federado com REGISTRATION_DISABLED', () => {
  describe.each(PROVIDERS)('%s', (_provider, run) => {
    it('recusa quando a conta ainda não existe', async () => {
      const h = buildHarness({
        existingAccount: null,
        registrationDisabled: true,
      });

      await expect(run(h)).rejects.toMatchObject({
        code: 'REGISTRATION_DISABLED',
      });

      expect(h.accountsRepository.save).not.toHaveBeenCalled();
      expect(h.onboarding.execute).not.toHaveBeenCalled();
    });

    it('deixa entrar quem já tem conta', async () => {
      const h = buildHarness({
        existingAccount: EXISTING_ACCOUNT,
        registrationDisabled: true,
      });

      await expect(run(h)).resolves.toBeDefined();
      expect(h.accountsRepository.save).not.toHaveBeenCalled();
    });

    it('cria a conta normalmente com o cadastro aberto', async () => {
      const h = buildHarness({
        existingAccount: null,
        registrationDisabled: false,
      });

      await expect(run(h)).resolves.toBeDefined();
      expect(h.accountsRepository.save).toHaveBeenCalledTimes(1);
    });
  });
});

/**
 * Quem clicava em Profissional e entrava pelo Google nascia no teste gratuito:
 * o plano não chegava ao backend, e o provisionamento cai no teste quando a
 * conta não traz nenhum.
 */
describe('cadastro federado com plano escolhido', () => {
  describe.each(PROVIDERS)('%s', (_provider, run) => {
    it('grava na conta criada o plano escolhido', async () => {
      const h = buildHarness({
        existingAccount: null,
        registrationDisabled: false,
        plan: { type: 'PRO' },
      });

      await run(h, { selectedPlanId: PLAN_ID });

      const saved = h.accountsRepository.save.mock.calls[0][0];
      expect(saved.selectedPlanId).toBe(PLAN_ID);
      // O onboarding recebe a mesma conta: é ele que lê o plano.
      expect(h.onboarding.execute.mock.calls[0][0]).toBe(saved);
    });

    it('recusa plano fora do catálogo antes de criar a conta', async () => {
      const h = buildHarness({
        existingAccount: null,
        registrationDisabled: false,
        plan: null,
      });

      await expect(run(h, { selectedPlanId: PLAN_ID })).rejects.toMatchObject({
        response: { code: 'PLAN_NOT_FOUND' },
      });
      expect(h.accountsRepository.save).not.toHaveBeenCalled();
      expect(h.onboarding.execute).not.toHaveBeenCalled();
    });

    it('recusa plano negociado', async () => {
      const h = buildHarness({
        existingAccount: null,
        registrationDisabled: false,
        plan: { type: 'ENTERPRISE' },
      });

      await expect(run(h, { selectedPlanId: PLAN_ID })).rejects.toMatchObject({
        response: { code: 'PLAN_REQUIRES_SALES_CONTACT' },
      });
      expect(h.accountsRepository.save).not.toHaveBeenCalled();
    });

    it('quem já tem conta entra sem o plano ser conferido', async () => {
      // Um id velho numa aba antiga não pode trancar fora quem já é cliente.
      const h = buildHarness({
        existingAccount: EXISTING_ACCOUNT,
        registrationDisabled: false,
        plan: null,
      });

      await expect(run(h, { selectedPlanId: PLAN_ID })).resolves.toBeDefined();
      expect(h.plansRepository.findById).not.toHaveBeenCalled();
    });
  });
});
