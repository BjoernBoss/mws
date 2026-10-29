# MWS - Modular Web Server
![TypeScript](https://img.shields.io/badge/language-TypeScript-blue?style=flat-square)
[![License](https://img.shields.io/badge/license-BSD--3--Clause-brightgreen?style=flat-square)](LICENSE.txt)

A lightweight TypeScript framework for hosting isolated modules behind HTTP/HTTPS and WebSocket endpoints. Each module owns a subtree in the URL space and is isolated from its siblings. Modules can perform routing to sub-modules, thereby redirecting the URL flow, depending on given behavior or states.

The server integrates various automation features, such as error handling, validations, caching... Further, it contains integrated logging for proper connection tracing and logging.

## Installation
The only runtime dependency is [`ws`](https://github.com/websockets/ws) (plus its type definitions for TypeScript consumers).

	$ npm install @bjoernboss/mws

Requires Node.js 22.15 or later.

## Quick Start

```typescript
import { Server, ModuleHandler, ClientRequest, Media, addLogger, createConsoleLogger } from "@bjoernboss/mws";

addLogger(createConsoleLogger());

class HelloModule extends ModuleHandler {
	constructor() {
		super('hello');
	}

	protected override async handleRequest(client: ClientRequest): Promise<void> {
		client.respond('Hello, World!', { media: Media.Text });
	}
}

const server = new Server();
server.listen(new HelloModule(), { port: 8080 });
```

For HTTPS, pass a TLS configuration:

```typescript
server.listen(new HelloModule(), {
	port: 443,
	tls: { key: './privkey.pem', cert: './fullchain.pem' }
});
```

## Logging System

The framework defaults to write all of its logs out to `mws.logGlobal`. It in turn passes the raw log components (level, date, identity, message) to all of the loggers registered via `mws.addLogger`. Formatting happens inside the individual logger implementations. For convenience, there exist colorful console loggers, file loggers (writes logging contents to a file), log filters, or request loggers, which format the multiple request related logs into single-line logs.

## Listeners

`server.listen()` returns a `Listener` that emits `'listening'`, `'failed'`, and `'stopped'` events:

```typescript
const listener = server.listen(handler, { port: 8080 });

listener.on('listening', (address) => console.log(`Listening on port ${address?.port}`));
listener.on('failed', (err) => console.error(`Failed: ${err.message}`));
listener.on('stopped', () => console.log('Stopped'));
```

A serverless listener does not bind to a port. Instead, connections are passed to it manually via `listener.handleRequest()` and `listener.handleUpgrade()` (can also be used on other listeners to feed connections into them):

```typescript
const listener = server.listen(handler, { serverless: { secure: false } });

/* forward requests from an external HTTP server */
externalServer.on('request', (req, resp) => listener.handleRequest(req, resp));
externalServer.on('upgrade', (req, sock, head) => listener.handleUpgrade(req, sock, head));
```

## Writing Modules

A module extends `ModuleHandler` and implements up to three lifecycle hooks:

```typescript
import { ModuleHandler, ClientRequest, Server, Params } from "@bjoernboss/mws";

export class MyModule extends ModuleHandler {
	constructor() {
		super('my-module');
	}

	/* Called once when first attached to a server (directly or through a parent module) */
	protected override async handleInitialize(server: Server): Promise<void> {
		/* allocate resources, start timers */
	}

	/* Called for every incoming request routed to this module */
	protected override async handleRequest(client: ClientRequest, params?: Params): Promise<void> {
		/* respond to the client */
	}

	/* Called once after the module has stopped and all clients have left;
	   accepted WebSockets are still open and must be closed manually */
	protected override async handleStop(): Promise<void> {
		/* release resources, close WebSockets */
	}
}
```

Only `handleRequest` is required. A module owns its entire subtree: if the handler returns without responding, the framework defaults to `404 Not Found`. Parent modules can intercept any child response (including the auto not-found) via the `patch` interface.

Modules form a tree via `linkModule()`. They only ever see requests relative to their `root`. Path translation happens automatically when dispatching to children. The client paths are rebased relative to each child module's position in the tree. A module can be linked to multiple parents and will only be initialized once, on first attachment to a server.

### Remapping Endpoints of Children

Translations are applied when dispatching to a child module:

```typescript
protected override async handleRequest(client: ClientRequest): Promise<void> {
	this.child.handle(client, { translate: {
		'/my-child': '/'
	} });
}

```

Translations are matched by longest path and reversed for any paths the child generates (via `client.makePath`), so links and redirects produced by the child automatically point back into the outer URL space. A `null` target hides a path from the child entirely. A generated path not covered by a translation is identity mapped, and logs a warning.

This makes a module's endpoint layout a default rather than enforced: modules define canonical endpoint paths (typically exported as an `Endpoints` constant), but a parent can fully re-map them (e.g. exposing one endpoint at the mount root and moving the auxiliary endpoints elsewhere) as long as every endpoint the child generates paths for remains mapped.

The following example maps the child module to `/child` and makes the child's path `/settings` unreachable. Note: paths into `/settings` generated by the child will still be created, but any lookup of them will fail.

```typescript
protected override async handleRequest(client: ClientRequest): Promise<void> {
	this.child.handle(client, { translate: {
		'/child': '/',
		'/child/settings': null
	} });
}
```

All possible mappings are considered when reversing the mappings, not just the taken mappings. This allows the re-mapping of all endpoints of a child. But mappings not applied to a client, while handling it, cannot be considered. Thus, the mapping architecture must ensure, that the final collection of possible mappings, which reach the child module, is complete, in order to ensure the module can create any possible paths correctly.

### Response Patching

Parent modules can register a `Patcher` to inspect and modify, or entirely replace, responses produced further down the module tree:

```typescript
client.patch({
	/* called just before a response header is committed (in reverse registration order) */
	response: (status, headers) => {
		headers['X-Custom'] = 'value';

		/* catch and replace any response, e.g. for custom error pages */
		if (status.code == 404)
			client.respondHtml(makeErrorPage(), { status: Status.NotFound });
	},

	/* called just before an HTML page is finalized (in reverse registration order) */
	html: (page, status, headers) => {
		page.head.push(build.LoadScript('/analytics.js'));
	}
});
```

A patcher that responds itself replaces the original response. Patchers registered earlier (i.e. by parent modules) still see the replacement, while the replacing patcher is not re-invoked for its own response. Patcher hooks must be synchronous. Patches are scoped to the current handler context and automatically removed when the handler returns.

### Shutdown

`server.stop()` waits for all active request handlers to complete before shutting down. Long-running handlers **must** check `client.claimed` or await `client.responded` to detect when the connection has been broken, and exit promptly.

### Stopping Individual Modules

Calling `module.stop()` detaches the module and waits for its active clients to drain. By default, a module stops automatically when all its parents unlink it; this can be disabled with `module.stopOnDetach(false)`.

## Helper Modules

Factory functions create common module patterns without subclassing:

### Path Routing: `dispatch`

Routes requests to children by longest URL path match. Stops itself once all children have been unlinked.

```typescript
import { Server, dispatch } from "@bjoernboss/mws";

const server = new Server();
server.listen(dispatch({
	'/api': apiModule,
	'/static': staticModule
}), { port: 8080 });
```

### Hostname Routing: `host`

Routes requests to children by longest hostname match (supports sub-domain matching).

```typescript
import { Server, host } from "@bjoernboss/mws";

server.listen(host({
	'api.example.com': apiModule,
	'example.com': mainModule
}), { port: 8080 });
```

### Parameter and Translation Binding: `bind`

Forwards all requests to a single child handler, optionally injecting `params` and a path `translate` map.

```typescript
import { bind } from "@bjoernboss/mws";

const bound = bind(myModule, {
	params: { role: 'admin' },
	translate: { '/v2': '/' }
});
```

### Host and Port Validation: `check`

Validates the request hostname and port before forwarding. Responds `404` and kills the connection on mismatch.

```typescript
import { check } from "@bjoernboss/mws";

const checked = check(myModule, ['localhost', '127.0.0.1'], { port: 8080 });
```

### Callback-Based Handler: `lambda`

Handles requests via callbacks instead of subclassing, with optional attached child modules.

```typescript
import { lambda, ClientRequest, Server, AttachedModule } from "@bjoernboss/mws";

const handler = lambda({
	attach: { api: apiModule },
	setup: async function (server: Server, links: Record<string, AttachedModule>) {
		/* runs on first attachment */
	},
	handle: async function (client: ClientRequest, params, links) {
		/* dispatch matching requests; unmatched requests auto-respond with not-found */
		if (client.isSubPathOf('/api'))
			await links.api.handle(client, { translate: { '/api': '/' } });
	},
	stop: async function (links) {
		/* cleanup */
	}
});
```

### Method and Path Routing: `makeRouter`

`makeRouter` is not a module but a helper for use inside a module. It builds a function that matches the request method and path against a list of routes and invokes the target of the best match. It returns `true` if the client was dispatched or responded to, and `false` if no route matched the path, in which case the client is left untouched.

```typescript
import { makeRouter, ModuleHandler, ClientRequest } from "@bjoernboss/mws";

export class ApiModule extends ModuleHandler {
	private router = makeRouter([
		{ method: 'GET', pattern: '/', target: async (client) => client.respondJson({ ok: true }) },
		{ method: 'GET', pattern: '/users/:id', target: async (client, args) => client.respondJson(await loadUser(args.id)) },
		{ method: 'POST', pattern: '/users/:id', target: async (client, args) => { /* ... */ } },
		{ method: 'GET', pattern: '/files/+path', target: async (client, args) => {
			if (!await client.tryRespondFile(`/var/www${args.path}`))
				client.respondNotFound();
		} },
		{ method: '*', pattern: '/*', target: async (client) => client.respondNotFound() }
	]);

	constructor() {
		super('api');
	}

	protected override async handleRequest(client: ClientRequest): Promise<void> {
		await this.router(client);
	}
}
```

Methods are matched on HTTP methods or `*` as wildcard. Pattern components are separated by `/` and are matched against the sanitized request path:

| Component | Matches | Captured Value |
|---|---|---|
| `name` | exactly this component (compared URI decoded) | *(nothing)* |
| `:name` | exactly one component | the component, URI decoded |
| `+name` | one or more remaining components | sanitized absolute path, e.g. `/a/b` |
| `*name` | zero or more remaining components | sanitized absolute path, `/` if empty |

A catch-all (`+`, `*`) must be the last component; anything after it is ignored. An empty name (`:`, `+`, `*`) matches but discards the capture. The request path is split into components before decoding, so an encoded slash never acts as a separator.

**Matching:** When several routes match, the highest specificity is chosen. When they match, the method is compared for specificity. If it also matches, they are picked by order.

## Request Handling

`ClientRequest` automatically manages requests to handle errors, prevent double-responses, and ensure expected HTTP behavior.

Receiving and responding can be started in any order and may overlap (e.g. streaming an upload back out as the response). As soon as a module starts receiving or responding, the request counts as *claimed*: it will not be dispatched to any further modules, and it must be fully completed (response completed, receive consumed) before the handler returns. Leaving a claimed request incomplete aborts its streams and answers the request with an internal error. A module owns its entire subtree. If the handler returns without claiming the request, or does not respond to it, the framework defaults to `404 Not Found`. Parent modules can intercept any response via the `patch` interface.

### Receiving Data

```typescript
/* as a complete buffer */
const data = await client.receiveAllBuffer(1_000_000);

/* as a decoded string */
const text = await client.receiveAllText('utf-8', 1_000_000);

/* as a readable stream */
const stream = client.receiveData(1_000_000);

/* directly to a file via the cache (atomic and durable: writes to a temp file, flushes it to the disk, then renames) */
await server.cache.write('/uploads/file.bin', client.receiveData(10_000_000));

/* directly to a file via the cache (create-only: throws if the file already exists) */
await server.cache.write('/uploads/file.bin', client.receiveData(10_000_000), { create: true });
```

### Responding

```typescript
/* simple text or buffer */
client.respond('OK', { media: Media.Text, status: Status.Ok });

/* streaming response (full completion must be awaited before returning from the handler) */
const writer = client.respondData({ media: Media.Json, disableEncoding: true });
writer.once('error', (e) => failure(e));
writer.end(JSON.stringify(data));

/* file with automatic range requests, etag, last-modified, encoding, and caching */
if (!await client.tryRespondFile('/var/www/index.html'))
	client.respondNotFound();

/* HTML page */
client.respondHtml(page, { status: Status.Ok });
```

**Important:** Streams returned by `receiveData()` and `respondData()` can emit `'error'` events. Always register an `'error'` handler on these streams to prevent unhandled errors from crashing the process. Generally: correspondingly tagged functions may throw or error and must handle errors accordingly, to prevent crashing the process.

Convenience methods: `respondOk`, `respondNotFound`, `respondBadRequest`, `respondForbidden`, `respondInternalError`, `respondConflict`, `respondSeeOther`, `respondTemporaryRedirect`, `respondPermanentRedirect`, `respondCreated`, and others.

### Cache Control

Every response method accepts an optional `cache` parameter of type `CachePolicy` to control the `Cache-Control` header. If `Cache-Control` is set manually in the headers, the policy is ignored.

| Policy | Default Header | Used By Default In |
|---|---|---|
| `immutable` | `public, max-age=2592000, immutable` | `tryRespondFile` (versioned paths) |
| `static` | `public, no-cache` | `tryRespondFile` (normal files) |
| `private` | `private, no-cache` | `respond`, `respondData`, `respondHtml`, and all other convenience methods |
| `sensitive` | `no-cache, no-store, max-age=0, must-revalidate` | `respondInternalError`, `respondForbidden` |
| `none` | *(no header set)* | *(only when explicitly chosen)* |

The default header values for each policy can be customized via `ClientConfig.cache`:

```typescript
const server = new Server({
	client: {
		cache: {
			immutable: 'public, max-age=604800, immutable',
			static: 'public, max-age=60',
			private: 'private, no-cache',
			sensitive: 'no-store',
			none: ''
		}
	}
});
```

## WebSocket

```typescript
protected override async handleRequest(client: ClientRequest): Promise<void> {
	const ws = await client.acceptWebSocket();
	if (ws == null) return;

	ws.on('data', (data: Buffer) => {
		ws.send(data);
	});
	ws.on('close', () => {
		/* cleanup */
	});
}
```

`ClientSocket` handles alive checks automatically via configurable ping/pong intervals (`ClientConfig.webSocketTimeout`, `ClientConfig.webSocketAliveTimeout`).

Non-upgrade requests that reach `acceptWebSocket()` receive an automatic `426 Upgrade Required` response.

## Caching

`Server` provides integrated caching with a two-layer system:

### In-Memory File Cache

An LRU cache for frequently served files. Encoded variants (gzip, brotli, ...) are cached alongside the original.

`client.tryRespondFile()` reads through this cache automatically.

### Immutable Versioned Paths

File paths can be tagged with a unique version identifier so clients can cache them immutably:

```typescript
/* style.css becomes style.<id>.css - the id changes when the file changes */
const versionedPath = server.cache.immutable('my-module', '/static/style.css');
```

When a request arrives for an immutable path, the cache strips the version tag, serves the underlying file, and redirects stale version tags to the current one. Set `CacheConfig.immutableStatePath` to persist version mappings across restarts.

### Direct Cache Access

These methods are designed for modules to be used, and allows directly to write to the disk, and update the cache at the same time.

```typescript
const buffer = await server.cache.read('/path/to/data.json');
await server.cache.write('/path/to/output.json', JSON.stringify(data));
await server.cache.write('/path/to/output.bin', readableStream);
await server.cache.remove('/path/to/old.json');

/* skip the disk flushes for disposable data */
await server.cache.write('/path/to/scratch.bin', buffer, { durable: false });

/* flush all cached data to ensure they are re-fetched from disk */
server.cache.flush();
```

## HTML Building

The `build` namespace provides programmatic HTML construction with automatic escaping. It allows parent modules to use the `html` hook of `patch`, to build around the HTML, before serving it:

```typescript
import { build } from "@bjoernboss/mws";

const page = new build.HtmlPage({
	head: [
		build.Title('My Page'),
		build.Meta('viewport', 'width=device-width, initial-scale=1'),
		build.LoadStyle('/style.css'),
		build.LoadScript('/app.js', { defer: '' })
	],
	body: [
		build.Div({ id: 'root' }, [
			build.Text('Hello, World!')
		])
	]
});
```

Plain strings passed as `HtmlString` values are automatically HTML-escaped. Use `build.Safe(content)` to mark trusted content that should not be escaped.

## Internal Methods

Methods prefixed with `_` (e.g. `_rootAttachToServer`, `_pushContext`, `_popContext`) are framework-internal and **must not** be called by module implementations. They are `public` for cross-class access within the framework, but are not part of the public API and may change without notice.
