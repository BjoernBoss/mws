/* SPDX-License-Identifier: BSD-3-Clause */
/* Copyright (c) 2024-2026 Bjoern Boss Henrichsen */
import * as libServer from "./server.js";
import * as libTemplates from "./templates.js";
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

export class ClientShiftState {
	public logIdentity: string;
	public basePath: string;
	public path: string;

	constructor(logIdentity: string, basePath: string, path: string) {
		this.logIdentity = logIdentity;
		this.basePath = basePath;
		this.path = path;
	}
}

export class ClientBase extends libLog.LogIdentity {
	protected context: Record<string, unknown>;

	/* path relative to current module base-path */
	public path: string;

	/* absolute path on web-server */
	public fullPath: string;

	/* base path between the fullpath and path */
	public basePath: string;

	/* raw request origin (no host will result in '_') */
	public url: libUrl.URL;

	/* unique id to identify client in logs */
	readonly id: number;

	protected constructor(url: libUrl.URL);
	protected constructor(client: ClientBase);
	protected constructor(arg: libUrl.URL | ClientBase) {
		if (arg instanceof libUrl.URL) {
			const thisClientId = ++NextClientId;
			super(`client!${thisClientId}`);

			/* decode the string and re-encode it to ensure '/' and '\' are preserved as URI encoding, but the rest is decoded */
			const cleanPath: string = arg.pathname.split('/').map((segment) => {
				return decodeURIComponent(segment).replace(/[/\\]/g, (c) => (c === '/' ? '%2F' : '%5C'));
			}).join('/');

			this.context = {};
			this.id = thisClientId;
			this.path = libLocation.Sanitize(cleanPath, false);
			this.url = arg;
			this.fullPath = this.path;
			this.basePath = '/';
		}
		else {
			super(arg.logIdentity);
			this.context = arg.context;
			this.path = arg.path;
			this.fullPath = arg.fullPath;
			this.basePath = arg.basePath;
			this.url = arg.url;
			this.id = arg.id;
		}
	}

	public getContext(name: string): unknown | null {
		if (name in this.context)
			return this.context[name];
		return null;
	}
	public setContext(name: string, value: unknown): void {
		this.context[name] = value;
	}
	public makePath(path: string): string {
		return libLocation.JoinSanitized(this.basePath, path);
	}

	/* check if path is a substring of the current path, and if so, shift the path and identity and
	*	return the cached shift (to be able to recover the old state), otherwise it returns null */
	public translate(path: string, identity: string): ClientShiftState | null {
		if (!libLocation.IsSubDirectory(path, this.path))
			return null;
		const shift = new ClientShiftState(this.logIdentity, this.basePath, this.path);

		/* shift the paths and the log identity */
		this.basePath = libLocation.JoinSanitized(this.basePath, path);
		this.path = this.path.substring(path.endsWith('/') ? path.length - 1 : path.length);
		if (this.path == '')
			this.path = '/';
		this.logIdentity = `${this.logIdentity}.${identity}`;
		return shift;
	}

	/* only shift onto the logging identity */
	public shiftLog(identity: string): ClientShiftState {
		const shift = new ClientShiftState(this.logIdentity, this.basePath, this.path);
		this.logIdentity = `${this.logIdentity}.${identity}`;
		return shift;
	}

	/* restore a shifting operation */
	public unshift(cache: ClientShiftState): void {
		this.logIdentity = cache.logIdentity;
		this.basePath = cache.basePath;
		this.path = cache.path;
	}
}

enum ResponseState {
	none,
	acknowledged,
	responded,
	broken
}

let NextClientId: number = 0;
const WebSocketServerInstance: libWs.Server = new libWs.WebSocketServer({ noServer: true });

/*
*	Request is considered acknowledged, as soon as a response has been triggered or a preparation started.
*	Paths are URI decoded, except for nested '/' and '\'
*	A request can only be responded to once, unless the response is marked as an exception, in which
*		case it will either be sent (if possible) or the connection will be flushed and closed
*	Not responded to requests will result in [not-found]
*/
export abstract class IncomingBase extends ClientBase {
	protected request: libHttp.IncomingMessage;
	protected state: ResponseState;
	protected outputHeaders: Record<string, string>;

	protected abstract finalizeTextHeader(status: libRequest.StatusType, media: libRequest.MediaType, content: string): void;
	protected abstract finishSelf(): Promise<void>;
	protected abstract destroySelfIfIncomplete(): void;

