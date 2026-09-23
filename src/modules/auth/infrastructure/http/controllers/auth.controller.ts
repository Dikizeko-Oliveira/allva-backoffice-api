import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { ThrottleLimit } from 'src/shared/infrastructure/http/throttling/throttle-policies';
import { Request } from 'express';
import { Account } from 'src/modules/accounts/domain/entities/account.entity';
import { CurrentUser } from 'src/modules/auth/infrastructure/http/decorators/current-user.decorator';
import { Public } from 'src/modules/auth/infrastructure/http/decorators/public.decorator';
import {
  ChangePasswordInputDto,
  ForgotPasswordInputDto,
  LoginWithFacebookInputDto,
  LoginWithGoogleInputDto,
  LoginWithPasswordInputDto,
  LoginWithPasswordOutputDto,
  RefreshSessionInputDto,
  RefreshSessionOutputDto,
  ResendEmailVerificationInputDto,
  ResetPasswordInputDto,
  RevokeSessionInputDto,
  VerifyEmailInputDto,
  VerifyEmailOutputDto,
} from 'src/modules/auth/application/dtos';
import {
  SendEmailVerificationUseCase,
  VerifyEmailUseCase,
} from 'src/modules/accounts/application/use-cases';
import {
  ChangePasswordUseCase,
  ForgotPasswordUseCase,
  IssueAuthSessionUseCase,
  ListSessionsUseCase,
  LoginWithFacebookUseCase,
  LoginWithGoogleUseCase,
  LoginWithPasswordUseCase,
  RefreshSessionUseCase,
  RegisterWithGoogleUseCase,
  ResetPasswordUseCase,
  RevokeSessionUseCase,
} from 'src/modules/auth/application/use-cases';
import { SessionsRepositoryInterface } from 'src/modules/auth/domain/ports';
import { extractClientContext } from 'src/modules/security/infrastructure/http/client-context';

@ApiTags('Autenticação')
@Controller('/api/v1/auth')
export class AuthController {
  constructor(
    private readonly loginWithPasswordUseCase: LoginWithPasswordUseCase,
    private readonly loginWithGoogleUseCase: LoginWithGoogleUseCase,
    private readonly registerWithGoogleUseCase: RegisterWithGoogleUseCase,
    private readonly loginWithFacebookUseCase: LoginWithFacebookUseCase,
    private readonly refreshSessionUseCase: RefreshSessionUseCase,
    private readonly revokeSessionUseCase: RevokeSessionUseCase,
    private readonly listSessionsUseCase: ListSessionsUseCase,
    private readonly forgotPasswordUseCase: ForgotPasswordUseCase,
    private readonly resetPasswordUseCase: ResetPasswordUseCase,
    private readonly changePasswordUseCase: ChangePasswordUseCase,
    private readonly verifyEmailUseCase: VerifyEmailUseCase,
    private readonly sendEmailVerificationUseCase: SendEmailVerificationUseCase,
    private readonly issueAuthSessionUseCase: IssueAuthSessionUseCase,
    private readonly sessionsRepository: SessionsRepositoryInterface,
  ) {}

  @Post('/login')
  @Public()
  // Brute-force protection: cap password login attempts per IP per minute.
  @ThrottleLimit(10)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Fazer login com email e senha' })
  @ApiOkResponse({
    description: 'Autenticacao bem-sucedida',
    schema: {
      example: {
        token: '12345678901234567890123456789012345678901234567890',
      },
    },
  })
  @ApiUnauthorizedResponse({
    description: 'Credenciais invalidas',
    schema: {
      example: {
        code: 'INVALID_CREDENTIALS',
        message: 'Email or password is invalid',
      },
    },
  })
  @ApiBadRequestResponse({
    description: 'Erro de validacao',
  })
  async loginWithPassword(
    @Body() dto: LoginWithPasswordInputDto,
    @Req() req: Request,
  ) {
    const { ipAddress, userAgent } = extractClientContext(req);

    return this.loginWithPasswordUseCase.execute({
      ...dto,
      ipAddress: dto.ipAddress ?? ipAddress,
      userAgent: dto.userAgent ?? userAgent,
    });
  }

