import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, IsIn, IsString, MaxLength, MinLength } from 'class-validator';
import {
  PLATFORM_PERMISSIONS,
  PLATFORM_ROLES,
  type PlatformPermission,
  type PlatformRole,
} from 'src/modules/accounts/domain/platform-rbac';

const STATUS_REASON_MIN_LENGTH = 5;
const STATUS_REASON_MAX_LENGTH = 500;

export class UpdateCustomerMembershipStatusInputDto {
  @ApiProperty({ enum: ['ACTIVE', 'BLOCKED'], example: 'BLOCKED' })
  @IsIn(['ACTIVE', 'BLOCKED'], {
    message: 'status must be ACTIVE or BLOCKED',
  })
  status: 'ACTIVE' | 'BLOCKED';

  @ApiProperty({
    minLength: STATUS_REASON_MIN_LENGTH,
    maxLength: STATUS_REASON_MAX_LENGTH,
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(STATUS_REASON_MIN_LENGTH)
  @MaxLength(STATUS_REASON_MAX_LENGTH)
  reason: string;
}

export class UpdateCustomerMembershipStatusOutputDto {
  @ApiProperty()
  id: string;

  @ApiProperty({ enum: ['ACTIVE', 'BLOCKED'] })
  status: 'ACTIVE' | 'BLOCKED';
}

export class UpdateOperatorStatusInputDto {
  @ApiProperty({ enum: ['ACTIVE', 'DISABLED'], example: 'DISABLED' })
  @IsIn(['ACTIVE', 'DISABLED'], {
    message: 'status must be ACTIVE or DISABLED',
  })
  status: 'ACTIVE' | 'DISABLED';

  @ApiProperty({
    minLength: STATUS_REASON_MIN_LENGTH,
    maxLength: STATUS_REASON_MAX_LENGTH,
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(STATUS_REASON_MIN_LENGTH)
  @MaxLength(STATUS_REASON_MAX_LENGTH)
  reason: string;
}

export class UpdateOperatorStatusOutputDto {
  @ApiProperty()
  id: string;

  @ApiProperty({ enum: ['ACTIVE', 'DISABLED'] })
  status: 'ACTIVE' | 'DISABLED';
}

export class CreateOperatorInputDto {
  @ApiProperty({ example: 'Joana Silva' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(2)
  @MaxLength(150)
  name: string;

  @ApiProperty({ example: 'joana@allva.com.br' })
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsEmail({}, { message: 'Email is invalid' })
  @MaxLength(320)
  email: string;

  @ApiProperty({ enum: PLATFORM_ROLES, example: 'ALLVA_SUPPORT' })
  @IsIn(PLATFORM_ROLES, {
    message: `platformRole must be one of: ${PLATFORM_ROLES.join(', ')}`,
  })
  platformRole: PlatformRole;
}

export class CreateOperatorOutputDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  name: string;

  @ApiProperty()
  email: string;

  @ApiProperty({ enum: PLATFORM_ROLES })
  platformRole: PlatformRole;

  @ApiProperty({
    enum: PLATFORM_PERMISSIONS,
    isArray: true,
  })
  platformPermissions: PlatformPermission[];

  @ApiProperty({ enum: ['ACTIVE'] })
  status: 'ACTIVE';
}
