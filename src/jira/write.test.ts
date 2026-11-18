import { describe, expect, it } from 'vitest';
import { DEMO_GRANT, setup } from '../../test/harness.ts';
import { JiraError } from './client.ts';
import { CreateIssueInput, createIssue, UpdateIssueInput, updateIssue } from './write.ts';

const create = (args: Record<string, unknown>) =>
  CreateIssueInput.parse({ project: 'DEMO', issueType: 'Task', summary: 'New', ...args });

describe('createIssue', () => {
  it('creates in an allowed project with the IDs Jira resolved', async () => {
    const { jira, context } = setup([DEMO_GRANT]);
    const result = await createIssue(
      context,
      create({
        project: 'demo',
        issueType: 'bug',
        description: 'Some **text**',
        labels: ['agent'],
        priority: 'High',
        assignee: 'me',
        parent: 'DEMO-1',
      }),
    );

    expect(result).toEqual({ key: 'DEMO-100', url: 'https://example.invalid/browse/DEMO-100' });
    expect(jira.writes).toEqual([
      {
        request: 'POST /rest/api/3/issue',
        body: {
          fields: {
            project: { id: '10000' },
            issuetype: { id: '10002' },
            parent: { id: '20001' },
            summary: 'New',
            description: {
              type: 'doc',
              version: 1,
              content: [
                {
                  type: 'paragraph',
                  content: [
                    { type: 'text', text: 'Some ' },
                    { type: 'text', text: 'text', marks: [{ type: 'strong' }] },
                  ],
                },
              ],
            },
            labels: ['agent'],
            priority: { name: 'High' },
            assignee: { accountId: 'synthetic' },
          },
        },
      },
    ]);
  });

  it('denies other and missing projects alike, without writing', async () => {
    const { jira, context } = setup([DEMO_GRANT]);
    const message = 'is not one this server may use. Allowed: DEMO.';
    await expect(createIssue(context, create({ project: 'SECRET' }))).rejects.toThrow(message);
    await expect(createIssue(context, create({ project: 'NOPE' }))).rejects.toThrow(message);
    expect(jira.writes).toEqual([]);
  });

  it('denies a parent outside the allowed projects, including keys that look allowed', async () => {
    const { jira, context } = setup([DEMO_GRANT]);
    for (const parent of ['SECRET-1', 'DEMO-2']) {
      await expect(createIssue(context, create({ parent }))).rejects.toThrow(
        /not found in a project/,
      );
    }
    expect(jira.writes).toEqual([]);
  });

  it('names the available issue types when the one asked for is unknown', async () => {
    const { jira, context } = setup([DEMO_GRANT]);
    await expect(createIssue(context, create({ issueType: 'Epic' }))).rejects.toThrow(
      'DEMO has no issue type "Epic". Available: Task, Bug.',
    );
    expect(jira.writes).toEqual([]);
  });

  it('denies everything when no project is allowed, without calling Jira', async () => {
    const { jira, context } = setup([]);
    await expect(createIssue(context, create({}))).rejects.toThrow(/No Jira projects/);
    expect(jira.requests).toEqual([]);
  });
});

