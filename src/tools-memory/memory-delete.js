// src/tools/memory-delete.js
// Tool handler for memory_delete (TDD Section 6.4).
// Hard delete by (category, key). Returns deleted=false rather than an error
// when the slot does not exist, per TDD contract.

import { getDb } from "./db.js";
import { memoryDeleteSchema } from "./schemas/index.js";
import { ToolError } from "./errors.js";

export async function handleMemoryDelete(rawArgs) {
  const parsed = memoryDeleteSchema.safeParse(rawArgs);
  if (!parsed.success) {
    throw new ToolError(
      "VALIDATION_ERROR",
      "Invalid input for memory_delete.",
      400,
      parsed.error.flatten(),
    );
  }
  const args = parsed.data;

  const db = getDb();
  const stmt = db.prepare("DELETE FROM memories WHERE category = ? AND key = ?");
  const info = stmt.run(args.category, args.key);

  return { success: true, deleted: info.changes > 0 };
}
