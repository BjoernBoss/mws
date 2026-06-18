/* SPDX-License-Identifier: BSD-3-Clause */
/* Copyright (c) 2024-2026 Bjoern Boss Henrichsen */
import * as libLog from "./log.js";
import * as libBuilder from "./builder.js";
import * as libCache from "./cache.js";
import * as libHelper from "./helper.js";
import * as libBase from "./base.js";
import * as libServer from "./server.js";
import * as libEvents from "events";
import * as libFs from "fs";
import * as libStream from "stream";
import * as libUrl from "url";
import * as libWs from "ws";
import * as libHttp from "http";

const BAD_HTTP_STRING_REGEX: RegExp = /[\x00-\x1f\x7f]/;
const BAD_HTTP_HEADER_NAME_REGEX: RegExp = /[\x00-\x1f\x7f\(\)<>@,;:\\"/\[\]\?=\{\} \t]/;

class ClientContext {
	public path: string;
	public identity: string;
	public translationCount: number;
	public busyCount: number;
	public headerPatchCount: number;
	public htmlPatchCount: number;

	constructor(path: string, identity: string, translationCount: number, busyCount: number, headerPatchCount: number, htmlPatchCount: number) {
		this.identity = identity;
		this.path = path;
		this.translationCount = translationCount;
		this.busyCount = busyCount;
		this.headerPatchCount = headerPatchCount;
		this.htmlPatchCount = htmlPatchCount;
	}
}

class ClientBase extends libLog.Logger {
	private _config: BurntClientConfig;
	protected _path: string;
	protected _translation: Record<string, string | null>[];

	protected constructor(url: libUrl.URL, kind: string, config: BurntClientConfig);
	protected constructor(client: ClientBase, kind: string, config: BurntClientConfig);
	protected constructor(arg: libUrl.URL | ClientBase, kind: string, config: BurntClientConfig) {
		super(kind);

		if (arg instanceof libUrl.URL) {
			this._translation = [];
			this._path = libHelper.sanitize(arg.pathname, false);
			this.url = arg;
		}
		else {
			this._translation = arg._translation;
			this._path = arg._path;
			this.url = arg.url;
		}

		this._config = config;
	}

	/** raw request origin (no host will result in '_'; host will be lower-case) */
	readonly url: libUrl.URL;

	/** path relative to current module */
	public get path(): string {
		return this._path;
	}

	/** configuration used by this client */
	public get config(): BurntClientConfig {
		return this._config
	}

	/** check if the path relative to the current module is a sub path or the same of the given test base path (can be /base or /base/...) */
	public isSubPathOf(base: string): boolean {
		return libHelper.isSubPath(base, this._path);
	}

	/** check if the path relative to the current module is inside of the given test base path (must be truly inside; /base/...) */
	public isInsideOf(base: string): boolean {
		return libHelper.isInside(base, this._path);
	}

	/** create a path relative from the current module into the clients traversed server space */
	public makePath(path: string): string {
		path = libHelper.sanitize(path, false);
		let output = path;

		for (let i = this._translation.length - 1; i >= 0; --i) {
			let nullCheck = false, match: [string, string | null] | null = null;

			/* find the best reverse mapping and apply it */
			for (const [from, to] of Object.entries(this._translation[i])) {
				if (to == null)
					nullCheck = true;
				else if (libHelper.isSubPath(to, output) && (match == null || match[1]!.length < to.length))
					match = [from, to];
			}
			if (match != null)
				output = libHelper.rebasePath(match[1]!, match[0], output);

			/* check if the translation contained null-mappings and check if
			*	the final unpacked path re-maps into the null-mapping */
			if (nullCheck) {
				match = null;
				for (const [from, to] of Object.entries(this._translation[i])) {
					if (libHelper.isSubPath(from, output) && (match == null || match[0].length < from.length))
						match = [from, to];
				}
			}

			/* check if the path could not be translated */
			if (match == null || match[1] == null) {
				this.warning(`Path [${path}] is not mapped by translations`);
				return path;
			}
		}
		return output;
	}
}

enum ReceiveState {
	none,
	receiving,
	completed
}
enum UpgradeState {
	none,
	upgrading,
	upgraded
}
enum ResponseState {
	none,
	acknowledged,
	headerSent,
	completed,
	broken
}

interface HttpResponseInterface {
	setHeader(name: string, value: string): void;
	setStatus(code: number, msg: string): void;
}

class HttpRequestResponse extends libStream.Writable {
	public writer: libStream.Writable;
	public totalSent: number;
	public cache: Buffer | null;
	public status: libBase.StatusType;
	public headers: Record<string, string>;
	public contentSize: number | null;
	public dynamicEncode: boolean;
	public contentType: libBase.MediaType;
	public encodingFailed: boolean;
	public responseCompleted: boolean;

	constructor(writer: libStream.Writable, status: libBase.StatusType, headers: Record<string, string>, contentSize: number | null, contentType: libBase.MediaType,
		dynamicEncode: boolean, handleData: (chunk: Buffer | null, cb: (err: any) => void) => void, destroy: (err: any, cb: (err: any) => void) => void
	) {
		super({
			write: (chunk, _, cb) => handleData(chunk, cb),
			final: (cb) => handleData(null, cb),
			destroy: (err, cb) => destroy(err, cb)
		});
		this.writer = writer;
		this.totalSent = 0;
		this.cache = null;
		this.status = status;
		this.headers = headers;
		this.contentSize = contentSize;
		this.dynamicEncode = dynamicEncode;
		this.contentType = contentType;
		this.encodingFailed = false;
		this.responseCompleted = false;
	}
}

type ClientSocketEvents = { 'data': (data: Buffer) => void, 'close': () => void };

/** look at the state and modify the headers accordingly (only add or remove headers, must not try to alter the response) */
export type HeaderPatch = (status: libBase.StatusType, headers: Record<string, string>) => void;

/** look at the page and modify it or the headers accordingly (can be interrupted by returning an alternate response) */
export type HtmlPatch = (page: libBuilder.HtmlPage, status: libBase.StatusType, headers: Record<string, string>) => Promise<void>;

/** type to invoke to update the logging tag (empty string will hide the tag entry;
 *	null will completely remove the tag; other values will update the tag) */
export type SocketLogTag = (value?: string) => void;

/** cache policy to be applied (Note: if Cache-Control is manually set, it will not be overwritten by the policy) */
export enum CachePolicy {
	/** immutable content that can be cached indefinitely */
	immutable = 'immutable',

	/** static content that may change but can be publically cached */
	static = 'static',

	/** generated content that is private and can change on every request */
	private = 'private',

	/** sensitive content that must not be cached at all */
	sensitive = 'sensitive',

	/** dont configure the cache in any way */
	none = 'none'
}

/**
 *	Does not throw any exceptions, unless explicitly stated.
 *	Http HEAD aware (will silently drain any data sent from a HEAD request).
 *
 *	Request is considered acknowledged, as soon as a response has been triggered or a preparation started.
 *	Path remains URI encoded, as it was received, and path building will use the same encoded paths.
 *	Repeated request responding may override any ongoing responses and may terminate the connection; depending on the prior state.
 *	Not responded to requests will result in [not-found].
 *
 *	Receiving data: Will automatically decode the stream and ensure a given maximum is not passed
 *		=> Any errors while receiving will either auto-respond or send the connection into the broken state, and fail the receive reader (stream user does not need to respond).
 *		=> Will terminate a connection, if the upload is not consumed or the client errors.
 *		=> Premature destroying of receive reader will result in the connection being gracefully terminated.
 *		=> All data must have been received before the response is completed.
 *	Responding data: Will automatically encode the stream and send the header accordingly
 *		=> Will automatically determine if encoding is to be used
 *		=> Checks if promised number of bytes is provided
 *		=> Will automatically error, if the broken state is detected, and will auto-respond or send the connection into the broken state (stream user does not need to respond).
 *
 *	A response sent while another is being prepared (acknowledged) will override it and close the connection.
 *	A response sent while data is already being streamed (header sent) will break the connection.
 *	Responses automatically apply the CachePolicy default for the response type, if no other cache control is specified.
 *	Responses will either use the dedicated responder interface and its highWaterMark, or a responder interface, which caches up to socket.highWaterMark.
 *
 *	Upgrade requests, which were not accepted, will be closed after responding.
 *	An accept attempt must be fully awaited before completing the handling procedure.
 *
 *	Defaults [Accept-Ranges] normally to 'none' or to 'bytes' for files
 *	Defaults [Vary] to 'Accept-Encoding'.
 *	Defaults [Connection] to 'close' for upgrade requests and for some error responses.
 */
export class ClientRequest extends ClientBase {
	private _headerPatcher: HeaderPatch[];
	private _htmlPatcher: HtmlPatch[];
	private _state: {
		respondedPromise: Promise<void>;
		respondedResolve: () => void;
		completedPromise: Promise<void>;
		completedResolve: () => void;
		breakPromise: Promise<void>;
		breakResolve: () => void;
		receive: ReceiveState;
		response: ResponseState;
		upgrade: UpgradeState;
		breaking: Promise<void> | null;
	};
	private _throughput: {
		timer: NodeJS.Timeout | null;
		deadline: number;
		start: number;
		active: boolean;
		busyCheck: (() => boolean)[];
	};
	private _native: {
		response: HttpResponseInterface;
		writer: libStream.Writable;
		socket?: { socket: libStream.Duplex, head: Buffer, wss: libWs.WebSocketServer };
		timeout?: number;
	};
	private _request: libHttp.IncomingMessage;
	private _server: libServer.Server;

	private constructor(server: libServer.Server, config: BurntClientConfig, protocol: string, kind: string, request: libHttp.IncomingMessage, response: libHttp.ServerResponse | { socket: libStream.Duplex, head: Buffer, wss: libWs.WebSocketServer }) {
		super(new libUrl.URL(`${protocol}://${request.headers.host?.toLowerCase() ?? '_'}${request.url}`), kind, config);
		this._headerPatcher = [];
		this._htmlPatcher = [];

		let respondedResolve: any = null, completedResolve: any = null, breakResolve: any = null;
		this._state = {
			respondedPromise: new Promise<void>((resolve) => respondedResolve = resolve),
			respondedResolve: () => { },
			completedPromise: new Promise<void>((resolve) => completedResolve = resolve),
			completedResolve: () => { },
			breakPromise: new Promise<void>((resolve) => breakResolve = resolve),
			breakResolve: () => { },
			receive: ReceiveState.none,
			response: ResponseState.none,
			upgrade: UpgradeState.none,
			breaking: null
		};
		this._state.respondedResolve = respondedResolve;
		this._state.completedResolve = completedResolve;
		this._state.breakResolve = breakResolve;

		this._request = request;
		this._server = server;

		/* setup the throughput measurement to detect any stalling connections */
		this._throughput = { timer: null, deadline: 0, start: 0, active: true, busyCheck: [] };
		if (this.config.throughputThreshold > 0) {
			this._throughput.start = Date.now() + this.config.throughputGrace;
			this.updateThroughput(0);
		}

		/* register the necessary network error handlers */
		const lostHandler = () => {
			if (this._state.response != ResponseState.completed && this._state.response != ResponseState.broken)
				this.markAsBroken('Connection lost', false);
		};
		const closedHandler = () => {
			if (this._state.response != ResponseState.completed && this._state.response != ResponseState.broken)
				this.markAsBroken('Connection closed by remote', false);
		};
		const timeoutHandler = () => {
			if (this._state.response != ResponseState.completed && this._state.response != ResponseState.broken)
				this.markAsBroken('Connection timed out', false);
		};
		request.once('error', lostHandler);
		request.once('aborted', closedHandler);
		request.socket.once('timeout', timeoutHandler);
		request.socket.once('error', lostHandler);
		request.socket.once('close', closedHandler);

		/* ensure to remove the events again once the processing has completed */
		this._state.completedPromise.then(() => {
			request.off('error', lostHandler);
			request.off('aborted', closedHandler);
			request.socket.off('timeout', timeoutHandler);
			request.socket.off('error', lostHandler);
			request.socket.off('close', closedHandler);
		});

		/* configure the native interface writer, depending on the actual source parameters */
		let responseWrapper: HttpResponseInterface | null = null;
		let writerWrapper: libStream.Writable | null = null;
		if (response instanceof libHttp.ServerResponse) {
			writerWrapper = response, responseWrapper = {
				setHeader: (name, value) => response.setHeader(name, value),
				setStatus: (code, msg) => { response.statusCode = code; response.statusMessage = msg; }
			};
		}
		else
			[responseWrapper, writerWrapper] = this.wrapSocketWriter(response.socket);
		this._native = { response: responseWrapper, writer: writerWrapper, socket: (response instanceof libHttp.ServerResponse ? undefined : response) };

		/* overwrite the original socket timeout as the client handler will take care of it (set it to twice the conceivable upper bound) */
		this._native.timeout = this._request.socket.timeout;
		this._request.socket.setTimeout((this.config.throughputWindow + this.config.throughputGrace) * 2);
	}

	private constructQuickResponse(status: libBase.StatusType, logReason: string | null, headers: Record<string, string>, content?: { media: libBase.MediaType, body?: Buffer } | null): void {
		if (headers == null)
			headers = {};
		const description = `${this.isHead ? 'HEAD:' : ''}[${status.msg}]${logReason == null ? '' : `: ${logReason}`}`;

		/* check if the response can still be sent (acknowledged state can be overridden; the connection
		*	will be closed afterwards to prevent the client from seeing inconsistent responses) */
		const override = (this._state.response == ResponseState.acknowledged);
		if (this._state.response == ResponseState.none || override) {
			if (status.code >= 500)
				this.error(`Responding with ${description}`);
			else if (override)
				this.warning(`Overriding in-progress response with ${description}`);
			else
				this.log(`Responding with ${description}`);

			if (override)
				headers['Connection'] = 'close';

			this.sendFullResponse(status, headers, content ?? undefined);

			if (override)
				this.markAsBroken('Overridden in-progress response', true);
		}
		else if (this._state.response == ResponseState.headerSent)
			this.markAsBroken(`Overlap with committed response ${description}`, false);
		else if (this._state.response != ResponseState.broken)
			this.warning(`Request already completed, discarding response ${description}`);
		else
			this.trace(`Request broken, discarding response ${description}`);
	}
	private failThroughput(): void {
		if (this.config.throughputThreshold <= 0 || !this._throughput.active || this._state.response == ResponseState.broken)
			return;

		/* check if the connection is still considered busy and should receive a grace delay */
		for (const cb of this._throughput.busyCheck) {
			let result = false;
			try { result = cb(); }
			catch (err: any) { this.error(`Unhandled exception in busy check: ${err.message}`); }
			if (!result) continue;

			this.trace(`Deferring throughput closing as connection is busy`);
			this._throughput.start = Date.now() + this.config.throughputGrace;
			this.updateThroughput(0);
			this._request.socket.setTimeout((this.config.throughputWindow + this.config.throughputGrace) * 2);
			return;
		}

		const description = `Throughput below [${this.config.throughputThreshold}] bytes/sec`;
		const closing = (this._state.response == ResponseState.none || this._state.response == ResponseState.acknowledged);

		if (closing)
			this.respondRequestTimeout(description, { headers: { 'Connection': 'close' } });
		this.markAsBroken((closing ? '' : description), closing);
	}
	private updateThroughput(delta: number): void {
		if (this._throughput.timer != null)
			clearTimeout(this._throughput.timer);
		this._throughput.timer = null;
		if (this.config.throughputThreshold <= 0 || !this._throughput.active)
			return;
		const _now = Date.now();
		const now = Math.max(_now, this._throughput.start);

		/* shift the deadline according to the bought time by the throughput */
		const bought = (delta / this.config.throughputThreshold) * 1000;
		this._throughput.deadline = now + Math.min(this.config.throughputWindow, Math.max(0, this._throughput.deadline - now) + bought);
		this._throughput.timer = setTimeout(() => this.failThroughput(), this._throughput.deadline - _now);
	}
	private wrapSocketWriter(socket: libStream.Duplex): [HttpResponseInterface, libStream.Writable] {
		let headers: Record<string, string> = {}, status: number = 0, message: string = '';

		/* wrap the response interface to catch the http parameter */
		const response: HttpResponseInterface = {
			setHeader: (name, value) => {
				if (name.match(BAD_HTTP_HEADER_NAME_REGEX))
					throw new Error('Bad Name');
				if (value.match(BAD_HTTP_STRING_REGEX))
					throw new Error('Bad Value');
				headers[name] = value;
			},
			setStatus: (code, msg) => {
				if (msg.match(BAD_HTTP_STRING_REGEX))
					throw new Error('Bad Status');
				status = code;
				message = msg;
			}
		};

		/* setup the buffer flush, which will also write the header out */
		let headerSent = false, buffer: Buffer | null = null, settled = false;
		const flushBuffer = (cb: () => void, last: boolean) => {
			let prefix = '', suffix = '';

			/* check if the header first needs to be sent */
			const chunked = (headerSent || !last);
			if (!headerSent) {
				headerSent = true;

				/* construct the header text */
				if (chunked)
					headers['Transfer-Encoding'] = 'chunked';
				else
					headers['Content-Length'] = (buffer?.byteLength ?? 0).toString();
				prefix = `HTTP/1.1 ${status} ${message}\r\n`;
				for (const key in headers)
					prefix += `${key}: ${headers[key]}\r\n`;
				prefix += '\r\n';
			}

			/* check if a chunk prefix needs to be added and if the chunk suffix needs to be added */
			if (chunked) {
				if (buffer != null)
					prefix += `${buffer.byteLength.toString(16)}\r\n`, suffix += '\r\n';
				if (last)
					suffix += '0\r\n\r\n';
			}

			/* construct the final chunk to be sent */
			let chunks = [];
			if (prefix != '')
				chunks.push(Buffer.from(prefix, 'utf-8'));
			if (buffer != null)
				chunks.push(buffer);
			if (suffix != null)
				chunks.push(Buffer.from(suffix, 'utf-8'));
			const chunk = (chunks.length == 1 ? chunks[0] : Buffer.concat(chunks));

			/* clear the cached data and write the data to the socket (chunk can never be empty, as either a buffer must exist, or the final suffix or header needs to be sent) */
			buffer = null;
			if (last)
				socket.end(chunk, cb);
			else
				socket.write(chunk, cb);
		};

		/* note: writer cannot interfere with later web-socket native socket, as the web-socket will only be instantiated,
		*	if response-state is none, and vice versa, all writers will fail once web-socket has started, as response-state
		*	will be header-sent (writer itself can never fail, and no error handlers will be attached to it; it uses the
		*	underlying sockets watermark as buffering capacity) */
		const writer = new libStream.Writable({
			destroy: (err, cb) => {
				if (settled) return; settled = true;
				socket.destroy(err ?? undefined);
				cb(null);
			},
			write: (chunk, _, cb) => {
				if (settled) return;
				buffer = (buffer == null ? chunk as Buffer : Buffer.concat([buffer, chunk]));
				if (buffer.byteLength < writer.writableHighWaterMark)
					return cb(null);
				flushBuffer(cb, false);
			},
			final: (cb) => {
				if (settled) return; settled = true;
				flushBuffer(cb, true);
			},
			highWaterMark: socket.writableHighWaterMark
		});
		return [response, writer];
	}
	private async killNativeConnection(graceful: boolean): Promise<void> {
		const writer = this._native.writer;

		/* raw closer, which will fully destroy the connection */
		const closeConnection = () => {
			if (this._request.destroyed && writer.destroyed)
				return;
			const error = new Error('Connection broken');

			this._request.destroy(error);
			writer.destroy(error);
		};

		if (!graceful || writer.writableFinished || writer.destroyed)
			return closeConnection();

		/* if graceful, wait for the last queued data to be sent; may be called multiple times */
		return new Promise<void>((resolve) => {
			let settled = false, handler = () => {
				if (settled) return; settled = true;
				closeConnection();
				resolve();
			};
			writer.once('finish', () => handler());
			writer.once('error', () => handler());
			writer.once('close', () => handler());
		});
	}
	private markAsBroken(reason: string, graceful: boolean): void {
		if (reason != '')
			this.error(`Connection broken: [${reason}]`);
		this._state.response = ResponseState.broken;
		if (this._state.breaking != null) {
			if (!graceful)
				this.killNativeConnection(false);
			return;
		}
		this._state.respondedResolve();

		/* setup the promise beforehand to ensure the promise body does not recursively
		*	enter this handler again, and sees the completed object still being unset */
		let resolver = () => { };
		this._state.breaking = new Promise<void>((res) => resolver = res);

		/* setup the break promise to ensure the connection is killed properly with the given grace */
		(async () => {
			let settled = false;

			const forceDestroy = setTimeout(() => {
				if (settled) return; settled = true;
				this.killNativeConnection(false);
				resolver();
			}, this.config.killGraceTimeout);

			await this.killNativeConnection(graceful);
			clearTimeout(forceDestroy);

			if (settled) return; settled = true;
			resolver();
		})();

		this._state.breakResolve();
	}
	private badClientUsage(reason: string, close: boolean): void {
		this.respondInternalError(`Bad Usage: ${reason}`, (close ? { headers: { 'Connection': 'close' } } : undefined));
	}
	private applyCachePolicy(headers: Record<string, string>, should: CachePolicy, override?: CachePolicy): void {
		if ('Cache-Control' in headers)
			return;
		const policy = this.config.cache[override ?? should];
		if (policy != '')
			headers['Cache-Control'] = policy;
	}

	private closeHeader(status: libBase.StatusType, headers: Record<string, string>, content?: { media: libBase.MediaType, size?: number, encoding?: string }): void {
		let logMsg = `Sending [${status.msg}] ${this.isHead ? 'HEAD ' : ''}`;
		if (content?.media == null)
			logMsg += `for no content`;
		else {
			logMsg += `[${content.media.mediaType}] of size [${content?.size ?? 'unknown'}]`;
			if (content.encoding != null)
				logMsg += ` dynamically encoded using [${content.encoding}]`;
		}
		this.trace(logMsg);

		/* mark the response as determined as it will now be sent this way */
		this._state.response = ResponseState.headerSent;
		this._state.respondedResolve();

		/* configure the default header values */
		if (!('Accept-Ranges' in headers))
			headers['Accept-Ranges'] = 'none';
		if (!('Vary' in headers))
			headers['Vary'] = 'Accept-Encoding';
		if (!('Date' in headers))
			headers['Date'] = new Date().toUTCString();
		for (const [key, value] of Object.entries(this.config.commonHeaders)) {
			if (!(key in headers))
				headers[key] = value;
		}
		if (this.config.serverName != '' && !('Server' in headers))
			headers['Server'] = this.config.serverName;
		if (content != null) {
			headers['Content-Type'] = libHelper.buildMediaTypeIdentifier(content.media);
			if (content.size != null)
				headers['Content-Length'] = content.size.toString();
		}

		/* check if its an upgrade request, which is always marked as being closed, as the
		*	underlying web-server will not take it back into the queue for keep-alive sockets */
		if (this._native.socket != null)
			headers['Connection'] = 'close';

		/* perform the header post processing (in reverse order to ensure first added is last executed) */
		for (let i = this._headerPatcher.length - 1; i >= 0; --i) {
			try { this._headerPatcher[i](status, headers); }
			catch (err: any) { this.error(`Unhandled exception in header patcher: ${err.message}`); }
		}

		/* setup the response status and headers (guard against invalid header values) */
		try { this._native.response.setStatus(status.code, status.msg); } catch (_) {
			return this.markAsBroken(`Failed to finalize response: Bad status message`, false);
		}
		for (const [key, value] of Object.entries(headers)) {
			try { this._native.response.setHeader(key, value); } catch (_) {
				this.error(`Failed to set header [${key}]: Bad header value`);
			}
		}
	}
	private sendFullResponse(status: libBase.StatusType, headers: Record<string, string>, content?: { media: libBase.MediaType, body?: Buffer }): void {
		let encoding: libBase.EncodingType | null = null;
		if (content != null) {
			headers['Vary'] = 'Accept-Encoding';

			/* check if the data should be encoded (if the size is not known, pretend the buffer to be large enough) */
			encoding = libHelper.negotiateEncoding(this.headers['accept-encoding'] ?? null, content.body?.byteLength ?? null, content.media);
			if (encoding != null) {
				if (content.body != null)
					content.body = encoding.encodeBuffer(content.body);
				headers['Content-Encoding'] = encoding.name;
			}
		}

		this.closeHeader(status, headers, (content == null ? undefined : { media: content.media, size: content.body?.byteLength, encoding: encoding?.name }));
		this._state.response = ResponseState.completed;

		/* try to finalize the response (can throw an exception for invalid status or header content) */
		try {
			if (!this.isHead && content?.body != null) {
				this.updateThroughput(content.body.length);
				this._native.writer.end(content.body);
			}
			else
				this._native.writer.end();
		} catch (err: any) {
			this.markAsBroken(`Failed to finalize response: ${err.message}`, false);
		}
	}
	private sendClientSetupHeader(resp: HttpRequestResponse, chunk: Buffer | null, cb: (err: any) => void): void {
		const last = (chunk == null);
		const cached = (resp.cache != null);

		/* check if previous data were cached and combine them */
		if (resp.cache != null)
			chunk = (chunk == null ? resp.cache : Buffer.concat([resp.cache, chunk]));
		resp.cache = null;

		/* check if the sending should be deferred to determine if compression
		*	should be enabled or to allow inline compression on small packets
		*	(for a head request, dont cache any data, immediately send the header) */
		if (!last && !this.isHead && (chunk!.byteLength < libBase.MIN_ENCODING_SIZE || !cached)) {
			resp.cache = chunk;
			return cb(null);
		}

		/* for a 'HEAD' request, pretend the size to not be known yet, if it has not been explicitly provided */
		let fullContentSize = resp.contentSize;
		if (fullContentSize == null && last && !this.isHead)
			fullContentSize = (chunk?.byteLength ?? 0);

		/* check if the content should be dynamically encoded */
		if (!resp.dynamicEncode) {
			this.closeHeader(resp.status, resp.headers, { media: resp.contentType, size: fullContentSize ?? undefined });
			return this.sendClientWrite(resp, chunk, last, cb);
		}
		resp.headers['Vary'] = 'Accept-Encoding';

		/* lookup the dynamic encoder (for [head] and no explicit content, default to size being valid to just
		*	assume an encoding - can always be disabled in the real run, should the data be too short) */
		let encoding = libHelper.negotiateEncoding(this.headers['accept-encoding'] ?? null, fullContentSize ?? chunk?.byteLength ?? null, resp.contentType);
		if (encoding == null) {
			this.closeHeader(resp.status, resp.headers, { media: resp.contentType, size: fullContentSize ?? undefined });
			return this.sendClientWrite(resp, chunk, last, cb);
		}
		resp.headers['Content-Encoding'] = encoding.name;
		resp.headers['Accept-Ranges'] = 'none';

		/* for HEAD, clear the content size, as it is not known through the encoder, and for real
		*	requests, check if the header can be encoded inplace (update the content size, as it is now
		*	exact but differs due to being encoded) and otherwise configure the encoding pipeline */
		if (this.isHead)
			fullContentSize = null;
		else if (last) {
			chunk = encoding.encodeBuffer(chunk!);
			resp.contentSize = chunk.byteLength;
			fullContentSize = chunk.byteLength;
		} else {
			fullContentSize = null;
			const encoder = encoding.makeEncode();
			encoder.pipe(resp.writer);
			resp.writer = encoder;

			encoder.once('error', (err: any) => {
				resp.encodingFailed = true;
				resp.destroy(err);
			});
		}

		this.closeHeader(resp.status, resp.headers, { media: resp.contentType, size: fullContentSize ?? undefined, encoding: encoding.name });
		return this.sendClientWrite(resp, chunk, last, cb);
	}
	private sendClientWrite(resp: HttpRequestResponse, chunk: Buffer | null, last: boolean, cb: (err: any) => void): void {
		/* check if this is a head write, in which case the response can
		*	just be marked as completed, and all other data can be drained */
		if (this.isHead) {
			if (this._state.response != ResponseState.headerSent)
				return cb(null);
			this._state.response = ResponseState.completed;
			resp.responseCompleted = true;
			resp.writer.end(() => cb(null));
			return;
		}

		/* update the total-sent counter and check if the upper-bound is broken */
		if (chunk != null) {
			this.updateThroughput(chunk.byteLength);
			resp.totalSent += chunk.byteLength;
			if (resp.contentSize != null && resp.totalSent > resp.contentSize) {
				this.badClientUsage('Sent more data than promised', false);
				return cb(new Error('Sent more data than promised'));
			}
		}

		/* check if this is an intermediate write, and write the data out */
		if (!last) {
			resp.writer.write(chunk!, () => cb(null));
			return;
		}

		/* check if all expected data have been provided */
		if (resp.contentSize != null && resp.totalSent < resp.contentSize) {
			this.badClientUsage('Sent fewer data than promised', false);
			return cb(new Error('Sent fewer data than promised'));
		}

		/* mark the state as completed and sent the last package */
		this._state.response = ResponseState.completed;
		resp.responseCompleted = true;
		if (chunk != null)
			resp.writer.end(chunk, () => cb(null));
		else
			resp.writer.end(() => cb(null));
	}
	private sendClientData(status: libBase.StatusType, media: libBase.MediaType, headers: Record<string, string>, dynamicEncode: boolean, contentSize: number | null): libStream.Writable {
		const makeErrorStream = (msg: string) => new libStream.Writable({ write(_0, _1, cb) { cb(new Error(msg)) }, final(cb) { cb(new Error(msg)) } });

		/* check if the object is already responded */
		if (this._state.response == ResponseState.broken)
			return makeErrorStream('Connection broken');
		if (this._state.response != ResponseState.none) {
			this.badClientUsage('Response on already claimed connection', false);
			return makeErrorStream('Connection already responded');
		}
		this._state.response = ResponseState.acknowledged;

		/* construct the actual response wrapper, which takes care of dynamic encoding and error handling */
		const output = new HttpRequestResponse(this._native.writer, status, headers, contentSize, media, dynamicEncode,
			(chunk: Buffer | null, cb: (err: any) => void) => {
				if (output.destroyed)
					return cb(new Error('Already failed'));

				/* check if the connection has been marked as failed or completed */
				if (this._state.response == ResponseState.completed)
					return cb(new Error('Responding to completed response'));
				if (this._state.response == ResponseState.broken)
					return cb(new Error('Connection broken'));

				/* handle the data accordingly and check for any errors due to malformed headers */
				try {
					if (this._state.response == ResponseState.headerSent)
						return this.sendClientWrite(output, chunk, chunk == null, cb);
					this.sendClientSetupHeader(output, chunk, cb);
				}
				catch (err: any) {
					this.markAsBroken(`Failed to process response: ${err.message}`, false);
					return cb(new Error('Connection broken'));
				}
			},
			(err: any, cb: (err: any) => void) => {
				/* check if the response was already completed, in which case the error must
				*	be ignored, as the encoder might still contain buffered data to be sent */
				if (output.responseCompleted)
					return cb(err);
				output.responseCompleted = true;

				/* check if the output stream was an encoder, in which case it can be destroyed */
				if (output.writer !== this._native.writer)
					output.writer.destroy();

				/* check if the error originated from the data sender and ensure the connection is closed
				*	(cannot be acknowledged for failed encodings, as they can first trigger on already header-sent) */
				if (this._state.response != ResponseState.broken) {
					const description = `${output.encodingFailed ? 'Encoding failure' : 'Response closed prematurely'}: ${err.message}`;
					const closing = (this._state.response == ResponseState.acknowledged);

					if (closing) {
						if (output.encodingFailed)
							this.respondInternalError(description, { headers: { 'Connection': 'close' } });
						else
							this.badClientUsage(description, true);
					}
					this.markAsBroken((closing ? '' : description), closing);
				}
				return cb(err);
			}
		);

		/* register the broken handler to detect closed or failed connections */
		this._state.breakPromise.then(() => output.destroy(new Error('Connection broken')));

		return output;
	}
	private receiveClientData(maxLength: number | null): libStream.Readable {
		const makeErrorStream = (msg: string) => new libStream.Readable({ read() { this.destroy(new Error(msg)) } });

		/* check if the object is ready for receiving */
		if (this._state.receive != ReceiveState.none) {
			this.badClientUsage('Already receiving data', false);
			return makeErrorStream('Connection is already being received');
		}
		if (this._state.response == ResponseState.broken)
			return makeErrorStream('Connection broken');
		this._state.receive = ReceiveState.receiving;

		/* setup the accumulation transformer (which will also be returned in the end; mark receiving
		*	as completed upon destroy - will automatically drain the request on cleanup) */
		let accumulated = 0;
		const output = new libStream.Transform({
			transform: (chunk, _, cb) => {
				if (output.destroyed) return cb(new Error('Already failed'));

				/* check if the connection has been processed or marked as failed */
				if (this._state.response == ResponseState.completed)
					this.badClientUsage('Response completed during active receive', false);
				if (this._state.response == ResponseState.broken)
					return cb(new Error('Connection broken'));

				/* check the maximum count (is violated) */
				this.updateThroughput(chunk.byteLength);
				accumulated += chunk.byteLength;
				if (maxLength == null || accumulated <= maxLength)
					return cb(null, chunk);
				this.respondContentTooLarge(maxLength, accumulated);
				cb(new Error('Request payload is too large'));
			},
			destroy: (err, cb) => {
				if (this._state.receive == ReceiveState.receiving) {
					this._request.unpipe();
					this._state.receive = ReceiveState.completed;
				}
				cb(err);
			},
			final: (cb) => {
				if (this._state.receive == ReceiveState.receiving) {
					this._request.unpipe();
					this._state.receive = ReceiveState.completed;
				}
				cb();
			},

		});

		/* check if the content is encoded and create the chain of decoders (in reverse to ensure the nesting is correct) */
		let stream: libStream.Readable = this._request;
		if (this.headers['content-encoding'] != null) {
			const encodings = libHelper.splitAndTrimList(this.headers['content-encoding'], ',', false);

			for (let i = encodings.length - 1; i >= 0; --i) {
				const encoding = libHelper.lookupEncoding(encodings[i]);

				if (encoding == null) {
					output.destroy();
					this.respondUnsupported(encodings[i], libHelper.supportedEncodingNames().join(','));
					return makeErrorStream('Unsupported content encoding');
				}

				/* configure the piping accordingly */
				const decoder = encoding.makeDecode();
				stream = stream.pipe(decoder);
				decoder.once('error', (err: any) => {
					if (!output.destroyed)
						this.respondBadRequest('Invalid data encoding');
					output.destroy(err);
				});

				/* register the cleanup handler to ensure the decoder is destroyed on completion */
				output.once('close', () => decoder.destroy());
			}
		}

		/* check if too many data have been promised (cannot be trusted if content-encoding is enabled) */
		else if (maxLength != null && this.headers['content-length'] != null) {
			const contentSize = parseInt(this.headers['content-length']);

			/* check if the length is valid and otherwise mark the request as 'consumed' */
			if (!isFinite(contentSize) || contentSize < 0 || contentSize > maxLength) {
				output.destroy();
				this.respondContentTooLarge(maxLength, contentSize);
				return makeErrorStream('Request payload is too large');
			}
		}

		/* register the broken handler to detect closed or failed connections */
		this._state.breakPromise.then(() => output.destroy(new Error('Connection broken')));

		/* create the plumbing between stream and output (errors are already handled) */
		return stream.pipe(output);
	}

	public _pushTranslation(map: Record<string, string | null> | null, identity: string): ClientContext | null {
		let sanitized: Record<string, string | null> | null = null;
		let match: [string, string | null] | null = null;

		/* check if this is only an identity map, in which case nothing complex needs to be evaluated */
		if (map == null || Object.keys(map).length == 1 && map['/'] == '/')
			match = ['/', '/'];

		/* create the merged reverse map and check if the map applies to the current translation */
		else {
			sanitized = {};
			for (const [_from, _to] of Object.entries(map)) {
				const from = libHelper.sanitize(_from, false);
				const to = (_to == null ? null : libHelper.sanitize(_to, false));
				sanitized[from] = to;

				/* check if the mapping can be applied to the current path */
				if (this.isSubPathOf(from) && (match == null || match[0].length < from.length))
					match = [from, to];
			}
			if (match == null || match[1] == null)
				return null;
		}

		const current = new ClientContext(this._path, this.identity, this._translation.length,
			this._throughput.busyCheck.length, this._headerPatcher.length, this._htmlPatcher.length);

		/* setup the new path, all path translations, and the tagged logging identity */
		this._path = libHelper.rebasePath(match[0], match[1]!, this._path);
		if (sanitized != null)
			this._translation.push(sanitized);
		if (identity != '')
			this.logSetIdentity(`${this.identity}.${identity}`);
		return current;
	}
	public _restoreSnapshot(snapshot: ClientContext): void {
		this._path = snapshot.path;
		this.logSetIdentity(snapshot.identity);
		this._translation.splice(snapshot.translationCount);
		this._throughput.busyCheck.splice(snapshot.busyCount);
		this._headerPatcher.splice(snapshot.headerPatchCount);
		this._htmlPatcher.splice(snapshot.htmlPatchCount);
	}
	public static _fromRequest(protocol: string, request: libHttp.IncomingMessage, response: libHttp.ServerResponse, config: BurntClientConfig, server: libServer.Server): ClientRequest {
		return new ClientRequest(server, config, protocol, 'request', request, response);
	}
	public static _fromUpgrade(protocol: string, request: libHttp.IncomingMessage, socket: libStream.Duplex, head: Buffer, config: BurntClientConfig, server: libServer.Server, wss: libWs.WebSocketServer): ClientRequest {
		return new ClientRequest(server, config, protocol, 'upgrade', request, { socket, head, wss });
	}
	public async _finalizeConnection(): Promise<void> {
		/* ensure the connection is default replied with not-found */
		if (this._state.response == ResponseState.none)
			this.respondNotFound();

		/* ensure that the data have been fully received (if the response is already completed,
		*	silently reset to 'header-sent' to ensure the connection is properly marked as broken) */
		if (this._state.receive == ReceiveState.receiving && this._state.response != ResponseState.broken) {
			if (this._state.response == ResponseState.completed)
				this._state.response = ResponseState.headerSent;
			this.badClientUsage('Receive stream not consumed', false);
		}

		/* check if data remain in the pipeline, in which case the connection needs
		*	to be closed to ensure the sender does not pipe more data over */
		const request = this._request;
		if (!request.readableEnded && !request.destroyed && this._state.response != ResponseState.broken) {
			const length = parseInt(this.headers['content-length'] ?? '0');
			const chunked = (this.headers['transfer-encoding'] != null);
			if (length != 0 || chunked)
				this.markAsBroken((request.readableLength > 0 ? 'Uploaded data not consumed' : 'Potential uploaded data not consumed'), true);
		}

		/* check if the upgrade was not fully awaited */
		if (this._state.upgrade == UpgradeState.upgrading && this._state.response != ResponseState.broken)
			this.badClientUsage('Upgrade not fully awaited', false);

		/* ensure that the response was properly sent */
		if (this._state.response != ResponseState.completed && this._state.response != ResponseState.broken)
			this.badClientUsage('Response not completed', false);

		/* check if the connection was an upgrade but was not was accepted, which needs to be
		*	killed, as the underlying web-server will not clean this connection up anymore */
		if (this._native.socket != null && this._state.upgrade != UpgradeState.upgraded && this._state.response != ResponseState.broken)
			this.markAsBroken('Upgrade was not accepted', true);

		/* kill the throughput timer, as it either does not need to be checked anymore, or it
		*	will have left the connection as broken, and will automatically be closed now */
		if (this._throughput.timer != null)
			clearTimeout(this._throughput.timer);
		this._throughput.timer = null;
		this._throughput.active = false;

		/* check if the connection is broken and await its grace cleanup completion */
		if (this._state.response == ResponseState.broken)
			await this._state.breaking!;

		/* recover the original socket timeout (not for sockets, as they take care of the timeout themselves) */
		if (this._state.upgrade != UpgradeState.upgraded || this._state.response != ResponseState.completed)
			this._request.socket.setTimeout(this._native.timeout ?? 0);

		this._state.completedResolve();
	}

	/** respond with an internal error and kill the connection */
	public killConnection(reason: string): void {
		const description = `Connection killed: ${reason}`;
		const closing = (this._state.response == ResponseState.none || this._state.response == ResponseState.acknowledged);

		if (closing)
			this.respondInternalError(description, { headers: { 'Connection': 'close' } });
		this.markAsBroken((closing ? '' : description), closing);
	}

	/** server the client originates from */
	public get server(): libServer.Server {
		return this._server;
	}

	/** cache host used by this server and client */
	public get cache(): libCache.CacheHost {
		return this._server.cache;
	}

	/** request has not yet been acknowledged in any way */
	public get unhandled(): boolean {
		return (this._state.response == ResponseState.none);
	}

	/** request has been acknowledged or already processed */
	public get claimed(): boolean {
		return (this._state.response != ResponseState.none);
	}

	/** resolves whenever the response has been determined (is broken or a response header has been sent) */
	public get responded(): Promise<void> {
		return this._state.respondedPromise;
	}

	/** resolves whenever the request has been fully processed */
	public get completed(): Promise<void> {
		return this._state.completedPromise;
	}

	/** http request headers */
	public get headers(): libHttp.IncomingHttpHeaders {
		return this._request.headers;
	}

	/** http request method */
	public get method(): string {
		return this._request.method ?? '';
	}

	/** was the http request a head request */
	public get isHead(): boolean {
		return (this._request.method == 'HEAD');
	}

	/** return the string formatted media-type (or empty string for no media type) */
	public getMediaType(): string {
		const type = libHelper.splitAndTrimList(this.headers['content-type'] ?? null, ';', true)[0] ?? '';
		return type.toLowerCase();
	}

	/** check the content-type for a media-type and otherwise return the default type */
	public getMediaTypeCharset(defEncoding: string): string {
		const type = this.headers['content-type'];
		if (type == null)
			return defEncoding;

		/* look for the first charset entry in the content-type list */
		for (const part of libHelper.splitAndTrimList(type, ';', true)) {
			if (part.substring(0, 8).toLowerCase() != 'charset=')
				continue;
			let value = part.substring(8).trim();

			/* remove the potential quotes around the charset value */
			const quoted = value.startsWith('"');
			if (quoted != value.endsWith('"'))
				break;
			if (quoted)
				value = value.substring(1, value.length - 1).trim();

			if (value.length == 0)
				break;
			return value.trim().toLowerCase();
		}
		return defEncoding;
	}

	/** ensure the media-type is one of the list and otherwise return null and auto-respond with [unsupported-media-type] (defaults to first type, if [noneIsFirst]) */
	public requireMediaType(types: libBase.MediaType[] | libBase.MediaType, options?: { noneIsFirst?: boolean, headers?: Record<string, string> }): libBase.MediaType | null {
		if (!Array.isArray(types))
			types = [types];

		const type = this.getMediaType();
		if (type == '' && options?.noneIsFirst === true)
			return types[0];

		for (let i = 0; i < types.length; ++i) {
			if (type === types[i].mediaType)
				return types[i];
		}
		this.respondUnsupported(type, types.map(t => t.mediaType).join(','), options);
		return null;
	}

	/** ensure the method is one of the list and otherwise return null and auto-respond with [method-not-allowed]
	 *	if [headExplicit] is false, method will substitute HEAD for GET, framework will consume the remaining body */
	public requireMethod(methods: string[] | string, options?: { headExplicit?: boolean, headers?: Record<string, string> }): string | null {
		if (!Array.isArray(methods))
			methods = [methods];

		if (methods.indexOf(this.method) >= 0)
			return this.method;

		/* check if the HEAD can be converted to a GET */
		const swapAllowed = (options?.headExplicit !== true && methods.indexOf('GET') >= 0 && methods.indexOf('HEAD') < 0);
		if (this.isHead && swapAllowed)
			return 'GET';

		const allowed = methods.join(',') + (swapAllowed ? ',HEAD' : '');
		this.respondMethodNotAllowed(this.method, allowed, options);
		return null;
	}

	/** register a callback to check if the request is still being processed (delays throughput
	 *	termintion and resets connection timeout; will only be considered within this handler context) */
	public busyCheck(cb: () => boolean): void {
		this._throughput.busyCheck.push(cb);
	}

	/** register a callback to be invoked once the response is sent, to adjust the
	 *	headers to be sent (will only be considered within this handler context) */
	public patchHeaders(cb: HeaderPatch): void {
		this._headerPatcher.push(cb);
	}

	/** register a callback to be invoked if html is built, to adjust the headers or
	 *	the content to be sent (will only be considered within this handler context) */
	public patchHtmlPage(cb: HtmlPatch): void {
		this._htmlPatcher.push(cb);
	}

	/** respond with [internal-error] and a default text response (always considered an error; reason is logged server-side only); cache policy defaults to [sensitive] */
	public respondInternalError(reason: string, options?: { headers?: Record<string, string>, cache?: CachePolicy }): void {
		const header = (options?.headers ?? {});
		this.applyCachePolicy(header, CachePolicy.sensitive, options?.cache);

		this.constructQuickResponse(libBase.Status.InternalError, `Failure Reason (not sent): ${reason}`, header, {
			media: libBase.Media.Text, body: Buffer.from(`An internal server error occurred while processing the request for [${this.url.pathname}].`, 'utf-8')
		});
	}

	/** respond with [forbidden] and a default text response (reason is logged server-side only); cache policy defaults to [sensitive] */
	public respondForbidden(reason: string, options?: { headers?: Record<string, string>, cache?: CachePolicy }): void {
		const header = (options?.headers ?? {});
		this.applyCachePolicy(header, CachePolicy.sensitive, options?.cache);

		this.constructQuickResponse(libBase.Status.Forbidden, `Forbidden Reason (not sent): ${reason}`, header, {
			media: libBase.Media.Text, body: Buffer.from(`Access to [${this.url.pathname}] denied.`, 'utf-8')
		});
	}

	/** respond with a any response of the given configuration (defaults to media-type: text/unknown/-, status: ok); if [lightResponse], the
	 *	content length is suppressed for head responses (to accomodate short-circuiting responding); cache policy defaults to [private] */
	public respond(content: string | Buffer | null, options?: { media?: libBase.MediaType, status?: libBase.StatusType, headers?: Record<string, string>, lightResponse?: boolean, cache?: CachePolicy }): void {
		const status = options?.status ?? libBase.Status.Ok;
		const header = (options?.headers ?? {});
		this.applyCachePolicy(header, CachePolicy.private, options?.cache);

		if (content == null)
			return this.constructQuickResponse(status, 'no body', header, null);

		let media = options?.media ?? libBase.Media.Text;
		if (typeof content == 'string')
			content = Buffer.from(content, 'utf-8');
		else if (options?.media == null)
			media = libBase.Media.Unknown;

		this.constructQuickResponse(status, `[${media.mediaType}] and size [${content.byteLength}]`, header, {
			media, body: (options?.lightResponse && this.isHead ? undefined : content)
		});
	}

	/** respond with [ok] and either a message or a default response; cache policy defaults to [private] */
	public respondOk(options?: { message?: string, headers?: Record<string, string>, cache?: CachePolicy }): void {
		const header = (options?.headers ?? {});
		this.applyCachePolicy(header, CachePolicy.private, options?.cache);

		this.constructQuickResponse(libBase.Status.Ok, options?.message ?? null, header, {
			media: libBase.Media.Text, body: Buffer.from(options?.message ?? `${this.method} was successful for [${this.url.pathname}].`, 'utf-8')
		});
	}

	/** respond with [created] and either a message or a default response (ensure target is properly URI encoded); cache policy defaults to [private] */
	public respondCreated(target: string, options?: { headers?: Record<string, string>, cache?: CachePolicy }): void {
		const header = (options?.headers ?? {});
		header['Location'] = target;
		this.applyCachePolicy(header, CachePolicy.private, options?.cache);

		this.constructQuickResponse(libBase.Status.Created, target, header, {
			media: libBase.Media.Text, body: Buffer.from(`Resource [${this.url.pathname}] successfully created:\n${target}`, 'utf-8')
		});
	}

	/** respond with [not-modified] and no body (ensure the etag and/or last-modified is set); cache policy defaults to [private] */
	public respondNotModified(options?: { etag?: string, lastModified?: string, headers?: Record<string, string>, cache?: CachePolicy }): void {
		const header = (options?.headers ?? {});
		if (options?.etag != null && !('ETag' in header))
			header['ETag'] = options.etag;
		if (options?.lastModified != null && !('Last-Modified' in header))
			header['Last-Modified'] = options.lastModified;
		this.applyCachePolicy(header, CachePolicy.private, options?.cache);

		this.constructQuickResponse(libBase.Status.NotModified, null, header, null);
	}

	/** respond with [precondition-failed] and a default text response (ensure the etag and/or last-modified is set); cache policy defaults to [private] */
	public respondPreconditionFailed(reason: string, options?: { etag?: string, lastModified?: string, headers?: Record<string, string>, cache?: CachePolicy }): void {
		const header = (options?.headers ?? {});
		if (options?.etag != null && !('ETag' in header))
			header['ETag'] = options.etag;
		if (options?.lastModified != null && !('Last-Modified' in header))
			header['Last-Modified'] = options.lastModified;
		this.applyCachePolicy(header, CachePolicy.private, options?.cache);

		this.constructQuickResponse(libBase.Status.PreconditionFailed, reason, header, {
			media: libBase.Media.Text, body: Buffer.from(`Precondition for resource [${this.url.pathname}] failed:\n${reason}`, 'utf-8')
		});
	}

	/** respond with [bad-request] and a default text response; cache policy defaults to [private] */
	public respondBadRequest(reason: string, options?: { headers?: Record<string, string>, cache?: CachePolicy }): void {
		const header = (options?.headers ?? {});
		this.applyCachePolicy(header, CachePolicy.private, options?.cache);

		this.constructQuickResponse(libBase.Status.BadRequest, reason, header, {
			media: libBase.Media.Text, body: Buffer.from(`Request for [${this.url.pathname}] is perceived as malformed:\n${reason}`, 'utf-8')
		});
	}

	/** respond with [range-not-satisfiable] and a default text response; cache policy defaults to [private] */
	public respondRangeIssue(range: string, size: number, options?: { headers?: Record<string, string>, cache?: CachePolicy }): void {
		const header = (options?.headers ?? {});
		header['Content-Range'] = `bytes */${size}`;
		this.applyCachePolicy(header, CachePolicy.private, options?.cache);

		this.constructQuickResponse(libBase.Status.RangeIssue, `[${range}] cannot be satisfied for size [${size}]`, header, {
			media: libBase.Media.Text, body: Buffer.from(`Range [${range}] cannot be satisfied for [${this.url.pathname}] of size ${size}.`, 'utf-8')
		});
	}

	/** respond with [conflict] and a default text response; cache policy defaults to [private] */
	public respondConflict(conflict: string, options?: { headers?: Record<string, string>, cache?: CachePolicy }): void {
		const header = (options?.headers ?? {});
		this.applyCachePolicy(header, CachePolicy.private, options?.cache);

		this.constructQuickResponse(libBase.Status.Conflict, conflict, header, {
			media: libBase.Media.Text, body: Buffer.from(`Conflict for resource [${this.url.pathname}]:\n${conflict}`, 'utf-8')
		});
	}

	/** respond with [not-found] and a default text response; cache policy defaults to [private] */
	public respondNotFound(options?: { headers?: Record<string, string>, cache?: CachePolicy }): void {
		const header = (options?.headers ?? {});
		this.applyCachePolicy(header, CachePolicy.private, options?.cache);

		this.constructQuickResponse(libBase.Status.NotFound, null, header, {
			media: libBase.Media.Text, body: Buffer.from(`Resource [${this.url.pathname}] could not be found.`, 'utf-8')
		});
	}

	/** respond with [unsupported-media-type] and a default text response; cache policy defaults to [private] */
	public respondUnsupported(used: string, allowed: string, options?: { headers?: Record<string, string>, cache?: CachePolicy }): void {
		const header = (options?.headers ?? {});
		this.applyCachePolicy(header, CachePolicy.private, options?.cache);

		this.constructQuickResponse(libBase.Status.UnsupportedMediaType, `Allowed was [${allowed}] but [${used}] was used`, header, {
			media: libBase.Media.Text, body: Buffer.from(`Media type [${used}] not supported for [${this.url.pathname}].\nAllowed: ${allowed}`, 'utf-8')
		});
	}

	/** respond with [method-not-allowed] and a default text response; cache policy defaults to [private] */
	public respondMethodNotAllowed(method: string, allowed: string, options?: { headers?: Record<string, string>, cache?: CachePolicy }): void {
		const header = (options?.headers ?? {});
		header['Allow'] = allowed;
		this.applyCachePolicy(header, CachePolicy.private, options?.cache);

		this.constructQuickResponse(libBase.Status.MethodNotAllowed, `Allowed was [${allowed}] but [${method}] was used`, header, {
			media: libBase.Media.Text, body: Buffer.from(`Method ${method} not allowed for [${this.url.pathname}].\nAllowed: ${allowed}.`, 'utf-8')
		});
	}

	/** respond with [request-timeout] and a default text response; cache policy defaults to [private] */
	public respondRequestTimeout(reason: string, options?: { headers?: Record<string, string>, cache?: CachePolicy }): void {
		const header = (options?.headers ?? {});
		header['Connection'] = 'close';
		this.applyCachePolicy(header, CachePolicy.private, options?.cache);

		this.constructQuickResponse(libBase.Status.RequestTimeout, reason, header, {
			media: libBase.Media.Text, body: Buffer.from(`Request processing of [${this.url.pathname}] timed out:\n${reason}`, 'utf-8')
		});
	}

	/** respond with [content-too-large] and a default text response; cache policy defaults to [private] */
	public respondContentTooLarge(allowed: number, atLeastProvided: number, options?: { headers?: Record<string, string>, cache?: CachePolicy }): void {
		const header = (options?.headers ?? {});
		this.applyCachePolicy(header, CachePolicy.private, options?.cache);

		this.constructQuickResponse(libBase.Status.ContentTooLarge, `[${atLeastProvided}] > [${allowed}]`, header, {
			media: libBase.Media.Text, body: Buffer.from(`Content of at least size ${atLeastProvided} too large for [${this.url.pathname}].\nAt most ${allowed} bytes are allowed.`, 'utf-8')
		});
	}

	/** respond with [update-required] and a default text response; cache policy defaults to [private] */
	public respondUpdateRequired(upgrade: string, options?: { headers?: Record<string, string>, cache?: CachePolicy }): void {
		const header = (options?.headers ?? {});
		if (!('Connection' in header))
			header['Connection'] = 'upgrade';
		header['Upgrade'] = upgrade;
		this.applyCachePolicy(header, CachePolicy.private, options?.cache);

		this.constructQuickResponse(libBase.Status.UpgradeRequired, `Required: ${upgrade}`, header, {
			media: libBase.Media.Text, body: Buffer.from(`Endpoint [${this.url.pathname}] requires an upgrade.\nRequired: ${upgrade}`, 'utf-8')
		});
	}

	/** respond with [see-other] to the given target and a default text response (forces method
	 *	GET; ensure target is properly URI encoded); cache policy defaults to [private] */
	public respondSeeOther(target: string, options?: { headers?: Record<string, string>, cache?: CachePolicy }): void {
		const header = (options?.headers ?? {});
		header['Location'] = target;
		this.applyCachePolicy(header, CachePolicy.private, options?.cache);

		this.constructQuickResponse(libBase.Status.SeeOther, target, header, {
			media: libBase.Media.Text, body: Buffer.from(`Continue at: ${target}`, 'utf-8')
		});
	}

	/** respond with [temporary-redirect] to the given target and a default text response (preserves
	 *	method; ensure target is properly URI encoded); cache policy defaults to [private] */
	public respondTemporaryRedirect(target: string, options?: { headers?: Record<string, string>, cache?: CachePolicy }): void {
		const header = (options?.headers ?? {});
		header['Location'] = target;
		this.applyCachePolicy(header, CachePolicy.private, options?.cache);

		this.constructQuickResponse(libBase.Status.TemporaryRedirect, target, header, {
			media: libBase.Media.Text, body: Buffer.from(`Resource [${this.url.pathname}] temporarily redirects to:\n${target}`, 'utf-8')
		});
	}

	/** respond with [permanent-redirect] to the given target and a default text response (preserves
	 *	method; ensure target is properly URI encoded); cache policy defaults to [private] */
	public respondPermanentRedirect(target: string, options?: { headers?: Record<string, string>, cache?: CachePolicy }): void {
		const header = (options?.headers ?? {});
		header['Location'] = target;
		this.applyCachePolicy(header, CachePolicy.private, options?.cache);

		this.constructQuickResponse(libBase.Status.PermanentRedirect, target, header, {
			media: libBase.Media.Text, body: Buffer.from(`Resource [${this.url.pathname}] permanently redirects to:\n${target}`, 'utf-8')
		});
	}

	/** respond with html, can be built on by parent modules, sent once the request has been fully processed (default status is
	 *	ok; for HEAD builds, no actual content will be constructed or estimated in size); cache policy defaults to [private] */
	public async respondHtml(page: libBuilder.HtmlPage, options?: { status?: libBase.StatusType, headers?: Record<string, string>, cache?: CachePolicy }): Promise<void> {
		if (this._state.response != ResponseState.none)
			return this.badClientUsage('HTML response on already claimed connection', false);

		this._state.response = ResponseState.acknowledged;
		const status = (options?.status ?? libBase.Status.Ok);
		const headers = (options?.headers ?? {});
		this.applyCachePolicy(headers, CachePolicy.private, options?.cache);

		/* invoke all registered html patcher to let them modify the content (in reverse order to ensure
		*	first added is last executed, and check if one of them produced an alternate response) */
		for (let i = this._htmlPatcher.length - 1; i >= 0; --i) {
			try {
				await this._htmlPatcher[i](page, status, headers);
				if (this._state.response != ResponseState.acknowledged)
					return;
			} catch (err: any) {
				this.badClientUsage(`Unhandled exception in HTML patcher: ${err.message}`, false);
				return;
			}
		}
		const content = (this.isHead ? undefined : Buffer.from(page.finalize(), 'utf-8'));

		/* mark first as completed now */
		this.log(`Responding with HTML content and status [${status.msg}]${this.isHead ? ' as light-build' : ''}`);
		this.sendFullResponse(status, headers, { media: libBase.Media.Html, body: content });
	}

	/** [no-throw but errors] send data with [media type] and [status] and return a writable stream (default: status is ok, media is unknown,
	 *	dynamicEncode is true); if a content size is provided, stream expects exactly this amount of bytes; if [dynamicEncode], the encoder
	 *	will be dynamically negotiated based on the content; for a HEAD request, no encoding will be negotiated, no lengths verified, and
	 *	the written data will just be drained (can immediately be ended using '.end()'); cache policy defaults to [private] */
	public respondData(options?: { status?: libBase.StatusType, media?: libBase.MediaType, contentSize?: number, dynamicEncode?: boolean, headers?: Record<string, string>, cache?: CachePolicy }): libStream.Writable {
		const status: libBase.StatusType = options?.status ?? libBase.Status.Ok;
		const headers = (options?.headers ?? {});
		this.applyCachePolicy(headers, CachePolicy.private, options?.cache);

		this.log(`Responding with data and status [${status.msg}]`);
		return this.sendClientData(status, options?.media ?? libBase.Media.Unknown, headers, options?.dynamicEncode ?? true, options?.contentSize ?? null);
	}

	/** try to respond with the given file, return false, if the file does not exist (range aware, HEAD aware); specify [checkFreshness]
	 *	to re-validate the file stats on disk before serving from cache; the media type can be overwritten (defaults to extracting
	 *	media-type from the file-path); [encoding] describes the encoding of a pre-encoded file (warning: no checks against
	 *	accepted encodings performed!); status will be [Ok], [partial-content], [not-modified] or according errors cache aware and
	 *	etag/last-modified aware; cache policy defaults to [immutable] for versioned paths, or [static] otherwise */
	public async tryRespondFile(filePath: string, options?: { encoded?: string, media?: libBase.MediaType, headers?: Record<string, string>, checkFreshness?: boolean, cache?: CachePolicy }): Promise<boolean> {
		if (options == null)
			options = {};
		if (this._state.response != ResponseState.none) {
			this.badClientUsage('File response on already claimed connection', false);
			return true;
		}

		/* read the entry from the cache and check if it has been permanently moved and apply the move */
		let cached: libCache.Cached | string | null = null;
		try {
			cached = this.cache.fetchImmutable(filePath, { checkFreshness: options.checkFreshness });
			if (cached == null)
				return false;
		}
		catch (err: any) {
			this.respondInternalError(`Failed to read file [${filePath}]: ${err.message}`);
			return true;
		}
		if (typeof cached == 'string') {
			this.respondPermanentRedirect(cached);
			return true;
		}

		/* parse the range and ensure that its well formed */
		const range = libHelper.parseRangeHeader(this.headers.range ?? null, cached.fileSize());
		if (range.state == libHelper.RangeState.malformed) {
			this.respondBadRequest(`Issues while parsing http-header range: [${this.headers.range}]`);
			return true;
		}
		else if (range.state == libHelper.RangeState.issue) {
			this.respondRangeIssue(this.headers.range!, cached.fileSize());
			return true;
		}

		/* update the cached reader to read the encoded content (no encoding if already encoded or a range request has occurred,
		*	as the encoded byte representation might not be stable; this is also the reason why the e-tag must be forced to weak,
		*	as the content cannot be guaranteed to be stabled across cache flushes or reloads) */
		const media = (options.media ?? libHelper.lookupMediaTypeFromFile(filePath) ?? libBase.Media.Unknown);
		let dynamicEncoder = ((options.encoded != null || range.state != libHelper.RangeState.noRange) ? null : libHelper.negotiateEncoding(this.headers['accept-encoding'] ?? null, cached.fileSize(), media));
		let reader: null | libCache.EncodedCache = null;
		if (dynamicEncoder != null)
			reader = cached.encoded(dynamicEncoder);

		/* mark byte-ranges to be supported in principle and add the caching properties */
		const headers = (options.headers ?? {});
		const etag = `${(dynamicEncoder != null) ? 'W/' : ''}"${cached.uniqueId()}"`;
		headers['Vary'] = 'Accept-Encoding';
		if (dynamicEncoder != null || options.encoded != null)
			headers['Content-Encoding'] = dynamicEncoder?.name ?? options.encoded!;
		headers['Accept-Ranges'] = (dynamicEncoder != null ? 'none' : 'bytes');
		headers['Last-Modified'] = cached.lastModified();
		headers['ETag'] = etag;
		this.applyCachePolicy(headers, (cached.isImmutable() ? CachePolicy.immutable : CachePolicy.static), options?.cache);

		/* validate the conditions (e-tag more relevant than last-modified; invalid times are not
		*	considered errors; no need to set etag/last-modified, as they are already set) */
		if (this.headers['if-match'] != null) {
			if (!libHelper.etagMatchesList(etag, this.headers['if-match'], true)) {
				this.respondPreconditionFailed(`New etag [${etag}]`, { headers });
				return true;
			}
		}
		else if (this.headers['if-unmodified-since'] != null) {
			const result = libHelper.timestampCompare(cached.lastModified(), this.headers['if-unmodified-since']);
			if (result != null && result > 0) {
				this.respondPreconditionFailed(`Modified at [${cached.lastModified()}]`, { headers });
				return true;
			}
		}

		/* check if the response can be skipped due to the resource not having been modified since
		*	the last fetch (etag outweighs last-modified; invalid times are not considered errors) */
		if (this.headers['if-none-match'] != null) {
			if (libHelper.etagMatchesList(etag, this.headers['if-none-match'], false)) {
				this.respondNotModified({ headers });
				return true;
			}
		}
		else if (this.headers['if-modified-since'] != null) {
			const result = libHelper.timestampCompare(cached.lastModified(), this.headers['if-modified-since']);
			if (result != null && result <= 0) {
				this.respondNotModified({ headers });
				return true;
			}
		}

		/* check if the file is empty (can only happen for unused ranges, which would otherwise have issues) */
		if ((reader == null ? cached.fileSize() : reader.contentSize()) === 0) {
			this.log(`Sending empty content for [${filePath}]`);
			this.sendFullResponse(libBase.Status.Ok, headers, { media, body: Buffer.alloc(0) });
			return true;
		}
		if (range.state == libHelper.RangeState.valid)
			headers['Content-Range'] = `bytes ${range.first}-${range.last}/${cached.fileSize()}`;

		/* create the writer stream (doesn't throw, but errors; enforce the selected encoder) */
		const status = (range.state == libHelper.RangeState.noRange ? libBase.Status.Ok : libBase.Status.PartialContent);
		let stream = this.sendClientData(status, media, headers, false, (reader == null ? range.last - range.first + 1 : reader.contentSize()));

		let logMsg = `Responding with file-${this.isHead ? 'HEAD' : 'content'} [${range.first} - ${range.last}/${cached.fileSize()}] from [${filePath}]`;
		if (reader != null) {
			logMsg += ` encoded using [${dynamicEncoder!.name}]`;
			if (reader.contentSize() != null)
				logMsg += ` from cache as [${reader.contentSize()}] bytes`;
		}
		this.log(logMsg);

		/* check if this is a head request, in which case the stream can just immediately be closed again, to prevent
		*	the file from consuming resources (null-catch any errors to ensure they are not propagated out of the connection) */
		if (this.isHead) {
			stream.once('error', () => { });
			return new Promise((resolve) => stream.end(() => resolve(true)));
		}

		/* create the source stream of the file to read from (will not throw any exceptions) */
		let source: libStream.Readable = (reader != null ? reader.stream() : cached.stream({ start: range.first, end: range.last }));

		/* pipe the components together and await completion */
		let settled = false;
		return new Promise((resolve) => {
			source.pipe(stream);
			source.once('error', (err: any) => {
				if (settled) return; settled = true;
				this.respondInternalError(`Failed to stream file [${filePath}]: ${err.message}`);
				stream.destroy(err);
			});
			stream.once('error', (err: any) => {
				if (settled) return; settled = true;
				source.destroy(err);
			});
			stream.once('close', () => {
				settled = true;
				resolve(true);
			});
		});
	}

	/** [throws] receive the payload of given max length and write it directly to a file; will fail
	 *	if the file already exists and delete the file if it could not be received in full
	 *	automatically responds with given exceptions if the payload cannot be received properly or file operations fail */
	public async receiveToFile(path: string, maxLength: number | null): Promise<void> {
		this.trace(`Collecting data from [${this.url.pathname}] to: [${path}]`);
		return new Promise((resolve, reject) => {
			let source: libStream.Readable = this.receiveClientData(maxLength);

			/* create the stream to the file to be written and setup the plumbing */
			const destination = libFs.createWriteStream(path, { flags: 'wx' });
			let fileFailed = false, sourceFailed = false, opened = false;
			source.once('error', (err: any) => {
				sourceFailed = true;
				destination.destroy(err);
			});
			destination.once('open', () => {
				opened = true;
				if (!sourceFailed)
					source.pipe(destination);
				else
					destination.destroy();
			});
			destination.once('error', (err: any) => {
				if (!sourceFailed)
					this.respondInternalError(`Failed to write uploaded file: ${err.message}`);
				fileFailed = true;

				/* destroy the source to clean up the receiving pipeline (will
				*	not close the underlying request, just the pass-through reader) */
				source.destroy();

				/* check if the file was opened and remove it */
				if (!opened)
					return reject(err);
				libFs.unlink(path, (err2: any) => {
					if (err2 != null)
						this.error(`Failed to remove temporary file [${path}]: ${err2.message}`);
					reject(err);
				});
			});
			destination.once('close', () => {
				if (!sourceFailed && !fileFailed)
					resolve();
			});
		});
	}

	/** [no-throw but errors] receive the payload of given max length as a readable stream
	 *	automatically responds with given exceptions if the payload cannot be received properly
	 *	automatically drained if the readable stream is destroyed before reading all data */
	public receiveData(maxLength: number | null): libStream.Readable {
		return this.receiveClientData(maxLength);
	}

	/** [throws] receive the payload of given max length as a single complete buffer
	 *	automatically responds with given exceptions if the payload cannot be received properly */
	public async receiveAllBuffer(maxLength: number | null): Promise<Buffer> {
		return new Promise((resolve, reject) => {
			let stream: libStream.Readable = this.receiveClientData(maxLength);

			const buffers: Buffer[] = [];
			stream.on('data', (chunk: Buffer) => buffers.push(chunk));
			stream.once('end', () => resolve(Buffer.concat(buffers)));
			stream.once('error', (err: any) => reject(err));
		});
	}

	/** [throws] receive the payload of given max length as a single complete decoded string
	 *	automatically responds with given exceptions if the payload cannot be received properly */
	public async receiveAllText(encoding: string, maxLength: number | null): Promise<string> {
		/* wait for the buffer (let all errors propagate out) */
		const buffer: Buffer = await this.receiveAllBuffer(maxLength);

		try {
			return buffer.toString(encoding as BufferEncoding);
		} catch (err: any) {
			this.respondBadRequest('Unable to decode content');
			throw err;
		}
	}

	/** marks the object as having been handled and returns a web socket or
	 *	automatically responds with a corresponding error and returns null */
	public async acceptWebSocket(): Promise<ClientSocket | null> {
		if (this._state.response != ResponseState.none) {
			this.badClientUsage('WebSocket upgrade on already claimed connection', false);
			return null;
		}

		/* check if the connection is a valid upgrade request (and ensure that the underlying web-server, also detected it) */
		let connection = libHelper.splitAndTrimList(this.headers.connection?.toLowerCase() ?? null, ',', false);
		if (connection.indexOf('upgrade') == -1 || this.headers?.upgrade?.toLowerCase() != 'websocket' || this.method != 'GET') {
			this.respondUpdateRequired('websocket');
			return null;
		}
		if (this._native.socket == null) {
			this.respondInternalError('Request was not provided as upgradable');
			return null;
		}
		const native = this._native.socket;

		/* mark the connection as being accepted */
		this._state.response = ResponseState.headerSent;
		this._state.respondedResolve();
		this._state.upgrade = UpgradeState.upgrading;
		this.trace(`Performing upgrade on web socket connection: [${this.url.pathname}]`);

		/* await the actual websocket upgrade */
		const ws = await new Promise<ClientSocket | null>((resolve) => {
			let settled = false;

			/* register the broken listener (to detect failures of the upgrading or network errors) */
			this._state.breakPromise.then(() => {
				if (settled) return; settled = true;
				this.error('Failed to upgrade to WebSocket');
				resolve(null);
			});

			/* start the upgrade process (web-socket upgrade handler will automatically send error messages) */
			native.wss.handleUpgrade(this._request, native.socket, native.head, (ws, _) => {
				if (!settled && this._state.response == ResponseState.headerSent) {
					settled = true, this._state.response = ResponseState.completed;

					/* ensure that the socket is valid as otherwise proper cleanup might not be guaranteed (no
					*	need to log errors, as this will trigger the broken state, which will be logged) */
					if (native.socket.destroyed)
						return resolve(null);

					/* clear the socket timeout (should already have been done in the first place by the web-socket-server) */
					this._request.socket.setTimeout(0);
					return resolve(ClientSocket._fromRequest(ws, this));
				}
				settled = true;
				this.markAsBroken('Broken connection upgraded', false);
				resolve(null);
			});
		});
		this._state.upgrade = UpgradeState.upgraded;
		return ws;
	}
}

/**
 *	WebSocket with integrated alive checks.
 *	Structured WebSocket, which takes care of error handling.
 *	The 'close' event is guaranteed to fire exactly once and no 'data' events will follow.
 *	Takes ownership of the socket.
 */
export class ClientSocket extends ClientBase {
	private _ws: libWs.WebSocket;
	private _alive: {
		timer: null | NodeJS.Timeout;
		isAlive: boolean;
	};
	private _closing: {
		promise: Promise<void> | null;
		closed: (() => void) | null, defer: number;
	};
	private _emitter: libEvents.EventEmitter;
	private _log: {
		self: string;
		root: string;
		tagList: { value: string }[];
	}

	private constructor(ws: libWs.WebSocket, source: ClientRequest) {
		super(source, 'socket', source.config);
		this._ws = ws;
		this._alive = { timer: null, isAlive: true };
		this._closing = { promise: null, closed: null, defer: 0 };
		this._emitter = new libEvents.EventEmitter();

		this._ws.on('pong', () => {
			this.trace(`Alive check pong received`, { identity: this._log.self });
			this.selfIsAlive();
		});
		this._ws.on('message', (data) => {
			this.selfIsAlive();
			if (this._closing.promise != null || this._emitter.listenerCount('data') == 0)
				return;

			++this._closing.defer;
			const buffer: Buffer = (Buffer.isBuffer(data) ? data : (Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data)));
			this.emitEventSync('data', buffer);
			--this._closing.defer;

			if (this._closing.promise != null)
				this.handleClosing();
		});
		this._ws.once('close', () => {
			this.handleClosing();

			/* check if any timers remain (must be the grace-kill timer, can be stopped, as this point can
			*	only be reached with an active timer, if defer was somehow still > 0, in which case its
			*	nested leaving will trigger the proper cleanup, but the timer is not necessary anymore) */
			if (this._alive.timer != null)
				clearTimeout(this._alive.timer);
			this._alive.timer = null;
		});
		this._ws.once('error', (err: any) => {
			this.handleClosing(`WebSocket error: ${err.message}`);
		});

		/* perserve the root identity for internal logs and the log extension of the base for open logs */
		this._log = { self: this.identity, root: '', tagList: [] };
		source.log(`WebSocket accepted: [${this.identity}]`);
		const extIndex = source.identity.indexOf('.');
		if (extIndex > 0)
			this.logSetIdentity(`${this.identity}${source.identity.substring(extIndex)}`);
		this._log.root = this.identity;

		/* start the first alive check (no need to consider the socket timeout, as it will have been cleared already) */
		this.selfIsAlive();
	}
	private checkIsAlive(): void {
		if (this._closing.promise != null)
			return;

		this._alive.timer = null;
		if (this.config.webSocketTimeout == 0)
			return;

		/* check if the connection is not alive anymore and should be killed */
		if (!this._alive.isAlive || this.config.webSocketAliveTimeout == 0)
			return this.handleClosing('Closing dead websocket');
		this._alive.isAlive = false;
		this._alive.timer = setTimeout(() => this.checkIsAlive(), this.config.webSocketAliveTimeout);

		/* try to ping the remote to check the liveliness */
		try {
			this.trace(`Sending ping to determine if connection is alive`, { identity: this._log.self });
			this._ws.ping();
		} catch (err: any) {
			this.handleClosing(`WebSocket error while pinging: ${err.message}`);
		}
	}
	private selfIsAlive(): void {
		this._alive.isAlive = true;
		if (this._closing.promise != null)
			return;

		if (this._alive.timer != null)
			clearTimeout(this._alive.timer);
		this._alive.timer = (this.config.webSocketTimeout == 0 ? null : setTimeout(() => this.checkIsAlive(), this.config.webSocketTimeout));
	}
	private handleClosing(terminate?: string): void {
		/* register the initial closing to mark a closing being imminent */
		if (this._closing.promise == null) {
			this._closing.promise = new Promise<void>((res) => this._closing.closed = res);

			/* kill the last timer (alive timer) */
			if (this._alive.timer != null)
				clearTimeout(this._alive.timer);
			this._alive.timer = null;

			/* check if a termination should be triggered and otherwise start the grace termination timer */
			if (terminate != null) {
				this.error(terminate, { identity: this._log.self });
				this._ws.terminate();
			}
			else {
				this._alive.timer = setTimeout(() => {
					this._alive.timer = null;
					if (this._closing.closed != null) {
						this.error('Closing connection', { identity: this._log.self });
						this._ws.terminate();
					}
				}, this.config.killGraceTimeout);
			}
		}

		if (this._closing.closed == null || this._closing.defer > 0)
			return;
		const closed = this._closing.closed;
		this._closing.closed = null;

		this.emitEventSync('close');
		this.trace('Socket connection closed', { identity: this._log.self });

		closed();
	}
	private updateLogIdentity(): void {
		let identity = this._log.root;

		for (const tag of this._log.tagList) {
			if (tag.value != '')
				identity += `.${tag.value}`;
		}

		this.logSetIdentity(identity);
	}

	public static _fromRequest(ws: libWs.WebSocket, source: ClientRequest) {
		return new ClientSocket(ws, source);
	}

	/** send data to the remote (ignored if connection is being closed) */
	public send(data: string | Buffer): void {
		if (this._closing.promise != null)
			return;

		try {
			this._ws.send(data);
		} catch (err: any) {
			this.handleClosing(`WebSocket error while sending data: ${err.message}`);
		}
	}

	/** close the web socket (promise resolved once the close callback has been fully invoked) */
	public close(): Promise<void> {
		if (this._closing.promise == null) {
			this._ws.close();
			this.handleClosing();
		}
		return this._closing.promise!;
	}

	/** tag the logging with the given identifier and return a callback to update the tag */
	public tagLog(identifier: string): SocketLogTag {
		let tag: { value: string } | null = { value: identifier };

		this._log.tagList.push(tag);
		if (tag.value != '')
			this.updateLogIdentity();

		/* setup the handler responsible to update the logging */
		return (value?: string) => {
			if (tag == null) return;

			/* check if the tag should be removed or if the value should just be updated */
			if (value == null) {
				this._log.tagList = this._log.tagList.filter((v) => v != tag);
				tag = null;
			}
			else if (value != tag.value)
				tag.value = value;

			this.updateLogIdentity();
		};
	}

	/* -------- event handler interfaces -------- */
	public on<K extends keyof ClientSocketEvents>(event: K, listener: ClientSocketEvents[K]): ClientSocket {
		this._emitter.on(event, listener); return this;
	}
	public off<K extends keyof ClientSocketEvents>(event: K, listener: ClientSocketEvents[K]): ClientSocket {
		this._emitter.off(event, listener); return this;
	}
	public once<K extends keyof ClientSocketEvents>(event: K, listener: ClientSocketEvents[K]): ClientSocket {
		this._emitter.once(event, listener); return this;
	}
	private emitEventSync<K extends keyof ClientSocketEvents>(event: K, ...args: Parameters<ClientSocketEvents[K]>): void {
		try {
			this._emitter.emit(event, ...args);
		}
		catch (err: any) {
			this.error(`Unhandled exception in ${event} listener: ${err.message}`, { identity: this._log.self });
		}
	}
}

