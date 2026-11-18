# atlassian-mcp

A local [MCP](https://modelcontextprotocol.io) server that gives coding agents access to Jira Cloud. You choose which projects an agent may read, create issues in, and update your own issues in. The API token stays in the OS keychain.

Status: unreleased proof of concept with read and write tools. There is no npm package yet, so this README is for developers running it from a checkout. Jira Cloud only, tested on macOS. Confluence, Bitbucket and Data Center are planned.

## Tools

| Tool | Does |
| --- | --- |
| `jira_search_issues` | Search with JQL and get a compact result per issue |
| `jira_get_issue` | Read issue details, including the creator's display name when available, description, parent, links, subtasks, latest comments, and any other fields you ask for |
| `jira_create_issue` | Create an issue in an allowed project |
| `jira_update_issue` | Update an issue you created in an allowed project |

Use `jira_create_issue` with a project key, issue type name, and summary. You can also supply a description, labels, a priority name, an assignee, and a parent issue key.

Use `jira_update_issue` with an issue key and any of summary, description, labels, priority name, assignee, status, or comment. Supplied fields replace their current values. Jira must offer a workflow transition to the requested status if the issue is in a different status. A comment is added as a new comment.

For either write tool, use `"me"` to assign the issue to the token owner, an Atlassian account ID to assign it to someone else, or `null` to unassign it.

Descriptions and comments accept Markdown. Jira renders paragraphs, headings, bullet and numbered lists with nesting, fenced code blocks, links using `http`, `https`, or `mailto`, bold, italic, and inline code. Unsupported syntax stays as literal text.

`jira_get_issue` lists the issue's other fields whose values it can show in `otherFields`, by ID and name. Ask for their values with `fields`:

```json
{ "issue": "PROJ-1", "fields": ["customfield_10016", "components"] }
```

Values come back as readable text, numbers or lists. An empty, unknown or shortened value says so in its `note`; shortened lists say so in `linksNote`, `subtasksNote`, `commentsNote` and `otherFieldsNote`. A field in a format the server doesn't show, such as an object it has no readable label for, returns `[not shown: unsupported field format]`. Parent, linked and subtask issues appear by key and link only, whichever project they're in; their own details are read with `jira_get_issue`, which applies the same permissions.

## Permissions

A single `allow <KEY>` grant lets the agent read and create issues in that project and update issues you created there. The server allows updates only when Jira's immutable creator field identifies the token owner. If Jira omits the creator, the server refuses the update.

A parent supplied on create must also belong to an allowed project. The server checks the project Jira reports, so issue key prefixes, crafted JQL, and tool annotations can't widen access. There are no delete tools, and the server sends no DELETE requests. Permission changes made with the CLI apply to running servers on their next call.

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

Setup lists the required scopes for a scoped API token. They are `read:jira-user`, `read:jira-work`, and `write:jira-work`. Tokens without scopes also work and carry everything your account can do.

## Commands

Run them from the checkout after `pnpm build`:

```
node dist/cli.js setup           Connect to Jira Cloud and allow a first project
node dist/cli.js status          Show the setup and check the connection
node dist/cli.js allow <KEY>     Allow reading, creating, and updating your own issues
node dist/cli.js deny <KEY>      Remove a project's access
node dist/cli.js token           Replace the stored API token
node dist/cli.js client-config   Print the MCP client configuration
node dist/cli.js reset           Delete the stored token and settings
node dist/cli.js serve           Run the MCP server over stdio (MCP clients start this)
```

`allow`, `status`, and `setup` show grants as "read, create, update own".

Settings live in `~/.config/atlassian-mcp/config.json` (or `$XDG_CONFIG_HOME/atlassian-mcp`). They hold the site, email and allowed projects, never the token.

## What this does not protect against

The limits apply to what an agent can do through this server. Any program running as your user can still run the CLI, change the settings or read the keychain entry. Run untrusted agents in a sandbox that can't do those things.

The server checks the issue's project before writing. If someone moves the issue to a denied project between the check and the write, the write can land there if the token has permission in that project. Jira offers no conditional write for this check.

Treat Jira issue text as untrusted input. An agent can write anything it reads into issues in allowed projects, including text from a prompt injection.

## Development

```sh
pnpm format      # formats the code (oxfmt)
pnpm check       # typecheck, lint, format check, unit tests, secret scan
pnpm test:e2e    # builds, then runs the CLI and stdio server against a fake Jira and the real OS keychain
pnpm check:pack  # builds, then checks the npm package holds only the built CLI and docs
```

The end-to-end test writes one keychain entry with synthetic credentials and deletes it when it finishes. Tests never contact a real Jira site.
