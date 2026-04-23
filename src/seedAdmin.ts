import { randomBytes } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readAllUsers, writeAllUsers, genUserId, hashUserPassword } from './userStorage.js'
import { resolveDataDir } from './paths.js'

/**
 * Senha inicial: prioriza `ADMIN_DEFAULT_PASSWORD` (env) sobre senha aleatória.
 * Em produção (Electron), o usuário não tem console visível — a senha gerada é
 * também escrita em `FIRST_LOGIN.txt` no diretório de dados para o cliente ler.
 */
function resolveInitialAdminPassword(): { password: string; source: 'env' | 'random' } {
  const fromEnv = process.env.ADMIN_DEFAULT_PASSWORD?.trim()
  if (fromEnv && fromEnv.length >= 14) return { password: fromEnv, source: 'env' }
  if (fromEnv && fromEnv.length > 0 && fromEnv.length < 14) {
    console.warn('[IGA][SEC] ADMIN_DEFAULT_PASSWORD ignorada: minimo 14 caracteres. Gerando senha aleatoria.')
  }
  const random = randomBytes(16).toString('base64url')
  return { password: random, source: 'random' }
}

function writeFirstLoginFile(email: string, password: string) {
  try {
    const path = join(resolveDataDir(), 'FIRST_LOGIN.txt')
    const body = [
      '================================================================',
      ' IGA Gestão — credenciais iniciais de administrador',
      '================================================================',
      '',
      ` E-mail: ${email}`,
      ` Senha:  ${password}`,
      '',
      ' AÇÃO NECESSÁRIA:',
      '   1) Faça login agora usando as credenciais acima.',
      '   2) Troque a senha imediatamente em "Meu perfil".',
      '   3) Depois de confirmar a nova senha, APAGUE este arquivo.',
      '',
      ` Gerado em: ${new Date().toISOString()}`,
      '================================================================',
      '',
    ].join('\r\n')
    writeFileSync(path, body, { encoding: 'utf-8', mode: 0o600 })
    return path
  } catch (err) {
    console.error('[IGA Backend] Falha ao gravar FIRST_LOGIN.txt:', err instanceof Error ? err.message : err)
    return null
  }
}

export function seedDefaultAdmin() {
  const users = readAllUsers()
  if (users.length > 0) return

  const { password, source } = resolveInitialAdminPassword()
  const now = new Date().toISOString()
  const email = process.env.ADMIN_DEFAULT_EMAIL?.trim() || 'admin@iga.com'
  const admin = {
    id: genUserId(),
    name: 'Administrador',
    email,
    role: 'admin' as const,
    status: 'active' as const,
    passwordHash: hashUserPassword(password),
    /** Quando a senha vem do env (`ADMIN_DEFAULT_PASSWORD`), assumimos que é uma
     *  decisão consciente — não força troca. Quando é aleatória (sem env), força
     *  troca obrigatória pra evitar admin com senha publicada em FIRST_LOGIN.txt. */
    mustChangePassword: source !== 'env',
    createdAt: now,
    updatedAt: now,
  }

  writeAllUsers([admin])

  const filePath = source === 'random' ? writeFirstLoginFile(email, password) : null
  const box = '═'.repeat(60)
  console.log(`\n${box}\n[IGA Backend] ADMIN CRIADO — ${source === 'env' ? 'senha via ADMIN_DEFAULT_PASSWORD' : 'SENHA GERADA ALEATORIAMENTE'}`)
  console.log(`              email:    ${admin.email}`)
  if (source === 'random') {
    console.log(`              senha:    ${password}`)
    if (filePath) console.log(`              arquivo:  ${filePath}`)
    console.log(`              >>> anote esta senha agora; será exigida troca no 1º login.`)
  } else {
    console.log(`              senha:    (definida via ADMIN_DEFAULT_PASSWORD)`)
  }
  console.log(`${box}\n`)
}
