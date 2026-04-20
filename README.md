# \[MWS\] Modular-WebServer to Host various Modules for File Servers and Small Games
![TypeScript](https://img.shields.io/badge/language-TypeScript-blue?style=flat-square)
[![License](https://img.shields.io/badge/license-BSD--3--Clause-brightgreen?style=flat-square)](LICENSE.txt)

A lightweight TypeScript web server for hosting independent modules (file servers, games) with HTTP/HTTPS and WebSocket support. Modules are isolated from each other and from the core, and each module is responsible for a sub-branch in the URL path tree.

## Getting Started
Clone the project and install dependencies:

    $ git clone https://github.com/BjoernBoss/mws-base.git
    $ cd mws-base
    $ npm install

Build and start the server:

    $ npm run start

To build without starting (and optionally executing manually):

    $ npm run build
    $ node ./main.js

This compiles all TypeScript sources and runs `node main.js`, which loads `modules/setup.js` and starts listening on the configured ports. The `Run` method in the `modules/setup.js` script is hereby the primary interface to configure the server and corresponding modules to be loaded.

An example for a `setup.js` could look like:

```JavaScript
export async function Run(server) {
    try {
        const mod = await import("my-module/app.js");
        server.listenHttp(8080, new mod.MyModule(), (host) => host == 'localhost');
    }
    catch (e) {
        throw new Error(`Failed to load module: ${e.message}`);
    }
}
```

## Writing a Module
Each module lives in `modules/<name>/` with its own `package.json` (private, type: module). The npm workspaces configuration automatically resolves cross-module imports. To write a module, implement the `ModuleInterface` from `core/interface.ts`:

```TypeScript
import * as libInterface from "core/interface.js";
import * as libClient from "core/client.js";
import * as libRequest from "core/request.js";

export class MyModule implements libInterface.ModuleInterface {
    public name: string = 'my-module';

    public async request(client: libClient.HttpRequest): Promise<void> {
        client.respondText('Hello from my module!', libRequest.Media.Text);
    }

    public async upgrade(client: libClient.HttpUpgrade): Promise<void> {
        /* handle WebSocket upgrades */
    }
}
```
Any requests not handled by a module, may be handled by parent modules, should they host child modules. If no module handles a request, a default `404 Not Found` is sent.

The framework also provides default helper implementations of modules:

- **`DispatchModule`** routes requests by URL path prefix to child modules
- **`UnhandledModule`** wraps a module and catches unhandled requests with a fallback
- **`WrapModule`** intercepts requests before/after passing them to an inner module

```JavaScript
const dispatch = new libInterface.DispatchModule({
    '/api': apiModule,
    '/static': fileModule
});
server.listenHttp(8080, dispatch, (host) => host == 'localhost');
```

## Core Components
The `core` workspace provides all server functionality:

| File | Purpose |
|---|---|
| `interface.ts` | `ModuleInterface` interface, and additional helper: `DispatchModule`, `LambdaModule`, `UnhandledModule`, `WrapModule` |
| `client.ts` | `HttpRequest` (response helpers, body parsing, file serving), `HttpUpgrade` and `ClientSocket` (WebSocket) |
| `request.ts` | HTTP status codes, media types, range parsing, and encoding negotiation (gzip, deflate, brotli, zstd) |
| `server.ts` | `Server` class managing HTTP/HTTPS listeners with host-header validation and server name configuration |
| `cache.ts` | File cache with LRU eviction, sync/async read, and streaming |
| `templates.ts` | Template loading and placeholder expansion |
| `builder.ts` | Programmatic HTML page construction |
| `location.ts` | Path sanitization, joining, and sub-directory checks |
| `log.ts` | Logging with console, file (with rotation), and custom logger support |

## Configuration
The `modules/setup.js` `Run` method receives a `Server` instance and is responsible for all configuration:

- **Server name:** `libServer.SetServerName('my-server')` (via `core/server.js`)
- **Logging:** `libLog.AddLogger(...)` for file or custom loggers (via `core/log.js`)
- **Caching:** `libCache.SetCacheOptions({ cacheSize, largestFile })` (via `core/cache.js`)
- **Listeners:** `server.listenHttp(port, module, hostCheck)` or `server.listenHttps(port, key, cert, module, hostCheck)`

Host validation is mandatory: every listener requires a callback that approves or rejects the incoming `Host` header.