export interface ClientConfig {
	/** default server name to be used in the http:server header [empty value prevents server header; Default: 'Modular Web Server'] */
	serverName?: string;

	/** default header values to be added to every http response [Default: { 'X-Content-Type-Options': 'nosniff' }] */
	commonHeaders?: Record<string, string>;

	/** default web-socket timeout before performing a ping to determine liveness [0 disables the timeout; in milliseconds; Default: 180_000] */
	webSocketTimeout?: number;

	/** default web-socket timeout to respond to a liveness ping before closing the connection [0 kills the connection without ping test; in milliseconds; Default: 2_000] */
	webSocketAliveTimeout?: number;

	/** time for a broken connection or socket to receive the response before force-closing it [0 results in immediate close; in milliseconds; Default: 1_000] */
	killGraceTimeout?: number;

	/** cache-control values per cache policy */
	cache?: {
		/** default cache-control value for immutable content reads [empty string does not set any cache-control; Default: 'public, max-age=2592000, immutable' (30 days)] */
		immutable?: string;

		/** default cache-control value for normal content reads [empty string does not set any cache-control; Default: 'public, no-cache'] */
		static?: string;

		/** default cache-control value for any basic responses [empty string does not set any cache-control; Default: 'private, no-cache'] */
		private?: string;

		/** default cache-control value for any sensitive responses [empty string does not set any cache-control; Default: 'no-cache, no-store, max-age=0, must-revalidate'] */
		sensitive?: string;

		/** default cache-control value for no cache policy [empty string does not set any cache-control; Default: ''] */
		none?: string;
	};

