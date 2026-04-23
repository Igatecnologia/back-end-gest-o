import cron from 'node-cron'
import nodemailer from 'nodemailer'
import { getDb } from '../db/sqlite.js'

const db = getDb()
let started = false

function getTransporter() {
  const host = process.env.SMTP_HOST?.trim()
  const port = Number(process.env.SMTP_PORT ?? 587)
  const user = process.env.SMTP_USER?.trim()
  const pass = process.env.SMTP_PASS?.trim()
  if (!host || !user || !pass) return null
  return nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
  })
}

export function startScheduledReportsJob() {
  if (started) return
  started = true
  cron.schedule('* * * * *', async () => {
    const transporter = getTransporter()
    if (!transporter) return
    const rows = db
      .prepare('SELECT id, name, recipients_json, format FROM scheduled_reports WHERE active = 1')
      .all() as Array<{ id: string; name: string; recipients_json: string; format: string }>
    for (const row of rows) {
      const recipients = JSON.parse(row.recipients_json) as string[]
      if (!recipients.length) continue
      await transporter.sendMail({
        from: process.env.SMTP_FROM ?? process.env.SMTP_USER,
        to: recipients.join(','),
        subject: `[IGA] Relatório agendado: ${row.name}`,
        text: `Relatório ${row.name} foi executado em ${new Date().toISOString()} (formato ${row.format}).`,
      })
      db.prepare('UPDATE scheduled_reports SET last_sent_at = ?, updated_at = ? WHERE id = ?').run(
        new Date().toISOString(),
        new Date().toISOString(),
        row.id,
      )
    }
  })
}
