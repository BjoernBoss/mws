/* SPDX-License-Identifier: BSD-3-Clause */
/* Copyright (c) 2026 Bjoern Boss Henrichsen */
import * as libZlib from "zlib";
import * as libStream from "stream";

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

export enum RangeState {
	noRange,
	valid,
	issue,
	malformed
}
export function ParseRangeHeader(range: string | null, fileSize: number): { first: number, last: number, state: RangeState } {
	if (range == null)
		return { first: 0, last: fileSize - 1, state: RangeState.noRange };

	/* check if it requests bytes */
	if (!range.startsWith('bytes='))
		return { first: 0, last: 0, state: RangeState.issue };
	range = range.substring(6);

	/* extract the first number */
	let numberLength: number = 0, firstNumber: string = '', lastNumber: string = '';
	while (numberLength < range.length && (range[numberLength] >= '0' && range[numberLength] <= '9'))
		++numberLength;
	firstNumber = range.substring(0, numberLength);
	range = range.substring(numberLength);

	/* check if the separator exists */
	if (!range.startsWith('-'))
		return { first: 0, last: 0, state: RangeState.malformed };
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
		return { first: 0, last: 0, state: RangeState.malformed };
	if (firstNumber == '' && lastNumber == '')
		return { first: 0, last: 0, state: RangeState.malformed };

	/* parse the two numbers */
	let first: number | null = (firstNumber.length == 0 ? null : parseInt(firstNumber));
	let last: number | null = (lastNumber.length == 0 ? null : parseInt(lastNumber));

	/* check if the range has an offset and potentially also an end */
	if (first != null) {
		if (last == null)
			last = fileSize - 1;
		if (first > last || last >= fileSize)
			return { first: 0, last: 0, state: RangeState.issue };
		return { first, last, state: RangeState.valid };
	}

	/* validate the offset at the end */
	if (last! > fileSize || last! == 0)
		return { first: 0, last: 0, state: RangeState.issue };
	return { first: fileSize - last!, last: fileSize - 1, state: RangeState.valid };
}

const RegisteredMediaTypes: Record<string, MediaType> = {
	'html': {
		fileEnding: 'html',
		mediaType: 'text/html; charset=utf-8',
		compressed: false
	},
	'css': {
		fileEnding: 'css',
		mediaType: 'text/css; charset=utf-8',
		compressed: false
	},
	'js': {
		fileEnding: 'js',
		mediaType: 'text/javascript; charset=utf-8',
		compressed: false
	},
	'txt': {
		fileEnding: 'txt',
		mediaType: 'text/plain; charset=utf-8',
		compressed: false
	},
	'json': {
		fileEnding: 'json',
		mediaType: 'application/json; charset=utf-8',
		compressed: false
	},
	'mp4': {
		fileEnding: 'mp4',
		mediaType: 'video/mp4',
		compressed: true
	},
	'png': {
		fileEnding: 'png',
		mediaType: 'image/png',
		compressed: true
	},
	'gif': {
		fileEnding: 'gif',
		mediaType: 'image/gif',
		compressed: true
	},
	'jpg': {
		fileEnding: 'jpg',
		mediaType: 'image/jpeg',
		compressed: true
	},
	'jpeg': {
		fileEnding: 'jpeg',
		mediaType: 'image/jpeg',
		compressed: true
	},
	'svg': {
		fileEnding: 'svg',
		mediaType: 'image/svg+xml',
		compressed: false
	},
}
export interface MediaType {
	fileEnding: string;
	mediaType: string;
	compressed: boolean;
}
export function LookupMediaType(fileEnding: string): MediaType {
	if (fileEnding in RegisteredMediaTypes)
		return RegisteredMediaTypes[fileEnding];
	return { fileEnding, mediaType: 'application/octet-stream', compressed: true };
}
export const HtmlType: MediaType = RegisteredMediaTypes['html'];
export const TextType: MediaType = RegisteredMediaTypes['txt'];
export const JsonType: MediaType = RegisteredMediaTypes['json'];

const RegisteredEncodings: Record<string, EncodingInterface> = {
	'br': {
		name: 'br',
		makeDecode: () => libZlib.createBrotliDecompress(),
		makeEncode: () => libZlib.createBrotliCompress(),
		encodeBuffer: (buffer: Buffer) => libZlib.brotliCompressSync(buffer)
	},
	'zstd': {
		name: 'zstd',
		makeDecode: () => libZlib.createZstdDecompress(),
		makeEncode: () => libZlib.createZstdCompress(),
		encodeBuffer: (buffer: Buffer) => libZlib.zstdCompressSync(buffer)
	},
	'gzip': {
		name: 'gzip',
		makeDecode: () => libZlib.createGunzip(),
		makeEncode: () => libZlib.createGzip(),
		encodeBuffer: (buffer: Buffer) => libZlib.gzipSync(buffer)
	},
	'deflate': {
		name: 'deflate',
		makeDecode: () => libZlib.createInflate(),
		makeEncode: () => libZlib.createDeflate(),
		encodeBuffer: (buffer: Buffer) => libZlib.deflateSync(buffer)
	},
	'identity': {
		name: 'identity',
		makeDecode: () => new libStream.PassThrough(),
		makeEncode: () => new libStream.PassThrough(),
		encodeBuffer: (buffer: Buffer) => buffer
	}
}
export const MIN_ENCODING_SIZE: number = 1_000;
export interface EncodingInterface {
	name: string;
	makeDecode(): libStream.Transform;
	makeEncode(): libStream.Transform;
	encodeBuffer(buffer: Buffer): Buffer;
}
export function EncodingOption(accept: string | null, atLeastSize: number, mediaType: MediaType): EncodingInterface | null {
	/* check if any accepted encodings can be found or if the type/size does not make sense */
	if (accept == null || atLeastSize < MIN_ENCODING_SIZE || mediaType.compressed)
		return null;

	/* parse the encoding types and look for a match */
	let bestMatch: EncodingInterface | null = null, bestScore: number = 0;
	for (const part of accept.split(',')) {
		const segments = part.split(';');

		/* check if its an supported encoding */
		const name = segments[0].trim().toLowerCase();
		if (!(name in RegisteredEncodings))
			continue;

		/* check if the encoding has been explicitly excluded via q=0 */
		let score = 1.0;
		for (let i = 1; i < segments.length; ++i) {
			const match = segments[i].match(/^\s*q\s*=\s*(\d+\.?\d*)\s*$/);
			if (match != null) {
				score = parseFloat(match[1]);
				break;
			}
		}
		if (score == 0.0)
			continue;

		/* check if this is a better match to the request */
		if (bestMatch == null || score > bestScore)
			bestMatch = RegisteredEncodings[name], bestScore = score;
	}
	return bestMatch;
}
export function LookupEncoding(name: string): EncodingInterface | null {
	return RegisteredEncodings[name.trim().toLowerCase()] ?? null;
}
export function SupportedEncodingNames(): string[] {
	const out = [];
	for (const name in RegisteredEncodings)
		out.push(name);
	return out;
}
