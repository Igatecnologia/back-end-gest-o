/**
 * Masking de PII em texto antes de persistir.
 * Substitui padrões comuns (CPF, CNPJ, telefone, email, cartão) por placeholders.
 */

const patterns: Array<{ regex: RegExp; replacement: string }> = [
  // CPF: 123.456.789-01 ou 12345678901
  { regex: /\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g, replacement: '[CPF]' },
  // CNPJ: 12.345.678/0001-00 ou 12345678000100
  { regex: /\b\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}\b/g, replacement: '[CNPJ]' },
  // Cartão de crédito: 4 grupos de 4 dígitos
  { regex: /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g, replacement: '[CARTAO]' },
  // Telefone BR: (11) 99999-9999 ou +55 11 999999999
  { regex: /(?:\+55\s?)?\(?\d{2}\)?\s?\d{4,5}-?\d{4}\b/g, replacement: '[TELEFONE]' },
  // Email
  { regex: /\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/g, replacement: '[EMAIL]' },
]

export function maskPii(text: string): string {
  let result = text
  for (const { regex, replacement } of patterns) {
    result = result.replace(regex, replacement)
  }
  return result
}
