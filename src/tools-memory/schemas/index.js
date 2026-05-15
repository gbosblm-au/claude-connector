// src/schemas/index.js
// Zod schemas for all six MCP tool input contracts.
// Mirrors TDD Section 6 (MCP Tool Specification) field-for-field.

import { z } from "zod";

// Allowed category enum, per TDD Section 5.4.
export const CATEGORY_ENUM = [
  "projects",
  "skills",
  "preferences",
  "contacts",
  "facts",
  "session",
];

export const categorySchema = z.enum(CATEGORY_ENUM);

// Field-level limits, per TDD Section 5.5.
export const MAX_KEY_LENGTH = 256;
export const MAX_VALUE_LENGTH = 65536; // serialised JSON characters

// -----------------------------------------------------------------------
// 6.1 memory_write
// -----------------------------------------------------------------------
export const memoryWriteSchema = z
  .object({
    category: categorySchema,
    key: z.string().min(1).max(MAX_KEY_LENGTH),
    value: z.any(),
    tags: z.array(z.string()).default([]),
    ttl_days: z.number().nonnegative().optional().nullable(),
    confidence: z.number().min(0).max(1).default(1.0),
    source_session: z.string().max(256).optional().nullable(),
  })
  .strict();

// -----------------------------------------------------------------------
// 6.2 memory_read
// At least one of category, key, or tags must be present.
// -----------------------------------------------------------------------
export const memoryReadSchema = z
  .object({
    category: categorySchema.optional(),
    key: z.string().min(1).max(MAX_KEY_LENGTH).optional(),
    tags: z.array(z.string()).optional(),
    limit: z.number().int().min(1).max(200).default(50),
  })
  .strict()
  .refine(
    (data) =>
      data.category !== undefined ||
      data.key !== undefined ||
      (Array.isArray(data.tags) && data.tags.length > 0),
    {
      message:
        "At least one of category, key, or a non-empty tags array must be provided.",
      path: ["category"],
    },
  );

// -----------------------------------------------------------------------
// 6.3 memory_search
// -----------------------------------------------------------------------
export const memorySearchSchema = z
  .object({
    query: z.string().min(1).max(1024),
    category: categorySchema.optional(),
    limit: z.number().int().min(1).max(50).default(10),
  })
  .strict();

// -----------------------------------------------------------------------
// 6.4 memory_delete
// -----------------------------------------------------------------------
export const memoryDeleteSchema = z
  .object({
    category: categorySchema,
    key: z.string().min(1).max(MAX_KEY_LENGTH),
  })
  .strict();

// -----------------------------------------------------------------------
// 6.5 memory_list
// -----------------------------------------------------------------------
export const memoryListSchema = z
  .object({
    category: categorySchema.optional(),
    include_value: z.boolean().default(false),
  })
  .strict();

// -----------------------------------------------------------------------
// 6.6 memory_get_session_context
// Accepts no parameters in v1.0.
// -----------------------------------------------------------------------
export const memorySessionContextSchema = z.object({}).strict();