	constructor(request: libHttp.IncomingMessage, host: string, protocol: string) {
		super(new libUrl.URL(`${protocol}//${host == '' ? '_' : host}${request.url}`));
		this.request = request;
		this.state = ResponseState.none;
		this.outputHeaders = {};
	}
	protected constructTextResponse(status: libRequest.StatusType, media: libRequest.MediaType, content: string, logReason: string, exception: boolean): void {
		if (this.state == ResponseState.none || (exception && this.state == ResponseState.acknowledged)) {
			this.log(`Responding with [${status.msg}]${logReason}`);
			this.finalizeTextHeader(status, media, content);
			this.state = ResponseState.responded;
		}
		else if (exception) {
			this.error(`Broken with [${status.msg}]${logReason}`);
			this.state = ResponseState.broken;
		}
		else
			throw new Error('Request has already been handled');
	}

	public get headers(): libHttp.IncomingHttpHeaders {
		return this.request.headers;
	}
	public get handled(): boolean {
		return (this.state != ResponseState.none);
	}
	public get broken(): boolean {
		return (this.state == ResponseState.broken);
	}
	public get method(): string {
		return this.request.method ?? '';
	}

	/* add the given header to the response (should be title cased) */
	public addHeader(key: string, value: string): void {
		if (this.state != ResponseState.none && this.state != ResponseState.acknowledged)
			throw new Error('Cannot modify headers of sent response');
		this.outputHeaders[key] = value;
	}

	/* called by framework to finish this incoming object (sends queued content, not-found if unhandled, or internal-error if incomplete/failed) */
	public async finishIncoming(): Promise<void> {
		await this.finishSelf();
		if (this.state == ResponseState.none)
			this.respondNotFound();
		else if (this.state == ResponseState.acknowledged)
			this.respondInternalError('Request processing failed');
		if (this.state == ResponseState.broken)
			this.destroySelfIfIncomplete();
	}

	/* respond with [internal-error] and a pre-defined html template response (always considered an exception, clears any other header fields) */
	public respondInternalError(msg: string): void {
		this.outputHeaders = {};
		const content = libTemplates.ErrorInternalServerError({ path: this.url.pathname, what: msg });
		this.constructTextResponse(libRequest.Status.InternalError, libRequest.Media.Html, content, ` due to [${msg}]`, true);
	}

	/* respond with [internal-error] and message 'Filesystem operation failed' */
	public respondFileSystemError(): void {
		this.respondInternalError('Filesystem operation failed');
	}

	/* respond with a textual response of the given configuration (defaults to media-type: text, status: ok) */
	public respondAnyText(content: string, options?: { media?: libRequest.MediaType, status?: libRequest.StatusType, exception?: boolean }): void {
		const media = options?.media ?? libRequest.Media.Text;
		const status = options?.status ?? libRequest.Status.Ok;
		const logReason = ` of type [${media.mediaType}]: [${content.substring(0, 32).replaceAll('\n', ' ').replaceAll('\r', ' ').replaceAll('\t', ' ')}...]`;
		this.constructTextResponse(status, media, content, logReason, options?.exception ?? false);
	}

	/* respond with [ok] and a pre-defined html template response */
	public respondOk(operation: string, options?: { exception?: boolean }): void {
		const content = libTemplates.SuccessOk({ path: this.url.pathname, operation: operation });
		this.constructTextResponse(libRequest.Status.Ok, libRequest.Media.Html, content, ` for [${operation}]`, options?.exception ?? false);
	}

	/* respond with [bad-request] and a pre-defined html template response */
	public respondBadRequest(reason: string, options?: { exception?: boolean }): void {
		const content = libTemplates.ErrorBadRequest({ path: this.url.pathname, reason });
		this.constructTextResponse(libRequest.Status.BadRequest, libRequest.Media.Html, content, ` due to [${reason}]`, options?.exception ?? false);
	}

	/* respond with [range-not-satisfiable] and a pre-defined html template response */
	public respondRangeIssue(range: string, size: number, options?: { exception?: boolean }): void {
		const content = libTemplates.ErrorRangeIssue({ path: this.url.pathname, range, size });
		const logReason = `because [${range}] cannot be satisfied for size [${size}]`;
		this.constructTextResponse(libRequest.Status.RangeIssue, libRequest.Media.Html, content, logReason, options?.exception ?? false);
	}

	/* respond with [conflict] and a pre-defined html template response */
	public respondConflict(conflict: string, options?: { exception?: boolean }): void {
		const content = libTemplates.ErrorConflict({ path: this.url.pathname, conflict });
		this.constructTextResponse(libRequest.Status.Conflict, libRequest.Media.Html, content, ` due to [${conflict}]`, options?.exception ?? false);
	}

