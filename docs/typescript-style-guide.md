# TypeScript Style Guide

This guide sets how TypeScript is written, formatted and organized. It aims
for code that is easy to read, hard to get wrong, and cheap to change.

Rules are written as **Do** and **Don't**, and each gives its reason. When two
rules conflict, pick the option that makes the code easier to read and safer
to change, and say why in the pull request.

**Contents**

1. [Principles](#1-principles)
2. [Tooling](#2-tooling)
3. [Vertical rhythm](#3-vertical-rhythm)
4. [Naming](#4-naming)
5. [Modules](#5-modules)
6. [Functions](#6-functions)
7. [Types](#7-types)
8. [Data and control flow](#8-data-and-control-flow)
9. [Errors](#9-errors)
10. [Logging](#10-logging)
11. [Configuration and secrets](#11-configuration-and-secrets)
12. [Comments and documentation](#12-comments-and-documentation)
13. [Project layout](#13-project-layout)
14. [Tests](#14-tests)
15. [Shell scripts](#15-shell-scripts)
16. [Appendix A: serverless handlers](#appendix-a-serverless-handlers)
17. [Appendix B: infrastructure as code (Pulumi)](#appendix-b-infrastructure-as-code-pulumi)
18. [Appendix C: review checklist](#appendix-c-review-checklist)

---

## 1. Principles

- **Plain code.** Write the obvious version. Add abstraction only when the
  code clearly needs it.
- **Fail fast, at the edge.** Validate input where it enters the program,
  and trust it from then on.
- **Let the compiler help.** Choose the construct TypeScript can check. Casts,
  `any` and non-null assertions turn that checking off.
- **No hidden effects.** A function does what its name says and does not
  change what it was given.
- **Tools enforce the rules.** Anything a formatter, linter or compiler can
  check is configured to check it. This guide covers what tools can't.

---

## 2. Tooling

### Formatter

Prettier decides formatting. Nobody formats by hand, and the linter does not
check formatting.

```json
{
  "printWidth": 80,
  "tabWidth": 2,
  "semi": true,
  "singleQuote": true,
  "quoteProps": "consistent",
  "trailingComma": "all",
  "arrowParens": "always",
  "endOfLine": "lf"
}
```

- Use one `.editorconfig`: UTF-8, LF, 2-space indent, final newline, trim
  trailing whitespace (except in Markdown).
- Formatting-only commits go into `.git-blame-ignore-revs`.

### Compiler

Write ES modules everywhere (`"type": "module"` in `package.json`) and target
ES2022 or newer.

```jsonc
{
  "compilerOptions": {
    "target": "es2022",
    "lib": ["es2023"],

    // Bundled code (esbuild, Vite, Next.js):
    "module": "preserve",
    "moduleResolution": "bundler",
    "noEmit": true,
    // Code run by Node without a bundler: "module": "nodenext" instead.

    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": true,
    "verbatimModuleSyntax": true,
    "erasableSyntaxOnly": true,
    "isolatedModules": true,
    "resolveJsonModule": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
  },
}
```

- **`erasableSyntaxOnly`** rules out `enum`, `namespace` and constructor
  parameter properties. Bundlers and Node's type stripping handle only code
  whose types can simply be removed.
- **`verbatimModuleSyntax`** requires `import type` for imports that are only
  types (see [Modules](#5-modules)). It does not work with CommonJS output,
  which is why the guide uses ES modules.
- **`noUncheckedIndexedAccess`** types `list[0]` and `record[key]` as
  possibly `undefined`. Handle that case; don't assert it away.
- **ES2022** is the minimum because error `cause` (see [Errors](#9-errors))
  needs it.
- **Under `nodenext`:**
  - Relative imports carry their extension (`'./db.js'`).
  - JSON imports need `with { type: 'json' }`.
  - The examples in this guide assume bundler resolution, which needs
    neither.
- **Path aliases** (`@/…`) are fine in applications. Libraries and small
  services use relative paths.

### Linter

These rules enforce the guide. Everything else comes from the recommended
presets:

- `eslint:recommended`
- `typescript-eslint` `recommendedTypeChecked`, with `projectService` turned
  on
- `prettier`, which comes last

Use `eslint-plugin-import-x` (or `eslint-plugin-import`) for the `import/*`
rules, and `@eslint-community/eslint-plugin-eslint-comments` for the
directive rules.

| Rule                                                                                                                                                          | Enforces                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `import/order` with `newlines-between: 'never'` (groups: builtin, external, internal, parent, sibling)                                                        | [Modules](#5-modules)                                                        |
| `import/no-default-export`, `import/no-duplicates`, `import/no-cycle`                                                                                         | [Modules](#5-modules)                                                        |
| `@typescript-eslint/consistent-type-imports`                                                                                                                  | [Modules](#5-modules)                                                        |
| `func-style: ['error', 'expression']`                                                                                                                         | [Functions](#6-functions)                                                    |
| `@typescript-eslint/max-params: ['error', { max: 3 }]`                                                                                                        | [Functions](#6-functions)                                                    |
| `@typescript-eslint/no-floating-promises`, `no-misused-promises`, `require-await`, `return-await: ['error', 'in-try-catch']`                                  | [Functions](#6-functions)                                                    |
| `no-async-promise-executor`, `no-promise-executor-return`                                                                                                     | [Functions](#6-functions)                                                    |
| `@typescript-eslint/consistent-type-definitions: ['error', 'type']`                                                                                           | [Types](#7-types)                                                            |
| `@typescript-eslint/no-explicit-any`, `no-non-null-assertion`, `consistent-type-assertions: ['error', { assertionStyle: 'never' }]` (still allows `as const`) | [Types](#7-types)                                                            |
| `@typescript-eslint/switch-exhaustiveness-check`, `no-unnecessary-condition`                                                                                  | [Types](#7-types)                                                            |
| `@typescript-eslint/prefer-nullish-coalescing`, `prefer-optional-chain`                                                                                       | [Data and control flow](#8-data-and-control-flow)                            |
| `no-param-reassign: ['error', { props: true, ignorePropertyModificationsFor: ['draft', 'acc'] }]`, `prefer-const`                                             | [Data and control flow](#8-data-and-control-flow)                            |
| `curly: ['error', 'all']`, `eqeqeq`, `prefer-template`, `no-nested-ternary`, `no-multiple-empty-lines`                                                        | [Data and control flow](#8-data-and-control-flow)                            |
| `@typescript-eslint/only-throw-error`, `preserve-caught-error`                                                                                                | [Errors](#9-errors)                                                          |
| `no-console`                                                                                                                                                  | [Logging](#10-logging)                                                       |
| `@typescript-eslint/no-unused-vars` with `argsIgnorePattern: '^_'` and `ignoreRestSiblings: true`                                                             | Unused parameters start with `_`; rest destructuring may leave fields unused |
| `eslint-comments/no-use` with `allow: ['eslint-disable-next-line']`, `eslint-comments/require-description`                                                    | [Comments](#12-comments-and-documentation)                                   |
| `@typescript-eslint/ban-ts-comment` (a description is required on `@ts-expect-error`)                                                                         | [Tests](#14-tests)                                                           |
| `camelcase: 'off'`                                                                                                                                            | External data keeps its own key names                                        |

Put exceptions in config overrides, not in scattered disable comments:

- **Tests:** allow type assertions.
- **Config files and framework entry points** (pages, layouts, routes):
  allow default exports and `function` declarations.
- **Framework callbacks with a fixed signature** (for example error
  middleware with four parameters): raise `max-params`.
- **`*.d.ts` files:** allow `interface`.

### Gates

- The scripts are `lint`, `typecheck` (`tsc --noEmit`), `test` and `build`.
  CI runs all four.
- Lint runs with `--max-warnings=0`.
- Chain script steps with `&&`, never `;`. A failed step must stop the steps
  after it, and above all it must stop a deploy.

  ```json
  "deploy:dev": "npm run lint && npm run typecheck && npm run test && npm run build && ./deploy.sh dev"
  ```

- Pin the runtime version in `.nvmrc`.
  - CI reads that file (`node-version-file`).
  - Keep the runtime setting of the deployment target equal to it.
- When you scaffold a project, remove what the templates leave behind:
  default descriptions, empty package fields, sample comments, duplicate
  lines in ignore files.

---

## 3. Vertical rhythm

Blank lines break code into steps. A step is one statement, or a few
statements that make sense only together.

**Do**

- Put a blank line between steps.
- Keep statements that belong together without a blank line: a pair of
  setters, a start/end pair, parallel declarations of the same kind.
- Put a blank line after the setup lines at the top of a function (logger,
  destructuring), and before a `return` that follows other statements.
- Assign the result to a named constant, then return it on its own line.
- Leave long string literals on one line and let the formatter wrap around
  them.

```ts
export const getPlaybackWindow = async (channelId: string) => {
  const logger = getLogger();

  const channel = await channelsTable.get(channelId);

  if (!channel) {
    throw new Error(`Channel not found for id: ${channelId}.`);
  }

  const windowStartUtc = startOfMinute(getNow());
  const windowEndUtc = addMinutes(windowStartUtc, channel.windowMinutes);

  logger.info('Resolved playback window:', { windowStartUtc, windowEndUtc });

  const playbackWindow = {
    hlsUrl: channel.hlsUrl,
    windowStartUtc,
    windowEndUtc,
  };

  return playbackWindow;
};
```

**Don't**

- Leave a blank line right after an opening brace or right before a closing
  brace.
- Use more than one blank line in a row.
- Leave blank lines inside the import block.

---

## 4. Naming

Name things after what they mean in the domain, not after how they are built.
If something is hard to name, it probably does too much.

### Files and folders

| Kind                                                    | Case                                   | Example                                   |
| ------------------------------------------------------- | -------------------------------------- | ----------------------------------------- |
| Folders                                                 | kebab-case                             | `event-scheduler/`                        |
| Modules                                                 | kebab-case, named by concern           | `db.ts`, `schedule.ts`, `media-client.ts` |
| A module that defines a class                           | PascalCase, after the class            | `EventsTable.ts`                          |
| React components                                        | PascalCase                             | `EventCard.tsx`                           |
| Tests                                                   | `<module>.spec.ts`, next to the module | `schedule.spec.ts`                        |
| Fixtures                                                | kebab-case JSON                        | `create-channel.json`                     |
| Code shared inside a package, but not a deployable unit | underscore prefix                      | `_common/`                                |
| Local notes and scratch files, never shipped            | underscore prefix, gitignored          | `_dev/`                                   |

### Identifiers

| Kind                                                                        | Case                                           | Example                                         |
| --------------------------------------------------------------------------- | ---------------------------------------------- | ----------------------------------------------- |
| Variables, functions, instances (including singletons)                      | camelCase                                      | `eventsTable`, `getEventsToStart`               |
| Classes, types, enum objects                                                | PascalCase                                     | `EventsTable`, `ChannelState`                   |
| Enum keys                                                                   | UPPER_SNAKE                                    | `ChannelState.CLEANING_UP`                      |
| Values read from outside the code (env vars, remote config, cached secrets) | UPPER_SNAKE, even when function-local          | `const LOOKBACK_MINUTES = config.getInteger(…)` |
| Constants written in the code                                               | camelCase                                      | `queryBatchSize`, `retryOptions`                |
| Generic type parameters                                                     | `T`, or `T` plus a name when there are several | `TEvent`, `TResult`                             |
| Environment variables                                                       | UPPER_SNAKE                                    | `TABLE_NAME`                                    |
| Config keys                                                                 | camelCase                                      | `workflowTimeoutInMinutes`                      |
| Event types, routes, resource names                                         | kebab-case strings                             | `'create-channel'`                              |

Values that come from outside the code are UPPER_SNAKE so they stand out.
Anyone reading can see which numbers an operator can change without a
deploy, and which ones need a code change.

- **Functions start with a verb:** `get`, `create`, `delete`, `add`, `assign`,
  `parse`, `validate`, `is`, `has`. Event handlers are `handleX`, and
  selectors are `selectX`.
- **Booleans read as statements:** `isEnabled`, `hasSignal`, `canRetry`,
  `withEndpoints`, `includeRetries`, `conditionPassed`.
- **Numbers name their unit:** `timeoutInSeconds`, `memorySizeInMb`,
  `retentionInDays`, `delayMs`, `lookbackMinutes`. Timestamps name their
  zone: `startDateTimeUtc`.
- **Acronyms are words:** `userId`, `HttpClient`, `parseJson`. Not `userID`,
  `HTTPClient`, `parseJSON`.
- **One spelling per term**, in identifiers, files and messages alike.
  Choose `Endpoints` or `EndPoints` once and never use the other.
- **Types have no decoration:** no `I` prefix, no `Type` suffix. A function's
  input type ends in `Payload` or `Options`, state types end in `State`, and
  component props are a local `Props`.
- **Test doubles are `mockX`**, and imported fixtures are `xFixture`.
- **An environment variable that holds the name of a remote parameter** ends
  in `_PARAM_NAME`.

---

## 5. Modules

**Do**

- Use named exports only, written inline: `export const getEvents = …`.
  Default exports are allowed only where a framework requires them.
- Order imports: built-in modules, external packages, internal aliases,
  parent paths, sibling paths. Don't sort alphabetically within a group, and
  keep the whole import block together with no blank lines.
- Import each module once. Use `import type` for anything that is only a
  type. Types and values from the same module may share one statement:
  `import { type Event, getEvent } from './db';`.
- Use named imports by default. Use a namespace import
  (`import * as aws from '…'`) only for a library whose documentation is
  written that way.
- Give a folder an `index.ts` barrel (`export * from …`) only when other
  folders use it as a stable public surface.

**Don't**

- Import a folder's own barrel from inside that folder. It creates import
  cycles.
- Put a module that does work when imported (creates clients, reads the
  environment) into a barrel. Import it by its own path, and add a comment
  saying why.
- Add an extra `export default` next to a named export.
- Import across package boundaries by relative path
  (`'../../other-package/src/…'`). Depend on the package instead.

```ts
import { readFile } from 'node:fs/promises';
import { formatInTimeZone } from 'date-fns-tz';
import type { Event } from '@acme/domain';
import { getLogger } from '../_common/logger';
import { getEventsToStart } from './db';
import channelFixture from './__fixtures__/channel.json';
```

---

## 6. Functions

### Shape

**Do**

- Define every named function as a `const` arrow function with a block
  body, even when it has one line.
- Inline callbacks may use an expression body:
  `events.map((event) => event.id)`,
  `events.map((event) => ({ ...event, action }))`.
- When a function has to match a signature, type the variable instead of
  each parameter.

  ```ts
  export const getChannel: Handler<GetChannelPayload> = async (event) => {
  ```

- Open with guard clauses: check the input, throw or return early, then do
  the work without extra nesting.
- Keep helpers private and close to the caller: in the same file, in a
  sibling file, or nested in the function that uses them. Move a helper to a
  shared folder only when a second module needs it.
- **Rule of three:** two copies are fine. On the third, extract a helper.
- Use curried factories for configured callbacks, such as error handlers,
  middleware and guards:

  ```ts
  const ignoreAlreadyExists = (resourceId: string) => (err: unknown) => {
  ```

**Don't**

- Use `function` declarations or overloads. Use a union parameter instead
  of an overload.
  - Framework entry points that require `function` are the exception.
  - So are named callbacks that need a display name (`forwardRef`, `memo`).
- Mark a function `async` when it never awaits anything.

### Parameters

**Do** take at most two positional parameters. Anything optional, and any
boolean flag, goes into a named options object with defaults.

```ts
// Do
export const createEndpoints = (
  channelId: string,
  endpointTypes: readonly EndpointType[],
  { drm = false, profileId, prefix }: CreateEndpointsOptions = {},
) => {

createEndpoints(channelId, types, { prefix });

// Don't
createEndpoints(channelId, types, false, undefined, prefix);
```

- Type array and object parameters as `readonly` when the function only
  reads them.
- Start the name of a parameter you have to accept but don't use with `_`.

### Asynchronous code

**Do**

- Use `async`/`await` instead of `.then` chains.
  - The one allowed chain is a per-item `.catch(handler)` inside
    `Promise.all`.
  - Values that are not promises (for example Pulumi outputs) keep their
    own API (`.apply`).
- Start independent work first, then await it all together:

  ```ts
  const toStartQuery = getEventsToStart();
  const toStopQuery = getEventsToStop();

  const [toStart, toStop] = await Promise.all([toStartQuery, toStopQuery]);
  ```

- Model each unit of batched work as a plain `() => Promise<T>`. The batch
  runner settles every item and returns the failures:

  ```ts
  export const runInBatches = async <T>(
    operations: readonly (() => Promise<T>)[],
    { batchSize }: { batchSize: number },
  ) => {
    const failures: unknown[] = [];

    for (let start = 0; start < operations.length; start += batchSize) {
      const batch = operations.slice(start, start + batchSize);

      const results = await Promise.allSettled(
        batch.map((operation) => operation()),
      );

      for (const result of results) {
        if (result.status === 'rejected') {
          failures.push(result.reason);
        }
      }
    }

    return failures;
  };

  const failures = await runInBatches(
    events.map((event) => () => startEvent(event)),
    { batchSize: 100 },
  );
  ```

- Use `for…of` with `await` when the order matters or when a step must
  stop the loop.
- Write `return await` inside `try` blocks, so the `catch` sees the
  rejection. Leave it out everywhere else.

**Don't**

- Pass an `async` function to `new Promise`, or build operations that must
  call `resolve` themselves. A throw before `resolve()` leaves the promise
  pending forever.
- Leave a promise without awaiting, returning or deliberately handling it.

---

## 7. Types

**Do**

- Use `type` aliases for every shape. Combine them with `&`, `Omit`, `Pick`
  and `Partial`.
- Model a fixed set of values as an `as const` object plus a union type of
  the same name:

  ```ts
  export const ChannelState = {
    IDLE: 'idle',
    RUNNING: 'running',
    CLEANING_UP: 'cleaning-up',
  } as const;

  export type ChannelState = (typeof ChannelState)[keyof typeof ChannelState];
  ```

  Use a bare union only for small local sets
  (`type HttpVerb = 'GET' | 'POST'`).

- Type the program's entry points as `unknown` (request bodies, event
  payloads, parsed JSON, caught errors) and narrow them before use.
  - For more than a few fields, use a schema library and take the type from
    the schema, so the check and the type can't drift apart.
  - For a single value, use a validating helper or a type predicate:

  ```ts
  const requireString = (value: unknown, name: string) => {
    if (typeof value !== 'string' || !value) {
      throw new Error(`Invalid ${name} provided: ${String(value)}.`);
    }

    return value;
  };

  const isChannelState = (value: unknown): value is ChannelState => {
    return Object.values<unknown>(ChannelState).includes(value);
  };
  ```

- Use `undefined` for "no value". Use `null` only where an external format
  requires it (JSON APIs, databases), and convert at the boundary.
- Check object literals against a type with `satisfies` and keep their
  narrow type:
  `const routes = { … } satisfies Record<EventType, Handler>;`
- Let the compiler infer return types. Write one when the inferred type is
  wider than you mean, when a function is recursive, or when it is the public
  API of a library.
- Derive types instead of restating them: `ReturnType<…>`,
  `Parameters<typeof fn>[0]`, `(typeof list)[number]`.
- Make `switch` statements over unions exhaustive:

  ```ts
  default: {
    const unhandled: never = state;

    throw new Error(`Unhandled channel state: ${String(unhandled)}.`);
  }
  ```

- Put a type directly above the function that uses it. Export a shared type
  from the module that owns the data. A `types.ts` belongs to one feature
  folder, never to the whole project.
- Use `Record<Key, Value>` for lookup tables. When you write an index
  signature, name its key: `{ [channelId: string]: Channel }`.

**Don't**

- Use `interface`, `enum`, `namespace` or constructor parameter properties.
  - `interface` is allowed only to extend a library's types (module
    augmentation, declaration merging), in a `.d.ts` file.
- Use `any`. Where a library forces it, keep the `any` inside one small
  documented helper.
- Use `as T`, `as unknown as T` or the `!` operator in production code. The
  only exceptions are `as const` and a documented workaround for incorrect
  library types.

### Classes

**Do** use a class only to wrap a stateful resource: a client, a table, a
cache. A class may also extend a class that a library provides.

- Keep the class private to its module, and export one configured instance.
- Mark private members with `#`.
- Assign fields in the constructor body.

**Don't** build your own inheritance hierarchies, or use a class as a
namespace for functions that have no state.

---

## 8. Data and control flow

### Immutability

**Do**

- Use `const` by default. Use `let` only for a value that really is assigned
  more than once.
- Return new values instead of changing the ones you were given:

  ```ts
  const scheduled = events.map((event) => ({ ...event, action: 'start' }));
  ```

- Leave a field out with rest destructuring:
  `const { secret, ...publicConfig } = config;`
- Give a changed value its own name instead of reassigning a parameter.

These may change, as exceptions:

- Local state that a function creates and owns (a pagination cursor, an
  array of failures).
- A `reduce` accumulator named `acc`.
- An Immer draft named `draft`.

**Don't** assign to a property of an argument, call `delete` on input,
mutate inside `map`, or reassign a parameter.

### Expressions

**Do**

- Use `??` for default values. Keep `||` and `&&` for boolean logic only.

  ```ts
  const WINDOW_HOURS = config.getInteger(WINDOW_HOURS_PARAM) ?? 2; // 0 stays 0
  ```

- Use optional chaining only where a value really can be missing, not after
  a check has already proved it exists.
- Add optional keys with a conditional spread, and test for the missing
  value itself, not for falsiness:

  ```ts
  ...(prefix !== undefined && { prefix }),
  ```

- Destructure nested input in one statement, with renames and defaults:

  ```ts
  const {
    payload: { id: eventId, startDateTimeUtc, withEndpoints = true },
  } = event;
  ```

- Use a ternary to choose between two values. Use `if`/`else` when a branch
  does work.
- Build strings with template literals.
- Check for emptiness explicitly: `list.length === 0`,
  `Object.keys(record).length === 0`.
- Parse numbers with `Number(value)` and reject the result with
  `Number.isNaN`.
- Use a computed key for a dynamic property: `{ [signalType]: hasSignal }`.

**Don't** nest ternaries, compare with `==`, join strings with `+`, or rely
on truthiness for numbers and strings where `0` or `''` are valid values.

### Statements

**Do**

- Always use braces, including for one-line `if` bodies.
- Loops:
  - `for…of` for sequential or awaited work, or when you may stop early.
  - `map` and `filter` to transform.
  - `reduce` to group items.
  - `Promise.all` or `Promise.allSettled` over `map` for parallel work.
- In a `switch`:
  - Wrap a `case` that declares variables in its own braces.
  - Put a blank line before `break`.
  - Always write a `default`, which throws or checks exhaustiveness.
  - Stacked cases are the only allowed fall-through.

### Numbers and time

**Do**

- Name every tunable number with its unit: `const batchSize = 25;`,
  `const pollIntervalMs = 5_000;`.
- Once time arithmetic repeats, use a named constant or a date library
  (`addMinutes(now, lookbackMinutes)`). A single `60 * 1000` is fine.
- Store and send timestamps as ISO 8601 strings in UTC. Convert to a
  local zone only for display or for rules that depend on the zone.

---

## 9. Errors

**Do**

- Throw `Error`. Pass the underlying error as `cause` when you rethrow:

  ```ts
  throw new Error(`Failed to create channel ${channelId}.`, { cause: err });
  ```

  Add a custom error class only when callers need to tell errors apart by
  type.

- Write messages as sentences that say what was wrong and include the
  offending value. End them with a period. If the reader has to act, start
  with "Please".

  ```ts
  `Invalid event id provided: ${eventId}.``Please provide a valid 'fromDate' when querying ${tableName}.`;
  ```

- Narrow a caught error before using it:

  ```ts
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
  ```

- Choose where errors are handled on purpose, and match it to the kind of
  work:

  | Kind of work                                                | Error handling                                                                     |
  | ----------------------------------------------------------- | ---------------------------------------------------------------------------------- |
  | Validation                                                  | Throw at the entry point, before any side effect                                   |
  | Batch or fan-out                                            | Settle every item, log each failure with `warn`, return the failures to the caller |
  | Transactional flow                                          | Undo the partial work, then rethrow                                                |
  | Orchestrated step (a workflow engine retries or catches it) | Let the error propagate                                                            |
  | Public API or router boundary                               | Turn the error into a response (`{ error: true, message }` or an HTTP status)      |

- Make create operations idempotent: when the resource already exists,
  recognize the error by its class or `err.name`, then read the existing
  resource.

  ```ts
  if (err instanceof ConflictException) {
    return describeEndpoint(endpointId);
  }
  ```

**Don't**

- Match on error message text, except as a documented last resort.
- Put the `g` flag on a regex used with `.test()`. It keeps state between
  calls.
- Catch an error and only log it when the failure means lost work.
- Swallow an error without a comment saying why that is safe.
- Throw strings or plain objects.

---

## 10. Logging

**Do**

- Log through one shared logger.
  - Every function that logs gets it on its first line:
    `const logger = getLogger();`.
  - Context that applies to the whole unit of work (request id, service
    name) is attached once, at the entry point.
- Write the message as a short label ending in a colon, and pass values as
  separate arguments for the logger to serialize:

  ```ts
  logger.info('Events to start:', events);
  logger.warn('Skipped endpoint:', endpointId, err);
  ```

  Use a template literal only when the value belongs inside the sentence.

- Choose the level by what happens next:
  - `error`: something needs attention.
  - `warn`: the program recovered or skipped something.
  - `info`: a milestone.
  - `debug`: detail you'd rarely need.

**Don't**

- Use `console.*` in shipped code. Standalone scripts and the raw output of
  child processes are the exceptions.
- Leave debug logging behind.
- Log secrets, tokens or whole credential objects.

---

## 11. Configuration and secrets

**Do**

- Read environment variables through one helper that throws when a
  variable is missing. Never read `process.env` anywhere else.
- Check that required configuration exists when the program starts, so a
  missing value fails immediately and not halfway through a request.
- Keep tunable values in remote configuration (a parameter store), and point
  to them from the environment
  (`LOOKBACK_MINUTES_PARAM_NAME=/prod/scheduler/lookback-minutes`).
- Load remote configuration once per unit of work, then read it
  synchronously from a small cache.
- Read the current time through one function (`getNow()`), frozen once per
  unit of work. Every time calculation in that run then uses the same
  instant, and tests can control it.
- Name parameter paths by one scheme:
  `/<stack>/<region>/<component>/<kebab-key>`.
- Keep secrets only in a secret store (encrypted parameters, a secrets
  manager, encrypted stack config).

**Don't**

- Commit secrets, tokens, client credentials or signed URLs. That includes
  plain config files, source code, comments, editor launch configs and notes.
- Paste account IDs or internal endpoint URLs into comments or docs. Read
  them from config or the provider.
- Let a local scratch folder (`_dev/`) be tracked by git, or put anything
  that looks like a credential into it.

---

## 12. Comments and documentation

**Do**

- Comment rarely, and explain why, not what. Good reasons to comment: an
  invariant, a workaround, a limit, a priority order, or a number that needs
  its reasoning.

  ```ts
  timeout: 55, // Runs every minute; a 5 second buffer prevents overlap.
  ```

- Write comments as sentences with a capital letter and a period. Always put
  a space after `//`.
- Credit where borrowed code or ideas came from:
  `// Ref: <url>`, `// Based on <source>.`
- When a function needs JSDoc, start it with the function's name:

  ```ts
  /**
   * spliceIntoEvents inserts an updated event at its sorted position,
   * replacing any older copy.
   */
  ```

  Leave out `@param` and `@returns` tags that repeat the types.

- Write TODOs as `// TODO: <imperative sentence>.`, and add the condition
  when there is one: `// TODO: Drop the fallback once the API returns URLs.`
- Suppress a lint rule only for the next line: name the rule, and give the
  reason after `--`.

  ```ts
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- The SDK types omit this option.
  ```

- Start a README with a title and a two-line purpose (plus a diagram if
  there is one), then Getting started, Deploying and Utilities. Introduce
  each command with a bold label ending in a colon.

**Don't**

- Leave commented-out code. Delete it; version control keeps the history.
- Disable a rule for a whole file or a block, or with a bare
  `eslint-disable`.
- Write comments that restate the code.

---

## 13. Project layout

Group code by deployable unit and by concern. A folder's name says what it
is; its files say what each one is responsible for.

```
src/
  <feature>/
    <unit>/
      index.ts            entry point: thin; validates, logs, delegates
      db.ts               data access
      <concern>.ts        domain logic (schedule.ts, router.ts, ...)
      types.ts            types for this unit only
      *.spec.ts           tests, next to the code
      __mocks__/          module mocks
      __fixtures__/       JSON inputs, reused for local runs
  _common/                code shared by more than one unit
infra/                    infrastructure as code, as its own package
scripts/<name>/           one-off maintenance scripts, each with its own package
_dev/                     local notes (gitignored)
```

- Each deployable unit is one folder with an `index.ts`, and the build
  produces one bundle per entry point.
- Clients and data-access objects are created once at module scope.
  Configuration and loggers are read inside functions.
- Keep the entry point thin. Routing, validation and logging happen there;
  the work happens in the concern modules.
- A data-access class wraps one table or resource. Its module
  (`EventsTable.ts`) keeps the class private and exports one camelCase
  instance (`eventsTable`).

---

## 14. Tests

**Do**

- Use `describe` and `it`, never `test`.
- Name blocks `describe('<Module> - functionName()')` and
  `it('should <behavior>')`, with `should` in lowercase. Write a stress word
  in capitals when it matters: `'should NOT start before the window'`.
- Separate arrange, act and assert with blank lines.
- Test what callers can observe: return values, thrown errors, calls to
  dependencies.
- Mock whole modules with hand-written `__mocks__` next to the module.
  - Declare each `mockX = vi.fn()` (or `jest.fn()`) first, then build the
    export from them.
  - Activate the mock with `vi.mock('./db')` (or `jest.mock('./db')`) at the
    top of the spec.
- Use the typed mock helper: `vi.mocked(fn)` / `jest.mocked(fn)`, never
  `fn as Mock`.
- Reset mocks in the runner config (`clearMocks: true`, and `restoreMocks:
true` for spies), not in each file.
- Mock SDK clients with a client-level mocking library, and assert on the
  commands they receive.
- Control time through `getNow()` or fake timers.
- Set fake environment variables in a global setup file.
- Test invalid input by deliberately breaking the types, then assert on the
  rejected promise:

  ```ts
  // @ts-expect-error Testing missing property
  const result = createChannel({ payload: {} });

  await expect(result).rejects.toThrow(/Invalid event id/);
  ```

- Keep realistic payloads in `__fixtures__/` as JSON, and reuse them for
  local runs of the code.
- Use `toEqual` for structures and `toBe` for primitives. Assert each call
  explicitly; don't assert in a loop.
- Mark placeholder data clearly: `'test-channel-1'`.

**Don't**

- Keep a `--passWithNoTests` flag in place of writing tests.
- Share mutable state between tests.
- Assert on private implementation details.

---

## 15. Shell scripts

**Do**

- Start with a comment that states what the script is for, then
  `set -euo pipefail`.
- Comment each step in one line.
- Use `snake_case` for local variables and UPPER_SNAKE for exported ones.
- Resolve paths from the script's own location:
  `root=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)`
- Quote every expansion.
- Check preconditions (tool installed, logged in, environment set) and exit
  with a clear message when one fails.
- Build a command with arguments that vary in an array, and run it as
  `"${args[@]}"`.

**Don't** build a command as a string and `eval` it.

---

## Appendix A: serverless handlers

Apply this appendix when the code runs as functions triggered by events.

- **Handler:** `export const handler = async (event: unknown) => { … }`.
  - Narrow the event first.
  - For several event types, route on a kebab-case `type` field.
- **Clients:**
  - Create SDK clients at module scope, so warm invocations reuse them.
  - Keep retry settings in one constant and spread it into each client:
    `const retryOptions = { maxAttempts: 3, retryMode: 'standard' };`
- **Build:**
  - Each handler gets its own bundle (`src/<feature>/<unit>/index.ts`
    → `dist/<feature>/<unit>/index.js`), minified, with source maps,
    targeting the pinned runtime.
  - Bundle the SDK version you tested with. Rely on the SDK that the runtime
    provides only when bundle size matters more than version control.
- **Stream and queue sources:**
  - Return the failed records as partial batch failures, so only those are
    retried.
  - Attach a dead-letter queue.
  - Never catch a failed record and only log it.
- **Workflow steps:** take the payload and return the payload with your
  changes, `{ ...payload, conditionPassed }`. Let errors propagate to the
  workflow's catch and retry settings.
- **Timeouts:** set a function's timeout below its trigger interval, and
  write the reason in a comment.
- **Containers:**
  - Use a fully qualified base image and run as a non-root user.
  - Start the process through an init process (`dumb-init`).
  - Report the result to the orchestrator before exiting with a meaningful
    code.

---

## Appendix B: infrastructure as code (Pulumi)

Apply this appendix when infrastructure is written in TypeScript.

- **Package:** `infra/` is its own package with its own lint and typecheck.
  - `index.ts` contains only side-effect imports of concern folders
    (`import './scheduler';`).
  - `config/` is a barrel: provider settings, region, account, sizing
    constants, `config`, `stackName`.
- **Provider:** use one explicit provider with default tags, and pass it to
  every resource. Don't leave any resource out.
- **Naming:**
  - Compute each name once, and use it as both the logical and physical
    name:

    ```ts
    const eventCronLambdaName = `${stackName}-event-cron`;

    export const eventCronLambda = new aws.lambda.Function(
      eventCronLambdaName,
      { name: eventCronLambdaName, … },
      providerOpts,
    );
    ```

  - Resource variables end in their kind: `eventCronLambdaRole`,
    `ssmPolicy`.
  - Stacks are named `<env>-<service>`.
- **Permissions:**
  - Create one policy per capability (logging, parameters, table, queue),
    attached to the role.
  - Build policy documents with `pulumi.jsonStringify`, and list actions and
    resources explicitly (no `*` unless the service requires it).
- **Logs:** create an explicit log group for every function, with retention
  set.
- **Cross-stack values:**
  - A stack publishes the values it owns as parameter-store entries at
    `/<stack>/<region>/<component>/<key>`.
  - Other stacks only read those entries.
- **Configuration:**
  - Stack config files are committed with camelCase keys.
  - Secrets are set with `--secret`.
  - Lists and objects use structured config
    (`config.requireObject<string[]>('subnetIds')`).
- **CI:**
  - One reusable workflow runs lint, typecheck, test and build, then deploys.
  - A thin caller workflow for each environment triggers it: manual, main
    branch, or version tag. Pull requests run the same workflow with deploy
    turned off.
  - Each caller gets its own concurrency group.
  - CI authenticates through OIDC, never with long-lived keys.

---

## Appendix C: review checklist

Every item allows the exceptions its section lists.

- [ ] Lint, typecheck, test and build pass. Script steps are chained with
      `&&`.
- [ ] No `any`, `as`, `!`, `enum`, `interface`, default export or
      `function` declaration.
- [ ] Entry points narrow `unknown` input. Errors are sentences that end
      with a period, and rethrown errors keep their `cause`.
- [ ] Defaults use `??`, and conditional spreads test for `undefined`. No
      function mutates its inputs or reassigns a parameter.
- [ ] No more than two positional parameters; flags go in an options
      object.
- [ ] Batch work settles every item; no `async` function is passed to a
      promise executor; no promise is left floating.
- [ ] Errors are handled at a boundary chosen on purpose; idempotency checks
      the error type, not its message.
- [ ] Logs go through the shared logger as `'Label:', value`; no
      `console.*`.
- [ ] Numbers carry units; external config is UPPER_SNAKE; each term has one
      spelling.
- [ ] No secrets, account IDs or commented-out code. Lint suppressions
      cover one line, name the rule and give a reason after `--`.
- [ ] Tests cover the new behavior, including invalid input, and use typed
      mocks.