  @Post('/google')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Fazer login com Google usando ID token validado no backend',
  })
  @ApiOkResponse({
    description: 'Autenticacao Google bem-sucedida',
    type: LoginWithPasswordOutputDto,
  })
  @ApiUnauthorizedResponse({
    description: 'Token Google invalido ou nao verificavel',
  })
  @ApiBadRequestResponse({
    description: 'Payload invalido',
  })
  async loginWithGoogle(
    @Body() dto: LoginWithGoogleInputDto,
    @Req() req: Request,
  ) {
    return this.executeGoogleLogin(dto, req);
  }

  @Post('/google/register')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Cadastro ou login com Google — cria conta automaticamente se não existir',
  })
  @ApiOkResponse({
    description: 'Cadastro/Login Google bem-sucedido',
    type: LoginWithPasswordOutputDto,
  })
  @ApiBadRequestResponse({
    description: 'Payload invalido',
  })
  @ApiUnauthorizedResponse({
    description: 'Token Google invalido ou nao verificavel',
  })
  @ApiForbiddenResponse({
    description:
      'Cadastro fechado nesta instalacao (REGISTRATION_DISABLED). So recusa quando a conta ainda nao existe — quem ja tem conta continua entrando.',
    schema: {
      example: {
        error: {
          code: 'REGISTRATION_DISABLED',
          category: 'KILL_SWITCH',
          message: 'Novos cadastros estão temporariamente fechados.',
          retryable: false,
        },
      },
    },
  })
  async registerWithGoogle(
    @Body() dto: LoginWithGoogleInputDto,
    @Req() req: Request,
  ) {
    const { ipAddress, userAgent } = extractClientContext(req);

    return this.registerWithGoogleUseCase.execute({
      ...dto,
      ipAddress: dto.ipAddress ?? ipAddress,
      userAgent: dto.userAgent ?? userAgent,
    });
  }

  @Post('/facebook')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Login ou cadastro com Facebook — cria conta automaticamente se não existir',
  })
  @ApiOkResponse({
    description: 'Login/Cadastro Facebook bem-sucedido',
    type: LoginWithPasswordOutputDto,
  })
  @ApiBadRequestResponse({
    description: 'Payload invalido ou email nao fornecido pelo Facebook',
  })
  @ApiUnauthorizedResponse({
    description: 'Token Facebook invalido ou expirado',
  })
  @ApiForbiddenResponse({
    description:
      'Cadastro fechado nesta instalacao (REGISTRATION_DISABLED). So recusa quando a conta ainda nao existe — quem ja tem conta continua entrando.',
    schema: {
      example: {
        error: {
          code: 'REGISTRATION_DISABLED',
          category: 'KILL_SWITCH',
          message: 'Novos cadastros estão temporariamente fechados.',
          retryable: false,
        },
      },
    },
  })
  async loginWithFacebook(
    @Body() dto: LoginWithFacebookInputDto,
    @Req() req: Request,
  ) {
    const { ipAddress, userAgent } = extractClientContext(req);

    return this.loginWithFacebookUseCase.execute({
      ...dto,
      ipAddress: dto.ipAddress ?? ipAddress,
      userAgent: dto.userAgent ?? userAgent,
    });
  }

  @Post('/refresh')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Atualizar token de acesso' })
  @ApiOkResponse({
    description: 'Tokens atualizados com sucesso',
    type: RefreshSessionOutputDto,
  })
  @ApiUnauthorizedResponse({
    description: 'Refresh token invalido ou expirado',
    schema: {
      example: {
        code: 'INVALID_REFRESH_TOKEN',
        message: 'Refresh token is invalid or expired',
      },
    },
  })
  async refreshSession(
    @Body() dto: RefreshSessionInputDto,
    @Req() req: Request,
  ) {
    return this.refreshSessionUseCase.execute(dto, extractClientContext(req));
  }

  @Post('/revoke')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Revogar sessao' })
  @ApiOkResponse({
    description: 'Sessao revogada com sucesso',
    schema: { example: {} },
  })
  @ApiNotFoundResponse({
    description: 'Sessao nao encontrada ou nao pertence a esta conta',
    schema: {
      example: {
        code: 'SESSION_NOT_FOUND',
        message: 'Session not found or does not belong to this account',
      },
    },
  })
  async revokeSession(
    @Body() dto: RevokeSessionInputDto,
    @CurrentUser() user: Account,
    @Req() req: Request,
  ) {
    const session = await this.sessionsRepository.findById(dto.sessionId);

    if (!session || session.accountId !== user.id) {
      throw new ForbiddenException({
        code: 'SESSION_NOT_FOUND',
        message: 'Session not found or does not belong to this account',
      });
    }

    return this.revokeSessionUseCase.execute(dto, extractClientContext(req));
  }

  @Get('/sessions')
  @ApiOperation({ summary: 'Listar sessoes' })
  async listSessions(@CurrentUser() user: Account) {
    const accountId = user.id;
    return this.listSessionsUseCase.execute(accountId);
  }

  @Post('/forgot-password')
  @Public()
  // Limit password-reset requests per IP to deter abuse / email flooding.
  @ThrottleLimit(5)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Solicitar redefinicao de senha' })
  @ApiOkResponse({
    description: 'Email de recuperacao enviado (se a conta existir)',
    schema: { example: {} },
  })
  async forgotPassword(
    @Body() dto: ForgotPasswordInputDto,
    @Req() req: Request,
  ) {
    return this.forgotPasswordUseCase.execute(
      dto.email,
      extractClientContext(req),
    );
  }

  @Post('/verify-email')
  @Public()
  // Seis digitos sao 10^6, e nao 2^256: aqui o throttle por IP faz parte da
  // defesa, junto do teto de 5 tentativas por codigo e do bloqueio progressivo.
  @ThrottleLimit(10)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Confirmar email usando o codigo de 6 digitos' })
  @ApiOkResponse({
    description: 'Email confirmado e sessao emitida',
    type: VerifyEmailOutputDto,
  })
  @ApiBadRequestResponse({
    description: 'Codigo invalido, expirado ou ja utilizado',
  })
  async verifyEmail(
    @Body() dto: VerifyEmailInputDto,
    @Req() req: Request,
  ): Promise<VerifyEmailOutputDto> {
    const { ipAddress, userAgent } = extractClientContext(req);

    const { accountId, account } = await this.verifyEmailUseCase.execute({
      email: dto.email,
      code: dto.code,
      ipAddress,
      userAgent,
    });

    /**
     * A confirmacao ja devolve a sessao — o cadastro nao passa pelo /login.
     *
     * Nao e conveniencia: ate este instante o /login recusa a conta com
     * `403 EMAIL_NOT_VERIFIED`, entao um cadastro que dependesse dele ficaria
     * preso entre "conta criada" e "conta utilizavel", que foi exatamente o
     * defeito que este fluxo veio corrigir.
     *
     * O codigo e credencial suficiente porque prova posse da caixa de entrada e
     * so existe **antes** da confirmacao: verificada a conta, o reenvio vira
     * no-op e este caminho fecha sozinho. Depois disso, entrar exige a senha.
     */
    const session = await this.issueAuthSessionUseCase.execute({
      account,
      ipAddress,
      userAgent,
    });

    return {
      accountId,
      emailVerified: true,
      accessToken: session.accessToken,
      refreshToken: session.refreshToken,
    };
  }

  @Post('/verify-email/resend')
  @Public()
  // Tighter than the token check: this one sends mail.
  @ThrottleLimit(5)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reenviar o codigo de confirmacao por email' })
  @ApiOkResponse({
    // Always 200, even for unknown/already-verified addresses, so the endpoint
    // cannot be used to discover which emails have an account.
    description: 'Email de confirmacao enviado (se aplicavel)',
    schema: { example: {} },
  })
  async resendEmailVerification(
    @Body() dto: ResendEmailVerificationInputDto,
  ): Promise<void> {
    return this.sendEmailVerificationUseCase.execute(dto.email);
  }

  private executeGoogleLogin(dto: LoginWithGoogleInputDto, req: Request) {
    const { ipAddress, userAgent } = extractClientContext(req);

    return this.registerWithGoogleUseCase.execute({
      ...dto,
      ipAddress: dto.ipAddress ?? ipAddress,
      userAgent: dto.userAgent ?? userAgent,
    });
  }

  @Post('/reset-password')
  @Public()
  // Limit reset-token guesses per IP (replay/brute-force protection).
  @ThrottleLimit(10)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Redefinir senha usando token' })
  @ApiOkResponse({
    description: 'Senha redefinida com sucesso',
    schema: { example: {} },
  })
  @ApiUnauthorizedResponse({
    description: 'Token invalido ou expirado',
    schema: {
      example: {
        code: 'INVALID_OR_EXPIRED_TOKEN',
        message: 'Reset token is invalid or expired',
      },
    },
  })
  async resetPassword(@Body() dto: ResetPasswordInputDto, @Req() req: Request) {
    const { ipAddress, userAgent } = extractClientContext(req);

    return this.resetPasswordUseCase.execute({ ...dto, ipAddress, userAgent });
  }

  @Post('/change-password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Alterar senha do usuário autenticado' })
  @ApiOkResponse({
    description: 'Senha alterada com sucesso',
    schema: {
      example: { success: true, message: 'Password changed successfully.' },
    },
  })
  async changePassword(
    @Body() dto: ChangePasswordInputDto,
    @CurrentUser() user: Account,
  ) {
    return this.changePasswordUseCase.execute({
      accountId: user.id,
      currentPassword: dto.currentPassword,
      newPassword: dto.newPassword,
    });
  }

  @Delete('/sessions/:sessionId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Revogar sessao pelo ID' })
  @ApiOkResponse({
    description: 'Sessao revogada com sucesso',
    schema: { example: { success: true } },
  })
  async deleteSession(
    @Param('sessionId') sessionId: string,
    @CurrentUser() user: Account,
    @Req() req: Request,
  ) {
    const session = await this.sessionsRepository.findById(sessionId);

    if (!session || session.accountId !== user.id) {
      throw new ForbiddenException({
        code: 'SESSION_NOT_FOUND',
        message: 'Session not found or does not belong to this account',
      });
    }

    await this.revokeSessionUseCase.execute(
      { sessionId },
      extractClientContext(req),
    );

    return { success: true };
  }
}