	/* respond with [not-found] and a pre-defined html template response */
	public respondNotFound(options?: { exception?: boolean }): void {
		const content = libTemplates.ErrorNotFound({ path: this.url.pathname });
		this.constructTextResponse(libRequest.Status.NotFound, libRequest.Media.Html, content, '', options?.exception ?? false);
	}

	/* respond with [unsupported-media-type] and a pre-defined html template response */
	public respondUnsupported(used: string, allowed: string, options?: { exception?: boolean }): void {
		const content = libTemplates.ErrorUnsupportedMediaType({ path: this.url.pathname, used, allowed });
		const logReason = ` because [${used}] was used and only [${allowed}] supported`;
		this.constructTextResponse(libRequest.Status.UnsupportedMediaType, libRequest.Media.Html, content, logReason, options?.exception ?? false);
	}

	/* respond with [invalid-method] and a pre-defined html template response */
	public respondMethodNotAllowed(method: string, allowed: string, options?: { exception?: boolean }): void {
		const content = libTemplates.ErrorInvalidMethod({ path: this.url.pathname, method: method, allowed });
		const logReason = ` because [${method}] was used and only [${allowed}] supported`;
		this.constructTextResponse(libRequest.Status.MethodNotAllowed, libRequest.Media.Html, content, logReason, options?.exception ?? false);
	}

	/* respond with [content-too-large] and a pre-defined html template response */
	public respondContentTooLarge(allowed: number, atLeastProvided: number, options?: { exception?: boolean }): void {
		const content = libTemplates.ErrorContentTooLarge({ path: this.url.pathname, allowedLength: allowed, providedLength: atLeastProvided });
		this.constructTextResponse(libRequest.Status.ContentTooLarge, libRequest.Media.Html, content, ` because [${atLeastProvided}] > [${allowed}]`, options?.exception ?? false);
	}

	/* respond with [see-other] to the given target and a pre-defined html template response (forces method GET) */
	public respondSeeOther(target: string, options?: { exception?: boolean }): void {
		const content = libTemplates.SeeOther({ destination: target });
		this.outputHeaders['Location'] = target;
		this.constructTextResponse(libRequest.Status.SeeOther, libRequest.Media.Html, content, ` to [${target}]`, options?.exception ?? false);
	}

	/* respond with [temporary-redirect] to the given target and a pre-defined html template response (preserves method) */
	public respondTemporaryRedirect(target: string, options?: { exception?: boolean }): void {
		const content = libTemplates.TemporaryRedirect({ path: this.url.pathname, destination: target });
		this.outputHeaders['Location'] = target;
		this.constructTextResponse(libRequest.Status.TemporaryRedirect, libRequest.Media.Html, content, ` to [${target}]`, options?.exception ?? false);
	}

	/* respond with [permanent-redirect] to the given target and a pre-defined html template response (preserves method)  */
	public respondPermanentRedirect(target: string, options?: { exception?: boolean }): void {
		const content = libTemplates.PermanentRedirect({ path: this.url.pathname, destination: target });
		this.outputHeaders['Location'] = target;
		this.constructTextResponse(libRequest.Status.PermanentRedirect, libRequest.Media.Html, content, ` to [${target}]`, options?.exception ?? false);
	}
}

/*
*	Html response is sent once its content has been set and the modules have completed the processing
*
*	Receiving data: Will automatically decode the stream and ensure a given maximum is not passed
*		=> Will drain upload if it is not being received or the request enters a failure state
*		=> Destroying receive reader will drain the remaining data
*		=> Any errors while receiving will either auto-respond or send the connection into the failed state, and fail the receive reader (stream user does not need to respond)
*	Responding data: Will automatically encode the stream and send the header accordingly
*		=> Will automatically determine if encoding is to be used
*		=> Checks if promised number of bytes is provided
*		=> Will automatically error, if the failed state is detected, and will auto-respond or send the connection into the failed state (stream user does not need to respond)
*/
export class HttpRequest extends IncomingBase {
	private response: libHttp.ServerResponse;
	private receiving: boolean;
	private responding: Promise<void> | null;
	private htmlResponse?: { page: libBuilder.HtmlPage, status: libRequest.StatusType };

	constructor(request: libHttp.IncomingMessage, response: libHttp.ServerResponse, host: string, protocol: string) {
		super(request, host, protocol);
		this.response = response;
		this.receiving = false;
		this.responding = null;
	}

