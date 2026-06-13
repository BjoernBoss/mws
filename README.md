# MWS - Modular Web Server
![TypeScript](https://img.shields.io/badge/language-TypeScript-blue?style=flat-square)
[![License](https://img.shields.io/badge/license-BSD--3--Clause-brightgreen?style=flat-square)](LICENSE.txt)

A lightweight TypeScript framework for hosting isolated modules behind HTTP/HTTPS and WebSocket endpoints. Each module owns a subtree in the URL space and is isolated from its siblings. Modules compose into trees for path-based routing, hostname routing, and request interception.

The server integrates various automation features, such as error handling, validations, caching... Further, it contains integrated logging for proper connection tracing and logging.

## Installation
Only depends on [`ws`](https://github.com/websockets/ws) at runtime.

	$ npm install @bjoernboss/mws

Requires Node.js 22 or later.

Note: Look into the source `TypeScript` code on [`GitHub`](https://github.com/BjoernBoss/mws).

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

## Writing Modules

A module extends `ModuleHandler` and implements up to three lifecycle hooks:

```typescript
import { ModuleHandler, ClientRequest, Server } from "@bjoernboss/mws";

export class MyModule extends ModuleHandler {
	constructor() {
		super('my-module');
	}

	/* Called once when first attached to a server (directly or through a parent module) */
	protected override async handleInitialize(server: Server): Promise<void> {
		/* allocate resources, start timers */
	}

	/* Called for every incoming request routed to this module */
	protected override async handleRequest(client: ClientRequest, params?: object): Promise<void> {
		/* respond to the client */
	}

	/* Called once after the module has stopped and all clients have left;
	   accepted WebSockets are still open and must be closed manually */
	protected override async handleStop(): Promise<void> {
		/* release resources, close WebSockets */
	}
}
```

Only `handleRequest` is required. Unhandled requests can be handled by parent modules or receive an automatic `404 Not Found`.

Modules form a tree via `linkModule()`. They only ever see requests relative to their `root`. Path translation happens automatically when dispatching to children — client paths are rebased relative to each child module's position in the tree. A module can be linked to multiple parents and will only be initialized once, on first attachment to a server.

### Header and HTML Patching

Parent modules can register patches that modify outgoing headers or HTML pages before they are sent to the client:

```typescript
/* called just before headers are sent (in reverse registration order) */
client.patchHeaders((status, headers) => {
	headers['X-Custom'] = 'value';
});

/* called just before an HTML page is finalized (in reverse registration order) */
client.patchHtmlPage(async (page, status, headers) => {
	page.head.push(build.LoadScript('/analytics.js'));
});
```

Patches are scoped to the current handler context and automatically removed when the handler returns.

### Shutdown

`server.stop()` waits for all active request handlers to complete before shutting down. Long-running handlers **must** check `client.claimed` or await `client.responded` to detect when the connection has been broken, and exit promptly.

### Stopping Individual Modules

Calling `module.stop()` detaches the module and waits for its active clients to drain. By default, a module stops automatically when all its parents unlink it; this can be disabled with `module.stopOnDetach(false)`.

## Helper Modules

Factory functions create common module patterns without subclassing:

### dispatch — Path Routing

Routes requests to children by longest URL path match. Stops itself once all children have been unlinked.

```typescript
import { Server, dispatch } from "@bjoernboss/mws";

const server = new Server();
server.listen(dispatch({
	'/api': apiModule,
	'/static': staticModule
}), { port: 8080 });
```

### host — Hostname Routing

Routes requests to children by longest hostname match (supports sub-domain matching).

```typescript
import { Server, host } from "@bjoernboss/mws";

server.listen(host({
	'api.example.com': apiModule,
	'example.com': mainModule
}), { port: 8080 });
```

### bind — Parameter and Translation Binding

Forwards all requests to a single child handler, optionally injecting `params` and a path `translate` map.

```typescript
import { bind } from "@bjoernboss/mws";

const bound = bind(myModule, {
	params: { role: 'admin' },
	translate: { '/v2': '/' }
});
```

### check — Host and Port Validation

Validates the request hostname and port before forwarding. Responds `404` and kills the connection on mismatch.

```typescript
import { check } from "@bjoernboss/mws";

const checked = check(myModule, ['localhost', '127.0.0.1'], { port: 8080 });
```

### lambda — Callback-Based Handler

Handles requests via callbacks instead of subclassing, with optional attached child modules.

```typescript
import { lambda, ClientRequest, Server, AttachedModule } from "@bjoernboss/mws";

const handler = lambda({
	attach: { api: apiModule },
	setup: async function (server: Server, links: Record<string, AttachedModule>) {
		/* runs on first attachment */
	},
	handle: async function (client: ClientRequest, params, links) {
		if (client.isSubPathOf('/api'))
			await links.api.handle(client, { translate: { '/api': '/' } });
		else
			client.respondNotFound();
	},
	stop: async function (links) {
		/* cleanup */
	}
});
```

## Request Handling

`ClientRequest` automatically manages requests to handle errors, prevent double-responses, and ensure expected HTTP behavior.

### Receiving Data

```typescript
/* as a complete buffer */
const data = await client.receiveAllBuffer(1_000_000);

/* as a decoded string */
const text = await client.receiveAllText('utf-8', 1_000_000);

/* as a readable stream */
const stream = client.receiveData(1_000_000);

/* directly to a file (fails if the file already exists) */
await client.receiveToFile('/uploads/file.bin', 10_000_000);
```

### Responding

```typescript
/* simple text or buffer */
client.respond('OK', { media: Media.Text, status: Status.Ok });

/* streaming response */
const writer = client.respondData({ media: Media.Json, dynamicEncode: true });
writer.end(JSON.stringify(data));

/* file with automatic range requests, etag, last-modified, encoding, and caching */
if (!await client.tryRespondFile('/var/www/index.html'))
	client.respondNotFound();

/* HTML page */
await client.respondHtml(page, { status: Status.Ok });
```

Convenience methods: `respondOk`, `respondNotFound`, `respondBadRequest`, `respondForbidden`, `respondInternalError`, `respondConflict`, `respondSeeOther`, `respondTemporaryRedirect`, `respondPermanentRedirect`, `respondCreated`, and others.

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
/* style.css becomes style.<id>.css — the id changes when the file changes */
const versionedPath = server.cache.immutable('my-handler', '/static/style.css');
```

When a request arrives for an immutable path, the cache strips the version tag, serves the underlying file, and redirects stale version tags to the current one. Set `CacheConfig.immutableStatePath` to persist version mappings across restarts.

### Direct Cache Access

```typescript
const buffer = await server.cache.read('/path/to/data.json');
await server.cache.write('/path/to/output.json', JSON.stringify(data));
server.cache.flush();
```

## HTML Building

The `build` namespace provides programmatic HTML construction with automatic escaping:

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

Methods prefixed with `_` (e.g. `_rootAttachToServer`, `_pushTranslation`, `_restoreSnapshot`) are framework-internal and **must not** be called by module implementations. They are `public` for cross-class access within the framework, but are not part of the public API and may change without notice.
