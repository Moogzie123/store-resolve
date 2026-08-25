export const authority: string
export const scopes: string
export const oidcConfigurationUrl: string
export const graphReadinessUrl: string
export const graphSanityUrl: string

export interface DeviceAuthorization {
  deviceCode: string
  userCode: string
  verificationUri: string
  expiresIn: number
  interval: number
}

export interface MicrosoftTokenResponse {
  accessToken: string
  refreshToken: string
  idToken: string
}

export interface IdentityConfirmation {
  matches: boolean
  maskedIdentity: string
  reason?: string
  graphReady?: boolean
  sanityCount?: number
}

export function requestDeviceCode(
  clientId: string,
  fetchImpl?: typeof fetch,
): Promise<DeviceAuthorization>

export function pollForTokenResponse(
  clientId: string,
  device: DeviceAuthorization,
  fetchImpl?: typeof fetch,
  wait?: (milliseconds: number) => Promise<void>,
): Promise<MicrosoftTokenResponse>

export function validateIdToken(
  idToken: string,
  clientId: string,
  fetchImpl?: typeof fetch,
  nowSeconds?: number,
): Promise<Record<string, unknown>>

export function maskMailbox(mailbox: string): string
export function confirmExpectedMailbox(
  claims: Record<string, unknown>,
  expectedMailbox: string,
): IdentityConfirmation

export function verifyGraphReadiness(accessToken: string, fetchImpl?: typeof fetch): Promise<true>
export function runMailboxMetadataSanityCheck(
  accessToken: string,
  fetchImpl?: typeof fetch,
): Promise<number>

export function storeRefreshToken(refreshToken: string, cwd?: string): Promise<void>

export function authorizeExpectedMailbox(options: {
  clientId: string
  expectedMailbox: string
  fetchImpl?: typeof fetch
  wait?: (milliseconds: number) => Promise<void>
  storeToken?: (refreshToken: string) => Promise<void>
  log?: (message: string) => void
}): Promise<IdentityConfirmation>

export function main(): Promise<void>
