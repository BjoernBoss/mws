/* SPDX-License-Identifier: BSD-3-Clause */
/* Copyright (c) 2024-2026 Bjoern Boss Henrichsen */
import { Config as libConfig } from "./config.js";
import * as libLog from "./log.js";
import * as libLocation from "./location.js";
import * as libBuilder from "./builder.js";
import * as libCache from "./cache.js";
import * as libRequest from "./request.js";
import * as libFs from "fs";
import * as libStream from "stream";
import * as libUrl from "url";
import * as libWs from "ws";
import * as libHttp from "http";

const BAD_HTTP_STRING_REGEX: RegExp = /[\x00-\x1f\x7f]/;
const BAD_HTTP_HEADER_NAME_REGEX: RegExp = /[\x00-\x1f\x7f\(\)<>@,;:\\"/\[\]\?=\{\} \t]/;

let NextClientId: number = 0;

class ClientContext {
	public logIdentity: string;
	public path: string;
	public translationCount: number;
	public busyCount: number;
	public headerPatchCount: number;
	public htmlPatchCount: number;

	constructor(logIdentity: string, path: string, translationCount: number, busyCount: number, headerPatchCount: number, htmlPatchCount: number) {
		this.logIdentity = logIdentity;
		this.path = path;
		this.translationCount = translationCount;
		this.busyCount = busyCount;
		this.headerPatchCount = headerPatchCount;
		this.htmlPatchCount = htmlPatchCount;
	}
}

class ClientBase extends libLog.LogIdentity {
	protected relativePath: string;
	protected pathTranslation: Record<string, string | null>[];

	protected constructor(url: libUrl.URL, kind: string);
	protected constructor(client: ClientBase, kind: string);
	protected constructor(arg: libUrl.URL | ClientBase, kind: string) {
		const thisClientId = ++NextClientId;
		super(`${kind}!${thisClientId}`);
		this.id = thisClientId;

		if (arg instanceof libUrl.URL) {
			this.pathTranslation = [];
			this.relativePath = libLocation.Sanitize(arg.pathname, false);
			this.url = arg;
		}
		else {
			this.pathTranslation = arg.pathTranslation;
			this.relativePath = arg.relativePath;
			this.url = arg.url;
		}
	}

	/* unique id to identify client in logs */
	readonly id: number;

	/* raw request origin (no host will result in '_') */
	readonly url: libUrl.URL;

	/* path relative to current module */
	public get path(): string {
		return this.relativePath;
	}

	/* check if the path relative to the current module is a sub path of the given test base path */
	public isSubPathOf(base: string): boolean {
		return libLocation.IsSubPath(base, this.relativePath);
	}

	/* check if the path relative to the current module is inside of the given test base path */
	public isInsideOf(base: string): boolean {
		return libLocation.IsInside(base, this.relativePath);
	}

	/* create a path relative from the current module into the clients traversed server space */
	public makePath(path: string): string {
		path = libLocation.Sanitize(path, false);
		let output = path;

		for (let i = this.pathTranslation.length - 1; i >= 0; --i) {
			let nullCheck = false, match: [string, string | null] | null = null;

			/* find the best reverse mapping and apply it */
			for (const [from, to] of Object.entries(this.pathTranslation[i])) {
				if (to == null)
					nullCheck = true;
				else if (libLocation.IsSubPath(to, output) && (match == null || match[1]!.length < to.length))
					match = [from, to];
			}
			if (match != null)
				output = libLocation.Rebase(match[1]!, match[0], output);

			/* check if the translation contained null-mappings and check if
			*	the final unpacked path re-maps into the null-mapping */
			if (nullCheck) {
				match = null;
				for (const [from, to] of Object.entries(this.pathTranslation[i])) {
					if (libLocation.IsSubPath(from, output) && (match == null || match[0].length < from.length))
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
	public status: libRequest.StatusType;
	public headers: Record<string, string>;
	public contentSize: number | null;
	public dynamicEncode: boolean;
	public contentType: libRequest.MediaType;

	constructor(writer: libStream.Writable, status: libRequest.StatusType, headers: Record<string, string>, contentSize: number | null, contentType: libRequest.MediaType,
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
	}
}

/* look at the state and modify the headers accordingly (only add or remove headers, must not try to alter the response) */
export type HeaderPatch = (status: libRequest.StatusType, headers: Record<string, string>) => void;

/* look at the page and modify it or the headers accordingly (can be interrupted by returning an alternate response) */
export type HtmlPatch = (page: libBuilder.HtmlPage, status: libRequest.StatusType, headers: Record<string, string>) => Promise<void>;

/*
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
*	Normal responses automatically add Config.responseCacheControl, if no other cache control is specified.
*	File responses will automatically add Config.fileCacheControl/Config.immutableCacheControl, if no other cache control is specified.
*	Responses will either use the dedicated responder interface and its highWaterMark, or a responder interface, which caches up to socket.highWaterMark.
*
*	Upgrade requests, which were not accepted, will be closed after responding.
*	An accept attempt must be fully awaited before completing the handling procedure.
*
*	Defaults [Accept-Ranges] normally to 'none' or to 'bytes' for files
*	Defaults [Vary] to 'Accept-Encoding'.
*	Defaults [Connection] to 'close' for upgrade requests.
*/
export class ClientRequest extends ClientBase {
	private headerPatcher: HeaderPatch[];
	private htmlPatcher: HtmlPatch[];
	private baseState: {
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
	private throughput: {
		timer: NodeJS.Timeout | null;
		deadline: number;
		start: number;
		threshold: number;
		window: number;
		busyCheck: (() => boolean)[];
	};
	private nativeInterface: {
		request: libHttp.IncomingMessage;
		response: HttpResponseInterface;
		writer: libStream.Writable;
		socket?: { socket: libStream.Duplex, head: Buffer, wss: libWs.WebSocketServer };
	};

	private constructor(request: libHttp.IncomingMessage, host: string, protocol: string, response: libHttp.ServerResponse | { socket: libStream.Duplex, head: Buffer, wss: libWs.WebSocketServer }) {
		super(new libUrl.URL(`${protocol}//${host == '' ? '_' : host}${request.url}`), 'request');
		this.headerPatcher = [];
		this.htmlPatcher = [];

		let respondedResolve: any = null, completedResolve: any = null, breakResolve: any = null;
		this.baseState = {
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
		this.baseState.respondedResolve = respondedResolve;
		this.baseState.completedResolve = completedResolve;
		this.baseState.breakResolve = breakResolve;

		/* setup the throughput measurement to detect any stalling connections */
		this.throughput = {
			timer: null,
			deadline: 0,
			start: 0,
			threshold: libConfig.throughputThreshold,
			window: libConfig.throughputWindow,
			busyCheck: []
		};
		if (this.throughput.threshold > 0) {
			this.throughput.start = Date.now() + libConfig.throughputGrace;
			this.updateThroughput(0);
		}

		/* register the necessary network error handlers */
		const lostHandler = () => {
			if (this.baseState.response != ResponseState.completed && this.baseState.response != ResponseState.broken)
				this.markAsBroken('Connection lost', false);
		};
		const closedHandler = () => {
			if (this.baseState.response != ResponseState.completed && this.baseState.response != ResponseState.broken)
				this.markAsBroken('Connection closed by remote', false);
		};
		const timeoutHandler = () => {
			if (this.baseState.response != ResponseState.completed && this.baseState.response != ResponseState.broken)
				this.markAsBroken('Connection timed out', false);
		};
		request.once('error', lostHandler);
		request.once('aborted', closedHandler);
		request.socket.once('timeout', timeoutHandler);
		request.socket.once('error', lostHandler);
		request.socket.once('close', closedHandler);

		/* ensure to remove the events again once the processing has completed */
		this.baseState.completedPromise.then(() => {
			request.removeListener('error', lostHandler);
			request.removeListener('aborted', closedHandler);
			request.socket.removeListener('timeout', timeoutHandler);
			request.socket.removeListener('error', lostHandler);
			request.socket.removeListener('close', closedHandler);
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
		this.nativeInterface = { request, response: responseWrapper, writer: writerWrapper, socket: (response instanceof libHttp.ServerResponse ? undefined : response) };
	}

	private constructQuickResponse(status: libRequest.StatusType, logReason: string | null, headers: Record<string, string> | undefined, content?: { media: libRequest.MediaType, body?: Buffer } | null): void {
		if (headers == null)
			headers = {};
		const description = `${this.isHead ? 'HEAD:' : ''}[${status.msg}]${logReason == null ? '' : `: ${logReason}`}`;

		if (!('Cache-Control' in headers) && libConfig.responseCacheControl != '')
			headers['Cache-Control'] = libConfig.responseCacheControl;

		/* check if the response can still be sent (acknowledged state can be overridden; the connection
		*	will be closed afterwards to prevent the client from seeing inconsistent responses) */
		const override = (this.baseState.response == ResponseState.acknowledged);
		if (this.baseState.response == ResponseState.none || override) {
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
		else if (this.baseState.response == ResponseState.headerSent)
			this.markAsBroken(`Overlap with committed response ${description}`, false);
		else if (this.baseState.response != ResponseState.broken)
			this.warning(`Request already completed, discarding response ${description}`);
		else
			this.trace(`Request broken, discarding response ${description}`);
	}
	private failThroughput(): void {
		if (this.throughput.threshold <= 0 || this.baseState.response == ResponseState.broken)
			return;

		/* check if the connection is still considered busy and should receive a grace delay */
		for (const cb of this.throughput.busyCheck) {
			let result = false;
			try { result = cb(); }
			catch (err: any) { this.error(`Unhandled exception in busy check: ${err.message}`); }
			if (!result) continue;

			this.trace(`Deferring throughput closing as connection is busy`);
			this.throughput.start = Date.now() + libConfig.throughputGrace;
			this.updateThroughput(0);
			this.nativeInterface.request.socket.setTimeout(libConfig.connectionTimeout);
			return;
		}

		const closing = (this.baseState.response == ResponseState.none || this.baseState.response == ResponseState.acknowledged);
		if (closing)
			this.respondRequestTimeout(`Throughput below [${this.throughput.threshold}] bytes/sec`, { headers: { 'Connection': 'close' } });
		this.markAsBroken(`Throughput below [${this.throughput.threshold}] bytes/sec`, closing);
	}
	private updateThroughput(delta: number): void {
		if (this.throughput.timer != null)
			clearTimeout(this.throughput.timer);
		this.throughput.timer = null;
		if (this.throughput.threshold <= 0)
			return;
		const _now = Date.now();
		const now = Math.max(_now, this.throughput.start);

		/* shift the deadline according to the bought time by the throughput */
		const bought = (delta / this.throughput.threshold) * 1000;
		this.throughput.deadline = now + Math.min(this.throughput.window, Math.max(0, this.throughput.deadline - now) + bought);
		this.throughput.timer = setTimeout(() => this.failThroughput(), this.throughput.deadline - _now);
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
		const native = this.nativeInterface;

		/* raw closer, which will fully destroy the connection */
		const closeConnection = () => {
			if (native.request.destroyed && native.writer.destroyed)
				return;
			const error = new Error('Connection broken');

			native.request.destroy(error);
			native.writer.destroy(error);
		};

		if (!graceful || native.writer.writableFinished || native.writer.destroyed)
			return closeConnection();

		/* if graceful, wait for the last queued data to be sent; may be called multiple times */
		return new Promise<void>((resolve) => {
			let settled = false, handler = () => {
				if (settled) return; settled = true;
				closeConnection();
				resolve();
			};
			native.writer.once('finish', () => handler());
			native.writer.once('error', () => handler());
			native.writer.once('close', () => handler());
		});
	}
	private markAsBroken(reason: string, graceful: boolean): void {
		this.error(`Connection broken: [${reason}]`);
		this.baseState.response = ResponseState.broken;
		if (this.baseState.breaking != null) {
			if (!graceful)
				this.killNativeConnection(false);
			return;
		}
		this.baseState.respondedResolve();

		/* setup the promise beforehand to ensure the promise body does not recursively
		*	enter this handler again, and sees the completed object still being unset */
		let resolver = () => { };
		this.baseState.breaking = new Promise<void>((res) => resolver = res);

		/* setup the break promise to ensure the connection is killed properly with the given grace */
		(async () => {
			let settled = false;

			const forceDestroy = setTimeout(() => {
				if (settled) return; settled = true;
				this.killNativeConnection(false);
				resolver();
			}, libConfig.killGraceTimeout);

			await this.killNativeConnection(graceful);
			clearTimeout(forceDestroy);

			if (settled) return; settled = true;
			resolver();
		})();

		this.baseState.breakResolve();
	}
	private badClientUsage(reason: string, close: boolean): void {
		this.respondInternalError(`Bad Usage: ${reason}`, (close ? { headers: { 'Connection': 'close' } } : undefined));
	}

	private closeHeader(status: libRequest.StatusType, headers: Record<string, string>, content?: { media: libRequest.MediaType, size?: number, encoding?: string }): void {
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
		this.baseState.response = ResponseState.headerSent;
		this.baseState.respondedResolve();

		/* configure the default header values */
		if (!('Accept-Ranges' in headers))
			headers['Accept-Ranges'] = 'none';
		if (!('Vary' in headers))
			headers['Vary'] = 'Accept-Encoding';
		if (!('Date' in headers))
			headers['Date'] = new Date().toUTCString();
		if (libConfig.serverName != '' && !('Server' in headers))
			headers['Server'] = libConfig.serverName;
		for (const [key, value] of Object.entries(libConfig.commonHeaders)) {
			if (!(key in headers))
				headers[key] = value;
		}
		if (content != null) {
			headers['Content-Type'] = libRequest.BuildMediaTypeIdentifier(content.media);
			if (content.size != null)
				headers['Content-Length'] = content.size.toString();
		}

		/* check if its an upgrade request, which is always marked as being closed, as the
		*	underlying web-server will not take it back into the queue for keep-alive sockets */
		if (this.nativeInterface.socket != null)
			headers['Connection'] = 'close';

		/* perform the header post processing (in reverse order to ensure first added is last executed) */
		for (let i = this.headerPatcher.length - 1; i >= 0; --i) {
			try { this.headerPatcher[i](status, headers); }
			catch (err: any) { this.error(`Unhandled exception in header patcher: ${err.message}`); }
		}

		/* setup the response status and headers (guard against invalid header values) */
		try { this.nativeInterface.response.setStatus(status.code, status.msg); } catch (_) {
			return this.markAsBroken(`Failed to finalize response: Bad status message`, false);
		}
		for (const [key, value] of Object.entries(headers)) {
			try { this.nativeInterface.response.setHeader(key, value); } catch (_) {
				this.error(`Failed to set header [${key}]: Bad header value`);
			}
		}
	}
	private sendFullResponse(status: libRequest.StatusType, headers: Record<string, string>, content?: { media: libRequest.MediaType, body?: Buffer }): void {
		let encoding: libRequest.EncodingType | null = null;
		if (content != null) {
			headers['Vary'] = 'Accept-Encoding';

			/* check if the data should be encoded (if the size is not known, pretend the buffer to be large enough) */
			encoding = libRequest.NegotiateEncoding(this.headers['accept-encoding'] ?? null, content.body?.byteLength ?? null, content.media);
			if (encoding != null) {
				if (content.body != null)
					content.body = encoding.encodeBuffer(content.body);
				headers['Content-Encoding'] = encoding.name;
			}
		}

		this.closeHeader(status, headers, (content == null ? undefined : { media: content.media, size: content.body?.byteLength, encoding: encoding?.name }));
		this.baseState.response = ResponseState.completed;

		/* try to finalize the response (can throw an exception for invalid status or header content) */
		try {
			if (!this.isHead && content?.body != null) {
				this.updateThroughput(content.body.length);
				this.nativeInterface.writer.end(content.body);
			}
			else
				this.nativeInterface.writer.end();
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
		if (!last && !this.isHead && (chunk!.byteLength < libRequest.MIN_ENCODING_SIZE || !cached)) {
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
		let encoding = libRequest.NegotiateEncoding(this.headers['accept-encoding'] ?? null, fullContentSize ?? chunk?.byteLength ?? null, resp.contentType);
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

			resp.writer.once('error', (err: any) => {
				if (!resp.destroyed)
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
			if (this.baseState.response != ResponseState.headerSent)
				return cb(null);
			this.baseState.response = ResponseState.completed;
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
		this.baseState.response = ResponseState.completed;
		if (chunk != null)
			resp.writer.end(chunk, () => cb(null));
		else
			resp.writer.end(() => cb(null));
	}
	private sendClientData(status: libRequest.StatusType, media: libRequest.MediaType, headers: Record<string, string>, options: { dynamicEncode?: boolean, contentSize?: number }): libStream.Writable {
		const makeErrorStream = (msg: string) => new libStream.Writable({ write(_0, _1, cb) { cb(new Error(msg)) }, final(cb) { cb(new Error(msg)) } });

		/* check if the object is already responded */
		if (this.baseState.response == ResponseState.broken)
			return makeErrorStream('Connection broken');
		if (this.baseState.response != ResponseState.none) {
			this.badClientUsage('Response on already claimed connection', false);
			return makeErrorStream('Connection already responded');
		}
		this.baseState.response = ResponseState.acknowledged;

		/* construct the actual response wrapper, which takes care of dynamic encoding and error handling */
		const output = new HttpRequestResponse(this.nativeInterface.writer, status, headers,
			options.contentSize ?? null, media, options?.dynamicEncode ?? false,
			(chunk: Buffer | null, cb: (err: any) => void) => {
				if (output.destroyed)
					return cb(new Error('Already failed'));

				/* check if the connection has been marked as failed or completed */
				if (this.baseState.response == ResponseState.completed)
					return cb(new Error('Responding to completed response'));
				if (this.baseState.response == ResponseState.broken)
					return cb(new Error('Connection broken'));

				/* handle the data accordingly and check for any errors due to malformed headers */
				try {
					if (this.baseState.response == ResponseState.headerSent)
						return this.sendClientWrite(output, chunk, chunk == null, cb);
					this.sendClientSetupHeader(output, chunk, cb);
				}
				catch (err: any) {
					this.markAsBroken(`Failed to process response: ${err.message}`, false);
					return cb(new Error('Connection broken'));
				}
			},
			(err: any, cb: (err: any) => void) => {
				if (this.baseState.response == ResponseState.completed)
					return cb(err);

				/* check if the output stream was an encoder, in which case it still needs to be destroyed
				*	(only if an error occurred and the response was not completed, as the decoder might otherwise
				*	still queue data waiting to be sent out, which the response writer already passed on) */
				if (output.writer !== this.nativeInterface.writer)
					output.writer.destroy();

				/* check if the error originated from the data sender and ensure the connection is closed
				*	(cannot be acknowledged for failed encodings, as they can first trigger on already header-sent) */
				if (this.baseState.response != ResponseState.broken) {
					const closing = (this.baseState.response == ResponseState.acknowledged);
					if (closing)
						this.badClientUsage('Response closed prematurely', true);
					this.markAsBroken(`Data transfer failed: ${err.message}`, closing);
				}
				return cb(err);
			}
		);

		/* register the broken handler to detect closed or failed connections */
		this.baseState.breakPromise.then(() => {
			if (!output.destroyed)
				output.destroy(new Error('Connection broken'));
		});

		return output;
	}
	private receiveClientData(maxLength: number | null): libStream.Readable {
		const makeErrorStream = (msg: string) => new libStream.Readable({ read() { this.destroy(new Error(msg)) } });

		/* check if the object is ready for receiving */
		if (this.baseState.receive != ReceiveState.none) {
			this.badClientUsage('Already receiving data', false);
			return makeErrorStream('Connection is already being received');
		}
		if (this.baseState.response == ResponseState.broken)
			return makeErrorStream('Connection broken');
		this.baseState.receive = ReceiveState.receiving;

		/* setup the accumulation transformer (which will also be returned in the end; mark receiving
		*	as completed upon destroy - will automatically drain the request on cleanup) */
		let accumulated = 0;
		const output = new libStream.Transform({
			transform: (chunk, _, cb) => {
				if (output.destroyed) return cb(new Error('Already failed'));

				/* check if the connection has been processed or marked as failed */
				if (this.baseState.response == ResponseState.completed)
					this.badClientUsage('Response completed during active receive', false);
				if (this.baseState.response == ResponseState.broken)
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
				if (this.baseState.receive == ReceiveState.receiving) {
					this.nativeInterface.request.unpipe();
					this.baseState.receive = ReceiveState.completed;
				}
				cb(err);
			},
			final: (cb) => {
				if (this.baseState.receive == ReceiveState.receiving) {
					this.nativeInterface.request.unpipe();
					this.baseState.receive = ReceiveState.completed;
				}
				cb();
			},

		});

		/* check if the content is encoded and create the chain of decoders (in reverse to ensure the nesting is correct) */
		let stream: libStream.Readable = this.nativeInterface.request;
		if (this.headers['content-encoding'] != null) {
			const encodings = libRequest.SplitAndTrimList(this.headers['content-encoding'], ',', false);

			for (let i = encodings.length - 1; i >= 0; --i) {
				const encoding = libRequest.LookupEncoding(encodings[i]);

				if (encoding == null) {
					output.destroy();
					this.respondUnsupported(encodings[i], libRequest.SupportedEncodingNames().join(','));
					return makeErrorStream('Unsupported content encoding');
				}

				/* configure the piping accordingly */
				const decoder = encoding.makeDecode();
				stream = stream.pipe(decoder);
				decoder.once('error', (err: any) => {
					if (output.destroyed) return;
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
		this.baseState.breakPromise.then(() => {
			if (!output.destroyed)
				output.destroy(new Error('Connection broken'));
		});

		/* create the plumbing between stream and output (errors are already handled) */
		return stream.pipe(output);
	}

	public static _fromRequest(request: libHttp.IncomingMessage, host: string, protocol: string, response: libHttp.ServerResponse): ClientRequest {
		return new ClientRequest(request, host, protocol, response);
	}
	public static _fromUpgrade(request: libHttp.IncomingMessage, host: string, protocol: string, socket: libStream.Duplex, head: Buffer, wss: libWs.WebSocketServer): ClientRequest {
		return new ClientRequest(request, host, protocol, { socket, head, wss });
	}
	public async _finishConnection(): Promise<void> {
		/* ensure the connection is default replied with not-found */
		if (this.baseState.response == ResponseState.none)
			this.respondNotFound();

		/* ensure that the data have been fully received (if the response is already completed,
		*	silently reset to 'header-sent' to ensure the connection is properly marked as broken) */
		if (this.baseState.receive == ReceiveState.receiving && this.baseState.response != ResponseState.broken) {
			if (this.baseState.response == ResponseState.completed)
				this.baseState.response = ResponseState.headerSent;
			this.badClientUsage('Receive stream not consumed', false);
		}

		/* check if data remain in the pipeline, in which case the connection needs
		*	to be closed to ensure the sender does not pipe more data over */
		const request = this.nativeInterface.request;
		if (!request.readableEnded && !request.destroyed && this.baseState.response != ResponseState.broken) {
			const length = parseInt(this.headers['content-length'] ?? '0');
			const chunked = (this.headers['transfer-encoding'] != null);
			if (length != 0 || chunked)
				this.markAsBroken((request.readableLength > 0 ? 'Uploaded data not consumed' : 'Potential uploaded data not consumed'), true);
		}

		/* check if the upgrade was not fully awaited */
		if (this.baseState.upgrade == UpgradeState.upgrading && this.baseState.response != ResponseState.broken)
			this.badClientUsage('Upgrade not fully awaited', false);

		/* ensure that the response was properly sent */
		if (this.baseState.response != ResponseState.completed && this.baseState.response != ResponseState.broken)
			this.badClientUsage('Response not completed', false);

		/* check if the connection was an upgrade but was not was accepted, which needs to be
		*	killed, as the underlying web-server will not clean this connection up anymore */
		if (this.nativeInterface.socket != null && this.baseState.upgrade != UpgradeState.upgraded && this.baseState.response != ResponseState.broken)
			this.markAsBroken('Upgrade was not accepted', true);

		/* kill the throughput timer, as it either does not need to be checked anymore, or it
		*	will have left the connection as broken, and will automatically be closed now
		*	(reset the threshold timer to ensure no new timers will be started anymore) */
		if (this.throughput.timer != null)
			clearTimeout(this.throughput.timer);
		this.throughput.timer = null;
		this.throughput.threshold = 0;

		/* check if the connection is broken and await its grace cleanup completion */
		if (this.baseState.response == ResponseState.broken)
			await this.baseState.breaking!;

		this.log('Request processing completed');
		this.baseState.completedResolve();
	}
	public _killConnection(): void {
		this.markAsBroken('Closing connection', false);
	}
	public _pushTranslation(map: Record<string, string | null>, identity: string): ClientContext | null {
		let sanitized: Record<string, string | null> | null = null;
		let match: [string, string | null] | null = null;

		/* check if this is only an identity map, in which case nothing complex needs to be evaluated */
		if (Object.keys(map).length == 1 && map['/'] == '/')
			match = ['/', '/'];

		/* create the merged reverse map and check if the map applies to the current translation */
		else {
			sanitized = {};
			for (const [_from, _to] of Object.entries(map)) {
				const from = libLocation.Sanitize(_from, false);
				const to = (_to == null ? null : libLocation.Sanitize(_to, false));
				sanitized[from] = to;

				/* check if the mapping can be applied to the current path */
				if (this.isSubPathOf(from) && (match == null || match[0].length < from.length))
					match = [from, to];
			}
			if (match == null || match[1] == null)
				return null;
		}

		const current = new ClientContext(this.logIdentity, this.relativePath, this.pathTranslation.length,
			this.throughput.busyCheck.length, this.headerPatcher.length, this.htmlPatcher.length);

		/* setup the new path, all path translations, and the tagged logging identity */
		this.relativePath = libLocation.Rebase(match[0], match[1]!, this.relativePath);
		if (sanitized != null)
			this.pathTranslation.push(sanitized);
		if (identity != '')
			this.logIdentity = `${this.logIdentity}.${identity}`;
		return current;
	}
	public _restoreSnapshot(snapshot: ClientContext): void {
		this.logIdentity = snapshot.logIdentity;
		this.relativePath = snapshot.path;
		this.pathTranslation.splice(snapshot.translationCount);
		this.throughput.busyCheck.splice(snapshot.busyCount);
		this.headerPatcher.splice(snapshot.headerPatchCount);
		this.htmlPatcher.splice(snapshot.htmlPatchCount);
	}

	/* request has not yet been acknowledged in any way */
	public get unhandled(): boolean {
		return (this.baseState.response == ResponseState.none);
	}

	/* request has been acknowledged or already processed */
	public get claimed(): boolean {
		return (this.baseState.response != ResponseState.none);
	}

	/* resolves whenever the response has been determined (is broken or a response header has been sent) */
	public get responded(): Promise<void> {
		return this.baseState.respondedPromise;
	}

	/* resolves whenever the request has been fully processed */
	public get completion(): Promise<void> {
		return this.baseState.completedPromise;
	}

	/* http request headers */
	public get headers(): libHttp.IncomingHttpHeaders {
		return this.nativeInterface.request.headers;
	}

	/* http request method */
	public get method(): string {
		return this.nativeInterface.request.method ?? '';
	}

	/* was the http request a head request */
	public get isHead(): boolean {
		return (this.nativeInterface.request.method == 'HEAD');
	}

	/* return the string formatted media-type (or empty string for no media type) */
	public getMediaType(): string {
		const type = libRequest.SplitAndTrimList(this.headers['content-type'] ?? null, ';', true)[0] ?? '';
		return type.toLowerCase();
	}

	/* check the content-type for a media-type and otherwise return the default type */
	public getMediaTypeCharset(defEncoding: string): string {
		const type = this.headers['content-type'];
		if (type == null)
			return defEncoding;

		/* look for the first charset entry in the content-type list */
		for (const part of libRequest.SplitAndTrimList(type, ';', true)) {
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

	/* ensure the media-type is one of the list and otherwise return null and auto-respond with [unsupported-media-type] (defaults to first type, if [noneIsFirst]) */
	public requireMediaType(types: libRequest.MediaType[] | libRequest.MediaType, options?: { noneIsFirst?: boolean, headers?: Record<string, string> }): libRequest.MediaType | null {
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

	/* ensure the method is one of the list and otherwise return null and auto-respond with [method-not-allowed]
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

	/* register a callback to check if the request is still being processed (delays throughput
	*	termintion and resets connection timeout; will only be considered within this handler context) */
	public busyCheck(cb: () => boolean): void {
		this.throughput.busyCheck.push(cb);
	}

	/* register a callback to be invoked once the response is sent, to adjust the
	*	headers to be sent (will only be considered within this handler context) */
	public patchHeaders(cb: HeaderPatch): void {
		this.headerPatcher.push(cb);
	}

	/* register a callback to be invoked if html is built, to adjust the headers or
	*	the content to be sent (will only be considered within this handler context) */
	public patchHtmlPage(cb: HtmlPatch): void {
		this.htmlPatcher.push(cb);
	}

	/* respond with [internal-error] and a default text response (always considered an error; reason is logged server-side only) */
	public respondInternalError(reason: string, options?: { headers?: Record<string, string> }): void {
		this.constructQuickResponse(libRequest.Status.InternalError, `Failure Reason (not sent): ${reason}`, options?.headers, {
			media: libRequest.Media.Text, body: Buffer.from(`An internal server error occurred while processing the request for [${this.url.pathname}].`, 'utf-8')
		});
	}

	/* respond with [forbidden] and a default text response (reason is logged server-side only) */
	public respondForbidden(reason: string, options?: { headers?: Record<string, string> }): void {
		this.constructQuickResponse(libRequest.Status.Forbidden, `Forbidden Reason (not sent): ${reason}`, options?.headers, {
			media: libRequest.Media.Text, body: Buffer.from(`Access to [${this.url.pathname}] denied.`, 'utf-8')
		});
	}

	/* respond with a any response of the given configuration (defaults to media-type: text/unknown/-, status: ok);
	*	if [lightResponse], the content length is suppressed for head responses (to accomodate short-circuiting responding) */
	public respond(content: string | Buffer | null, options?: { media?: libRequest.MediaType, status?: libRequest.StatusType, headers?: Record<string, string>, lightResponse?: boolean }): void {
		const status = options?.status ?? libRequest.Status.Ok;

		if (content == null)
			return this.constructQuickResponse(status, 'no body', options?.headers, null);

		let media = options?.media ?? libRequest.Media.Text;
		if (typeof content == 'string')
			content = Buffer.from(content, 'utf-8');
		else if (options?.media == null)
			media = libRequest.Media.Unknown;

		this.constructQuickResponse(status, `[${media.mediaType}] and size [${content.byteLength}]`, options?.headers, {
			media, body: (options?.lightResponse && this.isHead ? undefined : content)
		});
	}

	/* respond with [ok] and either a message or a default response */
	public respondOk(options?: { message?: string, headers?: Record<string, string> }): void {
		this.constructQuickResponse(libRequest.Status.Ok, options?.message ?? null, options?.headers, {
			media: libRequest.Media.Text, body: Buffer.from(options?.message ?? `${this.method} was successful for [${this.url.pathname}].`, 'utf-8')
		});
	}

	/* respond with [created] and either a message or a default response (ensure target is properly URI encoded) */
	public respondCreated(target: string, options?: { headers?: Record<string, string> }): void {
		const header = (options?.headers ?? {});
		header['Location'] = target;

		this.constructQuickResponse(libRequest.Status.Created, target, header, {
			media: libRequest.Media.Text, body: Buffer.from(`Resource [${this.url.pathname}] successfully created:\n${target}`, 'utf-8')
		});
	}

	/* respond with [not-modified] and no body (ensure the etag and/or last-modified is set) */
	public respondNotModified(options?: { etag?: string, lastModified?: string, headers?: Record<string, string> }): void {
		const header = (options?.headers ?? {});
		if (options?.etag != null && !('ETag' in header))
			header['ETag'] = options.etag;
		if (options?.lastModified != null && !('Last-Modified' in header))
			header['Last-Modified'] = options.lastModified;

		this.constructQuickResponse(libRequest.Status.NotModified, null, header, null);
	}

	/* respond with [precondition-failed] and a default text response (ensure the etag and/or last-modified is set) */
	public respondPreconditionFailed(reason: string, options?: { etag?: string, lastModified?: string, headers?: Record<string, string> }): void {
		const header = (options?.headers ?? {});
		if (options?.etag != null && !('ETag' in header))
			header['ETag'] = options.etag;
		if (options?.lastModified != null && !('Last-Modified' in header))
			header['Last-Modified'] = options.lastModified;

		this.constructQuickResponse(libRequest.Status.PreconditionFailed, reason, options?.headers, {
			media: libRequest.Media.Text, body: Buffer.from(`Precondition for resource [${this.url.pathname}] failed:\n${reason}`, 'utf-8')
		});
	}

	/* respond with [bad-request] and a default text response */
	public respondBadRequest(reason: string, options?: { headers?: Record<string, string> }): void {
		this.constructQuickResponse(libRequest.Status.BadRequest, reason, options?.headers, {
			media: libRequest.Media.Text, body: Buffer.from(`Request for [${this.url.pathname}] is perceived as malformed:\n${reason}`, 'utf-8')
		});
	}

	/* respond with [range-not-satisfiable] and a default text response */
	public respondRangeIssue(range: string, size: number, options?: { headers?: Record<string, string> }): void {
		const header = (options?.headers ?? {});
		header['Content-Range'] = `bytes */${size}`;

		this.constructQuickResponse(libRequest.Status.RangeIssue, `[${range}] cannot be satisfied for size [${size}]`, header, {
			media: libRequest.Media.Text, body: Buffer.from(`Range [${range}] cannot be satisfied for [${this.url.pathname}] of size ${size}.`, 'utf-8')
		});
	}

	/* respond with [conflict] and a default text response */
	public respondConflict(conflict: string, options?: { headers?: Record<string, string> }): void {
		this.constructQuickResponse(libRequest.Status.Conflict, conflict, options?.headers, {
			media: libRequest.Media.Text, body: Buffer.from(`Conflict for resource [${this.url.pathname}]:\n${conflict}`, 'utf-8')
		});
	}

	/* respond with [not-found] and a default text response */
	public respondNotFound(options?: { headers?: Record<string, string> }): void {
		this.constructQuickResponse(libRequest.Status.NotFound, null, options?.headers, {
			media: libRequest.Media.Text, body: Buffer.from(`Resource [${this.url.pathname}] could not be found.`, 'utf-8')
		});
	}

	/* respond with [unsupported-media-type] and a default text response */
	public respondUnsupported(used: string, allowed: string, options?: { headers?: Record<string, string> }): void {
		this.constructQuickResponse(libRequest.Status.UnsupportedMediaType, `Allowed was [${allowed}] but [${used}] was used`, options?.headers, {
			media: libRequest.Media.Text, body: Buffer.from(`Media type [${used}] not supported for [${this.url.pathname}].\nAllowed: ${allowed}`, 'utf-8')
		});
	}

	/* respond with [invalid-method] and a default text response */
	public respondMethodNotAllowed(method: string, allowed: string, options?: { headers?: Record<string, string> }): void {
		const header = (options?.headers ?? {});
		header['Allow'] = allowed;

		this.constructQuickResponse(libRequest.Status.MethodNotAllowed, `Allowed was [${allowed}] but [${method}] was used`, header, {
			media: libRequest.Media.Text, body: Buffer.from(`Method ${method} not allowed for [${this.url.pathname}].\nAllowed: ${allowed}.`, 'utf-8')
		});
	}

	/* respond with [request-timeout] and a default text response */
	public respondRequestTimeout(reason: string, options?: { headers?: Record<string, string> }): void {
		const header = (options?.headers ?? {});
		header['Connection'] = 'close';

		this.constructQuickResponse(libRequest.Status.RequestTimeout, reason, header, {
			media: libRequest.Media.Text, body: Buffer.from(`Request processing of [${this.url.pathname}] timed out:\n${reason}`, 'utf-8')
		});
	}

	/* respond with [content-too-large] and a default text response */
	public respondContentTooLarge(allowed: number, atLeastProvided: number, options?: { headers?: Record<string, string> }): void {
		this.constructQuickResponse(libRequest.Status.ContentTooLarge, `[${atLeastProvided}] > [${allowed}]`, options?.headers, {
			media: libRequest.Media.Text, body: Buffer.from(`Content of at least size ${atLeastProvided} too large for [${this.url.pathname}].\nAt most ${allowed} bytes are allowed.`, 'utf-8')
		});
	}

	/* respond with [update-required] and a default text response */
	public respondUpdateRequired(upgrade: string, options?: { headers?: Record<string, string> }): void {
		const header = (options?.headers ?? {});
		if (!('Connection' in header))
			header['Connection'] = 'upgrade';
		header['Upgrade'] = upgrade;

		this.constructQuickResponse(libRequest.Status.UpgradeRequired, `Required: ${upgrade}`, options?.headers, {
			media: libRequest.Media.Text, body: Buffer.from(`Endpoint [${this.url.pathname}] requires an upgrade.\nRequired: ${upgrade}`, 'utf-8')
		});
	}

	/* respond with [see-other] to the given target and a default text response (forces method GET; ensure target is properly URI encoded) */
	public respondSeeOther(target: string, options?: { headers?: Record<string, string> }): void {
		const header = (options?.headers ?? {});
		header['Location'] = target;

		this.constructQuickResponse(libRequest.Status.SeeOther, target, header, {
			media: libRequest.Media.Text, body: Buffer.from(`Continue at: ${target}`, 'utf-8')
		});
	}

	/* respond with [temporary-redirect] to the given target and a default text response (preserves method; ensure target is properly URI encoded) */
	public respondTemporaryRedirect(target: string, options?: { headers?: Record<string, string> }): void {
		const header = (options?.headers ?? {});
		header['Location'] = target;

		this.constructQuickResponse(libRequest.Status.TemporaryRedirect, target, header, {
			media: libRequest.Media.Text, body: Buffer.from(`Resource [${this.url.pathname}] temporarily redirects to:\n${target}`, 'utf-8')
		});
	}

	/* respond with [permanent-redirect] to the given target and a default text response (preserves method; ensure target is properly URI encoded)  */
	public respondPermanentRedirect(target: string, options?: { headers?: Record<string, string> }): void {
		const header = (options?.headers ?? {});
		header['Location'] = target;

		this.constructQuickResponse(libRequest.Status.PermanentRedirect, target, header, {
			media: libRequest.Media.Text, body: Buffer.from(`Resource [${this.url.pathname}] permanently redirects to:\n${target}`, 'utf-8')
		});
	}

	/* respond with html, can be built on by parent modules, sent once the request has been fully processed
	*	(default status is ok; for HEAD builds, no actual content will be constructed or estimated in size)
	*	automatically adds Config.responseCacheControl, if no other cache control is specified */
	public async respondHtml(page: libBuilder.HtmlPage, options?: { status?: libRequest.StatusType, headers?: Record<string, string> }): Promise<void> {
		if (this.baseState.response != ResponseState.none)
			return this.badClientUsage('HTML response on already claimed connection', false);

		this.baseState.response = ResponseState.acknowledged;
		const status = (options?.status ?? libRequest.Status.Ok);
		const headers = (options?.headers ?? {});
		if (!('Cache-Control' in headers) && libConfig.responseCacheControl != '')
			headers['Cache-Control'] = libConfig.responseCacheControl;

		/* invoke all registered html patcher to let them modify the content (in reverse order to ensure
		*	first added is last executed, and check if one of them produced an alternate response) */
		for (let i = this.htmlPatcher.length - 1; i >= 0; --i) {
			try {
				await this.htmlPatcher[i](page, status, headers);
				if (this.baseState.response != ResponseState.acknowledged)
					return;
			} catch (err: any) {
				this.badClientUsage(`Unhandled exception in HTML patcher: ${err.message}`, false);
				return;
			}
		}
		const content = (this.isHead ? undefined : Buffer.from(page.finalize(), 'utf-8'));

		/* mark first as completed now */
		this.log(`Responding with HTML content and status [${status.msg}]${this.isHead ? ' as light-build' : ''}`);
		this.sendFullResponse(status, headers, { media: libRequest.Media.Html, body: content });
	}

	/* [no-throw but errors] send data with [media type] and [status] and return a writable stream (default status is ok, media is unknown);
	*	if a content size is provided, stream expects exactly this amount of bytes; if [dynamicEncode], the encoder will be dynamically negotiated
	*	based on the content; for a HEAD request, no encoding will be negotiated, no lengths verified, and the written data will just be drained
	*	(can immediately be ended using '.end()'); automatically adds Config.responseCacheControl, if no other cache control is specified */
	public respondData(options?: { status?: libRequest.StatusType, media?: libRequest.MediaType, contentSize?: number, dynamicEncode?: boolean, headers?: Record<string, string> }): libStream.Writable {
		const status: libRequest.StatusType = options?.status ?? libRequest.Status.Ok;
		const headers = (options?.headers ?? {});
		if (!('Cache-Control' in headers) && libConfig.responseCacheControl != '')
			headers['Cache-Control'] = libConfig.responseCacheControl;

		this.log(`Responding with data and status [${status.msg}]`);
		return this.sendClientData(status, options?.media ?? libRequest.Media.Unknown, headers, { contentSize: options?.contentSize, dynamicEncode: options?.dynamicEncode });
	}

	/* try to respond with the given file, return false, if the file does not exist (range aware, HEAD aware); specify [checkFreshness] to
	*	re-validate the file stats on disk before serving from cache; the media type can be overwritten (defaults to extracting media-type
	*	from the file-path); [encoding] describes the encoding of a pre-encoded file (warning: no checks against accepted encodings
	*	performed!); status will be [Ok], [partial-content], [not-modified] or according errors cache aware and etag/last-modified aware;
	*	automatically adds Config.fileCacheControl/Config.immutableCacheControl, if no other cache control is specified */
	public async tryRespondFile(filePath: string, options?: { encoded?: string, media?: libRequest.MediaType, headers?: Record<string, string>, checkFreshness?: boolean }): Promise<boolean> {
		if (options == null)
			options = {};
		if (this.baseState.response != ResponseState.none) {
			this.badClientUsage('File response on already claimed connection', false);
			return true;
		}

		/* read the entry from the cache and check if it has been permanently moved and apply the move */
		let cached: libCache.Cached | string | null = null;
		try {
			cached = libCache.GetImmutable(filePath, { checkFreshness: options.checkFreshness });
			if (cached == null)
				return false;
		}
		catch (err: any) {
			this.respondInternalError(`Failed to read file: ${err.message}`);
			return true;
		}
		if (typeof cached == 'string') {
			this.respondPermanentRedirect(cached);
			return true;
		}

		/* parse the range and ensure that its well formed */
		const range = libRequest.ParseRangeHeader(this.headers.range ?? null, cached.fileSize());
		if (range.state == libRequest.RangeState.malformed) {
			this.respondBadRequest(`Issues while parsing http-header range: [${this.headers.range}]`);
			return true;
		}
		else if (range.state == libRequest.RangeState.issue) {
			this.respondRangeIssue(this.headers.range!, cached.fileSize());
			return true;
		}

		/* update the cached reader to read the encoded content (no encoding if already encoded or a range request has occurred,
		*	as the encoded byte representation might not be stable; this is also the reason why the e-tag must be forced to weak,
		*	as the content cannot be guaranteed to be stabled across cache flushes or reloads) */
		const media = (options.media ?? libRequest.LookupMediaTypeFromFile(filePath));
		let dynamicEncoder = ((options.encoded != null || range.state != libRequest.RangeState.noRange) ? null : libRequest.NegotiateEncoding(this.headers['accept-encoding'] ?? null, cached.fileSize(), media));
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
		if (!('Cache-Control' in headers)) {
			if (cached.isImmutable() && libConfig.immutableCacheControl != '')
				headers['Cache-Control'] = libConfig.immutableCacheControl;
			else if (libConfig.fileCacheControl != '')
				headers['Cache-Control'] = libConfig.fileCacheControl;
		}

		/* validate the conditions (e-tag more relevant than last-modified; invalid times are not
		*	considered errors; no need to set etag/last-modified, as they are already set) */
		if (this.headers['if-match'] != null) {
			if (!libRequest.ETagMatchesList(etag, this.headers['if-match'], true)) {
				this.respondPreconditionFailed(`New etag [${etag}]`, { headers });
				return true;
			}
		}
		else if (this.headers['if-unmodified-since'] != null) {
			const result = libRequest.TimeStampCompare(cached.lastModified(), this.headers['if-unmodified-since']);
			if (result != null && result > 0) {
				this.respondPreconditionFailed(`Modified at [${cached.lastModified()}]`, { headers });
				return true;
			}
		}

		/* check if the response can be skipped due to the resource not having been modified since
		*	the last fetch (etag outweighs last-modified; invalid times are not considered errors) */
		if (this.headers['if-none-match'] != null) {
			if (libRequest.ETagMatchesList(etag, this.headers['if-none-match'], false)) {
				this.respondNotModified({ headers });
				return true;
			}
		}
		else if (this.headers['if-modified-since'] != null) {
			const result = libRequest.TimeStampCompare(cached.lastModified(), this.headers['if-modified-since']);
			if (result != null && result <= 0) {
				this.respondNotModified({ headers });
				return true;
			}
		}

		/* check if the file is empty (can only happen for unused ranges, which would otherwise have issues) */
		if ((reader == null ? cached.fileSize() : reader.contentSize()) === 0) {
			this.log(`Sending empty content for [${filePath}]`);
			this.sendFullResponse(libRequest.Status.Ok, headers, { media, body: Buffer.alloc(0) });
			return true;
		}
		if (range.state == libRequest.RangeState.valid)
			headers['Content-Range'] = `bytes ${range.first}-${range.last}/${cached.fileSize()}`;

		/* create the writer stream (doesn't throw, but errors; enforce the selected encoder) */
		const status = (range.state == libRequest.RangeState.noRange ? libRequest.Status.Ok : libRequest.Status.PartialContent);
		let stream = this.sendClientData(status, media, headers, {
			dynamicEncode: false, contentSize: (reader == null ? range.last - range.first + 1 : reader.contentSize() ?? undefined)
		});

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
				this.respondInternalError(`Failed to stream file: ${err.message}`);
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

	/* [throws] receive the payload of given max length and write it directly to a file; will fail
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
				if (!source.destroyed)
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

	/* [no-throw but errors] receive the payload of given max length as a readable stream
	*	automatically responds with given exceptions if the payload cannot be received properly
	*	automatically drained if the readable stream is destroyed before reading all data */
	public receiveData(maxLength: number | null): libStream.Readable {
		return this.receiveClientData(maxLength);
	}

	/* [throws] receive the payload of given max length as a single complete buffer
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

	/* [throws] receive the payload of given max length as a single complete decoded string
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

	/* marks the object as having been handled and returns a web socket or
	*	automatically responds with a corresponding error and returns null */
	public async acceptWebSocket(): Promise<ClientSocket | null> {
		if (this.baseState.response != ResponseState.none) {
			this.badClientUsage('WebSocket upgrade on already claimed connection', false);
			return null;
		}

		/* check if the connection is a valid upgrade request (and ensure that the underlying web-server, also detected it) */
		let connection = libRequest.SplitAndTrimList(this.headers.connection?.toLowerCase() ?? null, ',', false);
		if (connection.indexOf('upgrade') == -1 || this.headers?.upgrade?.toLowerCase() != 'websocket' || this.method != 'GET') {
			this.respondUpdateRequired('websocket');
			return null;
		}
		if (this.nativeInterface.socket == null) {
			this.respondInternalError('Request was not provided as upgradable');
			return null;
		}
		const native = this.nativeInterface.socket;

		/* mark the connection as being accepted */
		this.baseState.response = ResponseState.headerSent;
		this.baseState.respondedResolve();
		this.baseState.upgrade = UpgradeState.upgrading;
		this.trace(`Performing upgrade on web socket connection: [${this.url.pathname}]`);

		/* await the actual websocket upgrade */
		const ws = await new Promise<ClientSocket | null>((resolve) => {
			let settled = false;

			/* register the broken listener (to detect failures of the upgrading or network errors) */
			this.baseState.breakPromise.then(() => {
				if (settled) return; settled = true;
				this.error('Failed to upgrade to WebSocket');
				resolve(null);
			});

			/* start the upgrade process (web-socket upgrade handler will automatically send error messages) */
			native.wss.handleUpgrade(this.nativeInterface.request, native.socket, native.head, (ws, _) => {
				if (!settled && this.baseState.response == ResponseState.headerSent) {
					settled = true, this.baseState.response = ResponseState.completed;

					/* ensure that the socket is valid as otherwise proper cleanup might not be guaranteed (no
					*	need to log errors, as this will trigger the broken state, which will be logged) */
					if (native.socket.destroyed)
						return resolve(null);
					return resolve(new ClientSocket(ws, this));
				}
				const settler = !settled;
				settled = true;
				this.markAsBroken('Broken connection upgraded', false);
				if (settler)
					resolve(null);
			});
		});
		this.baseState.upgrade = UpgradeState.upgraded;
		return ws;
	}
}

/*
*	WebSocket with integrated alive checks
*	Structured WebSocket, which takes care of error handling.
*	close() is guaranteed to be called exactly once and no data or others will follow.
*	Closing promise resolves once the close callback has been fully invoked.
*/
export class ClientSocket extends ClientBase {
	private ws: libWs.WebSocket;
	private timer: null | NodeJS.Timeout;
	private isAlive: boolean;
	private closing: { promise: Promise<void> | null, closed: (() => void) | null, defer: number };
	private logging: {
		root: libLog.LogIdentity,
		tags: { value: string }[]
	};

	public ondata?: (data: libWs.RawData, isBinary: boolean) => void;
	public onclose?: () => void;

	constructor(ws: libWs.WebSocket, base: ClientRequest) {
		super(base, 'socket');
		this.ws = ws;
		this.timer = null;
		this.isAlive = true;
		this.closing = { promise: null, closed: null, defer: 0 };
		this.logging = { root: libLog.Logger(this.logIdentity), tags: [] };

		this.ws.on('pong', () => {
			this.logging.root.trace(`Alive check pong received`);
			this.selfIsAlive();
		});
		this.ws.on('message', (data, isBinary) => {
			this.selfIsAlive();
			if (this.closing.promise != null || this.ondata == null)
				return;

			++this.closing.defer;
			try { this.ondata(data, isBinary); }
			catch (err: any) {
				this.handleClosing(`Unhandled exception in message handler: ${err.message}`);
			}
			--this.closing.defer;

			if (this.closing.promise != null)
				this.handleClosing();
		});
		this.ws.once('close', () => {
			this.handleClosing();

			/* check if any timers remain (must be the grace-kill timer, can be stopped, as this point can
			*	only be reached with an active timer, if defer was somehow still > 0, in which case its
			*	nested leaving will trigger the proper cleanup, but the timer is not necessary anymore) */
			if (this.timer != null)
				clearTimeout(this.timer);
			this.timer = null;
		});
		this.ws.once('error', (err: any) => {
			this.handleClosing(`WebSocket error: ${err.message}`);
		});

		/* start the first alive check */
		this.selfIsAlive();

		/* perserve the log tags of the base */
		base.log(`WebSocket accepted: [${this.logIdentity}]`);
		const logTagList = base.logIdentity.indexOf('.');
		if (logTagList >= 0) {
			this.logging.tags.push({ value: base.logIdentity.substring(logTagList + 1) });
			this.updateLogging();
		}
	}

	private checkIsAlive(): void {
		if (this.closing.promise != null)
			return;

		this.timer = null;
		if (libConfig.webSocketTimeout == 0)
			return;

		/* check if the connection is not alive anymore and should be killed */
		if (!this.isAlive || libConfig.webSocketAliveTimeout == 0)
			return this.handleClosing('Closing dead websocket');
		this.isAlive = false;
		this.timer = setTimeout(() => this.checkIsAlive(), libConfig.webSocketAliveTimeout);

		/* try to ping the remote to check the liveliness */
		try {
			this.logging.root.trace(`Sending ping to determine if connection is alive`);
			this.ws.ping();
		} catch (err: any) {
			this.handleClosing(`WebSocket error while pinging: ${err.message}`);
		}
	}
	private selfIsAlive(): void {
		this.isAlive = true;
		if (this.closing.promise != null)
			return;

		if (this.timer != null)
			clearTimeout(this.timer);
		this.timer = (libConfig.webSocketTimeout == 0 ? null : setTimeout(() => this.checkIsAlive(), libConfig.webSocketTimeout));
	}
	private handleClosing(terminate?: string): void {
		/* register the initial closing to mark a closing being imminent */
		if (this.closing.promise == null) {
			this.closing.promise = new Promise<void>((res) => this.closing.closed = res);

			/* kill the last timer (alive timer) */
			if (this.timer != null)
				clearTimeout(this.timer);
			this.timer = null;

			/* check if a termination should be triggered and otherwise start the grace termination timer */
			if (terminate != null) {
				this.logging.root.error(terminate);
				this.ws.terminate();
			}
			else {
				this.timer = setTimeout(() => {
					this.timer = null;
					if (this.closing.closed != null) {
						this.logging.root.error('Closing connection');
						this.ws.terminate();
					}
				}, libConfig.killGraceTimeout);
			}
		}

		if (this.closing.closed == null || this.closing.defer > 0)
			return;
		const closed = this.closing.closed;
		this.closing.closed = null;

		if (this.onclose != null) {
			try { this.onclose(); }
			catch (err: any) {
				this.logging.root.error(`Unhandled exception in WebSocket close handler: ${err.message}`);
			}
		}
		this.logging.root.trace('Socket connection closed');

		closed();
	}
	private updateLogging(): void {
		let identity = this.logging.root.logIdentity;

		for (const tag of this.logging.tags) {
			if (tag.value != '')
				identity += `.${tag.value}`;
		}

		this.logIdentity = identity;
	}

	/* tag the logging with the given identity and return a callback to update the tag (empty string will
	*	hide the tag entry; null will completely remove the tag; other values will update the tag) */
	public tagLog(identity: string): ((value?: string) => void) {
		let tag: { value: string } | null = { value: identity };

		this.logging.tags.push(tag);
		if (tag.value != '')
			this.updateLogging();

		/* setup the handler responsible to update the logging */
		return (value?: string) => {
			if (tag == null) return;

			/* check if the tag should be removed or if the value should just be updated */
			if (value == null) {
				this.logging.tags = this.logging.tags.filter((v) => v != tag);
				tag = null;
			}
			else if (value != tag.value)
				tag.value = value;

			this.updateLogging();
		};
	}

	public send(data: string | Buffer): void {
		if (this.closing.promise != null)
			return;

		try {
			this.ws.send(data);
		} catch (err: any) {
			this.handleClosing(`WebSocket error while sending data: ${err.message}`);
		}
	}
	public close(): Promise<void> {
		if (this.closing.promise == null) {
			this.ws.close();
			this.handleClosing();
		}
		return this.closing.promise!;
	}
}
