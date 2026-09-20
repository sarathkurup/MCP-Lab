import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

/**
 * Cross-checks package.json against the source.
 *
 * The extension host layer has no runtime tests, so a mistyped command id or a
 * setting that is read but never declared would only show up as a dead button
 * in the UI. These checks are cheap and catch exactly that class of mistake -
 * which is what makes a rename across ~130 identifiers safe.
 */

interface Manifest {
  name: string;
  displayName: string;
  description: string;
  publisher: string;
  icon?: string;
  keywords?: string[];
  contributes: {
    commands: Array<{ command: string; title: string; category?: string }>;
    menus: Record<string, Array<{ command?: string; when?: string }>>;
    views: Record<string, Array<{ id: string; icon?: string }>>;
    viewsContainers: { activitybar: Array<{ id: string; title: string; icon: string }> };
    viewsWelcome: Array<{ view: string; contents: string }>;
    chatParticipants?: Array<{ id: string; name: string }>;
    configuration: { title: string; properties: Record<string, unknown> };
  };
}

const ROOT = path.resolve('.');
const manifest = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as Manifest;

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      sourceFiles(full, acc);
    } else if (entry.name.endsWith('.ts')) {
      acc.push(full);
    }
  }
  return acc;
}

const SOURCES = sourceFiles(path.join(ROOT, 'src')).map((file) => ({
  file: path.relative(ROOT, file),
  text: readFileSync(file, 'utf8'),
}));

const ALL_SOURCE = SOURCES.map((entry) => entry.text).join('\n');

function matchAll(pattern: RegExp, text: string): string[] {
  return [...text.matchAll(pattern)].map((match) => match[1]);
}

// ---------------------------------------------------------------------------

describe('identity', () => {
  it('is named MCP Lab and says what it is', () => {
    assert.equal(manifest.name, 'mcplab');
    assert.match(manifest.displayName, /^MCP Lab/);
    // The tagline has to carry the search terms, because displayName is what
    // people read in the extensions list.
    assert.match(manifest.displayName, /MCP Inspector/i);
    assert.match(manifest.description, /MCP Inspector/i);
    assert.match(manifest.description, /Model Context Protocol/i);
  });

  it('is findable by the terms people actually type', () => {
    const keywords = (manifest.keywords ?? []).map((keyword) => keyword.toLowerCase());
    for (const expected of ['mcp', 'mcp inspector', 'model context protocol', 'testing']) {
      assert.ok(keywords.includes(expected), `missing keyword: ${expected}`);
    }
  });

  it('has no trace of the old name anywhere', () => {
    const stale = SOURCES.filter((entry) => /mcpWorkbench|MCP Workbench|mcp-workbench/.test(entry.text));
    assert.deepEqual(stale.map((entry) => entry.file), [], 'sources still mention the old name');

    const manifestText = readFileSync(path.join(ROOT, 'package.json'), 'utf8');
    assert.doesNotMatch(manifestText, /mcpWorkbench|MCP Workbench|mcp-workbench/);
  });

  it('never puts the old product name in front of a user', () => {
    // The internal class is still called Workbench, and its comments still say
    // so. What matters is that no command title, setting description or UI
    // string shows a user a name the extension no longer goes by.
    assert.doesNotMatch(JSON.stringify(manifest.contributes), /Workbench/);

    const offenders = SOURCES.flatMap((entry) =>
      entry.text
        .split('\n')
        .map((line, index) => ({ line, at: `${entry.file}:${index + 1}` }))
        // Quoted text only: comments are for developers, and import paths
        // legitimately point at Workbench.ts.
        .filter(({ line }) => !/^\s*(\/\/|\/?\*)/.test(line))
        .filter(({ line }) => !/\bfrom\s+'/.test(line))
        .filter(({ line }) => /(['`])[^'`]*\bWorkbench\b[^'`]*\1/.test(line))
        .map(({ at }) => at),
    );
    assert.deepEqual(offenders, [], 'UI strings still say Workbench');
  });
});

describe('commands', () => {
  const declared = new Set(manifest.contributes.commands.map((command) => command.command));
  // Handlers go through a local `register(id, fn)` wrapper that gives each one
  // the same error boundary, so the literal id sits there rather than at the
  // vscode.commands.registerCommand call it delegates to.
  const registered = new Set([
    ...matchAll(/registerCommand\(\s*'([^']+)'/g, ALL_SOURCE),
    ...matchAll(/(?<![.\w])register\(\s*'([^']+)'/g, ALL_SOURCE),
  ]);

  it('finds the registrations at all', () => {
    // Without this, a change to how commands get registered would empty the set
    // and quietly turn the two checks below into no-ops.
    assert.ok(registered.size > 0, 'no command registrations found; the pattern may have changed');
  });

  it('registers every command it declares', () => {
    const missing = [...declared].filter((command) => !registered.has(command));
    assert.deepEqual(missing, [], 'declared in package.json but never registered');
  });

  it('declares every command it registers', () => {
    const undeclared = [...registered].filter((command) => !declared.has(command));
    assert.deepEqual(undeclared, [], 'registered in code but missing from package.json');
  });

  it('only executes commands that exist', () => {
    // Commands MCP Lab invokes on itself must resolve; VS Code's own are fine.
    const executed = matchAll(/executeCommand\(\s*'([^']+)'/g, ALL_SOURCE).filter((command) =>
      command.startsWith('mcplab.'),
    );
    const missing = executed.filter((command) => !declared.has(command));
    assert.deepEqual(missing, [], 'executeCommand targets that are not declared');
  });

  it('only offers fix commands that exist', () => {
    // The doctor offers a one-click remedy per check; a stale id is a dead button.
    const fixes = matchAll(/fixCommand:\s*'([^']+)'/g, ALL_SOURCE);
    const missing = fixes.filter((command) => !declared.has(command));
    assert.deepEqual(missing, [], 'doctor fixCommand ids that are not declared');
  });

  it('references only real commands from menus and the welcome view', () => {
    const fromMenus = Object.values(manifest.contributes.menus)
      .flat()
      .map((entry) => entry.command)
      .filter((command): command is string => !!command);

    const fromWelcome = manifest.contributes.viewsWelcome.flatMap((entry) =>
      matchAll(/command:([\w.]+)/g, entry.contents),
    );

    for (const command of [...fromMenus, ...fromWelcome]) {
      assert.ok(declared.has(command), `menu or welcome references unknown command: ${command}`);
    }
  });

  it('namespaces every command under mcplab', () => {
    for (const command of declared) {
      assert.match(command, /^mcplab\./, `${command} is not namespaced`);
    }
  });
});

