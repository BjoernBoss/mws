/* SPDX-License-Identifier: BSD-3-Clause */
/* Copyright (c) 2024-2026 Bjoern Boss Henrichsen */
import * as libLog from "./log.js";
import * as libLocation from "./location.js";
import * as libCache from "./cache.js";

const logger = libLog.Logger('template');

const TemplateDirectory = libLocation.MakeSelfPath(import.meta.url, 'templates');
function LoadRelative(name: string): string {
	try {
		const data: Buffer | null = libCache.GetNormal(TemplateDirectory(name), true)?.readSync() ?? null;
		if (data != null)
			return data.toString('utf-8');
	} catch (_) { }

	/* return the default place-holder */
	logger.error(`Unable to load template [${name}] properly`);
	return '<!doctype html><html><body><p style="font-family: monospace;">Response message not found.</p></body></html>';
}
function ExpandPlaceholders(content: string, map: Record<string, string>, escapeValues: boolean = true): string {
	let out = '', name = '', placeholder = false;

	/* construct the new output content */
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

		/* validate the completed name */
		else {
			placeholder = false;
			if (!(name in map))
				logger.warning(`Undefined placeholder [${name}] encountered`);
			else
				out += (escapeValues ? EscapeHtml(map[name]) : map[name]);
		}
	}

	/* check if a last name was not closed properly */
	if (placeholder)
		logger.warning('Content ends with an incomplete placeholder');
	return out;
}

/* html formatted template message for success */
export function SuccessOk(payload: { path: string, operation: string }): string {
	const content: string = LoadRelative('200.template');
	return ExpandPlaceholders(content, { path: payload.path, op: payload.operation });
}

/* html formatted template message for redirect */
export function SeeOther(payload: { destination: string }): string {
	const content: string = LoadRelative('303.template');
	return ExpandPlaceholders(content, { new: payload.destination });
}

/* html formatted template message for redirect */
export function TemporaryRedirect(payload: { path: string, destination: string }): string {
	const content: string = LoadRelative('307.template');
	return ExpandPlaceholders(content, { path: payload.path, new: payload.destination });
}

/* html formatted template message for redirect */
export function PermanentRedirect(payload: { path: string, destination: string }): string {
	const content: string = LoadRelative('308.template');
	return ExpandPlaceholders(content, { path: payload.path, new: payload.destination });
}

/* html formatted template message for error */
export function ErrorPreconditionFailed(payload: { path: string, reason: string }): string {
	const content: string = LoadRelative('412.template');
	return ExpandPlaceholders(content, { path: payload.path, reason: payload.reason });
}

/* html formatted template message for error */
export function ErrorBadRequest(payload: { path: string, reason: string }): string {
	const content: string = LoadRelative('400.template');
	return ExpandPlaceholders(content, { path: payload.path, reason: payload.reason });
}

/* html formatted template message for error */
export function ErrorNotFound(payload: { path: string }): string {
	const content: string = LoadRelative('404.template');
	return ExpandPlaceholders(content, { path: payload.path });
}

/* html formatted template message for error */
export function ErrorInvalidMethod(payload: { path: string, method: string, allowed: string }): string {
	const content: string = LoadRelative('405.template');
	return ExpandPlaceholders(content, { path: payload.path, method: payload.method, allowed: payload.allowed });
}

/* html formatted template message for error */
export function ErrorConflict(payload: { path: string, conflict: string }): string {
	const content: string = LoadRelative('409.template');
	return ExpandPlaceholders(content, { path: payload.path, conflict: payload.conflict });
}

/* html formatted template message for error */
export function ErrorRequestTimeout(payload: { path: string, reason: string }): string {
	const content: string = LoadRelative('408.template');
	return ExpandPlaceholders(content, { path: payload.path, reason: payload.reason });
}

/* html formatted template message for error */
export function ErrorContentTooLarge(payload: { path: string, allowedLength: number, providedLength: number }): string {
	const content: string = LoadRelative('413.template');
	return ExpandPlaceholders(content, { path: payload.path, allowed: payload.allowedLength.toString(), size: payload.providedLength.toString() });
}

/* html formatted template message for error */
export function ErrorUnsupportedMediaType(payload: { path: string, allowed: string, used: string }): string {
	const content: string = LoadRelative('415.template');
	return ExpandPlaceholders(content, { path: payload.path, used: payload.used, allowed: payload.allowed });
}

/* html formatted template message for error */
export function ErrorRangeIssue(payload: { path: string, range: string, size: number }): string {
	const content: string = LoadRelative('416.template');
	return ExpandPlaceholders(content, { path: payload.path, range: payload.range, size: payload.size.toString() });
}

/* html formatted template message for error */
export function ErrorInternalServerError(payload: { path: string, what: string }): string {
	const content: string = LoadRelative('500.template');
	return ExpandPlaceholders(content, { path: payload.path, what: payload.what });
}

/* expand the placeholders in the content (format: {#name}, with '{#' being
*	escaped as '{##'; values are html-escaped by default to prevent injection) */
export function Expand(content: string, args: Record<string, string>, escapeValues: boolean = true): string {
	return ExpandPlaceholders(content, args, escapeValues);
}

/* escape html entities to prevent injection when embedding untrusted values into html */
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

/* create the escaped content */
export function Escape(content: string): string {
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