	protected override finalizeTextHeader(status: libRequest.StatusType, media: libRequest.MediaType, content: string): void {
		let buffer: Buffer = Buffer.from(content, 'utf-8');

		/* check if the data should be encoded */
		const encoding = libRequest.EncodingOption(this.headers['accept-encoding'] ?? null, buffer.byteLength, media);
		if (encoding != null) {
			this.log(`Sending content [${media.mediaType}] of size [${buffer.byteLength}] encoded using [${encoding.name}]`);
			buffer = encoding.encodeBuffer(buffer);
			this.outputHeaders['Content-Encoding'] = encoding.name;
			this.outputHeaders['Vary'] = 'Accept-Encoding';
		}

		/* send the encoded data */
		this.closeHeader(status, media, buffer.length, false);
		this.response.end(buffer);
	}
	protected override destroySelfIfIncomplete(): void {
		if (!this.response.writableEnded && !this.response.destroyed)
			this.response.destroy();
	}
	protected override async finishSelf(): Promise<void> {
		if (!this.receiving)
			this.request.resume();
		if (this.state != ResponseState.acknowledged)
			return;

		/* check if html has been queued and respond with it or await for the response header to be sent */
		if (this.htmlResponse != null) {
			this.finalizeTextHeader(this.htmlResponse.status, libRequest.Media.Html, this.htmlResponse.page.finalize());
			this.state = ResponseState.responded;
		}
		else if (this.responding != null)
			await this.responding;
	}
	private closeHeader(status: libRequest.StatusType, media: libRequest.MediaType, contentSize: number | null, updateState: boolean): void {
		if (updateState)
			this.state = ResponseState.responded;

		/* setup the response status and headers */
		this.response.statusCode = status.code;
		this.response.statusMessage = status.msg;
		for (const key in this.outputHeaders)
			this.response.setHeader(key, this.outputHeaders[key]);
		this.response.setHeader('Server', libServer.GetServerName());
		this.response.setHeader('Content-Type', libRequest.BuildMediaTypeIdentifier(media));
		this.response.setHeader('Date', new Date().toUTCString());
		if (!('Accept-Ranges' in this.outputHeaders))
			this.response.setHeader('Accept-Ranges', 'none');
		if (contentSize != null)
			this.response.setHeader('Content-Length', contentSize);
	}
	private receiveClientData(maxLength: number | null): libStream.Readable {
		/* check if the object is ready for receiving */
		if (this.receiving)
			throw new Error('Payload has already been handled');
		this.receiving = true;
		if (this.request.destroyed || this.state == ResponseState.broken)
			throw new Error('Connection is broken');

		/* add the accept-encoding list */
		const acceptedEncodings = libRequest.SupportedEncodingNames().join(',');
		this.outputHeaders['Accept-Encoding'] = acceptedEncodings;

		/* setup the accumulation transformer (which will also be returned in the end) */
		let accumulated = 0;
		const output = new libStream.Transform({
			transform: (chunk, _, cb) => {
				if (output.destroyed) return cb(new Error('Already failed'));

				/* check if the connection has been marked as failed */
				if (this.state == ResponseState.broken)
					return cb(new Error('Connection is broken'));

				/* check the maximum count (is violated) */
				accumulated += chunk.byteLength;
				if (maxLength == null || accumulated <= maxLength)
					return cb(null, chunk);
				this.respondContentTooLarge(maxLength, accumulated, { exception: true });
				cb(new Error('Request is too large'));
			}
		});

		/* drain the remainder of the request, if the output is closed/destroyed */
		output.on('close', () => {
			this.request.unpipe();
			if (!this.request.readableEnded)
				this.request.resume();
		});

		/* check if the content is encoded */
		let stream: libStream.Readable = this.request;
		if (this.headers['content-encoding'] != null) {
			const encoding: libRequest.EncodingType | null = libRequest.LookupEncoding(this.headers['content-encoding']);

			/* check if the encoding is unsupported and otherwise ensure the request is drained */
			if (encoding == null) {
				this.respondUnsupported(this.headers['content-encoding'], acceptedEncodings, { exception: true });
				this.request.resume();
				throw new Error('Unsupported content encoding');
			}

			/* wrap the request and register the compression stream failure handler */
			const decoder = encoding.makeDecode();
			stream = this.request.pipe(decoder);
			decoder.on('error', (err: any) => {
				if (output.destroyed) return;
				this.respondBadRequest('Invalid data encoding', { exception: true });
				output.destroy(err);
			});
			output.on('close', () => decoder.destroy());
		}

		/* check if too many data have been promised */
		else if (maxLength != null && this.headers['content-length'] != null) {
			const contentSize = parseInt(this.headers['content-length']);

			/* check if the length is valid and otherwise mark the request as 'consumed' */
			if (!isFinite(contentSize) || contentSize < 0 || contentSize > maxLength) {
				this.respondContentTooLarge(maxLength, contentSize, { exception: true });
				this.request.resume();
				throw new Error('Request payload is too large');
			}
		}

		/* register the network error handler to properly forward exceptions (no need to respond on network errors) */
		this.request.on('error', (err: any) => {
			if (!output.destroyed)
				output.destroy(err);
		});

		/* create the plumbing between stream and output (errors are already handled) */
		return stream.pipe(output);
	}
	private sendClientData(media: libRequest.MediaType, status: libRequest.StatusType, options: { encoded?: string, contentSize?: number, noEncode?: boolean }): libStream.Writable {
		/* check if the object is already responded */
		if (this.state != ResponseState.none)
			throw new Error('Request has already been handled');
		this.log(`Responding with data and status [${status.msg}]`);
		if (this.response.destroyed)
			throw new Error('Connection is broken');

		/* setup the respond promise to notify the cleanup of when the header has been sent */
		this.state = ResponseState.acknowledged;
		let resolver: (() => void) | null = null;
		this.responding = new Promise((resolve) => resolver = resolve);

		/* setup the output stream to be written out */
		const output = new libStream.Writable({
			write: (chunk: Buffer, _, cb: (err: any) => void) => handleData(chunk, cb),
			final: (cb: (err: any) => void) => handleData(null, cb),
			destroy: (err: any, cb: (err: any) => void) => {
				handleFailure();
				cb(err);
			}
		});

		let stream: libStream.Writable = this.response, headerSent = false;
		let dataCache: Buffer | null = null, totalSent = 0, closed = false;
		const handleData = (chunk: Buffer | null, cb: (err: any) => void) => {
			if (output.destroyed) return cb(new Error('Already failed'));

			/* check if the connection has been marked as failed or completed */
			if (closed)
				return cb(new Error('Responding to closed response'));
			if (this.state == ResponseState.broken)
				return cb(new Error('Connection is broken'));
			const last = (chunk == null), cached = (dataCache != null);

			/* check if the header still needs to be sent */
			if (!headerSent) {
				if (this.state != ResponseState.acknowledged)
					return cb(new Error('Connection already responded to'));

				/* check if previous data were cached and combine them */
				if (cached)
					chunk = (chunk == null ? dataCache : Buffer.concat([dataCache!, chunk]));
				dataCache = null;

				/* check if the sending should be deferred to determine if compression should be enabled or to allow inline compression on small packets */
				if (!last && (chunk!.byteLength < libRequest.MIN_ENCODING_SIZE || !cached)) {
					dataCache = chunk;
					return cb(null);
				}

				/* check if the content is already encoded */
				let fullContentSize = (options.contentSize ?? (last ? (chunk?.byteLength ?? 0) : null)), encoder = 'identity';
				if (options.encoded != null) {
					this.outputHeaders['Content-Encoding'] = options.encoded;
					this.outputHeaders['Vary'] = 'Accept-Encoding';
				}

				/* check if an encoding can be applied and setup the header and stream accordingly */
				else if (options.noEncode !== true && fullContentSize !== 0) {
					const encoding = libRequest.EncodingOption(this.headers['accept-encoding'] ?? null, fullContentSize ?? chunk!.byteLength, media);
					if (encoding != null) {
						encoder = encoding.name;
						this.outputHeaders['Content-Encoding'] = encoding.name;
						this.outputHeaders['Vary'] = 'Accept-Encoding';
						this.outputHeaders['Accept-Ranges'] = 'none';

						/* check if the header can be encoded inplace (update the content size, as it is now exact but differs due to being encoded) */
						if (last) {
							chunk = encoding.encodeBuffer(chunk!);
							options.contentSize = chunk.byteLength;
							fullContentSize = chunk.byteLength;
						} else {
							fullContentSize = null;
							stream = encoding.makeEncode();
							stream.pipe(this.response);

							/* register the encoding error handler */
							stream.on('error', (err: any) => {
								if (output.destroyed) return;
								this.respondInternalError('Data encoding error encountered');
								output.destroy(err);
							});
						}
					}
				}

				/* send the final header away and write the content to the stream */
				this.log(`Sending content [${media.mediaType}] of size [${fullContentSize ?? 'unknown'}] encoded using [${encoder}]`);
				this.closeHeader(status, media, fullContentSize, true);
				headerSent = true;
				resolver!();
			}

			/* update the total-sent counter and check if the upper-bound is broken */
			if (chunk != null) {
				totalSent += chunk.byteLength;
				if (options.contentSize != null && totalSent > options.contentSize) {
					this.respondInternalError('Response handling issue encountered');
					return cb(new Error('Sending more data than promised'));
				}
			}

			/* check if this is an intermediate write, and write the data out */
			if (!last)
				return stream.write(chunk!, () => cb(null));
			closed = true;

			/* send the last package */
			if (options.contentSize != null && totalSent < options.contentSize) {
				this.respondInternalError('Response handling issue encountered');
				return cb(new Error('Responded with too few data'));
			}
			if (chunk != null)
				return stream.end(chunk, () => cb(null));
			return stream.end(() => cb(null));
		};

		const handleFailure = () => {
			/* check if the entire message has already been sent, in which case this will just be ignored */
			if (closed)
				return;

			/* check if the output stream was an encoder, in which case it still needs to be destroyed */
			if (stream !== this.response)
				stream.destroy();

			/* check if the response has not yet been sent */
			if (this.state == ResponseState.acknowledged)
				return this.respondInternalError('Response handling issue encountered');

			/* check if data are still missing/the connection was not properly closed (will ensure the connection will be closed) */
			if (this.state == ResponseState.responded && headerSent)
				return this.respondInternalError('Response handling issue encountered');
		};

		/* register the network error handler to properly forward exceptions (no need to respond on network errors) */
		this.response.on('error', (err: any) => {
			if (!output.destroyed)
				output.destroy(err);
		});
		return output;
	}

