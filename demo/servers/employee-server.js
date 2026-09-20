'use strict';
/**
 * Demo employee server. Its problems are about *data*, not structure:
 *   - getEmployee returns an SSN and a personal email      (SEC011)
 *   - authenticateUser takes a password as a tool argument (SEC010)
 *   - purgeEmployee is destructive, unannotated and takes
 *     no required parameters                               (SEC012 / SEC013)
 *   - the whole server has no tests                        (MCP007)
 */

const { createDemoServer, runStdio } = require('./lib');

const EMPLOYEES = {
  'emp-1': {
    id: 'emp-1',
    name: 'Dana Okafor',
    email: 'dana.okafor@demo.example',
    ssn: '123-45-6789',
    department: 'Platform',
    entitlementId: 'ent-900',
  },
  'emp-2': {
    id: 'emp-2',
    name: 'Rafi Haddad',
    email: 'rafi.haddad@demo.example',
    ssn: '987-65-4321',
    department: 'DevOps',
    entitlementId: 'ent-901',
  },
};

const ENTITLEMENTS = {
  'ent-900': { id: 'ent-900', plan: 'platform-admin', features: ['deploy', 'rollback', 'cms-write'] },
  'ent-901': { id: 'ent-901', plan: 'devops', features: ['deploy', 'rollback'] },
};

const server = createDemoServer({
  name: 'demo-employee-mcp',
  version: '0.9.3',
  instructions: 'Employee directory and entitlements for the demo company.',

  tools: [
    {
      name: 'getEmployee',
      description: 'Returns an employee record by id.',
      inputSchema: {
        type: 'object',
        properties: { employeeId: { type: 'string', description: 'Employee identifier' } },
        required: ['employeeId'],
      },
      outputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          email: { type: 'string' },
          // Returned verbatim: the security scan should object.
          ssn: { type: 'string' },
          entitlementId: { type: 'string' },
        },
      },
      annotations: { readOnlyHint: true },
      handler: (args) => {
        const employee = EMPLOYEES[args.employeeId];
        if (!employee) {
          throw new Error(`No employee "${args.employeeId}"`);
        }
        return {
          content: [{ type: 'text', text: `${employee.name} (${employee.department})` }],
          structuredContent: employee,
        };
      },
    },

    {
      name: 'getEntitlement',
      description: 'Returns the entitlement record for an entitlement id.',
      inputSchema: {
        type: 'object',
        properties: { entitlementId: { type: 'string', description: 'Entitlement identifier' } },
        required: ['entitlementId'],
      },
      outputSchema: {
        type: 'object',
        properties: { id: { type: 'string' }, plan: { type: 'string' }, features: { type: 'array' } },
      },
      annotations: { readOnlyHint: true },
      handler: (args) => {
        const entitlement = ENTITLEMENTS[args.entitlementId];
        if (!entitlement) {
          throw new Error(`No entitlement "${args.entitlementId}"`);
        }
        return {
          content: [{ type: 'text', text: `${entitlement.plan}: ${entitlement.features.join(', ')}` }],
          structuredContent: entitlement,
        };
      },
    },

    {
      name: 'authenticateUser',
      description: 'Signs an employee in.',
      inputSchema: {
        type: 'object',
        properties: {
          email: { type: 'string', description: 'Work email' },
          // A credential as a tool argument: it will be logged and traced.
          password: { type: 'string', description: 'Account password' },
        },
        required: ['email', 'password'],
      },
      handler: (args) => ({
        content: [{ type: 'text', text: `Signed in as ${args.email}` }],
        structuredContent: { sessionToken: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.demo.signature' },
      }),
    },

    {
      name: 'purgeEmployee',
      // No annotations, no required parameters: two findings in one tool.
      description: 'Removes employee records.',
      inputSchema: {
        type: 'object',
        properties: { employeeId: { type: 'string' }, olderThanDays: { type: 'integer' } },
      },
      handler: (args) => ({
        content: [
          {
            type: 'text',
            text: args.employeeId
              ? `Purged ${args.employeeId}`
              : `Purged every record older than ${args.olderThanDays ?? 0} days`,
          },
        ],
      }),
    },
  ],
});

runStdio(server);
