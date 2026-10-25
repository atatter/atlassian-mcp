# atlassian-mcp

A local MCP server and CLI that gives agents read-only, per-project access to Jira Cloud. [README.md](README.md) is the user guide.

## A note from Aleks

I like ambitious ideas, simple systems and software that feels obvious. Don't keep complexity just because it exists, and don't add machinery because it looks impressive. Understand the real constraint, then build the smallest model that makes the correct behaviour unsurprising. Channel "measure twice, cut once" and YAGNI, and fight scope creep.

The rules in the next section are hard rules. Everything after them is a good default the maintainer can override. If a rule fights the task in front of you, say so and get the maintainer's sign-off before breaking it.

## What we can't compromise on

Security is the product here, so these are never traded for a shorter diff.

1. **Deny by default, checked on every call.** Policy is decided from the project ID Jira returns for the resource, never from model input such as an issue key prefix or JQL, and never from tool hiding or annotations. Search results are filtered after the query.
2. **The token never leaves the keychain except into the Authorization header.** Not in settings, arguments, logs, errors, tool results or fixtures. Errors that might carry upstream text go through `redact`.
3. **Only the human changes policy, through the CLI.** No MCP tool reads or writes settings.
4. **Read-only, and a wrapper.** The tools are `jira_search_issues` and `jira_get_issue`. They only read Jira, and they expose what Jira's APIs provide rather than reconstructing data Jira doesn't offer. Write tools or new kinds of data are a scope change for the maintainer to approve first.
5. **Everything in the repo is public.** Synthetic test data only. No real sites, emails, tokens, transcripts, local paths or notes. `pnpm scan:secrets` catches the common mistakes, not all of them.

## Where code lives

- `src/config.ts`, `src/policy.ts`, `src/credentials.ts`: settings, the permission check, keychain and redaction. Product-neutral.
- `src/jira/`: Jira Cloud REST and response validation (`client.ts`), the tools (`tools.ts`, `fields.ts`, `adf.ts`) and their MCP registration (`register.ts`).
- `src/cli.ts`, `src/setup.ts`, `src/prompt.ts`: the terminal experience. `src/server.ts`: the stdio server.
- `pnpm lint` keeps these apart: the product-neutral files import no Jira, terminal or server code; `src/jira/` never imports the terminal or the server entry; and `src/server.ts` never imports terminal code, since its stdout carries MCP messages.
- Complexity belongs at the boundary. Jira responses are checked with zod in `client.ts`, so the tools work with typed data and never re-check its shape.

## Changing a tool

- Load the resource, then call `allows` with the project ID Jira returned before anything reaches the output, as `fetchAllowedIssue` in `src/jira/tools.ts` does. A missing issue and a denied one answer the same way.
- Keep `readOnlyHint: true` in `register.ts`. Output passes through redaction there; redact before truncating, since a cut can hide a token.
- Test with `test/fake-jira.ts`, including an issue in the denied project. `test/e2e.test.ts` asserts that Jira only receives GETs and `POST /rest/api/3/search/jql`, so a new endpoint has to be added there on purpose.

## Code style

- `pnpm format` (oxfmt, `.oxfmtrc.json`) owns how the code looks, single quotes and import order included; don't format by hand. `pnpm lint` (oxlint, `.oxlintrc.json`) runs every rule as an error. A new rule is an error or it stays out; no warnings. Fix the error, or disable one line with a reason (see Comments). Both tools are pinned to exact versions in `package.json`.
- **Flat code** (lint errors). Every `if` and loop body has braces. Instead of a nested ternary, use early returns or a lookup object; instead of a fifth parameter, pass an object. No negated `if`/`else`, no reassigned parameters, no shadowed names, and separators in long numbers (`30_000`). TypeScript also rejects a function that returns a value on only some paths.
- **Types are inferred, strict and erasable.** `any` is the enemy; derive types from zod schemas with `z.infer`. `tsconfig.json` has `erasableSyntaxOnly`, so no enums, namespaces or parameter properties. Relative imports end in `.ts`.
- **Size is for review, not lint: about 250 lines per file, 80 per function and 15 branches per function.** Split where it makes the code clearer, not to meet a number. A closure that holds one connection's state, such as `createJiraClient`, can be longer.
- **Blank lines split a function into steps.** Lint can't check this one. Leave one after a run of guard clauses, between the declarations a step needs and the logic that uses them, around multi-line `if`, `for`, `try` and `switch` blocks, before the final `return` of a longer function, and between the inner functions of a factory. Lines that belong together stay together.

## Comments and docs

- A comment carries the why the code can't say: a constraint, a trap, an external fact about Jira or MCP. If the name and types already say it, leave it out. Comments move and change with the code.
- A comment on a declaration (function, type, class, module-level constant) is `/** */`, so editors show it on hover; comments on statements, and on a group of declarations, are `//`. Suppressing a lint rule needs a reason on the line above: `// reason` then `// oxlint-disable-next-line rule-name`.
- Reference only what a reader can open: paths in this repo and public docs. No ticket keys, private links or history ("used to", "previously").
- `README.md` is for users: tools, permissions, setup, commands and limits. Update it when any of those change; don't describe internals there. This file holds only what a maintainer would get wrong without it.

## Verifying

- `pnpm format`, then `pnpm check` (typecheck, lint, format check, unit tests, secret scan) before handing work back. `pnpm test:e2e` when touching the CLI, server, keychain or prompts. `pnpm check:pack` when touching the build or package contents.
- Unit tests use `test/fake-jira.ts` and a temporary `ATLASSIAN_MCP_CONFIG_DIR`. The e2e test also writes one synthetic entry to the real OS keychain and deletes it afterwards. Never point tests at a real Jira site, real settings or the maintainer's keychain entry.
- Library APIs change: check current docs for the MCP SDK (v2, `@modelcontextprotocol/server`) and Jira Cloud REST v3 rather than memory.
- Before calling it done, reread the diff as a reviewer who didn't write it.

## Work artifacts and pull requests

- Plans, research notes and review reports stay outside the checkout. The code, tests and commit history are the record.
- Never commit, push or open a PR unless the maintainer asks. Stage files by name and read the staged diff before committing.
- Conventional commit titles in plain language, e.g. `fix(jira): search no longer returns issues from denied projects`.
