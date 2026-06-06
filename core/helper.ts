/* SPDX-License-Identifier: BSD-3-Clause */
/* Copyright (c) 2026 Bjoern Boss Henrichsen */
import * as libLocation from "./location.js";
import * as libBase from "./base.js";
import * as libLog from "./log.js";

const logger = libLog.Logger('helper');

/* setup the reverse list of file-endings to media types and encoding-names to encoding types */
const FileEndingToMediaTypeMapping: Record<string, libBase.MediaType> = {};
const EncodingNameToEncodingTypeMapping: Record<string, libBase.EncodingType> = {};
for (const media of Object.values(libBase.Media)) {
	for (const fileEnding of media.fileEnding)
		FileEndingToMediaTypeMapping[fileEnding] = media;
}
for (const encoding of Object.values(libBase.Encoding))
	EncodingNameToEncodingTypeMapping[encoding.name] = encoding;

/* lookup the encoding for a given name */
export function LookupEncoding(name: string): libBase.EncodingType | null {
	return EncodingNameToEncodingTypeMapping[name.toLowerCase()] ?? null;
}

/* list of all supported encodings */
export function SupportedEncodingNames(): string[] {
	return Object.keys(EncodingNameToEncodingTypeMapping);
}

/* map extension of file-path/file-name to media type (null if no match was found) */
export function LookupMediaTypeFromFile(filePath: string): libBase.MediaType | null {
	const fileExtension = libLocation.SplitFilePath(filePath)[2];
	if (fileExtension != '') {
		const type = FileEndingToMediaTypeMapping[fileExtension.substring(1).toLowerCase()] ?? null;
		if (type != null)
			return type;
	}
	return null;
}

/* format the media type to the proper http header identifier */
export function BuildMediaTypeIdentifier(media: libBase.MediaType): string {
	if (media.encoding == '')
		return media.mediaType;
	return `${media.mediaType}; ${media.encoding}`;
}

/* does not respect 'no-identity' encoding requests; unknown at-least-size is considered valid (defaults 'identity' to null) */
export function NegotiateEncoding(accept: string | null, atLeastSize: number | null, media: libBase.MediaType): libBase.EncodingType | null {
	if (!media.compressible || accept == null)
		return null;
	if (atLeastSize != null && atLeastSize < libBase.MIN_ENCODING_SIZE)
		return null;

	/* parse the encoding types and their score */
	const scores: Record<string, number> = {};
	let bestScore: string | null = null;
	for (const part of SplitAndTrimList(accept, ',', false)) {
		const segments = SplitAndTrimList(part, ';', false);
		const name = segments[0].toLowerCase();

		/* check if the name is even supported and otherwise drop it */
		if (!(name in EncodingNameToEncodingTypeMapping) && name != '*')
			continue;

		/* parse the weight score of the value but default to 1.0 if none was given (ignore any with invalid quality) */
		let score = 1.0;
		for (let i = 1; i < segments.length; ++i) {
			const match = segments[i].match(/^\s*q\s*=\s*(\d+\.?\d*)\s*$/i);
			if (match != null) {
				score = parseFloat(match[1]);
				break;
			}
		}
		if (score < 0 || score > 1)
			continue;

		/* update the scores and best match */
		scores[name] = (name in scores ? Math.max(scores[name], score) : score);
		if (bestScore == null || scores[bestScore] < score)
			bestScore = name;
		else if (scores[bestScore] == score && (bestScore == name || bestScore == 'identity' || (bestScore == '*' && name != 'identity')))
			bestScore = name;
	}

	/* check if a best-match has been found */
	if (bestScore == null || scores[bestScore] <= 0)
		return null;
	if (bestScore != null && bestScore != '*')
		return (bestScore == 'identity' ? null : EncodingNameToEncodingTypeMapping[bestScore]);

	/* lookup the best entry not mentioned (because '*' was the best match) */
	for (const encoding in EncodingNameToEncodingTypeMapping) {
		if (!(encoding in scores))
			return EncodingNameToEncodingTypeMapping[encoding];
	}
	return null;
}

export enum RangeState {
	noRange,
	valid,
	issue,
	malformed
}