	/* ensure the method is one of the list and otherwise return null and auto-respond with [method-not-allowed] */
	public ensureMethod(methods: string[]): string | null {
		const method = this.request.method ?? '';
		if (methods.indexOf(method) >= 0)
			return method;
		this.respondMethodNotAllowed(method, methods.join(','));
		return null;
	}

	/* ensure the media-type is one of the list and otherwise return null and auto-respond with [unsupported-media-type] (defaults to first type) */
	public ensureMediaType(types: libRequest.MediaType[]): libRequest.MediaType | null {
		const type = this.headers['content-type']?.toLowerCase().split(';')[0].trim();
		if (type == null)
			return types[0];
		for (let i = 0; i < types.length; ++i) {
			if (type === types[i].mediaType)
				return types[i];
		}
		this.respondUnsupported(type, types.join(','));
		return null;
	}

	/* check the content-type for a media-type and otherwise return the default type */
	public getMediaTypeCharset(defEncoding: string): string {
		const type = this.headers['content-type'];
		if (type == null)
			return defEncoding;

		let index = type.indexOf('charset=');
		if (index == -1)
			return defEncoding;
		index += 8;

		let end = index;
		while (end < type.length && type[end] != ';')
			++end;

		if (index == end)
			return defEncoding;
		return type.substring(index, end).trim().toLowerCase();
	}

