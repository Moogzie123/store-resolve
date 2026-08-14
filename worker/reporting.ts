import type { AppState, Complaint } from '../src/lib/types'

export interface ReportingFilters {
  from?: string
  to?: string
  storeId?: string
  status?: string
  category?: string
  severity?: string
}

const group = (complaints: Complaint[], value: (complaint: Complaint) => string) =>
  Object.fromEntries(
    Array.from(
      complaints.reduce(
        (map, complaint) => map.set(value(complaint), (map.get(value(complaint)) ?? 0) + 1),
        new Map<string, number>(),
      ),
    ).sort(([left], [right]) => left.localeCompare(right)),
  )

const average = (values: number[]) =>
  values.length ? values.reduce((total, value) => total + value, 0) / values.length : 0

export function buildReport(state: AppState, filters: ReportingFilters = {}) {
  const from = filters.from ? new Date(filters.from).getTime() : Number.NEGATIVE_INFINITY
  const to = filters.to ? new Date(filters.to).getTime() : Number.POSITIVE_INFINITY
  const complaints = state.complaints.filter((complaint) => {
    const received = new Date(complaint.receivedAt).getTime()
    return (
      received >= from &&
      received <= to &&
      (!filters.storeId || complaint.storeId === filters.storeId) &&
      (!filters.status || complaint.status === filters.status) &&
      (!filters.category || complaint.category === filters.category) &&
      (!filters.severity || complaint.severity === filters.severity)
    )
  })
  const now = Date.now()
  const weekAgo = now - 7 * 86_400_000
  const monthAgo = now - 30 * 86_400_000
  const ackDurations = complaints
    .filter((complaint) => complaint.managerAcknowledgedAt)
    .map(
      (complaint) =>
        (new Date(complaint.managerAcknowledgedAt!).getTime() -
          new Date(complaint.receivedAt).getTime()) /
        60_000,
    )
  const resolutionDurations = complaints
    .filter((complaint) => complaint.resolutionSubmittedAt)
    .map(
      (complaint) =>
        (new Date(complaint.resolutionSubmittedAt!).getTime() -
          new Date(complaint.receivedAt).getTime()) /
        3_600_000,
    )
  const eligibleForSla = complaints.filter(
    (complaint) => complaint.managerAcknowledgedAt || complaint.isAckOverdue,
  )
  const slaCompliant = eligibleForSla.filter((complaint) => !complaint.isAckOverdue).length
  return {
    filters,
    totals: {
      complaints: complaints.length,
      thisWeek: complaints.filter(
        (complaint) => new Date(complaint.receivedAt).getTime() >= weekAgo,
      ).length,
      thisMonth: complaints.filter(
        (complaint) => new Date(complaint.receivedAt).getTime() >= monthAgo,
      ).length,
      open: complaints.filter((complaint) => complaint.status !== 'CLOSED').length,
      closed: complaints.filter((complaint) => complaint.status === 'CLOSED').length,
      overdue: complaints.filter(
        (complaint) => complaint.isAckOverdue || complaint.isResolutionOverdue,
      ).length,
      routingReview: complaints.filter((complaint) => complaint.routingConfidence === 'REVIEW')
        .length,
      unresolvedEscalations: complaints.filter(
        (complaint) =>
          complaint.status !== 'CLOSED' &&
          (complaint.isAckOverdue || complaint.isResolutionOverdue),
      ).length,
    },
    byStore: group(complaints, (complaint) => complaint.storeId ?? 'ROUTING_REVIEW'),
    byCategory: group(complaints, (complaint) => complaint.category),
    bySeverity: group(complaints, (complaint) => complaint.severity),
    byStatus: group(complaints, (complaint) => complaint.status),
    averageManagerAcknowledgmentMinutes: Math.round(average(ackDurations) * 10) / 10,
    averageResolutionHours: Math.round(average(resolutionDurations) * 10) / 10,
    slaCompliancePercent: eligibleForSla.length
      ? Math.round((slaCompliant / eligibleForSla.length) * 1000) / 10
      : 100,
  }
}
