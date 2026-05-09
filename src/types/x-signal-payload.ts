import { z } from 'zod'

export const X_SIGNAL_COUNT_SCHEMA = z.object({
  total: z.number().finite().nonnegative(),
  by_user: z.record(z.number().finite().nonnegative()),
})

export const X_TWEET_SCHEMA = z.object({
  id: z.string().optional(),
  author: z.string().optional(),
  name: z.string().optional(),
  source_user: z.string().optional(),
  text: z.string().optional(),
  likes: z.number().finite().optional(),
  retweets: z.number().finite().optional(),
  views: z.number().finite().optional(),
  replies: z.number().finite().optional(),
  created_at: z.string().optional(),
  url: z.string().optional(),
}).passthrough()

export const X_SIGNAL_PAYLOAD_SCHEMA = z.object({
  generated_at: z.string().trim().min(1),
  counts: z.object({
    bookmarks: X_SIGNAL_COUNT_SCHEMA,
    likes: X_SIGNAL_COUNT_SCHEMA,
    following: X_SIGNAL_COUNT_SCHEMA,
    for_you: X_SIGNAL_COUNT_SCHEMA.optional(),
  }),
  ok: z.boolean().optional(),
  errors: z.record(z.unknown()).optional(),
  bookmarks: z.array(X_TWEET_SCHEMA).optional(),
  likes: z.array(X_TWEET_SCHEMA).optional(),
  following: z.array(X_TWEET_SCHEMA).optional(),
  for_you: z.array(X_TWEET_SCHEMA).optional(),
}).passthrough()

export type XTweet = z.infer<typeof X_TWEET_SCHEMA>
export type XSignalPayload = z.infer<typeof X_SIGNAL_PAYLOAD_SCHEMA>

export function sumXSignalCounts(counts: XSignalPayload['counts']) {
  return Object.values(counts).reduce<number>((sum, value) => sum + (value?.total ?? 0), 0)
}