	/* return the html-page, if a child module plans to produce html */
	public getHtmlPage(): libBuilder.HtmlPage | null {
		return this.htmlResponse?.page ?? null;
	}

	/* respond with html, can be built on by parent modules, sent once the client is cleared and the builder is ready */
	public respondHtml(page: libBuilder.HtmlPage, status: libRequest.StatusType = libRequest.Status.Ok): void {
		if (this.state != ResponseState.none)
			throw new Error('Request has already been handled');

		this.log(`Responding with HTML content and status [${status.code}]`);
		this.state = ResponseState.acknowledged;
		this.htmlResponse = { page, status };
	}

	/* send data with [media type] and [status] and return a writable stream (default status is ok)
	*	if a content size is provided, stream expects exactly this amount of bytes
	*	the encoding can be configured, if the data is pre-encoded (warning: no checks against accepted encodings performed!) */
	public sendData(media: libRequest.MediaType = libRequest.Media.Unknown, options?: { status?: libRequest.StatusType, encoded?: string, contentSize?: number }): libStream.Writable {
		return this.sendClientData(media, options?.status ?? libRequest.Status.Ok, { encoded: options?.encoded, contentSize: options?.contentSize });
	}

	/* try to respond with the given file, and return false, if not found (http-range aware)
	*	the media type can be overwritten (defaults to extracting media-type from the file-path)
	*	the encoding can be configured, if the file is pre-encoded (warning: no checks against accepted encodings performed!)
	*	status will be [Ok] or [partial-content] */
	public tryRespondFile(filePath: string, options?: { encoded?: string, media?: libRequest.MediaType }): boolean {
		if (this.state != ResponseState.none)
			throw new Error('Request has already been handled');

		/* look for the file */
		let cached: libCache.Cached | null = null;
		try {
			/* lookup the file in the cache */
			cached = libCache.Get(filePath);
			if (cached == null)
				return false;
		}
		catch (_) {
			this.respondFileSystemError();
			return true;
		}
		const media = (options?.media ?? libRequest.LookupMediaTypeFromFile(filePath));

		/* mark byte-ranges to be supported in principle */
		this.outputHeaders['Accept-Ranges'] = 'bytes';

		/* parse the range and ensure that its well formed */
		const range = libRequest.ParseRangeHeader(this.headers.range ?? null, cached.fileSize());
		if (range.state == libRequest.RangeState.malformed) {
			this.respondBadRequest(`Issues while parsing http-header range: [${this.headers.range}]`, { exception: true });
			return true;
		}
		else if (range.state == libRequest.RangeState.issue) {
			this.outputHeaders['Content-Range'] = `bytes */${cached.fileSize()}`;
			this.respondRangeIssue(this.headers.range!, cached.fileSize(), { exception: true });
			return true;
		}

		/* check if the file is empty (can only happen for unused ranges, which would otherwise have issues) */
		if (cached.fileSize() == 0) {
			this.log(`Sending empty content for [${filePath}]`);
			this.closeHeader(libRequest.Status.Ok, media, 0, true);
			this.response.end();
			return true;
		}

		/* create the stream for the file and add the range header */
		let source: libStream.Readable = cached.stream({ start: range.first, end: range.last });
		if (range.state == libRequest.RangeState.valid)
			this.outputHeaders['Content-Range'] = `bytes ${range.first}-${range.last}/${cached.fileSize()}`;

		/* create the writer stream and connect the components */
		let stream: libStream.Writable | null = null;
		try {
			/* create the write stream for the content */
			const status = (range.state == libRequest.RangeState.noRange ? libRequest.Status.Ok : libRequest.Status.PartialContent);
			stream = this.sendClientData(media, status, { encoded: options?.encoded, contentSize: range.last - range.first + 1, noEncode: range.state != libRequest.RangeState.noRange });
			this.log(`Sending content [${range.first} - ${range.last}/${cached.fileSize()}] from [${filePath}]`);
		}
		catch (err: any) {
			this.error(`Failed to upload file [${filePath}]: ${err.message}`);
			return true;
		}

		/* pipe the components together */
		let closed = false;
		source.pipe(stream);
		source.on('error', (err: any) => {
			if (closed) return; closed = true;
			this.respondFileSystemError();
			this.error(`Error while sending file [${filePath}]: [${err.message}]`);
			stream.destroy(err);
		});
		stream.on('error', (err: any) => {
			if (closed) return; closed = true;
			source.destroy(err);
		});
		return true;
	}

