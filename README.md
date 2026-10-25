# atlassian-mcp

A local [MCP](https://modelcontextprotocol.io) server that gives coding agents read-only access to Jira Cloud. You choose which projects an agent may read; everything else is denied. The API token stays in the OS keychain.

Status: proof of concept, not released. There is no npm package yet, so this README is for developers running it from a checkout. Jira Cloud only, tested on macOS. Confluence, Bitbucket and Data Center are planned.

## Tools

| Tool | Does |
| --- | --- |
| `jira_search_issues` | Search with JQL; returns a compact list per issue |
| `jira_get_issue` | Read an issue: details, description, parent, links, subtasks, latest comments, and any other fields you ask for |

Both only read. No tool writes to Jira or changes permissions.

`jira_get_issue` lists the issue's other fields whose values it can show in `otherFields`, by ID and name. Ask for their values with `fields`:

```json
{ "issue": "PROJ-1", "fields": ["customfield_10016", "components"] }
```

Values come back as readable text, numbers or lists. An empty, unknown or shortened value says so in its `note`; shortened lists say so in `linksNote`, `subtasksNote`, `commentsNote` and `otherFieldsNote`. A field in a format the server doesn't show, such as an object it has no readable label for, returns `[not shown: unsupported field format]`. Parent, linked and subtask issues appear by key and link only, whichever project they're in; their own details are read with `jira_get_issue`, which applies the same permissions.

## Permissions

Read access is granted per Jira project. The server checks every call against the project Jira reports for each issue, so issue key prefixes, crafted JQL and tool annotations can't widen access. Permission changes made with the CLI apply to running servers on their next call.

## Run it from a checkout

Needs Node.js 24 or later and pnpm (the version in `packageManager` in `package.json`).

```sh
git clone https://github.com/atatter/atlassian-mcp.git
cd atlassian-mcp
pnpm install
pnpm build
node dist/cli.js setup
```

Setup asks for your Jira site, account email and an [API token](https://id.atlassian.com/manage-profile/security/api-tokens) (typed hidden), checks the connection, lets you pick a project to allow, and shows a summary before saving. It ends by printing the commands that register the server with Claude Code, Codex or any MCP client. They run this checkout's `dist/cli.js` with the Node.js that ran setup, and the client starts the server when it needs it. After changing the code, run `pnpm build`; a client picks up the new build the next time it starts the server.

API tokens with scopes need `read:jira-user` and `read:jira-work`. Tokens without scopes work too, but they carry everything your account can do; a token with only these two scopes is limited to reading.

## Commands

Run them from the checkout after `pnpm build`:

```
node dist/cli.js setup           Connect to Jira Cloud and allow a first project
node dist/cli.js status          Show the setup and check the connection
node dist/cli.js allow <KEY>     Allow reading a project
node dist/cli.js deny <KEY>      Remove a project's access
node dist/cli.js token           Replace the stored API token
node dist/cli.js client-config   Print the MCP client configuration
node dist/cli.js reset           Delete the stored token and settings
node dist/cli.js serve           Run the MCP server over stdio (MCP clients start this)
```

Settings live in `~/.config/atlassian-mcp/config.json` (or `$XDG_CONFIG_HOME/atlassian-mcp`). They hold the site, email and allowed projects, never the token.

## What this does not protect against

The limits apply to what an agent can do through this server. Any program running as your user can still run the CLI, change the settings or read the keychain entry. Run untrusted agents in a sandbox that can't do those things. Jira issue text is written by other people, so treat it as untrusted input to your agent.

## Development

```sh
pnpm format      # formats the code (oxfmt)
pnpm check       # typecheck, lint, format check, unit tests, secret scan
pnpm test:e2e    # builds, then runs the CLI and stdio server against a fake Jira and the real OS keychain
pnpm check:pack  # builds, then checks the npm package holds only the built CLI and docs
```

The end-to-end test writes one keychain entry with synthetic credentials and deletes it when it finishes. Tests never contact a real Jira site.
