# atlassian-mcp

A local MCP server and CLI that gives agents read-only, per-project access to Jira Cloud. See [README.md](README.md).

## What we can't compromise on

1. **Deny by default, checked on every call.** Policy is decided from the project ID Jira returns for the resource, never from model input such as an issue key prefix or JQL, and never from tool hiding or annotations. Search results are filtered after the query.
2. **The token never leaves the keychain except into the Authorization header.** Not in settings, arguments, logs, errors, tool results or fixtures. Errors that might carry upstream text go through `redact`.
3. **Only the human changes policy, through the CLI.** No MCP tool reads or writes settings.
4. **Read-only, and a wrapper.** Tools only read Jira, and they expose what Jira's APIs provide rather than reconstructing data Jira doesn't offer.
5. **Everything in the repo is public.** Synthetic test data only. No real sites, emails, tokens, transcripts, local paths or notes. Working material stays outside the checkout. `pnpm scan:secrets` catches the common mistakes, not all of them.

## Where code lives

- `src/config.ts`, `src/policy.ts`, `src/credentials.ts`: settings, the permission check, keychain and redaction. Product-neutral.
- `src/jira/`: Jira Cloud REST, response validation and the MCP tools. Deployment-specific code stays here.
- `src/cli.ts`, `src/setup.ts`, `src/prompt.ts`: the terminal experience. `src/server.ts`: the stdio server.
- `pnpm lint` keeps these apart: the product-neutral files import no Jira, terminal or server code; `src/jira/` never imports the terminal or the server entry; and `src/server.ts` never imports terminal code, since its stdout carries MCP messages.

## Code style

- `pnpm format` (oxfmt, `.oxfmtrc.json`) owns how the code looks, single quotes and import order included; don't format by hand. `pnpm lint` (oxlint, `.oxlintrc.json`) reports only errors: fix them, or disable one line with a reason (see Comments below).
- **Flat code** (lint errors). Every `if` and loop body has braces. Instead of a nested ternary, use early returns or a lookup object; instead of a fifth parameter, pass an object. No negated `if`/`else`, no reassigned parameters, no shadowed names, and separators in long numbers (`30_000`). TypeScript also rejects a function that returns a value on only some paths.
- **Size is for review, not lint: about 250 lines per file, 80 per function and 15 branches per function.** Split where it makes the code clearer, not to meet a number. A closure that holds one connection's state, such as `createJiraClient`, can be longer.
- **Blank lines split a function into steps.** Lint can't check this one. Leave one after a run of guard clauses, between the declarations a step needs and the logic that uses them, around multi-line `if`, `for`, `try` and `switch` blocks, before the final `return` of a longer function, and between the inner functions of a factory. Lines that belong together stay together.
- **Comments carry the why** the code can't say: a constraint, a trap, an external fact. A comment on a declaration (function, type, class, module-level constant) is `/** */`, so editors show it on hover; comments on statements, and on a group of declarations, are `//`. Suppressing a lint rule needs a reason on the line above: `// reason` then `// oxlint-disable-next-line rule-name`.

## Verifying

- `pnpm format`, then `pnpm check` before handing work back. `pnpm test:e2e` when touching the CLI, server, keychain or prompts. `pnpm check:pack` when touching the build or package contents.
- Tests use `test/fake-jira.ts` and a temporary `ATLASSIAN_MCP_CONFIG_DIR`. Never point tests at a real Jira site or real settings, and never post real Jira comments without the maintainer's explicit go-ahead.
- Library APIs change: check current docs for the MCP SDK (v2, `@modelcontextprotocol/server`) and Jira Cloud REST v3 rather than memory.

## Pull requests

- Never commit, push or open a PR unless the maintainer asks.
- Conventional commit titles in plain language, e.g. `fix(jira): search no longer returns issues from denied projects`.
