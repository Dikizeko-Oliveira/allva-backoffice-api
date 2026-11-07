import { AlertEvaluationScheduler } from './alert-evaluation.scheduler';

function build(enabled: boolean, evaluate: jest.Mock) {
  const env = { get: jest.fn().mockReturnValue(enabled) };
  return new AlertEvaluationScheduler({ evaluate } as never, env as never);
}

describe('AlertEvaluationScheduler', () => {
  afterEach(() => jest.useRealTimers());

  it('desligado, não agenda nada', () => {
    jest.useFakeTimers();
    const evaluate = jest.fn();
    const scheduler = build(false, evaluate);

    scheduler.onApplicationBootstrap();
    jest.advanceTimersByTime(60 * 60 * 1000);

    expect(evaluate).not.toHaveBeenCalled();
  });

  it('uma volta em curso impede a próxima de começar', async () => {
    let release!: () => void;
    const evaluate = jest.fn(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ FIRE: 0 });
        }),
    );
    const scheduler = build(true, evaluate);

    const first = scheduler.tick();
    await scheduler.tick();
    release();
    await first;

    expect(evaluate).toHaveBeenCalledTimes(1);
  });

  it('a falha de uma volta não derruba o processo nem trava a seguinte', async () => {
    const evaluate = jest
      .fn()
      .mockRejectedValueOnce(new Error('banco fora'))
      .mockResolvedValueOnce({ FIRE: 0 });
    const scheduler = build(true, evaluate);

    await expect(scheduler.tick()).resolves.toBeUndefined();
    await scheduler.tick();

    expect(evaluate).toHaveBeenCalledTimes(2);
  });

  it('para o timer no desligamento', () => {
    jest.useFakeTimers();
    const evaluate = jest.fn().mockResolvedValue({ FIRE: 0 });
    const scheduler = build(true, evaluate);

    scheduler.onApplicationBootstrap();
    scheduler.onApplicationShutdown();
    jest.advanceTimersByTime(60 * 60 * 1000);

    expect(evaluate).not.toHaveBeenCalled();
  });
});
