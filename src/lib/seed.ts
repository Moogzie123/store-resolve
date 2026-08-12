import type { AppState, Complaint, Store, User } from './types'

export const users: User[] = [
  {
    id: 'father',
    name: 'Father',
    email: 'father@example.invalid',
    phone: '+15550100001',
    role: 'OWNER',
    active: true,
    smsEnabled: false,
    timezone: 'America/New_York',
  },
  {
    id: 'uncle',
    name: 'Uncle',
    email: 'uncle@example.invalid',
    phone: '+15550100002',
    role: 'OWNER',
    active: true,
    smsEnabled: false,
    timezone: 'America/New_York',
  },
  {
    id: 'grandfather',
    name: 'Grandfather',
    email: 'grandfather@example.invalid',
    phone: '+15550100003',
    role: 'VIEW_ONLY',
    active: true,
    smsEnabled: false,
    timezone: 'America/New_York',
  },
  ...Array.from({ length: 7 }, (_, i) => ({
    id: `manager-${i + 1}`,
    name: `Manager Store ${i + 1}`,
    email: `manager${i + 1}@example.invalid`,
    phone: `+1555020000${i + 1}`,
    role: 'STORE_MANAGER' as const,
    active: true,
    smsEnabled: false,
    timezone: 'America/New_York',
  })),
]

export const stores: Store[] = Array.from({ length: 7 }, (_, i) => ({
  id: `store-${i + 1}`,
  number: `${41001 + i}`,
  name: `${['Riverside', 'Oak Street', 'Northgate', 'Market Square', 'Hillcrest', 'Lakeside', 'Park Avenue'][i]} Dunkin`,
  address: `${100 + i * 20} ${['River Rd', 'Oak St', 'North Ave', 'Market St', 'Hill Rd', 'Lake Dr', 'Park Ave'][i]}`,
  city: 'Brewster',
  state: 'MA',
  postalCode: `017${20 + i}`,
  phone: `+1555030000${i + 1}`,
  active: true,
  managerId: `manager-${i + 1}`,
}))

export const initialComplaints: Complaint[] = []
export const initialState: AppState = {
  users,
  stores,
  complaints: initialComplaints,
  config: { mode: 'MOCK', externalNotificationsEnabled: false },
  activeUserId: 'father',
  testNotifications: [],
}

export const fixtures = [
  {
    label: 'Customer service',
    category: 'Customer Service',
    severity: 'MEDIUM',
    subject: 'Service concern',
    complaintText: 'Customer reports an unhelpful interaction at the counter.',
    storeNumber: '41001',
  },
  {
    label: 'Order accuracy',
    category: 'Order Accuracy',
    severity: 'LOW',
    subject: 'Incorrect order',
    complaintText: 'Customer reports receiving an item different from the one ordered.',
    storeNumber: '41002',
  },
  {
    label: 'Cleanliness',
    category: 'Cleanliness',
    severity: 'HIGH',
    subject: 'Dining area concern',
    complaintText: 'Customer reports the dining area required attention.',
    storeNumber: '41003',
  },
  {
    label: 'Employee conduct',
    category: 'Employee Conduct',
    severity: 'HIGH',
    subject: 'Conduct concern',
    complaintText: 'Customer reports an inappropriate employee interaction.',
    storeNumber: '41004',
  },
  {
    label: 'Critical',
    category: 'Safety',
    severity: 'CRITICAL',
    subject: 'Urgent safety concern',
    complaintText: 'Customer reports a potential safety issue requiring immediate review.',
    storeNumber: '41005',
  },
  {
    label: 'Unknown store',
    category: 'Customer Service',
    severity: 'MEDIUM',
    subject: 'Store not identified',
    complaintText: 'Customer did not provide a recognizable location.',
    storeNumber: '99999',
  },
] as const
