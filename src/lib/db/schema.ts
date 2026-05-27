import { pgTable, uuid, text, timestamp, jsonb, integer, numeric, boolean, index } from 'drizzle-orm/pg-core'
import { relations, sql } from 'drizzle-orm'

/**
 * Owner of a conversation. Stable id from the OAuth provider (GitHub `sub`),
 * stored as text to accommodate any future provider.
 */
export const users = pgTable('users', {
  id: text('id').primaryKey(),
  email: text('email'),
  name: text('name'),
  image: text('image'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  totalCostUsd: numeric('total_cost_usd', { precision: 10, scale: 6 }).default('0').notNull(),
  totalTokens: integer('total_tokens').default(0).notNull(),
  /** Per-user budget override in USD. Null = fall back to BUDGET_USD_PER_SESSION env. */
  budgetUsd: numeric('budget_usd', { precision: 10, scale: 4 }),
})

export const conversations = pgTable(
  'conversations',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    title: text('title'),
    /** Claude input+output tokens accumulated in this thread (for per-chat context cap). */
    totalTokens: integer('total_tokens').default(0).notNull(),
    /** When set, this chat was opened after the parent hit the context token limit. */
    continuedFromConversationId: uuid('continued_from_conversation_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('conversations_user_updated_idx').on(t.userId, t.updatedAt)],
)

export const messages = pgTable(
  'messages',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    role: text('role').notNull(),
    content: jsonb('content').notNull(),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    costUsd: numeric('cost_usd', { precision: 10, scale: 6 }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('messages_conversation_created_idx').on(t.conversationId, t.createdAt)],
)

export const toolResults = pgTable(
  'tool_results',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    messageId: uuid('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    toolName: text('tool_name').notNull(),
    toolCallId: text('tool_call_id').notNull(),
    input: jsonb('input').notNull(),
    output: jsonb('output'),
    error: jsonb('error'),
    latencyMs: integer('latency_ms'),
    costUsd: numeric('cost_usd', { precision: 10, scale: 6 }).default('0').notNull(),
    cacheHit: boolean('cache_hit').default(false).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('tool_results_message_idx').on(t.messageId)],
)

export const usersRelations = relations(users, ({ many }) => ({
  conversations: many(conversations),
}))

export const conversationsRelations = relations(conversations, ({ one, many }) => ({
  user: one(users, { fields: [conversations.userId], references: [users.id] }),
  messages: many(messages),
}))

export const messagesRelations = relations(messages, ({ one, many }) => ({
  conversation: one(conversations, { fields: [messages.conversationId], references: [conversations.id] }),
  toolResults: many(toolResults),
}))

export const toolResultsRelations = relations(toolResults, ({ one }) => ({
  message: one(messages, { fields: [toolResults.messageId], references: [messages.id] }),
}))
