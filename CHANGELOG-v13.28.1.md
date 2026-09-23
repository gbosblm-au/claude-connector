# claude-connector v13.28.1

**Books tools require the per-call account.** Follows v13.28.0 (BOOKS-READ
AUTHORITY CUTOVER). No gateway change; Gateway v2.234.0 is still the pairing.

## Changed

- `src/tools/books.js`, `resolveBooksAccount`: `books_read` and
  `books_log_write` now take the account ONLY from the gateway's per-call
  context (`{ tenant_id, user_id }` on `POST /tool-call`). Both fields must be
  present and non-blank in the call itself.
- The connector session context is no longer a fallback. It is one
  process-global value, set by whichever account last ran
  `ts_gateway_session_init`, so on a connector serving more than one account a
  direct call could have been served as the wrong reader. A context carrying a
  user but no tenant is also refused, rather than taking `TS_TENANT_ID`.
- Direct MCP calls, which carry no per-call context, are refused with
  `account_unresolved` and a message telling the caller to start a gateway
  session and call the tools through the gateway.

## Unchanged

Tool names, input schemas and both response shapes. Calls through the gateway
behave exactly as in v13.28.0: `callConnectorTool` always sends both fields.

## Tests

`src/tests/books-cutover.test.js`: 14 to 17. The two new refusal tests fail
against v13.28.0 and pass here. A camelCase context is still accepted.
