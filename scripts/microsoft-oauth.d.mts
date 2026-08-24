export const authority: string
export const scopes: string

export interface DeviceAuthorization {
  deviceCode: string
  userCode: string
  verificationUri: string
  expiresIn: number
  interval: number
}

export function requestDeviceCode(
  clientId: string,
  fetchImpl?: typeof fetch,
): Promise<DeviceAuthorization>

export function pollForRefreshToken(
  clientId: string,
  device: DeviceAuthorization,
  fetchImpl?: typeof fetch,
  wait?: (milliseconds: number) => Promise<void>,
): Promise<string>

export function storeRefreshToken(refreshToken: string, cwd?: string): Promise<void>
export function main(): Promise<void>
