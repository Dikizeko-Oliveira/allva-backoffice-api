import {
  Body,
  BadRequestException,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Put,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBody,
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConsumes,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { FileInterceptor } from '@nestjs/platform-express';
import { CurrentUser } from 'src/modules/auth/infrastructure/http/decorators/current-user.decorator';
import { Public } from 'src/modules/auth/infrastructure/http/decorators/public.decorator';
import {
  CreateAccountWithPasswordInputDto,
  CreateAccountWithPasswordOutputDto,
  UpdateAccountInputDto,
} from 'src/modules/accounts/application/dtos';
import { Account } from 'src/modules/accounts/domain/entities';
import {
  CreateAccountWithPasswordUseCase,
  DeleteAccountUseCase,
  GetAccountUseCase,
  UploadAccountAvatarUseCase,
  UpdateAccountUseCase,
} from 'src/modules/accounts/application/use-cases';
import { AuthenticatedOnly } from 'src/modules/subscriptions/access/infrastructure/http/decorators/authenticated-only.decorator';
import { EntitlementGuard } from 'src/modules/subscriptions/access/infrastructure/http/guards/entitlement.guard';

@ApiTags('Gerenciar Contas')
@ApiBearerAuth('access-token')
@Controller('/api/v1/accounts')
@UseGuards(EntitlementGuard)
export class AccountsController {
  constructor(
    private readonly createAccountWithPasswordUseCase: CreateAccountWithPasswordUseCase,
    private readonly deleteAccountUseCase: DeleteAccountUseCase,
    private readonly updateAccountUseCase: UpdateAccountUseCase,
    private readonly getAccountUseCase: GetAccountUseCase,
    private readonly uploadAccountAvatarUseCase: UploadAccountAvatarUseCase,
  ) {}

  @Post()
  @Public()
  @ApiOperation({ summary: 'Criar conta com email e senha' })
  @ApiOkResponse({
    description: 'Conta criada com sucesso',
    type: CreateAccountWithPasswordOutputDto,
  })
  @ApiConflictResponse({
    description: 'Email ja esta em uso',
    schema: {
      example: {
        code: 'ACCOUNT_ALREADY_EXISTS',
        message: 'Account already exists',
      },
    },
  })
  @ApiForbiddenResponse({
    description: 'Cadastro fechado nesta instalacao (REGISTRATION_DISABLED)',
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
  async createAccountWithPassword(
    @Body() dto: CreateAccountWithPasswordInputDto,
  ): Promise<CreateAccountWithPasswordOutputDto> {
    return this.createAccountWithPasswordUseCase.execute(dto);
  }

  @Put()
  @AuthenticatedOnly()
  @ApiOperation({ summary: 'Atualizar conta' })
  @ApiOkResponse({
    description: 'Conta atualizada com sucesso',
    schema: {
      example: {},
    },
  })
  async updateAccount(
    @CurrentUser() user: Account,
    @Body() dto: UpdateAccountInputDto,
  ) {
    const account = await this.updateAccountUseCase.execute({
      ...dto,
      accountId: user.id,
    });

    return account.toJSON();
  }

  @Get('/profile')
  @AuthenticatedOnly()
  @ApiOperation({ summary: 'Listar conta' })
  async getAccount(@CurrentUser() user: Account) {
    const account = await this.getAccountUseCase.execute(user.id);

    return account.toJSON();
  }

  @Post('/avatar')
  @AuthenticatedOnly()
  @ApiOperation({ summary: 'Fazer upload da foto de perfil' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: {
        file: {
          type: 'string',
          format: 'binary',
        },
      },
    },
  })
  @ApiOkResponse({
    description: 'Foto de perfil atualizada com sucesso',
  })
  @ApiBadRequestResponse({
    description: 'Arquivo não enviado',
    schema: {
      example: {
        code: 'FILE_REQUIRED',
        message: 'File is required',
      },
    },
  })
  @UseInterceptors(FileInterceptor('file'))
  async uploadAvatar(
    @CurrentUser() user: Account,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    if (!file) {
      throw new BadRequestException({
        code: 'FILE_REQUIRED',
        message: 'File is required',
      });
    }

    const accountId = user.id;
    const account = await this.uploadAccountAvatarUseCase.execute({
      accountId,
      file,
    });

    return account.toJSON();
  }

  @Delete()
  @AuthenticatedOnly()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Deletar conta e todos os dados' })
  @ApiOkResponse({
    description: 'Conta deletada com sucesso',
    schema: { example: {} },
  })
  async deleteAccount(@CurrentUser() user: Account) {
    const accountId = user.id;
    return this.deleteAccountUseCase.execute(accountId);
  }
}
