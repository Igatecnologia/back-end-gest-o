import { createHash } from 'node:crypto'

export async function hashPassword(password: string, mode: string): Promise<string> {
  switch (mode) {
    case 'sha256':
      return createHash('sha256').update(password).digest('hex')
    case 'md5':
      return createHash('md5').update(password).digest('hex')
    case 'plain':
    default:
      return password
  }
}