	/* receive the payload of given max length as a readable stream
	*	automatically responds with given exceptions if the payload cannot be received properly */
	public receiveData(maxLength: number | null): libStream.Readable {
		return this.receiveClientData(maxLength);
	}

	/* receive the payload of given max length as a single complete buffer
	*	automatically responds with given exceptions if the payload cannot be received properly */
	public receiveAllBuffer(maxLength: number | null): Promise<Buffer> {
		return new Promise((resolve, reject) => {
			let stream: libStream.Readable | null = null;
			try {
				stream = this.receiveClientData(maxLength);
			} catch (err: any) {
				return reject(err);
			}

			const buffers: Buffer[] = [];
			stream.on('data', (chunk: Buffer) => buffers.push(chunk));
			stream.on('end', () => resolve(Buffer.concat(buffers)));
			stream.on('error', (err: any) => reject(err));
		});
	}

	/* receive the payload of given max length as a single complete decoded string
	*	automatically responds with given exceptions if the payload cannot be received properly */
	public async receiveAllText(encoding: string, maxLength: number | null): Promise<string> {
		/* wait for the buffer (let all errors propagate out) */
		const buffer: Buffer = await this.receiveAllBuffer(maxLength);

		try {
			return buffer.toString(encoding as BufferEncoding);
		} catch (err: any) {
			this.respondBadRequest('Unable to decode content', { exception: true });
			throw err;
		}
	}

