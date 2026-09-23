import { access, constants } from 'node:fs/promises';
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import ffmpegStaticPath from 'ffmpeg-static';
import { EnvService } from 'src/shared/infrastructure/config/env.service';

export type FfmpegStatus =
  /** Preview pipeline turned off by `VIDEO_PREVIEW_ENABLED=false`. */
  | 'disabled'
  /** Enabled and a runnable binary was found. */
  | 'ok'
  /** Enabled but no runnable binary — every preview job will fail. */
  | 'unavailable';

export type FfmpegProbe = {
  status: FfmpegStatus;
  /** Resolved path, or `null` when nothing could be resolved at all. */
  path: string | null;
  /** Present only when `status === 'unavailable'`. Safe to surface. */
  reason?: string;
};

/**
 * Single source of truth for "where is ffmpeg and can we run it" (PLAN.md
 * Sprint 5.5 / P-3).
 *
 * The binary ships via the `ffmpeg-static` install script, so a build with
 * `--ignore-scripts` or a pruned `node_modules` silently removes it. Before this
 * existed the absence only surfaced when a queue job failed, which is the one
 * place nobody is watching. Now it is visible at boot and on `/health`.
 */
@Injectable()
export class FfmpegBinaryLocator implements OnApplicationBootstrap {
  private readonly logger = new Logger(FfmpegBinaryLocator.name);

  constructor(private readonly env: EnvService) {}

  /**
   * Config-only resolution — no filesystem access, so the hot path (one call per
   * extraction) stays cheap. `FFMPEG_PATH` wins over the bundled build, which is
   * the documented escape hatch when the static build cannot run on the host.
   */
  resolvePath(): string | null {
    const configured = this.env.get('FFMPEG_PATH')?.trim();

    return configured || ffmpegStaticPath || null;
  }

  /** Whether the preview pipeline is supposed to be running at all. */
  isPreviewEnabled(): boolean {
    return this.env.get('VIDEO_PREVIEW_ENABLED') !== false;
  }

  /**
   * Resolves the binary and confirms it is executable. Never throws — callers
   * are a health endpoint and a boot log, neither of which should fail over a
   * missing accessory dependency.
   */
  async probe(): Promise<FfmpegProbe> {
    if (!this.isPreviewEnabled()) {
      return { status: 'disabled', path: this.resolvePath() };
    }

    const path = this.resolvePath();

    if (!path) {
      return {
        status: 'unavailable',
        path: null,
        reason:
          'no ffmpeg binary resolved (ffmpeg-static missing and FFMPEG_PATH unset)',
      };
    }

    try {
      await access(path, constants.X_OK);
      return { status: 'ok', path };
    } catch (error) {
      return {
        status: 'unavailable',
        path,
        reason: `ffmpeg at "${path}" is not executable: ${(error as Error).message}`,
      };
    }
  }

  /**
   * Boot-time visibility. Deliberately does not throw: preview is accessory, and
   * Sprint 5 removed exactly this class of boot crash from a non-critical
   * dependency (see PLAN.md P-6).
   */
  async onApplicationBootstrap(): Promise<void> {
    const probe = await this.probe();

    if (probe.status === 'disabled') {
      this.logger.log(
        'video_preview.disabled (VIDEO_PREVIEW_ENABLED=false) — no previews will be generated',
      );
      return;
    }

    if (probe.status === 'unavailable') {
      this.logger.error(
        `video_preview.ffmpeg_unavailable — ${probe.reason}. ` +
          'Every preview job will fail. Set FFMPEG_PATH to a runnable ffmpeg, ' +
          'reinstall dependencies without --ignore-scripts, or turn the pipeline ' +
          'off with VIDEO_PREVIEW_ENABLED=false.',
      );
      return;
    }

    this.logger.log(`video_preview.ffmpeg_ready path=${probe.path}`);
  }
}
