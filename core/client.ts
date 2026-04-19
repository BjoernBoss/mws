/* SPDX-License-Identifier: BSD-3-Clause */
/* Copyright (c) 2024-2026 Bjoern Boss Henrichsen */
import * as libServer from "./server.js";
import * as libTemplates from "./templates.js";
import * as libLog from "./log.js";
import * as libLocation from "./location.js";
import * as libBuilder from "./builder.js";
import * as libCache from "./cache.js";
import * as libPath from "path";
import * as libFs from "fs";
import * as libStream from "stream";
import * as libUrl from "url";
import * as libWs from "ws";
import * as libHttp from "http";

export interface ResponseBody {
	content: string;
	fileType: string;
}
export interface StatusCodeType {
	code: number;
	msg: string;
}
export const StatusCode = {
	Ok: { code: 200, msg: 'Ok' },
	PartialContent: { code: 206, msg: 'Partial Content' },
	SeeOther: { code: 303, msg: 'See Other' },
	TemporaryRedirect: { code: 307, msg: 'Temporary Redirect' },
	PermanentRedirect: { code: 308, msg: 'Permanent Redirect' },
	BadRequest: { code: 400, msg: 'Bad Request' },
	NotFound: { code: 404, msg: 'Not Found' },
	MethodNotAllowed: { code: 405, msg: 'Method Not Allowed' },
	Conflict: { code: 409, msg: 'Conflict' },
	ContentTooLarge: { code: 413, msg: 'Content Too Large' },
	UnsupportedMediaType: { code: 415, msg: 'Unsupported Media Type' },
	RangeIssue: { code: 416, msg: 'Range Not Satisfiable' },
	InternalError: { code: 500, msg: 'Internal Server Error' }
}

enum RangeParseState {
	noRange,
	valid,
	issue,
	malformed
}
function ParseRangeHeader(range: string | null, fileSize: number): { first: number, last: number, state: RangeParseState } {
	if (range == null)
		return { first: 0, last: fileSize - 1, state: RangeParseState.noRange };

	/* check if it requests bytes */
	if (!range.startsWith('bytes='))
		return { first: 0, last: 0, state: RangeParseState.issue };
	range = range.substring(6);

	/* extract the first number */
	let numberLength: number = 0, firstNumber: string = '', lastNumber: string = '';
	while (numberLength < range.length && (range[numberLength] >= '0' && range[numberLength] <= '9'))
		++numberLength;
	firstNumber = range.substring(0, numberLength);
	range = range.substring(numberLength);

	/* check if the separator exists */
	if (!range.startsWith('-'))
		return { first: 0, last: 0, state: RangeParseState.malformed };
	range = range.substring(1);

	/* extract the second number */
	numberLength = 0;
	while (numberLength < range.length && (range[numberLength] >= '0' && range[numberLength] <= '9'))
		++numberLength;
	lastNumber = range.substring(0, numberLength);
	range = range.substring(numberLength).trimStart();

	/* check if a valid end has been found or another range (only the first
	*	range will be respected) and that at least one number has been given */
	if (range != '' && !range.startsWith(','))
		return { first: 0, last: 0, state: RangeParseState.malformed };
	if (firstNumber == '' && lastNumber == '')
		return { first: 0, last: 0, state: RangeParseState.malformed };

	/* parse the two numbers */
	let first: number | null = (firstNumber.length == 0 ? null : parseInt(firstNumber));
	let last: number | null = (lastNumber.length == 0 ? null : parseInt(lastNumber));

	/* check if the range has an offset and potentially also an end */
	if (first != null) {
		if (last == null)
			last = fileSize - 1;
		if (first > last || last >= fileSize)
			return { first: 0, last: 0, state: RangeParseState.issue };
		return { first, last, state: RangeParseState.valid };
	}

	/* validate the offset at the end */
	if (last! > fileSize || last! == 0)
		return { first: 0, last: 0, state: RangeParseState.issue };
	return { first: fileSize - last!, last: fileSize - 1, state: RangeParseState.valid };
}
enum RespondedState {
	none,
	prepared,
	responded
}

