'use strict';
/**
 * Demo deployment server. This is the well-behaved one: every tool is
 * described, annotated and typed, so a clean lint run looks like something.
 *
 * The one deliberate flaw is behavioural rather than structural: getHealth
 * fails intermittently, which is what makes the workflow and the analytics
 * view interesting.
 */

const { createDemoServer, runStdio, delay } = require('./lib');

const PIPELINES = {
  QC: { id: 'pipe-2210', status: 'success', finishedAt: '2026-09-19T21:14:00Z', commit: 'a1b2c3d' },
  DEV: { id: 'pipe-2211', status: 'running', startedAt: '2026-09-20T08:02:00Z', commit: 'd4e5f6a' },
  PROD: { id: 'pipe-2209', status: 'success', finishedAt: '2026-09-18T17:40:00Z', commit: '9f8e7d6' },
};

let healthCalls = 0;

const server = createDemoServer({
  name: 'demo-deployment-mcp',
  version: '1.8.0',
  instructions: 'Pipelines, deployments and health checks for the demo company.',

  tools: [
    {
      name: 'getPipelineStatus',
      description: 'Returns the most recent pipeline for an environment.',
      inputSchema: {
        type: 'object',
        properties: {
          environment: {
            type: 'string',
            enum: ['DEV', 'QC', 'PROD'],
            description: 'Environment whose pipeline to inspect',
          },
        },
        required: ['environment'],
      },
      outputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          status: { type: 'string' },
          commit: { type: 'string' },
        },
        required: ['id', 'status'],
      },
      annotations: { readOnlyHint: true },
      handler: (args) => {
        const pipeline = PIPELINES[args.environment];
        return {
          content: [{ type: 'text', text: `${pipeline.id} is ${pipeline.status}` }],
          structuredContent: pipeline,
        };
      },
    },

    {
      name: 'getDeploymentLogs',
      description: 'Returns the tail of the deployment log for a pipeline.',
      inputSchema: {
        type: 'object',
        properties: {
          pipelineId: { type: 'string', description: 'Pipeline identifier' },
          lines: { type: 'integer', minimum: 1, maximum: 500, description: 'How many lines to return' },
        },
        required: ['pipelineId'],
      },
      annotations: { readOnlyHint: true },
      handler: async (args) => {
        await delay(120);
        const lines = Math.min(args.lines ?? 5, 20);
        const body = Array.from(
          { length: lines },
          (_unused, index) => `[${index}] deploying ${args.pipelineId}…`,
        ).join('\n');
        return { content: [{ type: 'text', text: body }] };
      },
    },

    {
      name: 'getHealth',
      description: 'Checks whether the deployed application is responding.',
      inputSchema: {
        type: 'object',
        properties: {
          environment: { type: 'string', enum: ['DEV', 'QC', 'PROD'], description: 'Environment to check' },
        },
        required: ['environment'],
      },
      outputSchema: {
        type: 'object',
        properties: { healthy: { type: 'boolean' }, latencyMs: { type: 'integer' } },
        required: ['healthy'],
      },
      annotations: { readOnlyHint: true },
      handler: async (args) => {
        await delay(150);
        // Fails every third call, so the failure-rate column is not always zero.
        healthCalls++;
        const healthy = healthCalls % 3 !== 0;
        return {
          content: [
            { type: 'text', text: healthy ? `${args.environment} is healthy` : `${args.environment} is not responding` },
          ],
          structuredContent: { healthy, latencyMs: healthy ? 140 : 9000 },
          isError: !healthy,
        };
      },
    },

    {
      name: 'rollbackDeployment',
      description: 'Rolls an environment back to the previous successful deployment.',
      inputSchema: {
        type: 'object',
        properties: {
          environment: { type: 'string', enum: ['DEV', 'QC', 'PROD'], description: 'Environment to roll back' },
          reason: { type: 'string', description: 'Why the rollback is happening' },
        },
        required: ['environment', 'reason'],
      },
      annotations: { destructiveHint: true, idempotentHint: false },
      handler: (args) => ({
        content: [
          { type: 'text', text: `Rolled ${args.environment} back to the previous release (${args.reason})` },
        ],
      }),
    },
  ],

  resources: [
    {
      uri: 'deploy://runbook',
      name: 'runbook',
      description: 'What to do when a QC deployment fails.',
      mimeType: 'text/markdown',
      read: () =>
        [
          '# QC failure runbook',
          '',
          '1. `getPipelineStatus` for QC.',
          '2. If it failed, `getDeploymentLogs` for the pipeline id.',
          '3. If the app is down, `rollbackDeployment` with a reason.',
        ].join('\n'),
    },
  ],
});

runStdio(server);
