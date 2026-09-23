import { Account } from 'src/modules/accounts/domain/entities';
import { AlertsController } from './alerts.controller';

const USER = { id: 'acc-1' } as Account;

function buildHarness() {
  const listAlerts = {
    execute: jest.fn().mockResolvedValue({ data: [], total: 0 }),
  };
  const getAlert = {
    execute: jest.fn().mockResolvedValue({ id: 'alert-1' }),
  };
  const markOneRead = {
    execute: jest.fn().mockResolvedValue({ id: 'alert-1' }),
  };
  const markAllRead = { execute: jest.fn().mockResolvedValue({ marked: 3 }) };
  const dismissAlert = {
    execute: jest.fn().mockResolvedValue({ id: 'alert-1' }),
  };
  const resolveAlert = {
    execute: jest.fn().mockResolvedValue({ id: 'alert-1' }),
  };

  const controller = new AlertsController(
    listAlerts as never,
    getAlert as never,
    markOneRead as never,
    markAllRead as never,
    dismissAlert as never,
    resolveAlert as never,
  );

  return {
    controller,
    listAlerts,
    getAlert,
    markOneRead,
    markAllRead,
    dismissAlert,
    resolveAlert,
  };
}

/** The query object the controller handed to ListAlertsUseCase. */
function lastQuery(listAlerts: { execute: jest.Mock }) {
  return listAlerts.execute.mock.calls.at(-1)?.[1];
}

describe('AlertsController', () => {
  describe('GET /alerts', () => {
    it('defaults to open alerts, page 1', async () => {
      const h = buildHarness();

      await h.controller.getAlerts(USER);

      expect(lastQuery(h.listAlerts)).toMatchObject({
        state: 'OPEN',
        page: 1,
        limit: 20,
      });
    });

    it.each(['OPEN', 'DISMISSED', 'RESOLVED', 'ALL'])(
      'passes the %s state through',
      async (state) => {
        const h = buildHarness();

        await h.controller.getAlerts(USER, undefined, undefined, state);

        expect(lastQuery(h.listAlerts).state).toBe(state);
      },
    );

    // A display filter should not 400 on a typo; falling back to OPEN keeps the
    // panel usable and matches the documented default.
    it.each(['nonsense', '', 'open'])(
      'falls back to OPEN for the invalid state %p',
      async (state) => {
        const h = buildHarness();

        await h.controller.getAlerts(USER, undefined, undefined, state);

        expect(lastQuery(h.listAlerts).state).toBe('OPEN');
      },
    );

    it.each([
      ['true', true],
      ['false', false],
    ])('parses isRead=%s as %p', async (raw, expected) => {
      const h = buildHarness();

      await h.controller.getAlerts(USER, raw);

      expect(lastQuery(h.listAlerts).isRead).toBe(expected);
    });

    it('leaves isRead undefined when not supplied', async () => {
      const h = buildHarness();

      await h.controller.getAlerts(USER);

      expect(lastQuery(h.listAlerts).isRead).toBeUndefined();
    });

    it('parses pagination', async () => {
      const h = buildHarness();

      await h.controller.getAlerts(
        USER,
        undefined,
        undefined,
        undefined,
        '3',
        '50',
      );

      expect(lastQuery(h.listAlerts)).toMatchObject({ page: 3, limit: 50 });
    });
  });

  describe('GET /alerts/:id', () => {
    it('fetches a single alert by id', async () => {
      const h = buildHarness();

      await h.controller.getAlert(USER, 'alert-1');

      expect(h.getAlert.execute).toHaveBeenCalledWith('acc-1', 'alert-1');
    });
  });

  describe('lifecycle endpoints', () => {
    it('marks one alert read', async () => {
      const h = buildHarness();

      await h.controller.readOne(USER, 'alert-1');

      expect(h.markOneRead.execute).toHaveBeenCalledWith('acc-1', 'alert-1');
    });

    it('marks every alert read', async () => {
      const h = buildHarness();

      await expect(h.controller.readAll(USER)).resolves.toEqual({ marked: 3 });
    });

    it('dismisses an alert', async () => {
      const h = buildHarness();

      await h.controller.dismiss(USER, 'alert-1');

      expect(h.dismissAlert.execute).toHaveBeenCalledWith('acc-1', 'alert-1');
    });

    it('resolves an alert', async () => {
      const h = buildHarness();

      await h.controller.resolve(USER, 'alert-1');

      expect(h.resolveAlert.execute).toHaveBeenCalledWith('acc-1', 'alert-1');
    });

    // Dismiss and resolve mean different things (M-2): hiding it versus declaring
    // the condition over. Routing one to the other would silently change behaviour,
    // because only resolve reopens the dedupe window.
    it('keeps dismiss and resolve on separate use cases', async () => {
      const h = buildHarness();

      await h.controller.dismiss(USER, 'alert-1');

      expect(h.resolveAlert.execute).not.toHaveBeenCalled();
    });
  });
});
