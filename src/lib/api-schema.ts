import { z } from 'zod'

export const severitySchema = z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'])
export const complaintInputSchema = z.object({
  externalCaseId: z.string().trim().min(1).max(100),
  storeNumber: z.string().trim().min(1).max(30),
  subject: z.string().trim().min(1).max(300),
  complaintText: z.string().trim().min(1).max(20_000),
  category: z.string().trim().min(1).max(100),
  severity: severitySchema,
})
export const actionSchema = z.object({
  action: z.enum([
    'ACKNOWLEDGE',
    'START_INVESTIGATION',
    'CONTACT_CUSTOMER',
    'SUBMIT_RESOLUTION',
    'CLOSE',
    'REOPEN',
  ]),
  data: z.record(z.string(), z.unknown()).default({}),
})
export const configSchema = z.object({
  mode: z.enum(['MOCK', 'FAMILY_PILOT', 'SINGLE_STORE_PILOT', 'FULL']),
  externalNotificationsEnabled: z.boolean(),
  pilotStoreId: z.string().optional(),
})
export const contactSchema = z.object({
  name: z.string().trim().min(1).max(100),
  email: z.union([z.literal(''), z.string().email().max(254)]),
  phone: z.union([z.literal(''), z.string().regex(/^\+[1-9]\d{7,14}$/, 'Use E.164 format')]),
  smsEnabled: z.boolean(),
  active: z.boolean(),
})
export const testNotificationSchema = z.object({
  recipientUserId: z.enum(['father', 'uncle', 'grandfather']),
  confirmed: z.literal(true),
})
export const signalWireCallbackSchema = z.object({
  MessageSid: z.string().uuid(),
})
