export type Role = 'OWNER' | 'VIEW_ONLY' | 'STORE_MANAGER' | 'ADMIN'
export type RecipientKind = 'STANDARD' | 'PILOT_ADMIN'
export type Severity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'
export type Status =
  | 'NEW'
  | 'ROUTING_REVIEW'
  | 'MANAGER_NOTIFIED'
  | 'ACKNOWLEDGED'
  | 'INVESTIGATING'
  | 'RESOLUTION_SUBMITTED'
  | 'CLOSED'
export type NotificationStatus =
  'PENDING' | 'SENT' | 'DELIVERED' | 'FAILED' | 'UNDELIVERED' | 'SUPPRESSED'
export type RolloutMode = 'MOCK' | 'FAMILY_PILOT' | 'SINGLE_STORE_PILOT' | 'FULL'
export type EventType =
  | 'COMPLAINT_RECEIVED'
  | 'FOLLOW_UP_RECEIVED'
  | 'STORE_ASSIGNED'
  | 'ROUTING_REVIEW_REQUIRED'
  | 'DUNKIN_ACKNOWLEDGED'
  | 'OWNER_NOTIFIED'
  | 'MANAGER_NOTIFIED'
  | 'MANAGER_ACKNOWLEDGED'
  | 'MANAGER_ACK_OVERDUE'
  | 'INVESTIGATION_STARTED'
  | 'INVESTIGATION_UPDATED'
  | 'CUSTOMER_CONTACTED'
  | 'RESOLUTION_SUBMITTED'
  | 'RESOLUTION_OVERDUE'
  | 'COMPLAINT_CLOSED'
  | 'COMPLAINT_REOPENED'

export interface User {
  id: string
  name: string
  email: string
  phone: string
  role: Role
  recipientKind: RecipientKind
  active: boolean
  smsEnabled: boolean
  complaintNotificationsEnabled?: boolean
  timezone: string
}
export interface Store {
  id: string
  number: string
  name: string
  address: string
  city: string
  state: string
  postalCode: string
  phone: string
  active: boolean
  managerId: string
  aliases?: string[]
}
export interface ComplaintEvent {
  id: string
  complaintId: string
  type: EventType
  actor: string
  timestamp: string
  metadata?: Record<string, unknown>
}
export interface Notification {
  id: string
  complaintId: string
  eventType: EventType | 'TEST'
  recipientUserId: string
  channel: 'SMS' | 'IN_APP'
  message: string
  status: NotificationStatus
  provider: 'MOCK' | 'SIGNALWIRE'
  providerMessageId?: string
  createdAt: string
  sentAt?: string
  deliveredAt?: string
  failedAt?: string
  failureReason?: string
}
export interface Complaint {
  id: string
  externalCaseId: string
  storeId?: string
  assignedManagerId?: string
  subject: string
  complaintText: string
  source?: 'MANUAL' | 'GMAIL'
  gmailMessageId?: string
  gmailThreadId?: string
  sourceSender?: string
  customerName?: string
  customerEmail?: string
  customerPhone?: string
  occurrenceAt?: string
  category: string
  severity: Severity
  status: Status
  isAckOverdue: boolean
  isResolutionOverdue: boolean
  routingReason: string
  routingConfidence: 'HIGH' | 'REVIEW'
  receivedAt: string
  dunkinAcknowledgedAt?: string
  acknowledgementStatus?: 'DISABLED' | 'PENDING' | 'IN_FLIGHT' | 'SENT' | 'FAILED'
  acknowledgementBody: string
  managerNotifiedAt?: string
  managerAcknowledgedAt?: string
  investigationStartedAt?: string
  resolutionSubmittedAt?: string
  closedAt?: string
  closedBy?: string
  ownerReviewedAt?: string
  reopenedAt?: string
  reopenReason?: string
  ownerNotes?: string
  ackDeadline: string
  resolutionDeadline?: string
  managerFindings?: string
  customerContacted?: boolean
  customerContactedAt?: string
  customerContactOutcome?: string
  correctiveAction?: string
  resolutionNotes?: string
  events: ComplaintEvent[]
  notifications: Notification[]
  followUps: { receivedAt: string; text: string }[]
}
export interface AppConfig {
  mode: RolloutMode
  externalNotificationsEnabled: boolean
  pilotStoreId?: string
  gmailIngestionEnabled?: boolean
  gmailAckEnabled?: boolean
  managerAckDeadlineMinutes?: number
  managerResolutionTargetHours?: number
  escalationIntervalMinutes?: number
  signalWireReconcileAfterMinutes?: number
  gmailSearchQuery?: string
}

export interface IntegrationHealth {
  gmailReady: boolean
  gmailIngestionEnabled: boolean
  gmailAckEnabled: boolean
  lastGmailSyncAt?: string
  signalWireReady: boolean
  externalNotificationsEnabled: boolean
  rolloutMode: RolloutMode
  lastBackgroundRunAt?: string
  recentFailures: Array<{ integration: string; code: string; occurredAt: string }>
}
export interface AppState {
  users: User[]
  stores: Store[]
  complaints: Complaint[]
  config: AppConfig
  activeUserId: string
  testNotifications: Notification[]
}
export interface SessionUser extends User {
  maskedPhone: string
  maskedEmail: string
}
export interface BootstrapResponse {
  state: AppState
  currentUser: SessionUser
  providerReady: boolean
  health?: IntegrationHealth
}
export interface NewComplaint {
  externalCaseId: string
  storeNumber: string
  subject: string
  complaintText: string
  category: string
  severity: Severity
}
