import type { AlertEvent, AlertRule } from '../domain/entities';
import type { AlertEventOutputDto, AlertRuleOutputDto } from './dtos';

export function toAlertRuleOutput(rule: AlertRule): AlertRuleOutputDto {
  return {
    id: rule.id,
    source: rule.source,
    threshold: rule.threshold,
    channel: rule.channel,
    target: rule.target,
    requiredPermission: rule.requiredPermission,
    quietHours: rule.quietHours,
    active: rule.active,
    createdAt: rule.createdAt,
    updatedAt: rule.updatedAt,
  };
}

export function toAlertEventOutput(event: AlertEvent): AlertEventOutputDto {
  return {
    id: event.id,
    ruleId: event.ruleId,
    source: event.source,
    severity: event.severity,
    payload: event.payload,
    requiredPermission: event.requiredPermission,
    acknowledgedBy: event.acknowledgedBy,
    acknowledgedAt: event.acknowledgedAt,
    createdAt: event.createdAt,
  };
}
