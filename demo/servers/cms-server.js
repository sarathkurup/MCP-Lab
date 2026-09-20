'use strict';
/**
 * Demo CMS server.
 *
 * Deliberately imperfect, so McpLab's doctor, linter and security scan have
 * something real to find:
 *   - deleteEvent is destructive but carries no destructiveHint   (MCP004 / SEC012)
 *   - updateEvent has an undocumented parameter and no output schema (MCP008 / MCP006)
 *   - getCmsConfig returns an apiKey                              (SEC011)
 *   - getEvents is slow                                           (latency)
 */

const { createDemoServer, runStdio, delay } = require('./lib');

const EVENTS = [
  { id: 'evt-1', title: 'Spring launch', enabled: true, startsAt: '2026-03-01T09:00:00Z' },
  { id: 'evt-2', title: 'Partner summit', enabled: false, startsAt: '2026-05-14T13:00:00Z' },
  { id: 'evt-3', title: 'Retro', enabled: true, startsAt: '2026-06-02T15:30:00Z' },
];

const server = createDemoServer({
  name: 'demo-cms-mcp',
  version: '2.4.1',
  instructions: 'Content management for the demo company. Events live here.',

  tools: [
    {
      name: 'getEvents',
      description: 'Lists events for an environment, newest first.',
      inputSchema: {
        type: 'object',
        properties: {
          environment: {
            type: 'string',
            enum: ['DEV', 'QC', 'PROD'],
            description: 'Which environment to read from',
          },
          enabledOnly: { type: 'boolean', description: 'Only return enabled events' },
        },
        required: ['environment'],
      },
      outputSchema: {
        type: 'object',
        properties: { events: { type: 'array' }, count: { type: 'integer' } },
        required: ['events', 'count'],
      },
      annotations: { readOnlyHint: true },
      handler: async (args) => {
        // Slow on purpose: gives the analytics view a p95 worth looking at.
        await delay(900);
        const events = args.enabledOnly ? EVENTS.filter((event) => event.enabled) : EVENTS;
        return {
          content: [{ type: 'text', text: `${events.length} event(s) in ${args.environment}` }],
          structuredContent: { events, count: events.length },
        };
      },
    },

    {
      name: 'updateEvent',
      description: 'Updates an existing event.',
      inputSchema: {
        type: 'object',
        properties: {
          eventId: { type: 'string', description: 'Identifier of the event to update' },
          title: { type: 'string', minLength: 3, description: 'New title' },
          enabled: { type: 'boolean', description: 'Whether the event is live' },
          startsAt: { type: 'string', format: 'date-time', description: 'ISO-8601 start time' },
          // No description: the linter should flag this (MCP008).
          revision: { type: 'integer' },
        },
        required: ['eventId'],
      },
      handler: (args) => {
        const event = EVENTS.find((entry) => entry.id === args.eventId);
        if (!event) {
          throw new Error(`No event "${args.eventId}"`);
        }
        Object.assign(event, {
          ...(args.title !== undefined ? { title: args.title } : {}),
          ...(args.enabled !== undefined ? { enabled: args.enabled } : {}),
          ...(args.startsAt !== undefined ? { startsAt: args.startsAt } : {}),
        });
        return {
          content: [{ type: 'text', text: `Updated ${event.id}` }],
          structuredContent: { event },
        };
      },
    },

    {
      name: 'deleteEvent',
      // No destructiveHint: the doctor and the security scan should both say so.
      description: 'Deletes an event.',
      inputSchema: {
        type: 'object',
        properties: { eventId: { type: 'string', description: 'Identifier of the event to delete' } },
        required: ['eventId'],
      },
      handler: (args) => {
        const index = EVENTS.findIndex((entry) => entry.id === args.eventId);
        if (index === -1) {
          throw new Error(`No event "${args.eventId}"`);
        }
        EVENTS.splice(index, 1);
        return { content: [{ type: 'text', text: `Deleted ${args.eventId}` }] };
      },
    },

    {
      name: 'getCmsConfig',
      description: 'Returns the CMS configuration for the current environment.',
      inputSchema: { type: 'object', properties: {} },
      outputSchema: {
        type: 'object',
        properties: {
          endpoint: { type: 'string' },
          // Returning a credential: SEC011 should flag this.
          apiKey: { type: 'string' },
        },
      },
      annotations: { readOnlyHint: true },
      handler: () => ({
        content: [{ type: 'text', text: 'CMS configuration' }],
        structuredContent: {
          endpoint: 'https://cms.demo.internal/api',
          apiKey: 'ghp_demoDEMOdemoDEMOdemoDEMOdemo123456',
        },
      }),
    },
  ],

  resources: [
    {
      uri: 'cms://templates',
      name: 'templates',
      description: 'Email templates available to events.',
      mimeType: 'application/json',
      read: () => JSON.stringify({ templates: ['welcome', 'reminder', 'thank-you'] }, null, 2),
    },
  ],

  prompts: [
    {
      name: 'summarize_event',
      description: 'Summarizes an event for a newsletter.',
      arguments: [{ name: 'eventId', description: 'Event identifier', required: true }],
      build: (args) => [
        {
          role: 'user',
          content: {
            type: 'text',
            text: `Write a two-sentence newsletter blurb for event ${args.eventId}.`,
          },
        },
      ],
    },
  ],
});

runStdio(server);