	/* receive the payload of given max length and write it directly to a file; will fail
	*	if the file already exists and delete the file if it could not be received in full
	*	automatically responds with given exceptions if the payload cannot be received properly or file operations fail */
	public receiveToFile(path: string, maxLength: number | null): Promise<void> {
		this.log(`Collecting data from [${this.url.pathname}] to: [${path}]`);
		return new Promise((resolve, reject) => {
			let source: libStream.Readable | null = null;
			try {
				source = this.receiveClientData(maxLength);
			}
			catch (err: any) {
				return reject(err);
			}

			/* create the stream to the file to be written and setup the blumbing */
			const destination = libFs.createWriteStream(path, { flags: 'wx' });
			let fileFailed = false, sourceFailed = false, opened = false;
			source.on('error', (err: any) => {
				sourceFailed = true;
				destination.destroy(err);
			});
			destination.on('open', () => {
				opened = true;
				if (!sourceFailed)
					source.pipe(destination);
				else
					destination.destroy();
			});
			destination.on('error', (err: any) => {
				if (!sourceFailed)
					this.respondFileSystemError();
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
			destination.on('close', () => {
				if (!sourceFailed && !fileFailed)
					resolve();
			});
		});
	}
}

/*
*	Will drain any uploaded data
*/
export class HttpUpgrade extends IncomingBase {
	private socket: libStream.Duplex;
	private head: Buffer;

	constructor(request: libHttp.IncomingMessage, socket: libStream.Duplex, head: Buffer, host: string, protocol: string) {
		super(request, host, protocol);
		this.socket = socket;
		this.head = head;
	}

	protected override finalizeTextHeader(status: libRequest.StatusType, media: libRequest.MediaType, content: string): void {
		const buffer = Buffer.from(content, 'utf-8');

		this.outputHeaders['Date'] = new Date().toUTCString();
		this.outputHeaders['Server'] = libServer.GetServerName();
		this.outputHeaders['Content-Type'] = libRequest.BuildMediaTypeIdentifier(media);
		this.outputHeaders['Content-Length'] = buffer.byteLength.toString();
		this.outputHeaders['Accept-Ranges'] = 'none';
		if ((this.request.headers.connection ?? "").toLowerCase() != "close" && this.request.httpVersionMajor < 2) {
			this.outputHeaders['Connection'] = 'keep-alive';
			this.outputHeaders['Keep-Alive'] = 'timeout=5';
		}

		/* construct the entire header content and send it away */
		let header = `HTTP/1.1 ${status.code} ${status.msg}\r\n`;
		for (const key in this.outputHeaders)
			header += `${key}: ${this.outputHeaders[key]}\r\n`;
		header += '\r\n';
		this.socket.write(header, 'utf-8');
		this.socket.write(buffer);
	}
	protected override async finishSelf(): Promise<void> {
		this.request.resume();
	}
	protected override destroySelfIfIncomplete(): void {
		if (!this.socket.destroyed)
			this.socket.destroy();
	}

	/* marks the object as having been handled (returns false, if connection is not a valid websocket upgrade request) */
	public tryAcceptWebSocket(cb: (ws: ClientSocket) => void): boolean {
		if (this.state != ResponseState.none)
			throw new Error('Request has already been handled');

		/* check if the connection is a valid upgrade request */
		let connection = this.headers?.connection?.toLowerCase().split(',').map((v) => v.trim());
		if (connection == null || connection.indexOf('upgrade') == -1)
			return false;
		if (this.headers?.upgrade?.toLowerCase() != 'websocket' || this.request.method != 'GET')
			return false;

		this.state = ResponseState.responded;

		WebSocketServerInstance.handleUpgrade(this.request, this.socket, this.head, (ws, request) => {
			WebSocketServerInstance.emit('connection', ws, request);
			cb(new ClientSocket(ws, this));
		});
		return true;
	}
}

export class ClientSocket extends ClientBase {
	private ws: libWs.WebSocket;

	public onpong?: () => void;
	public ondata?: (data: libWs.RawData, isBinary: boolean) => void;
	public onclose?: () => void;

	constructor(ws: libWs.WebSocket, base: HttpUpgrade) {
		super(base);
		this.ws = ws;

		this.ws.on('message', (data, isBinary) => {
			if (this.ondata != null)
				this.ondata(data, isBinary);
		});
		this.ws.on('close', () => {
			if (this.onclose != null)
				this.onclose();
		});
		this.ws.on('pong', () => {
			if (this.onpong != null)
				this.onpong();
		});
		this.ws.on('error', (err: any) => {
			this.error(`WebSocket error: ${err.message}`);
			if (this.ws.readyState != libWs.WebSocket.CLOSED)
				this.ws.close();
		});
	}

	public ping(): void {
		try {
			this.ws.ping();
		} catch (err: any) {
			this.error(`WebSocket error while pinging: ${err.message}`);
			if (this.ws.readyState != libWs.WebSocket.CLOSED)
				this.ws.close();
		}
	}
	public send(data: string | Buffer): void {
		try {
			this.ws.send(data);
		} catch (err: any) {
			this.error(`WebSocket error while sending data: ${err.message}`);
			if (this.ws.readyState != libWs.WebSocket.CLOSED)
				this.ws.close();
		}
	}
	public close(): void {
		this.ws.close();
	}
}
