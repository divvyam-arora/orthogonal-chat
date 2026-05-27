/**
 * One-shot helper for the auth refactor: wipe the legacy `sessions`-keyed
 * tables and the drizzle migration history, then apply the regenerated init
 * migration. Safe to run repeatedly.
 *
 *   DATABASE_URL=... npx tsx --env-file=.env.local drizzle/reset-and-migrate.ts
 */
import { drizzle } from 'drizzle-orm/neon-http'
import { migrate } from 'drizzle-orm/neon-http/migrator'
import { neon } from '@neondatabase/serverless'

async function main() {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL is required')
  const sql = neon(url)

  console.log('Dropping legacy tables (if present)…')
  await sql`DROP TABLE IF EXISTS "tool_results" CASCADE`
  await sql`DROP TABLE IF EXISTS "messages" CASCADE`
  await sql`DROP TABLE IF EXISTS "conversations" CASCADE`
  await sql`DROP TABLE IF EXISTS "sessions" CASCADE`
  await sql`DROP TABLE IF EXISTS "users" CASCADE`
  await sql`DROP TABLE IF EXISTS "__drizzle_migrations" CASCADE`
  await sql`DROP SCHEMA IF EXISTS "drizzle" CASCADE`

  console.log('Running migrations…')
  const db = drizzle(sql)
  await migrate(db, { migrationsFolder: './drizzle' })
  console.log('Migrations complete.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