describe('views', () => {
  it('wires the activity bar container to its views', () => {
    const container = manifest.contributes.viewsContainers.activitybar[0];
    assert.equal(container.id, 'mcplab');
    assert.equal(container.title, 'MCP Lab');
    assert.ok(manifest.contributes.views[container.id], 'no views for the container');
  });

  it('creates exactly the tree views it declares', () => {
    const declared = Object.values(manifest.contributes.views)
      .flat()
      .map((view) => view.id);
    const created = matchAll(/createTreeView\(\s*'([^']+)'/g, ALL_SOURCE);
    assert.deepEqual(created.sort(), declared.sort());
  });

  it('points menu when-clauses at a view that exists', () => {
    const declared = new Set(
      Object.values(manifest.contributes.views)
        .flat()
        .map((view) => view.id),
    );
    for (const entry of Object.values(manifest.contributes.menus).flat()) {
      for (const view of matchAll(/view == ([\w.]+)/g, entry.when ?? '')) {
        assert.ok(declared.has(view), `when-clause references unknown view: ${view}`);
      }
    }
  });

  it('welcomes into a view that exists', () => {
    const declared = new Set(
      Object.values(manifest.contributes.views)
        .flat()
        .map((view) => view.id),
    );
    for (const welcome of manifest.contributes.viewsWelcome) {
      assert.ok(declared.has(welcome.view), `viewsWelcome targets unknown view: ${welcome.view}`);
    }
  });
});

describe('configuration', () => {
  const declared = new Set(Object.keys(manifest.contributes.configuration.properties));

  it('declares every setting the code reads', () => {
    // Only files that actually read configuration, so a Map.get() cannot be
    // mistaken for a settings read.
    const readers = SOURCES.filter((entry) => entry.text.includes('getConfiguration('));
    const read = readers.flatMap((entry) => matchAll(/\.get<[^>]+>\(\s*'([^']+)'/g, entry.text));

    assert.ok(read.length > 0, 'no configuration reads were found; the pattern may have changed');
    for (const key of read) {
      assert.ok(
        declared.has(`mcplab.${key}`),
        `code reads mcplab.${key}, which package.json does not declare`,
      );
    }
  });

  it('namespaces every setting under mcplab', () => {
    for (const key of declared) {
      assert.match(key, /^mcplab\./, `${key} is not namespaced`);
    }
  });

  it('reads configuration from the mcplab section only', () => {
    const sections = matchAll(/getConfiguration\(\s*'([^']+)'/g, ALL_SOURCE);
    for (const section of sections) {
      assert.equal(section, 'mcplab');
    }
  });
});

describe('assets', () => {
  it('ships the files the manifest points at', () => {
    const referenced = [
      manifest.icon,
      manifest.contributes.viewsContainers.activitybar[0].icon,
      ...Object.values(manifest.contributes.views).flat().map((view) => view.icon),
    ].filter((asset): asset is string => !!asset);

    for (const asset of referenced) {
      assert.doesNotThrow(
        () => readFileSync(path.join(ROOT, asset)),
        `manifest references a missing asset: ${asset}`,
      );
    }
  });

  it('keeps the marketplace icon within a sane size', () => {
    const icon = readFileSync(path.join(ROOT, manifest.icon!));
    // PNG IHDR: width and height are big-endian uint32 at offsets 16 and 20.
    assert.equal(icon.readUInt32BE(16), 128, 'icon should be 128x128');
    assert.equal(icon.readUInt32BE(20), 128, 'icon should be 128x128');
    assert.ok(icon.length < 200 * 1024, `icon is ${Math.round(icon.length / 1024)}KB`);
  });

  it('excludes the source artwork from the package', () => {
    const ignore = readFileSync(path.join(ROOT, '.vscodeignore'), 'utf8');
    assert.match(ignore, /^logo\*\.png$/m, 'the 4MB source logos must not ship');
  });
});
