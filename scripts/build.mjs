// Builds the literally-aeo package (specs/aeo-open-source-cli-spec.md §4.1):
//
// - dist/cli.mjs and dist/author-tools.js: the command and the author's
//   research tool server, which Codex starts as a process of its own;
// - dist/lib/: every engine module as its own entry, for the hosted adapter
//   and other library users, with shared code split into chunks so one class
//   (an error a caller checks with instanceof) is one class across subpaths;
// - dist/types/: the declarations, from tsc;
// - resources/: the copy and author rules, the banlist, the neutral
//   editorial context and the operator guide, which enginePackageRoot finds
//   beside dist/.
//
// Runtime dependencies stay external: they install from npm at the versions
// package.json pins.

import { execFileSync } from 'node:child_process';
import { cp, readdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(
  await readFile(path.join(root, 'package.json'), 'utf8'),
);
const contracts = await readFile(
  path.join(root, 'src', 'bundle', 'contracts.ts'),
  'utf8',
);
const toolVersion = /export const toolVersion = '([^']+)'/.exec(contracts)?.[1];

// Every journal and bundle records toolVersion: it is the package version.
if (toolVersion !== manifest.version) {
  throw new Error(
    `package.json is ${manifest.version} but src/bundle/contracts.ts records toolVersion ${String(toolVersion)}; set both to the release version.`,
  );
}

const external = [
  ...Object.keys(manifest.dependencies ?? {}),
  ...Object.keys(manifest.peerDependencies ?? {}),
];
// Bundled CommonJS dependencies call require(); ESM output has none.
const requireShim =
  'import { createRequire as __createRequire } from "node:module";\nconst require = __createRequire(import.meta.url);';
const shared = {
  absWorkingDir: root,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  external,
  logLevel: 'warning',
};

// The two executables have top-level effects (the CLI runs main, the tool
// server starts listening), so they ship as bundles, never as library entries
// a consumer could import by accident.
const executables = new Set([
  'src/cli/literally-aeo.ts',
  'src/codex-workflow/author-tools-server.ts',
]);

const sourceFiles = async (dir) => {
  const found = [];

  for (const entry of await readdir(path.join(root, dir), {
    withFileTypes: true,
  })) {
    const relative = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      if (entry.name !== '__fixtures__') {
        found.push(...(await sourceFiles(relative)));
      }
    } else if (
      relative.endsWith('.ts') &&
      !relative.endsWith('.spec.ts') &&
      !/-fixtures?\.ts$/.test(relative) &&
      !executables.has(relative)
    ) {
      found.push(relative);
    }
  }

  return found;
};

await rm(path.join(root, 'dist'), { recursive: true, force: true });
await rm(path.join(root, 'resources'), { recursive: true, force: true });

await build({
  ...shared,
  entryPoints: ['src/cli/literally-aeo.ts'],
  outfile: 'dist/cli.mjs',
  banner: { js: `#!/usr/bin/env node\n${requireShim}` },
});
await build({
  ...shared,
  entryPoints: ['src/codex-workflow/author-tools-server.ts'],
  outfile: 'dist/author-tools.js',
  banner: { js: requireShim },
});
await build({
  ...shared,
  entryPoints: await sourceFiles('src'),
  outdir: 'dist/lib',
  outbase: 'src',
  splitting: true,
  chunkNames: 'chunks/[name]-[hash]',
  // No require() shim: every dependency stays external, so the library holds
  // only engine code, and a CommonJS consumer (the hosted Lambdas bundle it)
  // has no import.meta to give one.
});

execFileSync(
  path.join(root, 'node_modules', '.bin', 'tsc'),
  ['-p', 'tsconfig.build.json'],
  { cwd: root, stdio: 'inherit' },
);

for (const file of ['COPY_RULES.md', 'RULES.md', 'banlist.json']) {
  await cp(
    path.join(root, 'src', 'author', file),
    path.join(root, 'resources', 'author', file),
  );
}

await cp(
  path.join(root, 'src', 'engine', 'editorial'),
  path.join(root, 'resources', 'editorial'),
  { recursive: true },
);
await cp(
  path.join(root, 'src', 'engine', 'guide', 'OPERATOR.md'),
  path.join(root, 'resources', 'guide', 'OPERATOR.md'),
);

process.stdout.write(`Built ${manifest.name} ${manifest.version}\n`);