function MakeContentType(fileType: string): string {
	const typeMap: Record<string, string> = {
		'html': 'text/html; charset=utf-8',
		'css': 'text/css; charset=utf-8',
		'js': 'text/javascript; charset=utf-8',
		'txt': 'text/plain; charset=utf-8',
		'json': 'application/json; charset=utf-8',
		'mp4': 'video/mp4',
		'png': 'image/png',
		'gif': 'image/gif',
		'jpg': 'image/jpeg',
		'jpeg': 'image/jpeg',
		'svg': 'image/svg+xml'
	};

	if (fileType in typeMap)
		return typeMap[fileType];
	return 'application/octet-stream';
}

let NextClientId: number = 0;
const WebSocketServerInstance: libWs.Server = new libWs.WebSocketServer({ noServer: true });

export class ClientBase {
	protected logLayer: string;
	protected context: Record<string, unknown>;

	/* path relative to current module base-path */
	public path: string;

	/* absolute path on web-server */
	public fullpath: string;

	/* base path between the fullpath and path */
	public basepath: string;

	/* raw (URI encoded) absolute path */
	public rawpath: string;

	/* raw host of the request */
	public host: string;

	/* incoming header fields */
	public headers: libHttp.IncomingHttpHeaders;

	/* unique id to identify client in logs */
	readonly id: number;

