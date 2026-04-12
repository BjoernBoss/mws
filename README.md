# \[MWS\] Modular-WebServer to Host various Modules for File Servers and Small Games
![TypeScript](https://img.shields.io/badge/language-TypeScript-blue?style=flat-square)
[![License](https://img.shields.io/badge/license-BSD--3--Clause-brightgreen?style=flat-square)](LICENSE.txt)

Small custom webserver written in TypeScript/JavaScript, capable to host mutliple separate modules with support for simple http requests and websockets.

To write a module for the server, simply implement the `ModuleInterface` defined in `core/common.ts`. 

## Using the Server
To setup this server simply clone the project:

    $ git clone https://github.com/BjoernBoss/mws-base.git

Afterwards implement the `modules/setup.js` file with its `Run` method.
This method should setup any listeners, as well as register the modules themselves, and configure the system accordingly.

Finally install the dependencies, transpile, and start the server (both done by `start`):

    $ cd mws-base
    $ npm install
    $ npm run start

## Example setup.js

This is an example implementation of the `Run` method in the `modules/setup.js` file. It loads a dynamic module, and then opens port `93`, with the given module attached, and the host-name check for `localhost`.

```JavaScript
export async function Run(server) {
    try {
        const module = await import("some-module/app.js");
        server.listenHttp(93, new module.Module('some-parameter'), (host) => host == 'localhost');
    }
    catch (e) {
        throw new Error(`Failed to load module: ${e.message}`);
    }
}
```

Other possible configurations include `SetServerName` in `core/config.js`, or the logging configurations in `core/log.js`.