	/** grace period before the throughput is started to be measured or for busy connections [in milliseconds; Default: 10_000] */
	throughputGrace?: number;

	/** throughput required for combined sending and receiving bodies of requests [0 disables the throughput check, in bytes/second; Default: 1_000] */
	throughputThreshold?: number;

	/** length of sliding time window for which the throughput must be above the threshold [in milliseconds; Default: 30_000] */
	throughputWindow?: number;
}

export class BurntClientConfig {
	public readonly serverName: string;
	public readonly commonHeaders: Record<string, string>;
	public readonly webSocketTimeout: number;
	public readonly webSocketAliveTimeout: number;
	public readonly killGraceTimeout: number;
	public readonly cache: Record<CachePolicy, string>;
	public readonly throughputGrace: number;
	public readonly throughputThreshold: number;
	public readonly throughputWindow: number;

	public constructor(config?: ClientConfig) {
		this.serverName = config?.serverName ?? 'Modular Web Server';
		this.commonHeaders = config?.commonHeaders ?? { 'X-Content-Type-Options': 'nosniff' };
		this.webSocketTimeout = config?.webSocketTimeout ?? 180_000;
		this.webSocketAliveTimeout = config?.webSocketAliveTimeout ?? 2_000;
		this.killGraceTimeout = config?.killGraceTimeout ?? 1_000;
		this.cache = {
			immutable: config?.cache?.immutable ?? 'public, max-age=2592000, immutable',
			static: config?.cache?.static ?? 'public, no-cache',
			private: config?.cache?.private ?? 'private, no-cache',
			sensitive: config?.cache?.sensitive ?? 'no-cache, no-store, max-age=0, must-revalidate',
			none: config?.cache?.none ?? ''
		};
		this.throughputGrace = config?.throughputGrace ?? 10_000;
		this.throughputThreshold = config?.throughputThreshold ?? 1_000;
		this.throughputWindow = config?.throughputWindow ?? 30_000;
	}

	public static from(config?: ClientConfig | BurntClientConfig): BurntClientConfig {
		return (config instanceof BurntClientConfig ? config : new BurntClientConfig(config));
	}
}