	protected constructor(url: libUrl.URL, host: string, headers: libHttp.IncomingHttpHeaders);
	protected constructor(client: ClientBase);
	protected constructor(arg: libUrl.URL | ClientBase, host?: string, headers?: libHttp.IncomingHttpHeaders) {
		if (arg instanceof libUrl.URL) {
			/* decode the string and re-encode it to ensure '/' and '\' are preserved as URI encoding, but the rest is decoded */
			const cleanPath: string = arg.pathname.split('/').map((segment) => {
				return decodeURIComponent(segment).replace(/[/\\]/g, (c) => (c === '/' ? '%2F' : '%5C'));
			}).join('/');

			this.logLayer = '';
			this.context = {};
			this.id = ++NextClientId;
			this.path = libLocation.Sanitize(cleanPath, false);
			this.rawpath = arg.pathname;
			this.fullpath = this.path;
			this.basepath = '/';
			this.host = host!;
			this.headers = headers!;
		}
		else {
			this.logLayer = arg.logLayer;
			this.context = arg.context;
			this.path = arg.path;
			this.fullpath = arg.fullpath;
			this.basepath = arg.basepath;
			this.rawpath = arg.rawpath;
			this.host = arg.host;
			this.id = arg.id;
			this.headers = arg.headers;
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
	public tryTranslate(path: string): boolean {
		if (!libLocation.IsSubDirectory(path, this.path))
			return false;

		this.basepath = libLocation.JoinSanitized(this.basepath, path);
		this.path = this.path.substring(path.endsWith('/') ? path.length - 1 : path.length);
		if (this.path == '')
			this.path = '/';
		return true;
	}
	public makePath(path: string): string {
		return libLocation.JoinSanitized(this.basepath, path);
	}
	public pushLog(name: string) {
		this.logLayer = `${this.logLayer}::${name}`;
	}
	public log(msg: string) {
		libLog.Log(`Client[${this.id}]${this.logLayer}: ${msg}`);
	}
	public error(msg: string) {
		libLog.Error(`Client[${this.id}]${this.logLayer}: ${msg}`);
	}
}

/*
*	Request is considered acknowledged, as soon as a payload receiver is registered, a response has been triggered, or a preparation started.
*	Paths are URI decoded, except for nested '/' and '\'
*/
export abstract class IncomingBase extends ClientBase {
	protected request: libHttp.IncomingMessage;
	protected responseState: RespondedState;
	protected outputHeaders: Record<string, string>;

	protected abstract respondWithString(status: StatusCodeType, fileType: string, content: string): void;
	protected abstract finishSelf(): void;

	constructor(request: libHttp.IncomingMessage, host: string) {
		super(new libUrl.URL(`http://host.server${request.url}`), host, request.headers);
		this.request = request;
		this.responseState = RespondedState.none;
		this.outputHeaders = {};
	}

	public handled(): boolean {
		return (this.responseState != RespondedState.none);
	}
	public method(): string {
		return this.request.method || '';
	}

	/* called by framework to finish this incoming object (either by sending queued content or by sending a not-found, if not handled) */
	public finishIncoming(): void {
		this.finishSelf();
		if (this.responseState == RespondedState.none)
			this.respondNotFound();
	}

	/* respond with [internal-error], if the header has not yet been sent, and otherwise silently discard (only one to not fail, if request was already responded to) */
	public respondInternalError(msg: string): void {
		if (this.responseState == RespondedState.none || this.responseState == RespondedState.prepared) {
			this.log(`Responding with [${StatusCode.InternalError.msg}] due to [${msg}]`);
			this.outputHeaders = {};
			this.responseState = RespondedState.none;
			this.respondWithString(StatusCode.InternalError, 'txt', msg);
		}
	}

	/* perform a responds with [internal-error] and message 'Filesystem operation failed' */
	public respondFileSystemError(): void {
		this.respondInternalError('Filesystem operation failed');
	}

	/* respond with [not-found] and either a pre-defined template response or the given msg */
	public respondNotFound(body?: ResponseBody): void {
		this.log(`Responding with [${StatusCode.NotFound.msg}]`);
		if (body == null)
			body = { fileType: 'html', content: libTemplates.ErrorNotFound({ path: this.rawpath }) };
		this.respondWithString(StatusCode.NotFound, body.fileType || 'txt', body.content);
	}

	/* respond with [bad-request] and either a pre-defined template response or the given msg */
	public respondBadRequest(reason: string, body?: ResponseBody): void {
		this.log(`Responding with [${StatusCode.BadRequest.msg}] because of [${reason}]`);
		if (body == null)
			body = { fileType: 'html', content: libTemplates.ErrorBadRequest({ path: this.rawpath, reason }) };
		this.respondWithString(StatusCode.BadRequest, body.fileType || 'txt', body.content);
	}

	/* respond with [conflict] and either a pre-defined template response or the given msg */
	public respondConflict(conflict: string, body?: ResponseBody): void {
		this.log(`Responding with [${StatusCode.Conflict.msg}] of [${conflict}]`);
		if (body == null)
			body = { fileType: 'html', content: libTemplates.ErrorConflict({ path: this.rawpath, conflict }) };
		this.respondWithString(StatusCode.Conflict, body.fileType || 'txt', body.content);
	}

	/* respond with [see-other] to the given target and either a pre-defined template response or the given msg (forces method GET) */
	public respondSeeOther(target: string, body?: ResponseBody): void {
		this.log(`Responding with [${StatusCode.SeeOther.msg}] to [${target}]`);
		this.outputHeaders['Location'] = target;
		if (body == null)
			body = { fileType: 'html', content: libTemplates.SeeOther({ destination: target }) };
		this.respondWithString(StatusCode.SeeOther, body.fileType || 'txt', body.content);
	}

	/* respond with [temporary-redirect] to the given target and either a pre-defined template response or the given msg (preserves method) */
	public respondTemporaryRedirect(target: string, body?: ResponseBody): void {
		this.log(`Responding with [${StatusCode.TemporaryRedirect.msg}] to [${target}]`);
		this.outputHeaders['Location'] = target;
		if (body == null)
			body = { fileType: 'html', content: libTemplates.TemporaryRedirect({ path: this.rawpath, destination: target }) };
		this.respondWithString(StatusCode.TemporaryRedirect, body.fileType || 'txt', body.content);
	}

	/* respond with [permanent-redirect] to the given target and either a pre-defined template response or the given msg (preserves method)  */
	public respondPermanentRedirect(target: string, body?: ResponseBody): void {
		this.log(`Responding with [${StatusCode.PermanentRedirect.msg}] to [${target}]`);
		this.outputHeaders['Location'] = target;
		if (body == null)
			body = { fileType: 'html', content: libTemplates.PermanentRedirect({ path: this.rawpath, destination: target }) };
		this.respondWithString(StatusCode.PermanentRedirect, body.fileType || 'txt', body.content);
	}
}

/*
*	Unhandled exceptions thrown by a request handler will result in [internal-server-errors]
*	Not responded requests will result in [not-found]
*	Html response is sent once its content has been set and the modules have completed the processing
*/
export class HttpRequest extends IncomingBase {
	private response: libHttp.ServerResponse;
	private received: boolean;
	private htmlResponse?: { page: libBuilder.HtmlPage, status: StatusCodeType };

	constructor(request: libHttp.IncomingMessage, response: libHttp.ServerResponse, host: string) {
		super(request, host);
		this.response = response;
		this.received = false;
	}

	private closeHeader(status: StatusCodeType, fileType: string, contentSize: number | null = null): void {
		/* check if the header has already been sent */
		if (this.responseState != RespondedState.none)
			throw new Error('Request has already been handled');
		this.responseState = RespondedState.responded;

		/* setup the response */
		this.response.statusCode = status.code;
		this.response.statusMessage = status.msg;
		for (const key in this.outputHeaders)
			this.response.setHeader(key, this.outputHeaders[key]);
		this.response.setHeader('Server', libServer.GetServerName());
		this.response.setHeader('Content-Type', MakeContentType(fileType));
		this.response.setHeader('Date', new Date().toUTCString());
		if (!('Accept-Ranges' in this.outputHeaders))
			this.response.setHeader('Accept-Ranges', 'none');
		if (contentSize != null)
			this.response.setHeader('Content-Length', contentSize);
	}
	private receiveClientChunks(cb: (data: Buffer | null, error: Error | null) => boolean, maxLength: number | null): void {
		let failed = false, accumulated = 0;

		/* check if the object is ready for receiving */
		if (this.received)
			throw new Error('Payload has already been handled');
		this.received = true;

		/* check if too many data have been promised */
		if (maxLength != null && this.headers['content-length'] != undefined) {
			const contentSize = parseInt(this.headers['content-length']);

			/* check if the length is valid and otherwise mark the state as 'handled' */
			if (!isFinite(contentSize) || contentSize < 0 || contentSize > maxLength) {
				this.log(`Request is too large or has no size [${contentSize}]`);
				const content = libTemplates.ErrorContentTooLarge({ path: this.rawpath, allowedLength: maxLength, providedLength: contentSize });
				this.respondWithString(StatusCode.ContentTooLarge, 'html', content);
				cb(null, new Error('Request payload is too large'));
				return;
			}
		}

		/* register the data recipient */
		this.request.on('data', (data: Buffer) => {
			if (failed) return;

			/* check the maximum count */
			accumulated += data.byteLength;
			if (maxLength != null && accumulated > maxLength) {
				this.log(`Request payload is too large [${accumulated} > ${maxLength}]`);
				failed = true;

				/* send the response with the size error */
				const content = libTemplates.ErrorContentTooLarge({ path: this.rawpath, allowedLength: maxLength, providedLength: accumulated });
				this.respondWithString(StatusCode.ContentTooLarge, 'html', content);
				cb(null, new Error('Request is too large'));
			}

			/* pass the data to the handler */
			else if (failed = !cb(data, null)) {
				if (this.responseState != RespondedState.responded) {
					this.error('Connection closed automatically as chunked recipient returned false');
					this.respondInternalError('Unknown internal error encountered');
				}
			}
		});

		/* register the error and end handler */
		this.request.on('error', (e) => {
			if (failed) return;
			this.error(`Error while receiving data [${e.message}]`);
			failed = true;
			cb(null, e);
		});
		this.request.on('end', () => {
			if (failed) return;
			cb(null, null);
		});
	}
	protected respondWithString(status: StatusCodeType, fileType: string, content: string): void {
		let buffer: Buffer = Buffer.from(content, 'utf-8');
		this.closeHeader(status, fileType, buffer.length);
		this.response.end(buffer);
	}
	protected finishSelf(): void {
		/* check if html has been queued and respond with it */
		if (this.htmlResponse != null && this.responseState == RespondedState.prepared) {
			this.responseState = RespondedState.none;
			this.respondWithString(this.htmlResponse.status, 'html', this.htmlResponse.page.finalize());
		}
	}

	/* add the given header to the response (Should be title cased) */
	public addHeader(key: string, value: string): void {
		if (this.responseState == RespondedState.responded)
			throw new Error('Cannot modify headers of sent response');
		this.outputHeaders[key] = value;
	}

	/* ensure the method is one of the list and otherwise return null and auto-respond with [method-not-allowed] */
	public ensureMethod(methods: string[]): string | null {
		if (methods.indexOf(this.request.method!) >= 0)
			return this.request.method!;
		this.log(`Responding with [${StatusCode.MethodNotAllowed.msg}] due to [${this.request.method}]`);

		const content = libTemplates.ErrorInvalidMethod({ path: this.rawpath, method: this.request.method!, allowed: methods });
		this.respondWithString(StatusCode.MethodNotAllowed, 'html', content);
		return null;
	}

	/* ensure the media-type is one of the list and otherwise return null and auto-respond with [unsupported-media-type] */
	public ensureMediaType(types: string[]): string | null {
		const type = this.headers['content-type']?.toLowerCase();
		if (type == null)
			return types[0];
		for (let i = 0; i < types.length; ++i) {
			if (type === types[i] || type.startsWith(`${types[i]};`))
				return types[i];
		}
		this.log(`Responding with [${StatusCode.UnsupportedMediaType.msg}] for [${type}]`);

		const content = libTemplates.ErrorUnsupportedMediaType({ path: this.rawpath, used: type, allowed: types });
		this.respondWithString(StatusCode.UnsupportedMediaType, 'html', content);
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
		return this.htmlResponse?.page || null;
	}

	/* prepare the response to be html, can be built on by parent modules, sent once the client is cleared and the builder is ready */
	public respondHtml(page: libBuilder.HtmlPage, status: StatusCodeType = StatusCode.Ok): void {
		if (this.responseState != RespondedState.none)
			throw new Error('Request has already been handled');

		this.log(`Responding with HTML content and status [${status.code}]`);
		this.responseState = RespondedState.prepared;
		this.htmlResponse = { page, status };
	}

	/* respond with [status] and send data given to callback (callback must at least be called once with 'last' set) */
	public respondData(fileType: string = 'html', status: StatusCodeType = StatusCode.Ok): (data: Buffer | null, last: boolean) => Promise<void> {
		if (this.responseState != RespondedState.none)
			throw new Error('Request has already been handled');
		this.log(`Responding with data and status [${status.msg}]`);
		this.responseState = RespondedState.prepared;

		/* return the send callback */
		let completed = false, headerSent = false;
		return (data, last) => new Promise((resolve, reject) => {
			if (completed)
				return reject(new Error('Responding to closed response'));

			/* check if the header needs to be sent */
			if (this.responseState == RespondedState.prepared) {
				this.responseState = RespondedState.none;
				this.closeHeader(status, fileType, (last ? (data?.length || 0) : null));
				headerSent = true;
			}
			else if (!headerSent) {
				completed = true;
				return reject(new Error('Connection has failed'));
			}

			/* check if the last package is being sent */
			if (last) {
				this.response.end(data);
				completed = true;
				return resolve();
			}

			/* send the next message */
			this.response.write(data, (e) => {
				if (e == null)
					return resolve();
				completed = true;
				this.error(`Connection has failed: ${e.message}`);
				reject(e);
			});
		});
	}

	/* respond with [ok] and either a pre-defined template response or the given msg */
	public respondOk(operation: string, body?: ResponseBody): void {
		this.log(`Responding with [${StatusCode.Ok.msg}] for [${operation}]`);
		if (body == null)
			body = { fileType: 'html', content: libTemplates.SuccessOk({ path: this.rawpath, operation: operation }) };
		this.respondWithString(StatusCode.Ok, body.fileType || 'txt', body.content);
	}

	/* respond with a textual response of the given media-type and given status code */
	public respondText(content: string, fileType: string = 'html', status: StatusCodeType = StatusCode.Ok): void {
		this.log(`Responding with ${fileType}: [${content.substring(0, 32).replaceAll('\n', ' ').replaceAll('\r', ' ').replaceAll('\t', ' ')}...]`);
		this.respondWithString(status, fileType, content);
	}

	/* try to respond with the given file (extracting media-type from the file-path), and return false, if not found (http-range aware) */
	public tryRespondFile(filePath: string): boolean {
		try {
			/* lookup the file in the cache */
			const cached: libCache.Cached | null = libCache.Get(filePath);
			if (cached == null)
				return false;

			/* mark byte-ranges to be supported in principle */
			this.outputHeaders['Accept-Ranges'] = 'bytes';

			/* parse the range and ensure that its well formed */
			const range = ParseRangeHeader(this.headers.range, cached.fileSize());
			if (range.state == RangeParseState.malformed) {
				this.log(`Malformed range-request encountered [${this.headers.range}]`);
				const content = libTemplates.ErrorBadRequest({ path: this.rawpath, reason: `Issues while parsing http-header range: [${this.headers.range}]` });
				this.respondWithString(StatusCode.BadRequest, 'html', content);
				return true;
			}
			else if (range.state == RangeParseState.issue) {
				this.log(`Unsatisfiable range-request encountered [${this.headers.range}] with file-size [${cached.fileSize()}]`);
				this.outputHeaders['Content-Range'] = `bytes */${cached.fileSize()}`;
				const content = libTemplates.ErrorRangeIssue({ path: this.rawpath, range: this.headers.range!, fileSize: cached.fileSize() });
				this.respondWithString(StatusCode.RangeIssue, 'html', content);
				return true;
			}

			/* extract the file-type */
			let fileType = libPath.extname(filePath).toLowerCase();
			if (fileType.startsWith('.'))
				fileType = fileType.substring(1);

			/* check if the file is empty (can only happen for unused ranges) */
			if (cached.fileSize() == 0) {
				this.log(`Sending empty content for [${filePath}]`);
				this.closeHeader(StatusCode.Ok, fileType, 0);
				this.response.end();
				return true;
			}

			/* create the stream for the file */
			const stream: libStream.Readable = cached.stream({ start: range.first, end: range.last });

			/* setup the response */
			if (range.state == RangeParseState.valid)
				this.outputHeaders['Content-Range'] = `bytes ${range.first}-${range.last}/${cached.fileSize()}`;
			this.closeHeader((range.state == RangeParseState.noRange ? StatusCode.Ok : StatusCode.PartialContent), fileType, (range.last - range.first) + 1);

			/* write the content to the stream */
			this.log(`Sending content [${range.first} - ${range.last}/${cached.fileSize()}] from [${filePath}]`);
			libStream.pipeline(stream, this.response, (err) => {
				this.log(err == undefined ? `All content has been sent` : `Error while sending content: [${err}]`);
			});
		} catch (_) {
			this.respondFileSystemError();
		}
		return true;
	}

	/* receive the payload of given max length in chunks until the end has been reached (null, null) an error occurred, or the callback returned false
	*	- logs all errors and automatically responds with [content-too-large] if the payload is too large
	*	- if errors occur, and the connection is being responded to, the callback must return false */
	public receiveChunks(cb: (data: Buffer | null, error: Error | null) => boolean, maxLength: number | null): void {
		return this.receiveClientChunks(cb, maxLength);
	}

	/* receive the payload of given max length as a single complete buffer
	*	- logs all errors and automatically responds with [content-too-large] if the payload is too large
	*	- if errors occur, and the connection is being responded to, the callback must return false */
	public receiveAllBuffer(maxLength: number | null): Promise<Buffer> {
		return new Promise((resolve, reject) => {
			const body: Buffer[] = [];
			this.receiveClientChunks((buf, err) => {
				if (err != null)
					reject(err);
				else if (buf != null)
					body.push(buf);
				else
					resolve(Buffer.concat(body));
				return true;
			}, maxLength);
		});
	}

	/* receive the payload of given max length as a single complete decoded string
	*	- logs all errors and automatically responds with [content-too-large] if the payload is too large, or with [bad-request] on invalid encoding
	*	- if errors occur, and the connection is being responded to, the callback must return false */
	public receiveAllText(encoding: string, maxLength: number | null): Promise<string> {
		return new Promise((resolve, reject) => {
			const body: Buffer[] = [];
			this.receiveClientChunks((buf, err) => {
				/* check if an error occurred or if the next buffer was received */
				if (err != null)
					reject(err);
				else if (buf != null)
					body.push(buf);

				/* convert the buffers to a string */
				else try {
					resolve(Buffer.concat(body).toString(encoding as BufferEncoding));
				} catch (err: any) {
					this.error(`Failed to decode content with [${encoding}]: ${err.message}`);
					const content = libTemplates.ErrorBadRequest({ path: this.rawpath, reason: `Unable to decode content` });
					this.respondWithString(StatusCode.BadRequest, 'html', content);
					reject(err);
				}
				return true;
			}, maxLength);
		});
	}

	/* receive the payload of given max length and write it directly to a file; will fail if the file already exists and delete the file, if it could not be received in full
	*	- logs all errors and automatically responds with [content-too-large] if the payload is too large, or with internal-error on file operation failure
	*	- if errors occur, and the connection is being responded to, the callback must return false */
	public receiveToFile(path: string, maxLength: number | null): Promise<void> {
		this.log(`Collecting data from [${this.rawpath}] to: [${path}]`);
		return new Promise((resolve, reject) => {
			/* initialize busy until the file has been opened */
			let queue: Buffer[] = [], fd: number | null = null, cbResult: Error | null = null, fileException: boolean = false;
			let fdBusy = true, fdClose = false;
			const finishReceive = () => {
				if (cbResult == null)
					return resolve();

				/* send the failure response */
				if (fileException) {
					this.error(`Failed to collect data into file: ${cbResult.message}`);
					this.respondFileSystemError();
				}
				return reject(cbResult);
			};
			const failure = function (e: Error, fileError: boolean): void {
				if (cbResult == null)
					cbResult = e, fileException = fileError;
				fdClose = true;
				queue = [];
			};
			const process = () => {
				if (fdBusy)
					return;

				/* check if further data exist to be written out */
				if (queue.length > 0 && cbResult == null) {
					/* write the next data out */
					fdBusy = true;
					libFs.write(fd!, queue[0], function (e, written) {
						fdBusy = false;

						/* check if the write failed and otherwise consume the written data */
						if (e)
							failure(e, true);
						else if (written >= queue[0].length)
							queue = queue.splice(1);
						else
							queue[0] = queue[0].subarray(written);
						process();
					});
					return;
				}

				/* check if the fd is to be closed (leave it busy indefinitely) */
				if (!fdClose)
					return;
				fdBusy = true;

				/* check if the open failed in the first place */
				if (fd == null)
					finishReceive();

				/* close the file and check if it should be removed */
				else libFs.close(fd, () => {
					if (cbResult == null)
						finishReceive();
					else libFs.unlink(path, (err) => {
						if (err != null)
							this.error(`Failed to remove file [${path}] after writing uploaded data to it failed: ${err.message}`);
						finishReceive();
					});
				});
			};

			/* open the actual file for writing */
			libFs.open(path, 'wx', function (e, f) {
				fdBusy = false;
				if (e)
					failure(e, true);
				else
					fd = f;
				process();
			});

			/* setup the chunk receivers */
			this.receiveClientChunks(function (buf, err): boolean {
				if (err != null)
					failure(err, false);
				else if (buf == null)
					fdClose = true;
				else if (!fdClose)
					queue.push(buf);
				process();
				return !fdClose;
			}, maxLength);
		});
	}
}

export class HttpUpgrade extends IncomingBase {
	private socket: libStream.Duplex;
	private head: Buffer;

	constructor(request: libHttp.IncomingMessage, socket: libStream.Duplex, head: Buffer, host: string) {
		super(request, host);
		this.socket = socket;
		this.head = head;
	}

	protected respondWithString(status: StatusCodeType, fileType: string, content: string): void {
		const buffer = Buffer.from(content, 'utf-8');

		/* check if the header has already been sent (always set to finalized, as it is closed) */
		if (this.responseState != RespondedState.none)
			throw new Error('Request has already been handled');
		this.responseState = RespondedState.responded;

		let header = `HTTP/1.1 ${status.code} ${status.msg}\r\n`;
		header += `Date: ${new Date().toUTCString()}\r\n`;
		header += `Server: ${libServer.GetServerName()}\r\n`;
		header += `Content-Type: ${MakeContentType(fileType)}\r\n`;
		header += `Content-Length: ${buffer.length}\r\n`;
		header += `Accept-Ranges: none\r\n`;
		if ((this.request.headers.connection || "").toLowerCase() != "close" && this.request.httpVersionMajor < 2) {
			header += 'Connection: keep-alive\r\n';
			header += 'Keep-Alive: timeout=5\r\n';
		}
		header += '\r\n';

		this.socket.write(header, 'utf-8');
		this.socket.end(buffer);
	}
	protected finishSelf(): void { }

	/* marks the object as having been handled (returns false, if connection is not a valid websocket upgrade request) */
	public tryAcceptWebSocket(cb: (ws: ClientSocket) => void): boolean {
		/* ensure the connection can be accepted */
		if (this.responseState != RespondedState.none)
			throw new Error('Request has already been handled');

		/* check if the connection is a valid upgrade request */
		let connection = this.headers?.connection?.toLowerCase().split(',').map((v) => v.trim());
		if (connection == null || connection.indexOf('upgrade') == -1)
			return false;
		if (this.headers?.upgrade?.toLowerCase() != 'websocket' || this.request.method != 'GET')
			return false;

		/* mark the request as handled */
		this.responseState = RespondedState.responded;

		/* try to accept the request */
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

		/* register the callbacks */
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
	}

	public ping(): void {
		this.ws.ping();
	}
	public send(data: string | Buffer): void {
		this.ws.send(data);
	}
	public close(): void {
		this.ws.close();
	}
}
