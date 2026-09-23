import { HttpStatus } from '@nestjs/common';
import { Queue } from 'bull';
import { Response } from 'express';
import { PrismaService } from 'src/shared/infrastructure/database/prisma/prisma.service';
import {
  FfmpegBinaryLocator,
  FfmpegProbe,
} from 'src/shared/infrastructure/media/ffmpeg-binary.locator';
import { HealthController } from './health.controller';

type Options = {
  databaseUp?: boolean;
  redisUp?: boolean;
  ffmpeg?: FfmpegProbe;
};

function build({
  databaseUp = true,
  redisUp = true,
  ffmpeg = { status: 'ok', path: '/usr/bin/ffmpeg' },
}: Options = {}) {
  const prisma = {
    $queryRaw: jest.fn(() =>
      databaseUp
        ? Promise.resolve([{ 1: 1 }])
        : Promise.reject(new Error('db down')),
    ),
  } as unknown as PrismaService;

  const queue = {
    client: redisUp
      ? Promise.resolve({ ping: jest.fn().mockResolvedValue('PONG') })
      : Promise.reject(new Error('redis down')),
  } as unknown as Queue;

  const locator = {
    probe: jest.fn<Promise<FfmpegProbe>, []>().mockResolvedValue(ffmpeg),
  } as unknown as FfmpegBinaryLocator;

  const controller = new HealthController(queue, prisma, locator);

  // Silence the expected error logs from the down-dependency cases.
  jest
    .spyOn((controller as any).logger, 'error')
    .mockImplementation(() => undefined);

  const status = jest.fn();
  const res = { status } as unknown as Response;

  return { controller, res, status };
}

describe('HealthController', () => {
  it('returns 200 and status ok when database and redis are up', async () => {
    const { controller, res, status } = build();

    const body = await controller.check(res);

    expect(status).toHaveBeenCalledWith(HttpStatus.OK);
    expect(body).toEqual({
      status: 'ok',
      services: { database: 'ok', redis: 'ok' },
      optional: { videoPreview: 'ok' },
    });
  });

  it.each([
    [
      'database',
      { databaseUp: false },
      { database: 'unavailable', redis: 'ok' },
    ],
    ['redis', { redisUp: false }, { database: 'ok', redis: 'unavailable' }],
  ])(
    'returns 503 and degraded when %s is down',
    async (_name, options, expectedServices) => {
      const { controller, res, status } = build(options);

      const body = await controller.check(res);

      expect(status).toHaveBeenCalledWith(HttpStatus.SERVICE_UNAVAILABLE);
      expect(body).toMatchObject({
        status: 'degraded',
        services: expectedServices,
      });
    },
  );

  // PLAN.md Sprint 5.5 / P-3: the whole point of surfacing ffmpeg on /health is
  // that it becomes visible WITHOUT pulling the instance out of the load
  // balancer. If this ever flips to 503, preview outages become site outages.
  it('surfaces an unavailable ffmpeg without degrading the instance', async () => {
    const { controller, res, status } = build({
      ffmpeg: {
        status: 'unavailable',
        path: '/opt/ffmpeg',
        reason: 'not executable',
      },
    });

    const body = await controller.check(res);

    expect(status).toHaveBeenCalledWith(HttpStatus.OK);
    expect(body).toEqual({
      status: 'ok',
      services: { database: 'ok', redis: 'ok' },
      optional: { videoPreview: 'unavailable' },
    });
  });

  it('reports the preview pipeline as disabled when the flag is off', async () => {
    const { controller, res, status } = build({
      ffmpeg: { status: 'disabled', path: null },
    });

    const body = await controller.check(res);

    expect(status).toHaveBeenCalledWith(HttpStatus.OK);
    expect(body).toMatchObject({ optional: { videoPreview: 'disabled' } });
  });

  it('does not leak the ffmpeg failure reason on the public endpoint', async () => {
    const { controller, res } = build({
      ffmpeg: {
        status: 'unavailable',
        path: '/srv/app/node_modules/ffmpeg-static/ffmpeg',
        reason: 'ENOENT at /srv/app/node_modules/ffmpeg-static/ffmpeg',
      },
    });

    const body = await controller.check(res);

    expect(JSON.stringify(body)).not.toContain('/srv/app');
  });
});