describe('updateIssue', () => {
  it('edits fields, moves the status and comments, in that order', async () => {
    const { jira, context } = setup([DEMO_GRANT]);
    const result = await updateIssue(
      context,
      UpdateIssueInput.parse({
        issue: 'demo-1',
        summary: 'Renamed',
        status: 'done',
        comment: 'Hi',
      }),
    );

    expect(result).toEqual({
      key: 'DEMO-1',
      url: 'https://example.invalid/browse/DEMO-1',
      changed: ['summary', 'status', 'comment'],
    });
    expect(jira.writes).toEqual([
      { request: 'PUT /rest/api/3/issue/20001', body: { fields: { summary: 'Renamed' } } },
      { request: 'POST /rest/api/3/issue/20001/transitions', body: { transition: { id: '31' } } },
      {
        request: 'POST /rest/api/3/issue/20001/comment',
        body: {
          body: {
            type: 'doc',
            version: 1,
            content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hi' }] }],
          },
        },
      },
    ]);
  });

  it('refuses issues created by someone else', async () => {
    const { jira, context } = setup([DEMO_GRANT]);
    await expect(
      updateIssue(context, UpdateIssueInput.parse({ issue: 'DEMO-7', comment: 'Hi' })),
    ).rejects.toThrow("DEMO-7 can't be changed: someone else created it.");
    expect(jira.writes).toEqual([]);
  });

  it('fails closed when Jira gives no creator', async () => {
    const { jira, context } = setup([DEMO_GRANT]);
    await expect(
      updateIssue(context, UpdateIssueInput.parse({ issue: 'DEMO-9', summary: 'x' })),
    ).rejects.toThrow("DEMO-9 can't be changed: Jira didn't say who created it.");
    expect(jira.writes).toEqual([]);
  });

  it('denies issues in other projects, including keys that look allowed', async () => {
    const { jira, context } = setup([DEMO_GRANT]);
    for (const issue of ['SECRET-1', 'DEMO-2']) {
      await expect(
        updateIssue(context, UpdateIssueInput.parse({ issue, summary: 'x' })),
      ).rejects.toThrow(/not found in a project/);
    }
    expect(jira.writes).toEqual([]);
  });

  it('names the reachable statuses and writes nothing when a move is impossible', async () => {
    const { jira, context } = setup([DEMO_GRANT]);
    // "Finish" names a transition, not a status, so it is not a destination either.
    for (const status of ['Gone', 'Finish']) {
      await expect(
        updateIssue(context, UpdateIssueInput.parse({ issue: 'DEMO-1', labels: [], status })),
      ).rejects.toThrow(`DEMO-1 can't move to "${status}". Available: In Progress, Done.`);
    }
    expect(jira.writes).toEqual([]);
  });

  it('names what was already applied when a later write fails', async () => {
    const { jira, context } = setup([DEMO_GRANT]);
    const client = {
      ...context.client,
      addComment: () => Promise.reject(new JiraError(400, 'Comment rejected.')),
    };
    await expect(
      updateIssue(
        { ...context, client },
        UpdateIssueInput.parse({ issue: 'DEMO-1', summary: 'x', comment: 'Hi' }),
      ),
    ).rejects.toThrow('Comment rejected. Already applied: summary.');
    expect(jira.writes.map((write) => write.request)).toEqual(['PUT /rest/api/3/issue/20001']);
  });

  it('unassigns with null and skips a move to the current status', async () => {
    const { jira, context } = setup([DEMO_GRANT]);
    const result = await updateIssue(
      context,
      UpdateIssueInput.parse({ issue: 'DEMO-1', assignee: null, status: 'To Do' }),
    );
    expect(result.changed).toEqual(['assignee']);
    expect(jira.writes).toEqual([
      { request: 'PUT /rest/api/3/issue/20001', body: { fields: { assignee: null } } },
    ]);
  });

  it('reports a failed first write as it is, and denies everything with no projects', async () => {
    const { jira, context } = setup([DEMO_GRANT]);
    const client = {
      ...context.client,
      editIssue: () => Promise.reject(new JiraError(400, 'Edit rejected.')),
    };
    const input = UpdateIssueInput.parse({ issue: 'DEMO-1', summary: 'x', comment: 'Hi' });
    await expect(updateIssue({ ...context, client }, input)).rejects.toThrow(/^Edit rejected\.$/);
    await expect(
      updateIssue({ ...context, config: { ...context.config, projects: [] } }, input),
    ).rejects.toThrow(/No Jira projects/);
    expect(jira.writes).toEqual([]);
  });

  it('refuses a call with nothing to change, without calling Jira', async () => {
    const { jira, context } = setup([DEMO_GRANT]);
    await expect(updateIssue(context, UpdateIssueInput.parse({ issue: 'DEMO-1' }))).rejects.toThrow(
      /Nothing to change/,
    );
    expect(jira.requests).toEqual([]);
  });
});