/* parse an http header range request (first and last are correct for all valid range states; will be [0,-1] for an emtpy file) */
export function ParseRangeHeader(range: string | null, fileSize: number): { first: number, last: number, state: RangeState } {
	if (range == null)
		return { first: 0, last: fileSize - 1, state: RangeState.noRange };

	/* ignore unknown range units (range units are case-insensitive) */
	if (range.length < 6 || range.substring(0, 6).toLowerCase() != 'bytes=')
		return { first: 0, last: fileSize - 1, state: RangeState.noRange };
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

/* check if the [etag] matches the list (i.e. in list or list is '*'), will not match for undefined list; if [strong]
*	comparison, both must be non-weak, opaque-tags equal (strip W/ prefix and compare opaque-tags regardless of weakness) */
export function ETagMatchesList(etag: string, header: string | null, strong: boolean): boolean {
	if (header == null)
		return false;

	const list: string[] = SplitAndTrimList(header, ',', true);
	if (list.length == 1 && list[0] == '*')
		return true;
	if (strong && etag.startsWith('W/'))
		return false;

	const target = etag.startsWith('W/') ? etag.substring(2) : etag;
	for (const entry of list) {
		const current = ((strong || !entry.startsWith('W/')) ? entry : entry.substring(2));
		if (target == current)
			return true;
	}
	return false;
}

/* returns null on invalid times, [>0] for a being greater, [<0] for a being smaller, [=0] for same time */
export function TimeStampCompare(a: string, b: string): number | null {
	const _a = new Date(a).getTime();
	if (isNaN(_a))
		return null;
	const _b = new Date(b).getTime();
	if (isNaN(_b))
		return null;
	return (_a - _b);
}

/* split a list value while removing whitespace and optionally respecting quotes (returns empty list on validly quoted strings) */
export function SplitAndTrimList(content: string | null, separator: string, quotesAware: boolean): string[] {
	if (content == null)
		return [];

	let output: string[] = [], current = '', inQuote = false;
	for (const c of content) {
		if (c == '"' && quotesAware)
			inQuote = !inQuote, current += c;
		else if (c != separator || inQuote)
			current += c
		else
			output.push(current.trim()), current = '';
	}

	if (inQuote)
		return [];
	output.push(current.trim());

	return output;
}

/* escape all html-special characters to prevent injection when embedding untrusted values */
export function EscapeHtml(content: string): string {
	let out = '';
	for (let i = 0; i < content.length; ++i) {
		switch (content[i]) {
			case '&': out += '&amp;'; break;
			case '<': out += '&lt;'; break;
			case '>': out += '&gt;'; break;
			case '"': out += '&quot;'; break;
			case '\'': out += '&#39;'; break;
			default: out += content[i]; break;
		}
	}
	return out;
}

/* expand the placeholders in the content (format: {#name}, with '{#' being escaped as '{##'; optionally html-escape values) */
export function ExpandPlaceholders(content: string, args: Record<string, string>, htmlEscape: boolean): string {
	let out = '', name = '', placeholder = false;
	for (let i = 0; i < content.length; ++i) {
		/* check if this is not the start/end of a placeholder, in which case it can just be added to the current set */
		if (!content.startsWith(placeholder ? '}' : '{#', i)) {
			if (placeholder)
				name += content[i];
			else
				out += content[i];
			continue;
		}

		/* check if a name is being started and if its potentially just an escape sequence */
		if (!placeholder) {
			if (content.startsWith('{##', i))
				out += '{#', i += 2;
			else
				name = '', placeholder = true, ++i;
			continue;
		}

		placeholder = false;
		if (name in args)
			out += (htmlEscape ? EscapeHtml(args[name]) : args[name]);
		else
			logger.warning(`Undefined placeholder [${name}] encountered`);
	}

	if (placeholder)
		logger.warning('Content ends with an incomplete placeholder');
	return out;
}

/* escape all placeholders in the content */
export function EscapePlaceholders(content: string): string {
	let out = '';

	/* construct the new escaped output content */
	for (let i = 0; i < content.length; ++i) {
		if (!content.startsWith('{#', i))
			out += content[i];
		else
			out += '{##', ++i;
	}
	return out;
}
