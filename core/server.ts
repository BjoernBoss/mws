/* SPDX-License-Identifier: BSD-3-Clause */
/* Copyright (c) 2024-2026 Bjoern Boss Henrichsen */
import * as libLog from "core/log.js";
import * as libClient from "core/client.js";
import * as libCommon from "core/common.js";
import * as libHttps from "https";
import * as libHttp from "http";
import * as libFs from "fs";
import * as libStream from "stream";
import * as libNet from "net";

export class Server {
	private stopList: (() => void)[];

	constructor() {
		libLog.Info(`Server object created`);
		this.stopList = [];
	}

	private respondNotFound(request: libHttp.IncomingMessage, client: libClient.HttpRequest | libClient.HttpUpgrade): void {
		client.respondNotFound(`No resource found at [${request.headers.host ?? ''}]:[${client.rawpath}]`);
		client.finalize();
	}
	private handleWrapper(wasRequest: boolean, request: libHttp.IncomingMessage, checkHost: libCommon.CheckHost, handler: libCommon.ModuleInterface, port: number, establish: (host: string) => libClient.HttpRequest | libClient.HttpUpgrade): void {
		let client = null;
		try {
			/* setup the client object */
			const rawHostName = (request.headers.host ?? '').toLowerCase();
			client = establish(rawHostName);
			client.log(`${wasRequest ? 'Request' : 'Upgrade'}:${port} from [${request.socket.remoteAddress}]:${request.socket.remotePort} to [${request.headers.host}]:[${request.url}] (user-agent: [${request.headers['user-agent']}])`);

			/* extract the host to be used and validate its port */
			const hostNameRegex = rawHostName.match(/^(.*):(\d+)$/);
			let hostName = rawHostName;
			if (hostNameRegex != null) {
				if (parseInt(hostNameRegex[2], 10) != port) {
					client.error(`Host [${hostName}] port does not match [${port}]`);
					return this.respondNotFound(request, client);
				}
				hostName = hostNameRegex[1];
			}

			/* validate the host name */
			if (!checkHost(hostName)) {
				client.error(`Host [${hostName}] now allowed for this endpoint [${port}]`);
				return this.respondNotFound(request, client);
			}

			/* handle the actual client request */
			if (wasRequest)
				handler.request(client as libClient.HttpRequest);
			else
				handler.upgrade(client as libClient.HttpUpgrade);
			client.finalize();
		} catch (err) {
			/* log the unknown caught exception (internal-server-error) */
			libLog.Error(`Uncaught exception encountered for client [${client != null ? client.id : null}]: ${err}`)
			if (client != null)
				client.respondInternalError('Unknown internal error encountered');
			request.destroy();
		}
	}
	private handleRequest(request: libHttp.IncomingMessage, response: libHttp.ServerResponse, check: libCommon.CheckHost, handler: libCommon.ModuleInterface, port: number): void {
		this.handleWrapper(true, request, check, handler, port, function (host: string): libClient.HttpRequest {
			return new libClient.HttpRequest(request, response, host);
		});
	}
	private handleUpgrade(request: libHttp.IncomingMessage, socket: libStream.Duplex, head: Buffer, check: libCommon.CheckHost, handler: libCommon.ModuleInterface, port: number): void {
		this.handleWrapper(false, request, check, handler, port, function (host: string): libClient.HttpUpgrade {
			return new libClient.HttpUpgrade(request, socket, head, host);
		});
	}

	public listenHttp(port: number, handler: libCommon.ModuleInterface, checkHost: libCommon.CheckHost): void {
		try {
			/* initialize the server config */
			const config = {
				requireHostHeader: true
			};

			/* start the actual server */
			const server = libHttp.createServer(config, (req, resp) => this.handleRequest(req, resp, checkHost, handler, port)).listen(port);
			server.on('error', (err) => libLog.Error(`While listening to port ${port} using http: ${err}`));
			server.on('upgrade', (req, sock, head) => this.handleUpgrade(req, sock, head, checkHost, handler, port));
			if (!server.listening)
				return;

			/* register the stop-function */
			this.stopList.push(() => server.close());

			/* log the established listener */
			const address = server.address() as libNet.AddressInfo;
			libLog.Info(`Http-server started successfully on [${address.address}]:${address.port} [family: ${address.family}] with handler [${handler.name}]`);
		} catch (err) {
			libLog.Error(`While listening to port ${port} using http: ${err}`);
		}
	}
	public listenHttps(port: number, key: string, cert: string, handler: libCommon.ModuleInterface, checkHost: libCommon.CheckHost): void {
		try {
			/* initialize the server config and load the key and certificate */
			const config = {
				requireHostHeader: true,
				key: libFs.readFileSync(key),
				cert: libFs.readFileSync(cert)
			};

			/* start the actual server */
			const server = libHttps.createServer(config, (req, resp) => this.handleRequest(req, resp, checkHost, handler, port)).listen(port);
			server.on('error', (err) => libLog.Error(`While listening to port ${port} using https: ${err}`));
			server.on('upgrade', (req, sock, head) => this.handleUpgrade(req, sock, head, checkHost, handler, port));
			if (!server.listening)
				return;

			/* register the stop-function */
			this.stopList.push(() => server.close());

			/* log the established listener */
			const address = server.address() as libNet.AddressInfo;
			libLog.Info(`Https-server started successfully on [${address.address}]:${address.port} [family: ${address.family}] with handler [${handler.name}]`);
		} catch (err) {
			libLog.Error(`While listening to port ${port} using https: ${err}`);
		}
	}
	public stop(): void {
		for (const cb of this.stopList)
			cb();
	}
};
