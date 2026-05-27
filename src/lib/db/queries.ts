import { eq, desc, and } from 'drizzle-orm'
import { db } from '.'
import { users, conversations, messages, toolResults } from './schema'

export type UpsertUserInput = {
  id: string
  email?: string | null
  name?: string | null
  image?: string | null
}

export async function upsertUser(u: UpsertUserInput) {
  await db
    .insert(users)
    .values({
      id: u.id,
      email: u.email ?? null,
      name: u.name ?? null,
      image: u.image ?? null,
    })
    .onConflictDoUpdate({
      target: users.id,
      set: {
        email: u.email ?? null,
        name: u.name ?? null,
        image: u.image ?? null,
      },
    })
}

export async function getUserTotals(userId: string) {
  const rows = await db.select().from(users).where(eq(users.id, userId)).limit(1)
  return rows[0] ?? null
}

export async function setUserBudget(userId: string, budgetUsd: number | null) {
  await db
    .update(users)
    .set({ budgetUsd: budgetUsd === null ? null : budgetUsd.toFixed(4) })
    .where(eq(users.id, userId))
}

export async function bumpUserTotals(userId: string, addCostUsd: number, addTokens: number) {
  const current = await getUserTotals(userId)
  const newCost = Number(current?.totalCostUsd ?? 0) + addCostUsd
  const newTokens = (current?.totalTokens ?? 0) + addTokens
  await db
    .update(users)
    .set({ totalCostUsd: newCost.toFixed(6), totalTokens: newTokens })
    .where(eq(users.id, userId))
  return { totalCostUsd: newCost, totalTokens: newTokens }
}

export async function listConversations(userId: string) {
  return db
    .select({
      id: conversations.id,
      title: conversations.title,
      totalTokens: conversations.totalTokens,
      continuedFromConversationId: conversations.continuedFromConversationId,
      updatedAt: conversations.updatedAt,
      createdAt: conversations.createdAt,
    })
    .from(conversations)
    .where(eq(conversations.userId, userId))
    .orderBy(desc(conversations.updatedAt))
}

export async function bumpConversationTokens(conversationId: string, addTokens: number) {
  const rows = await db
    .select({ totalTokens: conversations.totalTokens })
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .limit(1)
  const current = rows[0]?.totalTokens ?? 0
  const next = current + addTokens
  await db.update(conversations).set({ totalTokens: next }).where(eq(conversations.id, conversationId))
  return next
}

export async function createContinuedConversation(opts: {
  userId: string
  continuedFromConversationId: string
  title: string
  summary: string
  summaryInputTokens: number
  summaryOutputTokens: number
  summaryCostUsd: number
}) {
  const [row] = await db
    .insert(conversations)
    .values({
      userId: opts.userId,
      title: opts.title,
      continuedFromConversationId: opts.continuedFromConversationId,
      totalTokens: opts.summaryInputTokens + opts.summaryOutputTokens,
    })
    .returning({
      id: conversations.id,
      title: conversations.title,
      continuedFromConversationId: conversations.continuedFromConversationId,
    })

  await insertMessage({
    conversationId: row.id,
    role: 'assistant',
    content: [
      {
        type: 'context-continuity',
        text: opts.summary,
        continuedFromId: opts.continuedFromConversationId,
      },
    ] as unknown as object,
    inputTokens: opts.summaryInputTokens,
    outputTokens: opts.summaryOutputTokens,
    costUsd: opts.summaryCostUsd.toFixed(6),
  })

  return row
}

export async function createConversation(userId: string) {
  const [row] = await db
    .insert(conversations)
    .values({ userId })
    .returning({ id: conversations.id, title: conversations.title, createdAt: conversations.createdAt })
  return row
}

export async function getConversation(userId: string, conversationId: string) {
  const rows = await db
    .select()
    .from(conversations)
    .where(and(eq(conversations.id, conversationId), eq(conversations.userId, userId)))
    .limit(1)
  return rows[0] ?? null
}

export async function listMessages(conversationId: string) {
  return db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(messages.createdAt)
}

export async function insertMessage(row: typeof messages.$inferInsert) {
  const [r] = await db.insert(messages).values(row).returning()
  return r
}

export async function insertToolResult(row: typeof toolResults.$inferInsert) {
  const [r] = await db.insert(toolResults).values(row).returning()
  return r
}

export async function touchConversation(conversationId: string, title?: string | null) {
  await db
    .update(conversations)
    .set({ updatedAt: new Date(), ...(title ? { title } : {}) })
    .where(eq(conversations.id, conversationId))
}

export async function deleteConversation(userId: string, conversationId: string) {
  // Schema cascades to messages + tool_results.
  const result = await db
    .delete(conversations)
    .where(and(eq(conversations.id, conversationId), eq(conversations.userId, userId)))
    .returning({ id: conversations.id })
  return result[0] ?? null
}
